// Unit tests for the v0.3 pin node (tools/pin.mjs; V03-DESIGN-REVIEW 2.7.5 item 7, 2.8.6; MF-46, MF-50): the mailbox with the chat holder
// quotas on a fake clock and saved on disk, the moderator queue that shows five fields and opens nothing, pinned files on disk, and
// --quarantine (moves, stops seeding, logs). No browser is started; the page side is a fake.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, existsSync, rmSync, statSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';

import {
  PinStore, Mailbox, FilePins, createPinHost, attachPinBridge, normalizeRequest, PIN_LIMITS, pinStatsLine, statusLine, pageSeeder, runModeration, pinCapacity, parsePinArgs,
} from '../../tools/pin.mjs';
import { ToolError, UsageError, ROOT } from '../../tools/lib.mjs';
import { makePinRequest } from '../../src/pin/frames.js';
import { generateKeyPair, exportPublicKey, publicKeyBytes } from '../../src/chain/crypto.js';
import { b64url } from '../../src/chain/canonical.js';
import { T, encode, envBody, decode, frameId, withNonce } from '../../src/chat/frames.js';
import { generateChatKey } from '../../src/chat/seal.js';
import { inboxTag } from '../../src/chat/tags.js';
import { headerDay, utcDay, stampWork } from '../../src/chat/stamp.js';
import { inboxProof } from '../../src/chat/holder.js';
import { FLAG_HOLD, FLAG_STRANGER, DAY_MS, HOLD_PER_TAG, HOLD_TTL_MS } from '../../src/chat/limits.js';

const work = mkdtempSync(join(tmpdir(), 'mw-v03-pin-'));
after(() => rmSync(work, { recursive: true, force: true }));
let n = 0;
const profile = () => join(work, 'profile-' + ++n);
const T0 = 20381 * DAY_MS + 12 * 3600000;
const isPosix = process.platform !== 'win32';
const mode = (p) => statSync(p).mode & 0o777;

// ---------------------------------------------------------------------------------------------- helpers

let EPK;
async function frame(tag, { flags = FLAG_HOLD, ct = 272, nonce = null } = {}) {
  if (!EPK) EPK = publicKeyBytes((await generateChatKey()).pub);
  const c = new Uint8Array(ct);
  globalThis.crypto.getRandomValues(c);
  let f = encode(T.ENV, { day: headerDay(T0), flags }, envBody({ tag, epk: EPK, iv: new Uint8Array(12), ct: c }));
  if (nonce) f = withNonce(f, nonce);
  return f;
}
const tagOf = (k) => Uint8Array.of(k & 255, (k >> 8) & 255, 3, 4, 5, 6, 7, 8);
function nonceWithWork(f, pred) {
  for (let i = 0; i < 1 << 16; i++) {
    const nonce = new Uint8Array(8);
    new DataView(nonce.buffer).setUint32(4, i);
    if (pred(stampWork(frameId(f), nonce))) return nonce;
  }
  throw new Error('no nonce');
}
async function author() {
  const { publicKey } = await generateKeyPair({ extractable: false });
  return exportPublicKey(publicKey);
}
// A member's key and its signed file pin request (code review v0.3: the host takes only requests their author signed).
const PIN_LEDGER = 'mw1:pinV03TestLedgerAbcdefghij';
async function member() {
  const kp = await generateKeyPair({ extractable: false });
  return { pub: await exportPublicKey(kp.publicKey), privateKey: kp.privateKey };
}
const signedReq = (key, fields, at) => makePinRequest(Object.assign({ site: PIN_LEDGER, author: key.pub, at }, fields), key.privateKey);
const IH = (k) => String(k).padStart(2, '0').repeat(20).slice(0, 40);
const sha256hex = (bytes) => createHash('sha256').update(bytes).digest('hex');

class FakeSeeder {
  constructor(onStop = null) {
    this.started = [];
    this.stopped = [];
    this.onStop = onStop;
  }

  async start(meta) {
    this.started.push(meta.ih);
    return 'ok';
  }

  async stop(ih) {
    if (this.onStop) this.onStop(ih);
    this.stopped.push(ih);
    return 'ok';
  }
}

// ---------------------------------------------------------------------------------------------- the mailbox

test('mailbox: holds only frames the sender flagged; the pin mailbox (unlike a peer holder) also holds stranger mail', async () => {
  const mb = new Mailbox({ now: () => T0 });
  const live = await frame(tagOf(1), { flags: 0 });
  assert.deepEqual(mb.offer(live, 'w1'), { held: false, reason: 'not-flagged' });
  const flagged = await frame(tagOf(2));
  const r = mb.offer(flagged, 'w1');
  assert.equal(r.held, true);
  assert.deepEqual(r.holding.frameId, frameId(flagged));
  const stranger = await frame(tagOf(3), { flags: FLAG_HOLD | FLAG_STRANGER });
  assert.equal(mb.offer(stranger, 'w1').held, true, 'the pin mailbox holds stranger mail');
  assert.equal(mb.offer(flagged, 'w2').reason, 'duplicate');
  assert.equal(mb.stats().count, 2);
  const peer = new Mailbox({ now: () => T0, pinMailbox: false });
  assert.equal(peer.offer(stranger, 'w1').reason, 'stranger-mail', 'a peer holder refuses it');
  assert.equal(mb.offer(new Uint8Array([1, 2, 3]), 'w1').reason, 'malformed', 'bytes that are not a frame');
});

