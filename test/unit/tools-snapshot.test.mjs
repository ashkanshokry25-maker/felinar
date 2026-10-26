// Unit tests for tools/snapshot.mjs (ARCHITECTURE sections 6.7 and 10, DESIGN-REVIEW S2): the file
// written for the pointer's cs= is valid input for the loader's ChainNode.importSnapshot.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { gunzipSync, gzipSync } from 'node:zlib';

import { buildSnapshot, encodeSnapshot, parseExport } from '../../tools/snapshot.mjs';
import { createGenesis, appendControl, ledgerIdForOwner, readBlocksFile } from '../../tools/ledger-admin.mjs';
import { keygen } from '../../tools/keygen.mjs';
import { loadOwnerKey, ROOT } from '../../tools/lib.mjs';
import { createBlock } from '../../src/chain/block.js';
import { generateKeyPair, exportPublicKey } from '../../src/chain/crypto.js';
import { ChainNode } from '../../src/chain/node.js';
import { MemoryBlockStore } from '../../src/chain/stores.js';
import { readSnapshot } from '../../src/common/snapshot-read.js';

const work = mkdtempSync(join(tmpdir(), 'mw-snapshot-test-'));
after(() => rmSync(work, { recursive: true, force: true }));
const T = 1790000000000;

async function newLedger() {
  const file = join(work, 'owner-' + Math.random().toString(36).slice(2) + '.jwk');
  await keygen({ out: file });
  const owner = await loadOwnerKey(file);
  const ledgerId = await ledgerIdForOwner(owner.pub, { scope: 'example.com' });
  const genesis = await createGenesis({ identity: owner, ledgerId, policy: { writers: 'open', bits: 0 }, now: T });
  const kp = await generateKeyPair();
  const guest = { privateKey: kp.privateKey, pub: await exportPublicKey(kp.publicKey) };
  return { owner, guest, ledgerId, genesis, file };
}

const post = (who, ledger, prev, n, value) => createBlock({
  identity: who, site: ledger.ledgerId, seq: n, prev, op: { t: 'append', l: 'guestbook' }, value, ts: T + n * 60000, bits: 0,
});

test('buildSnapshot: keeps the connected valid blocks in (depth, hash) order, drops invalid and orphan blocks', async () => {
  const l = await newLedger();
  const a = await post(l.guest, l, [l.genesis.h], 1, { msg: 'first' });
  const b = await post(l.guest, l, [a.h], 2, { msg: 'second' });
  const forged = JSON.parse(JSON.stringify(b));
  forged.e.ts += 60000; // h no longer matches
  const lost = await post(l.guest, l, ['ab'.repeat(32)], 3, { msg: 'parent unknown' });
  const snap = await buildSnapshot({ blocks: [b, lost, forged, l.genesis, a] });
  assert.deepEqual(snap.blocks.map((x) => x.h), [l.genesis.h, a.h, b.h]);
  assert.equal(snap.height, 3);
  assert.equal(snap.site, l.ledgerId);
  assert.equal(snap.owner, l.owner.pub);
  assert.equal(snap.invalid.length, 1);
  assert.equal(snap.invalid[0].reason, 'hash');
  assert.equal(snap.orphans, 1);
  assert.match(snap.root, /^[0-9a-f]{64}$/);
  // the same blocks in any order give the same bytes
  const again = await buildSnapshot({ blocks: [a, l.genesis, b] });
  assert.equal(encodeSnapshot(again.blocks).equals(encodeSnapshot(snap.blocks)), true);
  assert.equal(encodeSnapshot(snap.blocks, { plain: true }).toString('utf8'), gunzipSync(encodeSnapshot(snap.blocks)).toString('utf8'));
});