test('mailbox quotas on a fake clock: 7 days, 64 frames per tag, one source at most 1/8 of the store, eviction by stamp work', async () => {
  let now = T0;
  const mb = new Mailbox({ now: () => now });
  const a = await frame(tagOf(10));
  assert.equal(mb.offer(a, 'w').held, true);
  now = T0 + HOLD_TTL_MS - 1;
  mb.expire();
  assert.equal(mb.stats().count, 1, 'still held one millisecond before the seven days');
  now = T0 + HOLD_TTL_MS;
  mb.expire();
  assert.equal(mb.stats().count, 0, 'gone after seven days');
  // 64 per tag
  now = T0;
  let held = 0;
  for (let i = 0; i < HOLD_PER_TAG + 6; i++) {
    const f = await frame(tagOf(7));
    const g = withNonce(f, nonceWithWork(f, (w) => w === 0));
    if (mb.offer(g, 's' + (i % 16)).held) held++;
  }
  assert.equal(held, HOLD_PER_TAG);
  // a small store so the per-source share bites: 64 KiB, one source may use 8 KiB (7 frames of 1,139 bytes)
  const small = new Mailbox({ now: () => T0, quotas: { bytes: 65536 } });
  for (let i = 0; i < 7; i++) {
    const f = await frame(tagOf(100 + i), { ct: 1040 });
    assert.equal(small.offer(withNonce(f, nonceWithWork(f, (w) => w === 0)), 'flooder').held, true);
  }
  const f8 = await frame(tagOf(200), { ct: 1040 });
  assert.equal(small.offer(withNonce(f8, nonceWithWork(f8, (w) => w === 0)), 'flooder').reason, 'source-quota');
  assert.equal(small.offer(withNonce(f8, nonceWithWork(f8, (w) => w >= 4)), 'flooder').held, true, 'more stamp work replaces the weakest frame of that source');
  for (let i = 0; i < 7; i++) assert.equal(small.offer(await frame(tagOf(300 + i), { ct: 1040 }), 'honest' + i).held, true, 'other sources keep their share');
  assert.ok(small.stats().bytes <= 65536);
  assert.ok(small.holder.bySource.get('flooder') <= 8192);
});

test('mailbox on disk: saved with mode 0600, restored after a restart in arrival order, and the seven days run from the first arrival', async () => {
  const dir = profile();
  let now = T0;
  const store = new PinStore({ profileDir: dir, now: () => now });
  const a = new Mailbox({ store, now: () => now });
  const early = await frame(tagOf(21));
  const stranger = await frame(tagOf(22), { flags: FLAG_HOLD | FLAG_STRANGER });
  a.offer(early, 'wire-1');
  now = T0 + 3 * DAY_MS;
  a.offer(stranger, 'wire-2');
  assert.equal(a.save(), true);
  assert.equal(a.save(), false, 'nothing changed since the save');
  const file = store.path('mailbox.json');
  if (isPosix) assert.equal(mode(file), 0o600);
  const saved = JSON.parse(readFileSync(file, 'utf8'));
  assert.equal(saved.items.length, 2);
  assert.deepEqual(saved.items.map((i) => i.at), [T0, T0 + 3 * DAY_MS]);
  // a restart four days later: both are restored with their original arrival times
  now = T0 + 4 * DAY_MS;
  const b = new Mailbox({ store: new PinStore({ profileDir: dir, now: () => now }), now: () => now });
  assert.equal(b.load(), 2);
  assert.equal(b.holder.has(frameId(early)), true);
  assert.equal(b.holder.has(frameId(stranger)), true);
  // the first frame was held at T0: it goes at T0 + 7 days, not at restart + 7 days
  now = T0 + 7 * DAY_MS;
  b.expire();
  assert.equal(b.holder.has(frameId(early)), false);
  assert.equal(b.holder.has(frameId(stranger)), true);
  assert.equal(b.save(), true);
  // a node that was down past the seven days restores nothing that expired
  now = T0 + 12 * DAY_MS;
  const c = new Mailbox({ store: new PinStore({ profileDir: dir, now: () => now }), now: () => now });
  assert.equal(c.load(), 0);
  // a damaged file is ignored, not fatal
  writeFileSync(file, '{ not json');
  assert.equal(new Mailbox({ store, now: () => now }).load(), 0);
});

test('mailbox: stranger mail is released only to a collector that proves it holds the chat key (INBOX-CHAL / INBOX-RESP); COLLECTED deletes', async () => {
  const mb = new Mailbox({ now: () => T0 });
  const bob = await generateChatKey();
  const eve = await generateChatKey();
  const day = utcDay(T0);
  const mail = await frame(await inboxTag(bob.pub, day), { flags: FLAG_HOLD | FLAG_STRANGER });
  assert.equal(mb.offer(mail, 'sender').held, true);
  assert.equal(mb.want([decode(mail).fields.tag], 'eve').length, 0, 'asking for the inbox tag gets nothing');
  const c1 = await mb.challenge('eve');
  assert.deepEqual(await mb.respond('eve', { ek: publicKeyBytes(eve.pub), proof: await inboxProof(eve, c1.hepk, c1.challenge) }), [], 'Eve proves her own key: no mail');
  const c2 = await mb.challenge('eve');
  assert.equal(await mb.respond('eve', { ek: publicKeyBytes(bob.pub), proof: await inboxProof(eve, c2.hepk, c2.challenge) }), null, "Bob's key with Eve's proof: refused");
  const c3 = await mb.challenge('bob');
  const mailOut = await mb.respond('bob', { ek: publicKeyBytes(bob.pub), proof: await inboxProof(bob, c3.hepk, c3.challenge) });
  assert.equal(mailOut.length, 1);
  assert.deepEqual(frameId(mailOut[0]), frameId(mail));
  assert.equal(mb.collected(frameId(mail), new Uint8Array(32), 'bob'), true);
  assert.equal(mb.stats().count, 0);
  assert.equal(mb.dirty, true, 'a collected frame marks the store for saving');
  assert.equal(await new Mailbox({ pinMailbox: false }).challenge('x'), null);
});

// ---------------------------------------------------------------------------------------------- the moderator queue

test('a request is reduced to five fields: infohash, name, size, author key, declared hash; the name is made safe and nothing else is kept', async () => {
  const who = await author();
  const ok = normalizeRequest({
    ih: IH(7).toUpperCase(), name: 'inv\u202eoice_\u0000exe.pdf', size: 1234, author: who, sha256: 'AB'.repeat(32),
    html: '<script>alert(1)</script>', thumbnail: 'data:image/png;base64,AAAA', url: 'https://evil.example', mime: 'text/html',
  });
  assert.equal(ok.ok, true);
  assert.deepEqual(Object.keys(ok.value).sort(), ['author', 'ih', 'name', 'sha256', 'size']);
  assert.equal(ok.value.ih, IH(7));
  assert.equal(ok.value.sha256, 'ab'.repeat(32));
  assert.equal(ok.value.name.includes('\u202e') || ok.value.name.includes('\u0000'), false, 'bidi and control characters are stripped');
  assert.equal(normalizeRequest({ ih: IH(7), size: 5, author: who }).value.sha256, null, 'a private file declares no hash');
  assert.equal(normalizeRequest({ ih: IH(7), size: 5, author: who }).value.name, '', 'a media request has no name');
  for (const [entry, reason] of [
    [null, 'bad-entry'], [[], 'bad-entry'], [{ ih: 'xyz', size: 5, author: who }, 'bad-infohash'], [{ ih: IH(1), size: 0, author: who }, 'bad-size'],
    [{ ih: IH(1), size: 1.5, author: who }, 'bad-size'], [{ ih: IH(1), size: PIN_LIMITS.maxFileBytes + 1, author: who }, 'too-large'],
    [{ ih: IH(1), size: 5, author: 'someone' }, 'bad-author'], [{ ih: IH(1), size: 5, author: who, sha256: 'nope' }, 'bad-hash'],
  ]) {
    assert.deepEqual(normalizeRequest(entry), { ok: false, reason }, reason);
  }
});

test('the queue shows name, size, author key and declared hash only; duplicates, a full queue and one author flooding are refused', async () => {
  const store = new PinStore({ profileDir: profile() });
  const files = new FilePins({ store, limits: { maxPending: 5, maxPendingPerAuthor: 2 } });
  const a = await author();
  const b = await author();
  assert.deepEqual(files.request({ ih: IH(1), name: 'one.bin', size: 10, author: a, sha256: '11'.repeat(32), secretField: 'x' }), { queued: true });
  const shown = files.queue();
  assert.equal(shown.length, 1);
  assert.deepEqual(Object.keys(shown[0]).sort(), ['author', 'ih', 'name', 'requestedAt', 'sha256', 'size']);
  const onDisk = JSON.parse(readFileSync(store.path('files', 'queue', IH(1) + '.json'), 'utf8'));
  assert.deepEqual(Object.keys(onDisk).sort(), ['author', 'ih', 'name', 'requestedAt', 'sha256', 'size'], 'the stored record holds nothing more');
  assert.equal(files.request({ ih: IH(1), size: 10, author: a }).reason, 'duplicate');
  assert.deepEqual(files.request({ ih: IH(2), size: 10, author: a }), { queued: true });
  assert.equal(files.request({ ih: IH(3), size: 10, author: a }).reason, 'author-limit', 'one author may have 2 waiting');
  for (const k of [4, 5, 6]) assert.deepEqual(files.request({ ih: IH(k), size: 10, author: b === a ? a : (k === 6 ? await author() : b) }).queued !== undefined, true);
  assert.equal(files.queue().length <= 5, true);
  const full = new FilePins({ store: new PinStore({ profileDir: profile() }), limits: { maxPending: 3, maxPendingPerAuthor: 10 } });
  for (const k of [1, 2, 3]) assert.equal(full.request({ ih: IH(k), size: 1, author: a }).queued, true);
  assert.equal(full.request({ ih: IH(4), size: 1, author: a }).reason, 'queue-full');
  if (isPosix) assert.equal(mode(store.path('files', 'queue', IH(1) + '.json')), 0o600);
});