test('buildSnapshot: a tombstoned post and a banned author lose their values; the control blocks stay', async () => {
  const l = await newLedger();
  const other = await generateKeyPair();
  const troll = { privateKey: other.privateKey, pub: await exportPublicKey(other.publicKey) };
  const keep = await post(l.guest, l, [l.genesis.h], 1, { msg: 'keep me' });
  const remove = await post(l.guest, l, [keep.h], 2, { msg: 'remove me' });
  const spam = await post(troll, l, [l.genesis.h], 3, { msg: 'spam' });
  const withTomb = await appendControl({ blocks: [l.genesis, keep, remove, spam], identity: l.owner, op: { t: 'tombstone', h: remove.h }, now: T + 600000 });
  const withBan = await appendControl({ blocks: withTomb.blocks, identity: l.owner, op: { t: 'ban', author: troll.pub }, now: T + 660000 });
  const snap = await buildSnapshot({ blocks: withBan.blocks });
  const byHash = new Map(snap.blocks.map((b) => [b.h, b]));
  assert.deepEqual(byHash.get(keep.h).v, { msg: 'keep me' });
  assert.equal(byHash.get(remove.h).v, undefined, 'the tombstoned value is not republished');
  assert.equal(byHash.get(spam.h).v, undefined, 'the banned author\'s value is not republished');
  assert.equal(snap.redacted, 2);
  assert.equal(snap.height, withBan.blocks.length, 'the stubs stay: they are DAG nodes with valid hashes and signatures');
  assert.equal(JSON.stringify(snap.blocks).includes('remove me'), false);
  assert.equal(JSON.stringify(snap.blocks).includes('spam'), false);
  assert.ok(byHash.get(withBan.block.h).e.op.t === 'ban');
});

test('buildSnapshot refuses an empty or invalid export and a ledger above the cap', async () => {
  const l = await newLedger();
  await assert.rejects(buildSnapshot({ blocks: [] }), /no valid block/);
  const broken = JSON.parse(JSON.stringify(l.genesis));
  broken.s = 'A'.repeat(86);
  await assert.rejects(buildSnapshot({ blocks: [broken] }), /no valid block.*sig/);
  await assert.rejects(buildSnapshot({ blocks: [l.genesis], maxBytes: 100 }), /more than/);
  await assert.rejects(buildSnapshot({ blocks: 'nope' }), /no blocks/);
});

test('parseExport reads arrays, { blocks }, single blocks and gzip; rejects anything else', async () => {
  const l = await newLedger();
  const blocks = [l.genesis];
  assert.deepEqual(parseExport(Buffer.from(JSON.stringify(blocks))), blocks);
  assert.deepEqual(parseExport(Buffer.from(JSON.stringify({ blocks }))), blocks);
  assert.deepEqual(parseExport(Buffer.from(JSON.stringify(l.genesis))), blocks);
  assert.deepEqual(parseExport(gzipSync(Buffer.from(JSON.stringify(blocks)))), blocks);
  assert.throws(() => parseExport(Buffer.from('nope')), /not JSON/);
  assert.throws(() => parseExport(Buffer.from('{"a":1}')), /not a ledger export/);
});

test('the snapshot is what the loader reads: ChainNode.importSnapshot accepts it and reaches the same state (gzip and plain)', async () => {
  const l = await newLedger();
  const a = await post(l.guest, l, [l.genesis.h], 1, { msg: 'hello' });
  const b = await post(l.guest, l, [a.h], 2, { msg: 'again' });
  const withTomb = await appendControl({ blocks: [l.genesis, a, b], identity: l.owner, op: { t: 'tombstone', h: a.h }, now: T + 600000 });
  const snap = await buildSnapshot({ blocks: withTomb.blocks });
  for (const plain of [false, true]) {
    const bytes = encodeSnapshot(snap.blocks, { plain });
    // What the shell and drop-in do (src/common/snapshot-read.js), here without DecompressionStream as on
    // Safari and iOS 15.4 to 16.3 (code review round 1): the default gzip output must still be readable.
    const blocks = await readSnapshot({
      url: 'https://example.com/snapshot.json.gz',
      fetch: async () => ({ ok: true, status: 200, headers: { get: () => null }, arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) }),
      maxBytes: 1 << 24,
      maxInflatedBytes: 1 << 25,
    });
    const node = await ChainNode.open({ siteId: l.ledgerId, expectedOwner: l.owner.pub, genesisHash: l.genesis.h, store: new MemoryBlockStore() });
    try {
      await node.importSnapshot(blocks);
      assert.equal(node.height, withTomb.blocks.length, (plain ? 'plain' : 'gzip') + ': every block was accepted');
      const lists = node.snapshot().lists;
      assert.deepEqual(lists.guestbook.map((x) => x.v), [{ msg: 'again' }], 'the tombstoned entry is gone, the other stays');
      assert.equal(node.snapshot().owner, l.owner.pub);
    } finally {
      await node.close();
    }
  }
});