test('pinning is a moderator action: nothing is fetched until accept; accept asks the seeder, decline waits 7 days, deny is for good', async () => {
  let now = T0;
  const seeder = new FakeSeeder();
  const store = new PinStore({ profileDir: profile(), now: () => now });
  const files = new FilePins({ store, seeder, now: () => now });
  const a = await author();
  for (const k of [1, 2, 3]) files.request({ ih: IH(k), name: 'f' + k, size: 100, author: a });
  assert.deepEqual(seeder.started, [], 'a request starts nothing');
  assert.deepEqual(files.pinned(), []);
  const accepted = await files.decide(IH(1), 'accept', { by: 'ana' });
  assert.equal(accepted.pinned, true);
  assert.equal(accepted.seeding, true);
  assert.deepEqual(seeder.started, [IH(1)]);
  assert.equal(accepted.meta.state, 'pinned');
  assert.equal(accepted.meta.approvedBy, 'ana');
  assert.deepEqual(files.queue().map((q) => q.ih), [IH(2), IH(3)]);
  assert.equal(files.request({ ih: IH(1), size: 100, author: a }).reason, 'already-pinned');
  // decline: refused for 7 days, then asked again
  await files.decide(IH(2), 'decline');
  assert.equal(files.request({ ih: IH(2), size: 100, author: a }).reason, 'declined');
  now += 7 * DAY_MS + 1;
  assert.equal(files.request({ ih: IH(2), size: 100, author: a }).queued, true);
  await files.decide(IH(3), 'deny');
  now += 3650 * DAY_MS;
  assert.equal(files.request({ ih: IH(3), size: 100, author: a }).reason, 'declined', 'deny does not expire');
  await assert.rejects(files.decide(IH(9), 'accept'), (e) => e.code === 'E_NOT_QUEUED');
  await assert.rejects(files.decide(IH(2), 'maybe'), (e) => e.code === 'E_BAD_REQUEST');
  await assert.rejects(files.decide('../etc', 'accept'), (e) => e.code === 'E_BAD_REQUEST');
  // the total cap
  const tiny = new FilePins({ store: new PinStore({ profileDir: profile() }), limits: { maxTotalBytes: 150 } });
  tiny.request({ ih: IH(1), size: 100, author: a });
  tiny.request({ ih: IH(2), size: 100, author: a });
  await tiny.decide(IH(1), 'accept');
  await assert.rejects(tiny.decide(IH(2), 'accept'), (e) => e.code === 'E_PIN_FULL');
  assert.equal(tiny.queue().length, 1, 'a refused approval leaves the request waiting');
  // a seeder that fails does not undo the pin
  const failing = new FilePins({ store: new PinStore({ profileDir: profile() }), seeder: { start: async () => { throw new Error('no page'); }, stop: async () => {} } });
  failing.request({ ih: IH(5), size: 10, author: a });
  const r = await failing.decide(IH(5), 'accept');
  assert.equal(r.pinned, true);
  assert.equal(r.seeding, false);
  assert.ok(failing.store.readLog().some((l) => l.action === 'seed-failed' && /no page/.test(l.error)));
});

test('pinned files live on disk: chunks land in data.part, finish checks length and the declared hash, a wrong hash deletes the bytes', async () => {
  const store = new PinStore({ profileDir: profile() });
  const files = new FilePins({ store, limits: { chunkMax: 8 } });
  const a = await author();
  const bytes = Buffer.from('the quick brown fox jumps over the lazy dog');
  files.request({ ih: IH(1), name: 'fox.txt', size: bytes.length, author: a, sha256: sha256hex(bytes) });
  files.request({ ih: IH(2), name: 'lie.txt', size: bytes.length, author: a, sha256: '00'.repeat(32) });
  await files.decide(IH(1), 'accept');
  await files.decide(IH(2), 'accept');
  assert.throws(() => files.writeChunk(IH(9), 0, Buffer.from('x')), (e) => e.code === 'E_NOT_PINNED');
  assert.throws(() => files.writeChunk(IH(1), 0, Buffer.alloc(9)), (e) => e.code === 'E_RANGE', 'a chunk is bounded');
  assert.throws(() => files.writeChunk(IH(1), bytes.length - 2, Buffer.from('abc')), (e) => e.code === 'E_RANGE', 'not past the declared size');
  assert.throws(() => files.writeChunk(IH(1), -1, Buffer.from('a')), (e) => e.code === 'E_RANGE');
  assert.throws(() => files.finish(IH(1)), (e) => e.code === 'E_INCOMPLETE');
  // out-of-order chunks
  const order = [];
  for (let off = 0; off < bytes.length; off += 8) order.push(off);
  for (const off of order.reverse()) files.writeChunk(IH(1), off, bytes.subarray(off, off + 8));
  const done = files.finish(IH(1));
  assert.deepEqual(done, { complete: true, sha256: sha256hex(bytes) });
  assert.equal(files.pinned().find((m) => m.ih === IH(1)).state, 'complete');
  assert.equal(readFileSync(store.path('files', 'pinned', IH(1), 'data'), 'utf8'), bytes.toString());
  if (isPosix) assert.equal(mode(store.path('files', 'pinned', IH(1), 'data')), 0o600);
  assert.throws(() => files.writeChunk(IH(1), 0, Buffer.from('x')), (e) => e.code === 'E_COMPLETE');
  assert.equal(files.readChunk(IH(1), 4, 5).toString(), 'quick');
  assert.equal(files.readChunk(IH(1), bytes.length - 3, 8).toString(), 'dog', 'a read stops at the end');
  assert.throws(() => files.readChunk(IH(1), bytes.length, 4), (e) => e.code === 'E_RANGE');
  assert.throws(() => files.readChunk(IH(2), 0, 4), (e) => e.code === 'E_NOT_PINNED', 'not complete');
  // declared hash that does not match
  for (let off = 0; off < bytes.length; off += 8) files.writeChunk(IH(2), off, bytes.subarray(off, off + 8));
  assert.throws(() => files.finish(IH(2)), (e) => e.code === 'E_FILE_HASH');
  assert.equal(existsSync(store.path('files', 'pinned', IH(2), 'data.part')), false, 'the bytes are deleted');
  assert.ok(store.readLog().some((l) => l.action === 'hash-mismatch' && l.ih === IH(2)));
});

test('quarantine: stops seeding first, then moves the folder to an isolated directory, strips the execute bit, and logs the action', async () => {
  let now = T0;
  const store = new PinStore({ profileDir: profile(), now: () => now });
  const seen = {};
  const seeder = new FakeSeeder((ih) => { seen.pinnedStillThere = existsSync(store.path('files', 'pinned', ih)); });
  const files = new FilePins({ store, seeder, now: () => now });
  const a = await author();
  const bytes = Buffer.from('#!/bin/sh\necho not a file anyone should run\n');
  files.request({ ih: IH(4), name: 'installer.sh', size: bytes.length, author: a, sha256: sha256hex(bytes) });
  await files.decide(IH(4), 'accept');
  files.writeChunk(IH(4), 0, bytes);
  files.finish(IH(4));
  now += 5000;
  const r = await files.quarantine(IH(4), { reason: 'reported as malware (scan 3)', by: 'ana' });
  assert.equal(r.stopped, true);
  assert.deepEqual(seeder.stopped, [IH(4)], 'seeding was stopped');
  assert.equal(seen.pinnedStillThere, true, 'seeding stops before the folder moves');
  assert.equal(existsSync(store.path('files', 'pinned', IH(4))), false, 'it is no longer in the pinned store');
  assert.deepEqual(files.pinned(), []);
  const q = store.path('quarantine', IH(4));
  assert.equal(r.to, q);
  assert.deepEqual(readdirSync(q).sort(), ['QUARANTINED.json', 'data.quarantined', 'meta.json']);
  assert.equal(readFileSync(join(q, 'data.quarantined'), 'utf8'), bytes.toString(), 'the bytes moved, untouched');
  if (isPosix) {
    assert.equal(mode(q), 0o700);
    assert.equal(mode(join(q, 'data.quarantined')) & 0o111, 0, 'no execute bit');
    assert.equal(mode(join(q, 'data.quarantined')), 0o600);
  }
  const record = JSON.parse(readFileSync(join(q, 'QUARANTINED.json'), 'utf8'));
  assert.equal(record.state, 'quarantined');
  assert.equal(record.reason, 'reported as malware (scan 3)');
  assert.equal(record.quarantinedBy, 'ana');
  assert.equal(record.stopped, true);
  assert.equal(record.quarantinedAt, now);
  assert.deepEqual(files.quarantined().map((m) => m.ih), [IH(4)]);
  const entry = store.readLog().filter((l) => l.action === 'quarantine').pop();
  assert.equal(entry.ih, IH(4));
  assert.equal(entry.stopped, true);
  assert.equal(entry.reason, 'reported as malware (scan 3)');
  assert.equal(entry.t, new Date(now).toISOString());
  // it cannot come back through the queue, and it is not seeded again after a restart
  assert.equal(files.request({ ih: IH(4), size: 5, author: a }).reason, 'quarantined');
  const restarted = new FilePins({ store, seeder: new FakeSeeder() });
  assert.equal(await restarted.restore(), 0);
  assert.deepEqual(restarted.seeder.started, []);
  await assert.rejects(files.quarantine(IH(4)), (e) => e instanceof ToolError && e.code === 'E_NOT_PINNED');
  await assert.rejects(files.quarantine('nonsense'), (e) => e.code === 'E_BAD_REQUEST');
  // a second file with the same infohash lands in its own folder; a stop that fails is logged and the move still happens
  files.request({ ih: IH(5), name: 'x', size: 3, author: a });
  await files.decide(IH(5), 'accept');
  files.seeder = { start: async () => {}, stop: async () => { throw new Error('page gone'); } };
  const second = await files.quarantine(IH(5));
  assert.equal(second.stopped, false);
  assert.equal(second.requested, true);
  assert.ok(store.readLog().some((l) => l.action === 'stop-failed' && /page gone/.test(l.error)));
  assert.equal(existsSync(store.path('quarantine', IH(5))), true);
});

test('quarantine without a running seeder leaves a stop note, and the running node carries it out (and a start restores what is still pinned)', async () => {
  const dir = profile();
  const a = await author();
  const offline = new FilePins({ store: new PinStore({ profileDir: dir }) });
  offline.request({ ih: IH(6), name: 'a', size: 5, author: a });
  offline.request({ ih: IH(7), name: 'b', size: 5, author: a });
  await offline.decide(IH(6), 'accept');
  await offline.decide(IH(7), 'accept');
  const r = await offline.quarantine(IH(6), { reason: 'operator' });
  assert.equal(r.stopped, false);
  assert.equal(r.requested, true);
  const notes = readdirSync(offline.store.path('control'));
  assert.equal(notes.length, 1);
  assert.match(notes[0], new RegExp('^\\d{15}-stop-' + IH(6) + '\\.json$'));
  // the running node: a new FilePins on the same directory with its seeder
  const seeder = new FakeSeeder();
  const running = new FilePins({ store: new PinStore({ profileDir: dir }), seeder });
  assert.equal(await running.processControl(), 1);
  assert.deepEqual(seeder.stopped, [IH(6)]);
  assert.deepEqual(readdirSync(running.store.path('control')), [], 'the note is removed');
  assert.equal(await running.restore(), 1, 'only the file that is still pinned is seeded again');
  assert.deepEqual(seeder.started, [IH(7)]);
  // without a seeder a note stays for the next start
  const lonely = new FilePins({ store: new PinStore({ profileDir: profile() }) });
  lonely.requestStop(IH(8));
  assert.equal(await lonely.processControl(), 0);
  assert.equal(readdirSync(lonely.store.path('control')).length, 1);
});

// ---------------------------------------------------------------------------------------------- the host, the bridge, the command line