test('command line: file in, gzip or plain out, the summary is printed; bad input exits 1, usage errors 2', async () => {
  const l = await newLedger();
  const a = await post(l.guest, l, [l.genesis.h], 1, { msg: 'hello' });
  const input = join(work, 'export.json');
  writeFileSync(input, JSON.stringify([a, l.genesis]));
  const gz = join(work, 'snapshot.json.gz');
  const run = (...args) => spawnSync(process.execPath, ['tools/snapshot.mjs', ...args], { cwd: ROOT, encoding: 'utf8' });
  const ok = run(input, '--out', gz);
  assert.equal(ok.status, 0, ok.stderr);
  assert.match(ok.stdout, /blocks   2 /);
  assert.match(ok.stdout, new RegExp('ledger   ' + l.ledgerId.replace(/[^A-Za-z0-9]/g, '.')));
  // Post-wave fix E: every loader reads gzip since F20; --plain is an option, never "needed for older iOS".
  assert.match(ok.stdout, /every loader reads the gzip file, also Safari and iOS 15\.4 to 16\.3 without DecompressionStream; --plain writes plain JSON if you prefer/);
  assert.doesNotMatch(ok.stdout, /Safari 16\.4 or later|use --plain for older iOS/);
  assert.equal(readBlocksFile(gz).length, 2, 'ledger-admin reads the gzip file too');
  const plainFile = join(work, 'snapshot.json');
  assert.equal(run(input, '--out', plainFile, '--plain', '--quiet').status, 0);
  assert.equal(JSON.parse(readFileSync(plainFile, 'utf8')).length, 2);
  assert.equal(readFileSync(plainFile)[0], 0x5b, 'plain JSON starts with [');
  const missing = run(join(work, 'nope.json'), '--out', gz);
  assert.equal(missing.status, 1);
  assert.equal(run(input).status, 2, '--out is required');
  assert.equal(run().status, 2);
  const remote = run('https://example.invalid/export.json', '--out', gz);
  assert.equal(remote.status, 1);
  assert.match(remote.stderr, /--remote/, 'a remote URL is refused unless --remote is given, before anything is contacted');
});

// v0.3 (V03-DESIGN-REVIEW 3.2.2 "Snapshot first", E-SO-6): the recent window, newest posts plus control blocks.
test('buildRecentSnapshot: the newest posts and every block above them plus every control block; redacted values travel as stubs', async () => {
  const { buildRecentSnapshot } = await import('../../tools/snapshot.mjs');
  const { parseRecentSnapshot } = await import('../../src/chain/recent.js');
  const l = await newLedger();
  let blocks = [l.genesis];
  let prev = [l.genesis.h];
  const posts = [];
  for (let i = 1; i <= 230; i++) {
    const b = await post(l.guest, l, prev, i, { msg: 'p' + i });
    blocks.push(b);
    posts.push(b);
    prev = [b.h];
  }
  // An owner tombstone of an old post (below the window) and of a recent one (inside it).
  for (const target of [posts[4], posts[225]]) {
    const r = await appendControl({ blocks, identity: l.owner, op: { t: 'tombstone', h: target.h }, now: T + 300 * 60000 + blocks.length * 60000 });
    blocks = r.blocks;
  }
  const rec = await buildRecentSnapshot({ blocks, posts: 50 });
  const w = parseRecentSnapshot(JSON.parse(JSON.stringify(rec.entries)));
  assert.equal(w.ledger, l.ledgerId);
  assert.equal(w.posts, 50);
  const payload = w.blocks.filter((b) => b.e.op.t === 'append');
  assert.ok(payload.length >= 50 && payload.length <= 51, 'the newest 50 posts (the redacted one is a stub among them): ' + payload.length);
  const controls = w.blocks.filter((b) => b.e.op.t !== 'append');
  assert.equal(controls.length, 3, 'the genesis policy and both tombstones');
  const recent = w.blocks.find((b) => b.h === posts[225].h);
  assert.equal(recent.v, undefined, 'a tombstoned value is not republished');
  assert.equal(JSON.stringify(rec.entries).includes('"p226"'), false);
  assert.equal(rec.checkpoint, null);
  await assert.rejects(buildRecentSnapshot({ blocks, posts: 201 }), /--posts/);
  await assert.rejects(buildRecentSnapshot({ blocks, maxBytes: 100 }), /more than/);
});

test('buildRecentSnapshot with a checkpoint in effect: S stands for the covered blocks; the window loads into a follower', async () => {
  const { buildRecentSnapshot } = await import('../../tools/snapshot.mjs');
  const { loadRecentSnapshot, viewOf } = await import('../../src/chain/recent.js');
  const { checkpointFor } = await import('../../src/chain/state.js');
  const { loadLedger } = await import('../../tools/ledger-admin.mjs');
  const l = await newLedger();
  let blocks = [l.genesis];
  let prev = [l.genesis.h];
  for (let i = 1; i <= 40; i++) {
    const b = await post(l.guest, l, prev, i, { msg: 'p' + i });
    blocks.push(b);
    prev = [b.h];
  }
  const led = await loadLedger(blocks);
  const made = checkpointFor(led.dag, prev, { genesisOwner: l.owner.pub });
  const withCp = await appendControl({ blocks, identity: l.owner, op: { t: 'checkpoint', heads: made.heads, snap: made.snap, n: made.n, bytes: made.bytes }, now: T + 100 * 60000 });
  blocks = withCp.blocks;
  prev = [withCp.block.h];
  for (let i = 41; i <= 45; i++) {
    const b = await post(l.guest, l, prev, i, { msg: 'p' + i });
    blocks.push(b);
    prev = [b.h];
  }
  const rec = await buildRecentSnapshot({ blocks });
  assert.equal(rec.checkpoint.snap, made.snap);
  assert.equal(rec.height, 6, 'the checkpoint block and the five posts after it');
  const file = JSON.parse(encodeSnapshot(rec.entries, { plain: true }).toString('utf8'));
  const follower = await ChainNode.open({ siteId: l.ledgerId, expectedOwner: l.owner.pub, genesisHash: l.genesis.h, store: new MemoryBlockStore(), config: { tickMs: 0 } });
  try {
    await loadRecentSnapshot(follower, file);
    const d = viewOf(follower).state();
    assert.equal(d.complete, true);
    assert.equal(d.checkpoint.snap, made.snap);
    assert.equal(d.snapshot.lists.guestbook.length, 45, 'every post, the 40 covered ones from S');
  } finally {
    await follower.close();
  }
});

test('command line --recent-out: written with or without --out; the loader\'s reader takes it', async () => {
  const { parseRecentSnapshot } = await import('../../src/chain/recent.js');
  const l = await newLedger();
  const blocks = [l.genesis];
  let prev = [l.genesis.h];
  for (let i = 1; i <= 12; i++) {
    const b = await post(l.guest, l, prev, i, { msg: 'p' + i });
    blocks.push(b);
    prev = [b.h];
  }
  const input = join(work, 'export-recent.json');
  writeFileSync(input, JSON.stringify(blocks));
  const run = (...args) => spawnSync(process.execPath, ['tools/snapshot.mjs', ...args], { cwd: ROOT, encoding: 'utf8' });
  const full = join(work, 'full.json.gz');
  const recentFile = join(work, 'recent.json.gz');
  const both = run(input, '--out', full, '--recent-out', recentFile, '--posts', '5');
  assert.equal(both.status, 0, both.stderr);
  assert.match(both.stdout, /recent   6 blocks/, "five posts and the genesis policy");
  assert.equal(readBlocksFile(full).length, 13);
  const bytes = readFileSync(recentFile);
  const entries = await readSnapshot({
    url: 'https://example.com/recent.json.gz',
    fetch: async () => ({ ok: true, status: 200, headers: { get: () => null }, arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) }),
    maxBytes: 1 << 24,
    maxInflatedBytes: 1 << 25,
  });
  const w = parseRecentSnapshot(entries);
  assert.equal(w.blocks.filter((b) => b.e.op.t === 'append').length, 5);
  const only = join(work, 'recent-only.json');
  const r2 = run(input, '--recent-out', only, '--plain', '--quiet');
  assert.equal(r2.status, 0, r2.stderr);
  assert.equal(JSON.parse(readFileSync(only, 'utf8'))[0].mw, 'recent-v1');
  assert.equal(run(input, '--recent-out', only, '--posts', '0').status, 1);
});