test('the host is the one door for the page: binary as base64url, features that are off refuse, unknown operations are errors', async () => {
  const dir = profile();
  const off = createPinHost({ profileDir: dir });
  await assert.rejects(off.call('file.request', { ih: IH(1) }), /without --files/);
  await assert.rejects(off.call('mailbox.offer', { frame: 'AA', wire: 'w' }), /without --mailbox/);
  await assert.rejects(off.call('shell.exec', {}), /unknown pin operation/);
  const host = createPinHost({ profileDir: profile(), mailbox: true, files: true, now: () => T0 });
  const a = await member();
  const req = await signedReq(a, { ih: IH(1), name: 'x', size: 4 }, T0);
  assert.deepEqual(await host.call('file.request', req), { queued: false, reason: 'site-unknown' }, 'the ledger a request is signed for comes from the page');
  await host.setSite({ ledgerId: PIN_LEDGER });
  assert.deepEqual(await host.call('file.request', { ih: IH(1), name: 'x', size: 4, author: a.pub }), { queued: false, reason: 'unsigned' });
  assert.deepEqual(await host.call('file.request', req), { queued: true });
  assert.equal((await host.call('file.request', { ih: 'zz', size: 4, author: a.pub })).reason, 'bad-infohash');
  await host.files.decide(IH(1), 'accept');
  assert.deepEqual(await host.call('file.write', { ih: IH(1), offset: 0, data: b64url.encode(Buffer.from('abcd')) }), { written: 4 });
  assert.equal((await host.call('file.finish', { ih: IH(1) })).complete, true);
  assert.equal(Buffer.from(b64url.decode((await host.call('file.read', { ih: IH(1), offset: 1, length: 2 })).data)).toString(), 'bc');
  assert.deepEqual(await host.call('file.pinned', {}), [{ ih: IH(1), name: 'x', size: 4, state: 'complete' }]);
  await assert.rejects(host.call('file.request', 'not an object'), /object/);
  const f = await frame(tagOf(50));
  const held = await host.call('mailbox.offer', { frame: b64url.encode(f), wire: 'w1' });
  assert.equal(held.held, true);
  assert.equal(held.holding.frameId, b64url.encode(frameId(f)));
  assert.equal(held.holding.expiry, Math.floor((T0 + HOLD_TTL_MS) / 1000));
  assert.equal((await host.call('mailbox.offer', { frame: b64url.encode(f), wire: 'w2' })).reason, 'duplicate');
  const got = await host.call('mailbox.want', { entries: [b64url.encode(Uint8Array.of(50))], wire: 'c1' });
  assert.equal(got.frames.length, 1);
  await assert.rejects(host.call('mailbox.want', { entries: new Array(33).fill('AA'), wire: 'c' }), /at most 32/);
  const bob = await generateChatKey();
  const ch = await host.call('mailbox.challenge', { wire: 'bob' });
  assert.equal(b64url.decode(ch.hepk).length, 65);
  const proof = await inboxProof(bob, b64url.decode(ch.hepk), b64url.decode(ch.challenge));
  const resp = await host.call('mailbox.respond', { wire: 'bob', ek: b64url.encode(publicKeyBytes(bob.pub)), proof: b64url.encode(proof) });
  assert.deepEqual(resp, { frames: [] }, 'a proven collector with no stranger mail gets an empty answer');
  assert.deepEqual(await host.call('mailbox.respond', { wire: 'nobody', ek: 'AA', proof: 'AA' }).catch(() => null), null);
  const stats = await host.call('stats', {});
  assert.equal(stats.mailbox.count, 1);
  assert.equal(stats.pinned, 1);
  assert.match(pinStatsLine(stats), /mailbox 1 frame\(s\).*files: 0 waiting, 1 pinned/);
  assert.equal(pinStatsLine({ mailbox: null, queue: null }), '');
  await host.tick();
  assert.equal(existsSync(host.store.path('mailbox.json')), true, 'tick saves the mailbox');
  // a restart reads the same stores back
  const again = createPinHost({ profileDir: host.store.profileDir, mailbox: true, files: true, now: () => T0 + 1000, seeder: new FakeSeeder() });
  await again.start();
  assert.equal(again.mailbox.stats().count, 1);
  assert.deepEqual(again.files.seeder.started, [IH(1)]);
  assert.match(statusLine({ status: 'Sharing' }, { restarts: 0, now: new Date(Date.UTC(2026, 9, 20, 12, 0, 0)), extra: 'mailbox 1 frame(s)' }), /^12:00:00 Sharing \| mailbox 1 frame\(s\)$/);
});

test('the bridge answers the binding of the pinned page\'s top frame only (no boundary: requests need their author\'s signature); the page seeder talks to window.__mwPinHost', async () => {
  const host = createPinHost({ profileDir: profile(), files: true });
  await host.setSite({ ledgerId: PIN_LEDGER });
  let binding = null;
  const page = { mainFrame: () => 'top' };
  await attachPinBridge({ exposeBinding: async (name, fn) => { binding = { name, fn }; } }, host, { page });
  assert.equal(binding.name, '__mwPinCall');
  const a = await member();
  assert.deepEqual(await binding.fn({ page, frame: 'top' }, 'file.request', await signedReq(a, { ih: IH(1), size: 3 }, Date.now())), { queued: true });
  await assert.rejects(binding.fn({ page, frame: 'child' }, 'file.request', await signedReq(a, { ih: IH(2), size: 3 }, Date.now())), /top frame/);
  await assert.rejects(binding.fn({ page: {}, frame: 'top' }, 'file.request', await signedReq(a, { ih: IH(2), size: 3 }, Date.now())), /top frame/);
  assert.equal(host.files.queue().length, 1);
  const calls = [];
  const fakePage = { evaluate: async (fn, args) => { calls.push(args); return 'ok'; } };
  const logged = [];
  const seeder = pageSeeder(() => fakePage, (l) => logged.push(l));
  assert.equal(await seeder.start({ ih: IH(1), name: 'n', size: 3, state: 'pinned' }), 'ok');
  assert.equal(await seeder.stop(IH(1)), 'ok');
  assert.deepEqual(calls.map((c) => c[0]), ['start', 'stop']);
  assert.equal(await pageSeeder(() => null).stop(IH(1)), 'no-page');
  const noHost = pageSeeder(() => ({ evaluate: async () => 'no-host' }), (l) => logged.push(l));
  await noHost.stop(IH(3));
  assert.ok(logged.some((l) => /no pin host/.test(l)));
});

function cli(args) {
  return spawnSync(process.execPath, ['tools/pin.mjs', ...args], { cwd: ROOT, encoding: 'utf8' });
}

test('command line: --queue, --approve, --decline, --pinned, --quarantine and --quarantined work on a profile with no browser; usage errors exit 2', async () => {
  const dir = profile();
  const a = await author();
  const host = createPinHost({ profileDir: dir, files: true });
  host.files.request({ ih: IH(1), name: 'one.pdf', size: 2048, author: a, sha256: 'cd'.repeat(32) });
  host.files.request({ ih: IH(2), name: 'two.png', size: 99, author: a });
  host.files.request({ ih: IH(3), name: 'three.zip', size: 7, author: a });
  const q = cli(['--queue', '--profile', dir]);
  assert.equal(q.status, 0, q.stderr);
  assert.match(q.stdout, /Waiting for a moderator \(name, size, author key, declared hash; nothing else is known, nothing is opened\)/);
  assert.match(q.stdout, new RegExp(IH(1) + ' +2\\.0 KiB +p256:[A-Za-z0-9_-]{9}\\.\\.\\. +sha256 cdcdcdcdcdcdcdcd\\.\\.\\. +"one\\.pdf"'));
  assert.match(q.stdout, /no declared hash +"two\.png"/);
  const ap = cli(['--approve', IH(1), '--profile', dir, '--by', 'ana']);
  assert.equal(ap.status, 0, ap.stderr);
  assert.match(ap.stdout, /pinned [0-9a-f]{40} \(2\.0 KiB, "one\.pdf"\).*it was not opened/);
  const dc = cli(['--decline', IH(2), '--profile', dir]);
  assert.equal(dc.status, 0, dc.stderr);
  assert.match(dc.stdout, /declined .* not asked again for 7 days/);
  const pinned = cli(['--pinned', '--profile', dir]);
  assert.match(pinned.stdout, new RegExp(IH(1) + ' +pinned'));
  const qr = cli(['--quarantine', IH(1), '--profile', dir, '--reason', 'reported', '--by', 'ana']);
  assert.equal(qr.status, 0, qr.stderr);
  assert.match(qr.stdout, /quarantined [0-9a-f]{40} -> .*quarantine.*a stop note is left for the running node/);
  assert.match(qr.stdout, /logged in .*log\.jsonl/);
  const list = cli(['--quarantined', '--profile', dir]);
  assert.match(list.stdout, new RegExp(IH(1) + ' .*"reported"'));
  assert.equal(cli(['--pinned', '--profile', dir]).stdout.trim(), 'no file is pinned');
  const log = readFileSync(join(dir, 'pin', 'log.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l)).map((l) => l.action);
  assert.deepEqual(log, ['request', 'request', 'request', 'approve', 'decline', 'quarantine']);
  assert.equal(cli(['--quarantine', IH(9), '--profile', dir]).status, 1, 'not pinned');
  assert.equal(cli(['--queue']).status, 2, 'a profile is required');
  assert.equal(cli(['--queue', '--profile', dir, 'https://example.com/']).status, 2, 'no URL with the moderation commands');
  assert.equal(cli([]).status, 2);
  assert.equal(cli(['--approve', 'xyz', '--profile', dir]).status, 1);
  const help = cli(['--help']);
  for (const flag of ['--mailbox', '--files', '--queue', '--pinned', '--quarantined', '--approve', '--decline', '--quarantine', '--reason', '--by', '--profile', '--headless']) assert.ok(help.stdout.includes(flag), flag);
  assert.ok(typeof runModeration === 'function');
});

test('the stores are plain files with private permissions', async () => {
  if (!isPosix) return;
  const dir = profile();
  const host = createPinHost({ profileDir: dir, mailbox: true, files: true, now: () => T0 });
  host.mailbox.offer(await frame(tagOf(1)), 'w');
  await host.tick();
  host.store.log({ action: 'probe' });
  for (const sub of ['pin', 'pin/files', 'pin/files/queue', 'pin/files/pinned', 'pin/quarantine', 'pin/control']) assert.equal(mode(join(dir, sub)) & 0o077, 0, sub + ' is private');
  for (const f of ['pin/mailbox.json', 'pin/log.jsonl']) assert.equal(mode(join(dir, f)) & 0o077, 0, f + ' is private');
});

test('integrator (SCALE-9, SCALE-15): --max-total, --mailbox-bytes and --mailbox-source-fraction reach the stores', () => {
  const run = parsePinArgs(['http://127.0.0.1:9/', '--files', '--mailbox', '--max-total', '20GiB', '--mailbox-bytes', '64MiB', '--mailbox-source-fraction', '8']);
  assert.equal(run.options.limits.maxTotalBytes, 20 * 1024 ** 3);
  assert.deepEqual(run.options.quotas, { bytes: 64 * 1024 ** 2, sourceFraction: 8 });
  assert.throws(() => parsePinArgs(['http://127.0.0.1:9/', '--max-total', 'lots']), UsageError);
  assert.deepEqual(pinCapacity({}), { limits: {}, quotas: {} });
  const dir = mkdtempSync(join(tmpdir(), 'mw-pin-cap-'));
  try {
    const host = createPinHost({ profileDir: dir, files: true, mailbox: true, limits: run.options.limits, quotas: run.options.quotas });
    assert.equal(host.files.limits.maxTotalBytes, 20 * 1024 ** 3, 'more than the 2 GiB default');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('review round MAL53-3: decide() and restore() quarantine an item the site ledger denies (_deny/), by infohash, declared hash or the page host', async () => {
  const a = await author();
  const denied = new Set();
  const isDenied = async (id) => denied.has(id);
  const seeder = new FakeSeeder();
  const store = new PinStore({ profileDir: profile() });
  const files = new FilePins({ store, seeder, isDenied, limits: { maxTotalBytes: 150 } });
  const badHash = 'ee'.repeat(32);
  files.request({ ih: IH(1), name: 'denied-by-ih', size: 100, author: a });
  files.request({ ih: IH(2), name: 'denied-by-hash', size: 100, author: a, sha256: badHash });
  files.request({ ih: IH(3), name: 'fine', size: 100, author: a });
  denied.add(IH(1));
  denied.add(badHash);
  // decide('accept') of a denied item: no seeding, quarantined with a record, never pinned (and the size cap does not hide the deny)
  const d1 = await files.decide(IH(1), 'accept', { by: 'ana' });
  assert.equal(d1.pinned, false);
  assert.equal(d1.quarantined, true);
  assert.equal(d1.seeding, false);
  const d2 = await files.decide(IH(2), 'accept');
  assert.equal(d2.quarantined, true, 'a deny of the declared SHA-256 counts too');
  assert.deepEqual(seeder.started, [], 'no swarm was joined for a denied item');
  assert.deepEqual(files.pinned(), []);
  assert.deepEqual(files.quarantined().map((m) => m.ih).sort(), [IH(1), IH(2)]);
  assert.equal(files.quarantined()[0].quarantinedBy, '_deny/');
  assert.equal(files.request({ ih: IH(1), size: 100, author: a }).reason, 'quarantined', 'it cannot come back through the queue');
  assert.ok(store.readLog().some((l) => l.action === 'ledger-denied' && l.ih === IH(1)));
  // a fine item pins and seeds; a later _deny/ entry quarantines it at the next restore(), which seeds nothing for it
  const d3 = await files.decide(IH(3), 'accept');
  assert.equal(d3.pinned, true);
  assert.deepEqual(seeder.started, [IH(3)]);
  denied.add(IH(3));
  assert.equal(await files.restore(), 0);
  assert.deepEqual(seeder.started, [IH(3)], 'restore() started nothing');
  assert.equal(seeder.stopped[seeder.stopped.length - 1], IH(3), 'the quarantine stopped the seeding');
  assert.deepEqual(files.pinned(), []);
  assert.ok(files.quarantined().some((m) => m.ih === IH(3) && /_deny/.test(m.reason)));
  // restore() checks the deny list even while the month cap holds the pinned files
  const paused = new FilePins({ store: new PinStore({ profileDir: profile() }), seeder: new FakeSeeder(), isDenied, paused: () => true });
  paused.request({ ih: IH(4), name: 'p', size: 5, author: a });
  await paused.decide(IH(4), 'accept');
  assert.equal(paused.pinned().length, 1);
  denied.add(IH(4));
  assert.equal(await paused.restore(), 0);
  assert.deepEqual(paused.pinned(), []);
  assert.deepEqual(paused.quarantined().map((m) => m.ih), [IH(4)]);
  // without isDenied, the page host's answer is enough: a seeder whose start() says 'denied' quarantines at accept and at restore
  let pageDenies = new Set([IH(5)]);
  const page = { started: [], stopped: [], async start(meta) { if (pageDenies.has(meta.ih)) return 'denied'; this.started.push(meta.ih); return 'seeding'; }, async stop(ih) { this.stopped.push(ih); return 'not-held'; } };
  const viaPage = new FilePins({ store: new PinStore({ profileDir: profile() }), seeder: page });
  viaPage.request({ ih: IH(5), name: 'x', size: 5, author: a });
  viaPage.request({ ih: IH(6), name: 'y', size: 5, author: a });
  assert.equal((await viaPage.decide(IH(5), 'accept')).quarantined, true);
  assert.equal((await viaPage.decide(IH(6), 'accept')).pinned, true);
  pageDenies = new Set([IH(6)]);
  assert.equal(await viaPage.restore(), 0);
  assert.deepEqual(viaPage.pinned(), []);
  assert.deepEqual(viaPage.quarantined().map((m) => m.ih).sort(), [IH(5), IH(6)]);
  // a check that throws is not a deny
  const flaky = new FilePins({ store: new PinStore({ profileDir: profile() }), seeder: new FakeSeeder(), isDenied: async () => { throw new Error('ledger not open'); } });
  flaky.request({ ih: IH(7), name: 'z', size: 5, author: a });
  assert.equal((await flaky.decide(IH(7), 'accept')).pinned, true);
  // pageSeeder hands the declared hash to the page host, so it can check _deny/ by hash too
  let asked = null;
  const ps = pageSeeder(() => ({ evaluate: async (_fn, [m, arg]) => { asked = [m, arg]; return 'denied'; } }));
  assert.equal(await ps.start({ ih: IH(8), name: 'n', size: 1, state: 'complete', sha256: badHash, sha256Actual: badHash }), 'denied');
  assert.equal(asked[0], 'start');
  assert.equal(asked[1].sha256, badHash);
  assert.equal(asked[1].sha256Actual, badHash);
});