// Code review v0.3 (MF-24 to MF-26): copies prune to the owner's checkpoint, so a cs= file of a pruned copy carries S first.
test('a pruned copy\'s export (checkpoint first): buildSnapshot writes the header and the blocks after it; a visitor imports it; loadLedger reads it', async () => {
  const { checkpointFor } = await import('../../src/chain/state.js');
  const { loadLedger } = await import('../../tools/ledger-admin.mjs');
  const l = await newLedger();
  let blocks = [l.genesis];
  let prev = [l.genesis.h];
  for (let i = 1; i <= 20; i++) {
    const b = await post(l.guest, l, prev, i, { msg: 'p' + i });
    blocks.push(b);
    prev = [b.h];
  }
  const led = await loadLedger(blocks);
  const made = checkpointFor(led.dag, prev, { genesisOwner: l.owner.pub });
  const withCp = await appendControl({ blocks, identity: l.owner, op: { t: 'checkpoint', heads: made.heads, snap: made.snap, n: made.n, bytes: made.bytes }, now: T + 100 * 60000 });
  blocks = withCp.blocks.concat([await post(l.guest, l, [withCp.block.h], 21, { msg: 'p21' })]);
  // The pinned copy prunes on its tick and exports S with the blocks after it.
  const pinned = await ChainNode.open({ siteId: l.ledgerId, expectedOwner: l.owner.pub, genesisHash: l.genesis.h, store: new MemoryBlockStore(), config: { tickMs: 0 } });
  const visitor = await ChainNode.open({ siteId: l.ledgerId, expectedOwner: l.owner.pub, genesisHash: l.genesis.h, store: new MemoryBlockStore(), config: { tickMs: 0 } });
  try {
    await pinned.importSnapshot(blocks);
    await pinned.tick();
    assert.equal(pinned.dag.coveredCount, made.n);
    const exported = JSON.parse(JSON.stringify(pinned.exportSnapshot()));
    assert.equal(exported[0].mw, 'checkpoint-v1');
    const snap = await buildSnapshot({ blocks: exported });
    assert.equal(snap.checkpoint.snap, made.snap);
    assert.equal(snap.height, 2, 'the checkpoint block and the post after it');
    assert.equal(snap.entries[0].mw, 'checkpoint-v1');
    assert.equal(snap.entries[0].ledger, l.ledgerId);
    const file = JSON.parse(gunzipSync(encodeSnapshot(snap.entries)).toString('utf8'));
    const r = await visitor.importSnapshot(file);
    assert.equal(r.rejected, 0);
    assert.equal(visitor.dag.coveredCount, made.n);
    assert.equal(visitor.snapshot().lists.guestbook.length, 21, 'the 20 covered posts from S and the one after');
    // The same through readBlocksFile and loadLedger: the genesis owner comes from S.
    const path = join(work, 'pruned.json');
    writeFileSync(path, JSON.stringify(exported));
    const back = await loadLedger(readBlocksFile(path));
    assert.equal(back.genesisOwner, l.owner.pub);
    assert.equal(back.checkpoint.snap, made.snap);
    assert.deepEqual(back.invalid, []);
    assert.equal(back.state.lists.get('guestbook').length, 21);
    // A header whose S does not match its block is refused.
    const bad = JSON.parse(JSON.stringify(exported));
    bad[0].checkpoint.S.state.kv.push(['x', { v: 1, author: l.owner.pub, h: 'cd'.repeat(32), ts: 0 }]);
    await assert.rejects(loadLedger(bad), /does not match/);
  } finally {
    await pinned.close();
    await visitor.close();
  }
});
