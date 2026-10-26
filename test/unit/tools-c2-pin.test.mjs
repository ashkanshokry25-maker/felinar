// Unit tests for the v0.3 C2 pin node (tools/pin.mjs; SEEDING-AND-ZERO-SETUP-DESIGN 3.1.6, owner decision SZ-6): the new flags and
// their errors, --pin-key and its permissions and printout, the Node signer that refuses everything but mw_pin1 hello and receipt
// strings, the heartbeat file (content, hashed ids, mode 0644), auto-accept of the owner's requests with and without the flag, the
// month cap on a fake clock with fake page counters, the page report parser, and the E-PS-1 fixture (test/fixtures/pin) with a fake
// run. No browser is started.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, existsSync, rmSync, statSync, readdirSync, chmodSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';

import {
  parsePinArgs, parseByteSize, utcMonth, loadPinKey, pinKeyLines, createPinSigner, MonthMeter, writeStatusFile, parsePinPage,
  createPinHost, attachPinBridge, pinStatsLine, runPin, PIN_C2, PinStore,
} from '../../tools/pin.mjs';
import { keygen } from '../../tools/keygen.mjs';
import { UsageError, ROOT } from '../../tools/lib.mjs';
import { helloBytes, receiptBytes, verifyHello, verifyReceipt, makeHello, makePinRequest, verifyPinRequest, pinRequestBytes, isPinSignable } from '../../src/pin/frames.js';
import { verifyStatus, itemId } from '../../src/pin/heartbeat.js';
import { generateKeyPair, exportPublicKey } from '../../src/chain/crypto.js';
import { b64url, utf8 } from '../../src/chain/canonical.js';
import { signPointer, formatPointer, ledgerIdFor, parsePointer } from '../../src/common/pointer.js';
import { startPin, assertLocalUrl } from '../fixtures/pin/start-pin.mjs';

const work = mkdtempSync(join(tmpdir(), 'mw-c2-pin-'));
after(() => rmSync(work, { recursive: true, force: true }));
let n = 0;
const profile = () => join(work, 'profile-' + ++n);
const isPosix = process.platform !== 'win32';
const mode = (p) => statSync(p).mode & 0o777;
const IH = (k) => String(k).padStart(2, '0').repeat(20).slice(0, 40);
const SITE_IH = 'ab'.repeat(20);
const LEDGER = 'mw1:pinTestLedgerAbcdefghijklm';
const N16 = b64url.encode(new Uint8Array(16).fill(3));
const T0 = Date.UTC(2026, 9, 20, 12, 0, 0);

async function newPinKey() {
  const file = join(work, 'pin-' + ++n + '.jwk');
  await keygen({ out: file });
  return { file, key: await loadPinKey(file) };
}
async function author() {
  const { publicKey } = await generateKeyPair();
  return exportPublicKey(publicKey);
}
async function authorKey() {
  const kp = await generateKeyPair();
  return { pub: await exportPublicKey(kp.publicKey), privateKey: kp.privateKey };
}

class FakeSeeder {
  constructor() {
    this.started = [];
    this.stopped = [];
  }

  async start(meta) {
    this.started.push(meta.ih);
    return 'ok';
  }

  async stop(ih) {
    this.stopped.push(ih);
    return 'ok';
  }
}

function cli(args) {
  return spawnSync(process.execPath, ['tools/pin.mjs', ...args], { cwd: ROOT, encoding: 'utf8' });
}

// ---------------------------------------------------------------------------------------------- the command line

test('parsePinArgs: the C2 flags and their defaults; --pin-key alone is the key printout; moderation and help are unchanged', () => {
  const r = parsePinArgs(['https://example.com/', '--headless', '--files', '--pin-key', 'pin.jwk', '--status', 'out/pin-status.json',
    '--status-every', '120', '--auto-accept', 'owner', '--month-cap', '500GiB']);
  assert.equal(r.mode, 'run');
  assert.equal(r.url, 'https://example.com/');
  assert.equal(r.pinKeyFile, 'pin.jwk');
  assert.equal(r.options.statusFile, resolve('out/pin-status.json'));
  assert.equal(r.options.statusEverySec, 120);
  assert.equal(r.options.autoAccept, 'owner');
  assert.equal(r.options.monthCap, 500 * 1024 ** 3);
  assert.equal(r.options.files, true);
  assert.equal(r.options.headless, true);
  const d = parsePinArgs(['https://example.com/']);
  assert.equal(d.pinKeyFile, null);
  assert.equal(d.options.statusFile, null);
  assert.equal(d.options.statusEverySec, PIN_C2.statusEveryDefaultSec);
  assert.equal(d.options.statusEverySec, 300);
  assert.equal(d.options.autoAccept, null);
  assert.equal(d.options.monthCap, null);
  assert.equal(d.options.maxRestarts, Infinity);
  assert.deepEqual(parsePinArgs(['--pin-key', 'k.jwk']).mode, 'key');
  assert.equal(parsePinArgs(['--pin-key', 'k.jwk']).pinKeyFile, 'k.jwk');
  assert.equal(parsePinArgs(['--help']).mode, 'help');
  assert.equal(parsePinArgs(['--queue', '--profile', 'p']).mode, 'moderation');
});

test('parsePinArgs: usage errors (exit 2) for a heartbeat without a key, bad rules, sizes and intervals', () => {
  const bad = [
    ['https://example.com/', '--status', 'x.json'],
    ['https://example.com/', '--pin-key', 'k', '--status', 'x.json', '--status-every', '0'],
    ['https://example.com/', '--pin-key', 'k', '--status', 'x.json', '--status-every', String(PIN_C2.statusEveryMaxSec + 1)],
    ['https://example.com/', '--files', '--auto-accept', 'everyone'],
    ['https://example.com/', '--auto-accept', 'owner'],
    ['https://example.com/', '--month-cap', 'lots'],
    ['https://example.com/', '--month-cap', '0'],
    ['https://example.com/', '--month-cap', '-5'],
    ['https://example.com/', '--pin-key='],
    ['--status', 'x.json'],
    ['--month-cap', '1GiB'],
    ['ftp://example.com/', '--pin-key', 'k'],
  ];
  for (const argv of bad) assert.throws(() => parsePinArgs(argv), UsageError, argv.join(' '));
  assert.equal(parsePinArgs(['https://example.com/', '--pin-key', 'k', '--status', 's', '--status-every', '600']).options.statusEverySec, 600);
});

test('parseByteSize: bytes, binary and decimal units, fractions; nothing else', () => {
  assert.equal(parseByteSize('536870912000'), 536870912000);
  assert.equal(parseByteSize('500GiB'), 500 * 1024 ** 3);
  assert.equal(parseByteSize('500 gib'), 500 * 1024 ** 3);
  assert.equal(parseByteSize('2TB'), 2e12);
  assert.equal(parseByteSize('1.5g'), 1.5 * 1024 ** 3);
  assert.equal(parseByteSize('64KiB'), 65536);
  assert.equal(parseByteSize('1'), 1);
  for (const bad of ['', '0', '0.4', 'GiB', '1 parsec', '1e9', '-1', '12XB', null, '99999999999999999TB']) assert.equal(parseByteSize(bad), null, String(bad));
  assert.equal(utcMonth(Date.UTC(2026, 9, 31, 23, 59, 59)), '2026-10');
  assert.equal(utcMonth(Date.UTC(2026, 10, 1, 0, 0, 0)), '2026-11');
});

test('--pin-key without a URL prints the public key and the ledger-admin command; a readable key file is refused; help lists the flags', async () => {
  const { file, key } = await newPinKey();
  const r = cli(['--pin-key', file]);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, new RegExp('Pin key: ' + key.pub.replace(/[-]/g, '\\-') + ' \\(fingerprint [0-9a-f]{8}\\)'));
  assert.ok(r.stdout.includes('node tools/ledger-admin.mjs cfg --key owner.jwk --file <ledger.json> --pin ' + key.pub));
  const jwk = JSON.parse(readFileSync(file, 'utf8'));
  assert.ok(!r.stdout.includes(jwk.d) && !r.stderr.includes(jwk.d), 'the private scalar is never printed');
  assert.deepEqual(pinKeyLines(key)[2], '  node tools/ledger-admin.mjs cfg --key owner.jwk --file <ledger.json> --pin ' + key.pub);
  if (isPosix) {
    chmodSync(file, 0o644);
    const loose = cli(['--pin-key', file]);
    assert.equal(loose.status, 1);
    assert.match(loose.stderr, /--pin-key: refusing .* readable or writable by group or others .*chmod 600/);
    await assert.rejects(loadPinKey(file), /refusing/);
    chmodSync(file, 0o600);
  }
  const missing = cli(['--pin-key', join(work, 'nope.jwk')]);
  assert.equal(missing.status, 1);
  assert.match(missing.stderr, /key file not found.*keygen/);
  const notKey = join(work, 'not-a-key.jwk');
  writeFileSync(notKey, '{"kty":"oct"}', { mode: 0o600 });
  assert.equal(cli(['--pin-key', notKey]).status, 1);
  assert.equal(cli(['https://example.com/', '--status', 'x.json']).status, 2, 'a heartbeat needs a key');
  assert.equal(cli(['https://example.com/', '--files', '--auto-accept', 'all']).status, 2);
  const help = cli(['--help']);
  assert.equal(help.status, 0);
  for (const flag of ['--pin-key', '--status', '--status-every', '--auto-accept', '--month-cap', '--mailbox', '--files', '--queue']) assert.ok(help.stdout.includes(flag), flag);
});

test('runPin refuses a heartbeat without a key and auto-accept without the file pin before it starts anything', async () => {
  await assert.rejects(runPin({ url: 'http://127.0.0.1:9/', profileDir: profile(), statusFile: join(work, 'x.json') }), UsageError);
  await assert.rejects(runPin({ url: 'http://127.0.0.1:9/', profileDir: profile(), autoAccept: 'owner' }), UsageError);
});

// ---------------------------------------------------------------------------------------------- the signer

test('the Node signer signs only mw_pin1 hello and receipt strings, fresh ones, and receipts only for what this node keeps', async () => {
  const { key } = await newPinKey();
  let now = T0;
  const keptSet = new Set([SITE_IH]);
  const signer = createPinSigner({ key, now: () => now, kept: (ih) => keptSet.has(ih) });
  assert.equal(signer.pub, key.pub);
  const hello = { t: 'hello', key: key.pub, ih: IH(7), n: N16, at: T0, sig: b64url.encode(await signer.sign(helloBytes(IH(7), N16, T0))) };
  assert.equal((await verifyHello(hello, { expectKey: key.pub, ih: IH(7), n: N16, now: T0 })).ok, true, 'a hello for any wire');
  const sig = await signer.signB64(b64url.encode(receiptBytes(SITE_IH, 4096, T0)));
  assert.equal((await verifyReceipt({ t: 'rcpt', key: key.pub, ih: SITE_IH, total: 4096, at: T0, sig }, { expectKey: key.pub, ih: SITE_IH, now: T0 })).ok, true);
  const refuse = async (bytes, code) => {
    await assert.rejects(signer.sign(bytes), (e) => e.code === code, code);
    assert.equal(signer.check(bytes).code, code);
  };
  await refuse(receiptBytes(IH(7), 10, T0), 'E_NOT_KEPT');
  await refuse(utf8.encode('mw-block-v1\n' + IH(7)), 'E_NOT_SIGNABLE');
  await refuse(utf8.encode('mw-pointer-v1\nv=mw1; btih=' + IH(7)), 'E_NOT_SIGNABLE');
  await refuse(utf8.encode('mw-pin-status-v1\n{}'), 'E_NOT_SIGNABLE');
  await refuse(new Uint8Array(32), 'E_NOT_SIGNABLE');
  await refuse(helloBytes(IH(7), N16, T0 - 300001), 'E_STALE');
  await refuse(helloBytes(IH(7), N16, T0 + 300001), 'E_STALE');
  now = T0 + 300000;
  assert.equal(signer.check(helloBytes(IH(7), N16, T0)).ok, true, 'exactly 5 minutes');
  for (const bad of [42, '', '***', 'A'.repeat(PIN_C2.signArgMax + 1)]) await assert.rejects(signer.signB64(bad), (e) => e.code === 'E_BAD_REQUEST', String(bad));
  signer.disable('test');
  await refuse(helloBytes(IH(7), N16, now), 'E_POLICY');
  await assert.rejects(signer.signStatus({}), (e) => e.code === 'E_POLICY');
  assert.throws(() => createPinSigner({ key: { pub: 'x' } }), TypeError);
});

test('the host: pin.key and pin.sign answer only with --pin-key, through the bridge of the top frame only; pin.sign refuses other bytes', async () => {
  const off = createPinHost({ profileDir: profile(), files: true });
  assert.equal(await off.call('pin.key'), null);
  await assert.rejects(off.call('pin.sign', b64url.encode(helloBytes(IH(1), N16, Date.now()))), (e) => e.code === 'E_POLICY' && /--pin-key/.test(e.message));
  const { key } = await newPinKey();
  const host = createPinHost({ profileDir: profile(), files: true, pinKey: key });
  assert.equal(await host.call('pin.key'), key.pub);
  const at = Date.now();
  const sig = await host.call('pin.sign', b64url.encode(helloBytes(IH(1), N16, at)));
  assert.equal((await verifyHello({ t: 'hello', key: key.pub, ih: IH(1), n: N16, at, sig }, { expectKey: key.pub, ih: IH(1), n: N16, now: at })).ok, true);
  // a page builds its hello with makeHello and a signer that calls the bridge
  const viaBridge = await makeHello({ key: key.pub, ih: IH(2), n: N16, at }, (bytes) => host.call('pin.sign', b64url.encode(bytes)));
  assert.equal((await verifyHello(viaBridge, { expectKey: key.pub, ih: IH(2), n: N16, now: at })).ok, true);
  await assert.rejects(host.call('pin.sign', b64url.encode(utf8.encode('mw-block-v1\nanything'))), (e) => e.code === 'E_NOT_SIGNABLE');
  await assert.rejects(host.call('pin.sign', { bytes: 'AA' }), (e) => e.code === 'E_BAD_REQUEST');
  // receipts: the site torrent once the page named it, and pinned files; nothing else
  await assert.rejects(host.call('pin.sign', b64url.encode(receiptBytes(SITE_IH, 9, at))), (e) => e.code === 'E_NOT_KEPT');
  await host.setSite({ btih: SITE_IH, ledgerId: LEDGER, mounted: true });
  assert.equal(typeof await host.call('pin.sign', b64url.encode(receiptBytes(SITE_IH, 9, at))), 'string');
  const a = await author();
  host.files.request({ ih: IH(3), size: 5, author: a });
  await assert.rejects(host.call('pin.sign', b64url.encode(receiptBytes(IH(3), 5, at))), (e) => e.code === 'E_NOT_KEPT', 'queued is not kept');
  await host.files.decide(IH(3), 'accept');
  assert.equal(typeof await host.call('pin.sign', b64url.encode(receiptBytes(IH(3), 5, at))), 'string');
  await host.files.quarantine(IH(3), { reason: 'test' });
  await assert.rejects(host.call('pin.sign', b64url.encode(receiptBytes(IH(3), 5, at))), (e) => e.code === 'E_NOT_KEPT', 'quarantined is not kept');
  // the bridge: the same ops, the top frame only
  let binding = null;
  const page = { mainFrame: () => 'top' };
  await attachPinBridge({ exposeBinding: async (name, fn) => { binding = fn; } }, host, { page });
  assert.equal(await binding({ page, frame: 'top' }, 'pin.key'), key.pub);
  await assert.rejects(binding({ page, frame: 'child' }, 'pin.key'), /top frame/);
  await assert.rejects(binding({ page, frame: 'child' }, 'pin.sign', b64url.encode(helloBytes(IH(1), N16, at))), /top frame/);
  const stats = await host.call('stats', {});
  assert.deepEqual(stats.key, { pub: key.pub, off: false });
  assert.equal(stats.month.cap, null);
});

test('a pin key that is the site\'s owner key turns the signer off: no key, no signature, no heartbeat, one loud error', async () => {
  const { key } = await newPinKey();
  const lines = [];
  const host = createPinHost({ profileDir: profile(), pinKey: key, log: (l) => lines.push(l) });
  await host.setSite({ btih: SITE_IH, ledgerId: LEDGER, mounted: true, owner: key.pub });
  assert.equal(await host.call('pin.key'), null);
  await assert.rejects(host.call('pin.sign', b64url.encode(helloBytes(IH(1), N16, Date.now()))), (e) => e.code === 'E_POLICY');
  assert.equal(await host.heartbeat(), null);
  assert.equal(await host.writeStatus(join(work, 'never.json')), null);
  assert.equal(existsSync(join(work, 'never.json')), false);
  assert.equal(lines.filter((l) => /^ERROR: --pin-key is the site's owner key/.test(l)).length, 1);
  await host.setSite({ owner: key.pub });
  assert.equal(lines.filter((l) => /^ERROR/.test(l)).length, 1, 'said once');
  assert.ok(host.store.readLog().some((e) => e.action === 'signer-off'));
});

// ---------------------------------------------------------------------------------------------- the heartbeat

test('the heartbeat file: the site torrent while mounted and the pinned files held whole, hashed ids only, signed, mode 0644', async () => {
  const { key } = await newPinKey();
  let now = T0;
  const dir = profile();
  const host = createPinHost({ profileDir: dir, files: true, pinKey: key, now: () => now, seeder: new FakeSeeder() });
  assert.equal(await host.heartbeat(), null, 'no ledger id yet: nothing to sign for');
  await host.setSite({ btih: SITE_IH, ledgerId: LEDGER, mounted: false });
  assert.deepEqual((await host.heartbeat()).items, [], 'the site is not mounted yet');
  const a = await author();
  for (const k of [1, 2, 3]) {
    host.files.request({ ih: IH(k), size: 4, author: a });
    await host.files.decide(IH(k), 'accept');
  }
  await host.call('file.write', { ih: IH(1), offset: 0, data: b64url.encode(utf8.encode('abcd')) });
  await host.call('file.finish', { ih: IH(1) }); // whole on the node's disk
  await host.observe({ site: { btih: SITE_IH, ledgerId: LEDGER, mounted: true }, files: [{ ih: IH(2), uploaded: 0, complete: true }, { ih: IH(3), uploaded: 0, complete: false }] });
  assert.deepEqual(host.statusItems().sort(), [IH(1), IH(2), SITE_IH].sort(), 'IH(3) is not held whole');
  assert.equal(host.statusDirty(), true);
  const file = join(work, 'site-' + n, 'ws', 'pin-status.json');
  const old = isPosix ? process.umask(0o077) : null;
  let written;
  try {
    written = await host.writeStatus(file);
  } finally {
    if (isPosix) process.umask(old);
  }
  assert.equal(host.statusDirty(), false);
  if (isPosix) assert.equal(mode(file), 0o644, 'the web server reads it, whatever the umask');
  const text = readFileSync(file, 'utf8');
  assert.deepEqual(JSON.parse(text), written);
  for (const x of [IH(1), IH(2), IH(3), SITE_IH]) assert.ok(!text.includes(x), 'no infohash in the clear');
  assert.deepEqual(readdirSync(join(work, 'site-' + n, 'ws')), ['pin-status.json'], 'no temporary file left');
  const v = await verifyStatus(text, { expectKey: key.pub, site: LEDGER, now: now + 1000 });
  assert.equal(v.ok, true, v.reason);
  assert.equal(v.count, 3);
  for (const x of [SITE_IH, IH(1), IH(2)]) assert.equal(v.has(x), true, x);
  assert.equal(v.has(IH(3)), false);
  assert.equal(written.at, now);
  assert.equal(written.monthBytes, 0);
  assert.equal(written.monthCap, null);
  assert.deepEqual(written.items, [SITE_IH, IH(1), IH(2)].map(itemId).sort());
  // the page reports IH(2) is no longer whole; a new page knows nothing until it reports
  await host.observe({ files: [{ ih: IH(2), uploaded: 0, complete: false }] });
  assert.deepEqual(host.statusItems().sort(), [IH(1), SITE_IH].sort());
  host.pageChanged();
  assert.deepEqual(host.statusItems(), [IH(1)], 'the site counts again once the new page says it is mounted');
  // the browser stopped: a heartbeat that lists nothing
  now += 5000;
  const empty = await host.writeStatus(file, { empty: true });
  assert.deepEqual(empty.items, []);
  const ve = await verifyStatus(readFileSync(file), { expectKey: key.pub, site: LEDGER, now });
  assert.equal(ve.ok, true);
  assert.equal(ve.has(IH(1)), false);
  await assert.rejects(createPinHost({ profileDir: profile() }).heartbeat(), (e) => e.code === 'E_POLICY');
});

test('writeStatusFile writes atomically with mode 0644 and leaves the old file when the write fails', async () => {
  const { key } = await newPinKey();
  const host = createPinHost({ profileDir: profile(), pinKey: key });
  await host.setSite({ ledgerId: LEDGER });
  const st = await host.heartbeat();
  const dir = join(work, 'atomic-' + n);
  const file = join(dir, 'pin-status.json');
  writeStatusFile(file, st);
  if (isPosix) assert.equal(mode(file), 0o644);
  assert.throws(() => writeStatusFile(file, { pad: 'x'.repeat(300 * 1024) }), RangeError);
  assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')), st, 'the old heartbeat stays');
  assert.deepEqual(readdirSync(dir), ['pin-status.json']);
});

// ---------------------------------------------------------------------------------------------- auto-accept (SZ-6)

test('--auto-accept owner: requests the owner key signed are pinned at once and logged; members wait; unsigned or forged requests are refused; without the flag nothing changes', async () => {
  const ownerKey = await authorKey();
  const memberKey = await authorKey();
  const owner = ownerKey.pub;
  const member = memberKey.pub;
  const req = (key, fields, at = Date.now()) => makePinRequest(Object.assign({ site: LEDGER, author: key.pub, at }, fields), key.privateKey);
  const seeder = new FakeSeeder();
  const lines = [];
  const dir = profile();
  // a moderator declined IH(5) before the flag was on: that decision stands
  const before = createPinHost({ profileDir: dir, files: true });
  before.files.request({ ih: IH(5), size: 3, author: owner });
  await before.files.decide(IH(5), 'decline');
  const host = createPinHost({ profileDir: dir, files: true, autoAccept: 'owner', seeder, log: (l) => lines.push(l) });
  await host.setSite({ ledgerId: LEDGER });
  // the owner is not known yet (the page has not loaded): the request waits
  assert.deepEqual(await host.call('file.request', await req(ownerKey, { ih: IH(1), name: 'a.jpg', size: 10 })), { queued: true });
  assert.equal(host.files.queue().length, 1);
  assert.ok(host.store.readLog().some((e) => e.action === 'auto-accept-wait' && e.ih === IH(1)));
  // the page names the owner: the waiting owner request is pinned
  await host.setSite({ owner });
  assert.equal(host.files.queue().length, 0);
  assert.equal(host.files.pinned()[0].approvedBy, 'auto-accept owner');
  assert.deepEqual(seeder.started, [IH(1)]);
  // a new owner request is pinned at once
  assert.deepEqual(await host.call('file.request', await req(ownerKey, { ih: IH(2), size: 10 })), { queued: true, accepted: true, seeding: true });
  assert.deepEqual(seeder.started, [IH(1), IH(2)]);
  // a member's request waits for a moderator
  assert.deepEqual(await host.call('file.request', await req(memberKey, { ih: IH(3), size: 10 })), { queued: true });
  assert.deepEqual(host.files.queue().map((e) => e.ih), [IH(3)]);
  // Code review v0.3: site code can call the bridge; naming the owner as author without the owner's signature gets nothing.
  assert.deepEqual(await host.call('file.request', { ih: IH(7), size: 10, author: owner }), { queued: false, reason: 'unsigned' });
  const forged = Object.assign(await req(memberKey, { ih: IH(7), size: 10 }), { author: owner });
  assert.deepEqual(await host.call('file.request', forged), { queued: false, reason: 'bad-signature' });
  const otherSite = await makePinRequest({ site: 'mw1:anotherPinLedger00000000000', ih: IH(7), size: 10, author: owner, at: Date.now() }, ownerKey.privateKey);
  assert.deepEqual(await host.call('file.request', otherSite), { queued: false, reason: 'bad-signature' }, 'signed for another ledger');
  assert.deepEqual(await host.call('file.request', await req(ownerKey, { ih: IH(7), size: 10 }, Date.now() - 3600000)), { queued: false, reason: 'bad-signature' }, 'too old');
  const renamed = Object.assign(await req(ownerKey, { ih: IH(7), name: 'a.jpg', size: 10 }), { name: 'b.exe' });
  assert.deepEqual(await host.call('file.request', renamed), { queued: false, reason: 'bad-signature' }, 'the name the moderator sees is signed too');
  assert.equal(host.files.pinned().some((m) => m.ih === IH(7)), false);
  assert.equal(host.files.queue().some((e) => e.ih === IH(7)), false);
  // a moderator's decline is not overridden; a duplicate is still a duplicate
  assert.deepEqual(await host.call('file.request', await req(ownerKey, { ih: IH(5), size: 3 })), { queued: false, reason: 'declined' });
  assert.deepEqual(await host.call('file.request', await req(ownerKey, { ih: IH(2), size: 10 })), { queued: false, reason: 'already-pinned' });
  const log = host.store.readLog();
  assert.deepEqual(log.filter((e) => e.action === 'auto-accept').map((e) => [e.ih, e.author, e.rule]), [[IH(1), owner, 'owner'], [IH(2), owner, 'owner']]);
  assert.deepEqual(log.filter((e) => e.action === 'approve').map((e) => e.by), ['auto-accept owner', 'auto-accept owner']);
  assert.equal(log.filter((e) => e.action === 'request-refused').length, 5);
  assert.equal(lines.filter((l) => /^auto-accepted [0-9a-f]{40} .*the file is not opened$/.test(l)).length, 2);
  // a full store: the owner's request stays in the queue and says why
  const tiny = createPinHost({ profileDir: profile(), files: true, autoAccept: 'owner', limits: { maxTotalBytes: 5 }, log: () => {} });
  await tiny.setSite({ owner, ledgerId: LEDGER });
  assert.deepEqual(await tiny.call('file.request', await req(ownerKey, { ih: IH(4), size: 10 })), { queued: true, accepted: false, reason: 'E_PIN_FULL' });
  assert.equal(tiny.files.queue().length, 1);
  // without the flag: the owner's request waits like any other
  const plain = createPinHost({ profileDir: profile(), files: true, seeder: new FakeSeeder() });
  await plain.setSite({ owner, ledgerId: LEDGER });
  assert.deepEqual(await plain.call('file.request', await req(ownerKey, { ih: IH(6), size: 10 })), { queued: true });
  assert.equal(plain.files.pinned().length, 0);
  assert.throws(() => createPinHost({ profileDir: profile(), files: true, autoAccept: 'everyone' }), TypeError);
});

// ---------------------------------------------------------------------------------------------- the month cap

test('--month-cap: pinned files\' upload growth counts per UTC month; at the cap they stop, the site seeds on, the next month they start again', async () => {
  const { key } = await newPinKey();
  let now = Date.UTC(2026, 9, 31, 23, 58, 0);
  const seeder = new FakeSeeder();
  const lines = [];
  const dir = profile();
  const host = createPinHost({ profileDir: dir, files: true, monthCap: 1000, now: () => now, seeder, pinKey: key, log: (l) => lines.push(l) });
  const a = await author();
  for (const k of [1, 2]) {
    host.files.request({ ih: IH(k), size: 10, author: a });
    await host.files.decide(IH(k), 'accept');
  }
  await host.setSite({ btih: SITE_IH, ledgerId: LEDGER, mounted: true });
  // the site torrent and infohashes that are not pinned do not count
  await host.observe({ files: [{ ih: IH(1), uploaded: 300, complete: true }, { ih: IH(2), uploaded: 200, complete: true }, { ih: SITE_IH, uploaded: 99999 }, { ih: IH(9), uploaded: 5000 }] });
  assert.equal(host.meter.bytes, 500);
  // growth, not totals
  await host.observe({ files: [{ ih: IH(1), uploaded: 400, complete: true }, { ih: IH(2), uploaded: 200, complete: true }] });
  assert.equal(host.meter.bytes, 600);
  // a reloaded page starts its counters again; a smaller value without a reload is a new session as well
  host.pageChanged();
  await host.observe({ site: { btih: SITE_IH, ledgerId: LEDGER, mounted: true }, files: [{ ih: IH(1), uploaded: 50, complete: true }] });
  assert.equal(host.meter.bytes, 650);
  await host.observe({ files: [{ ih: IH(1), uploaded: 10, complete: true }] });
  assert.equal(host.meter.bytes, 660);
  assert.deepEqual(seeder.stopped, []);
  // the cap: every pinned file stops, the site torrent is never asked to stop
  await host.observe({ files: [{ ih: IH(2), uploaded: 400, complete: true }] });
  assert.equal(host.meter.bytes, 1060);
  assert.deepEqual(seeder.stopped.slice().sort(), [IH(1), IH(2)]);
  assert.ok(!seeder.stopped.includes(SITE_IH));
  assert.equal(host.stats().month.paused, true);
  assert.match(pinStatsLine(host.stats()), /month 1\.0 KiB of 1000 B \(pinned files paused\)/);
  assert.ok(lines.some((l) => /^month cap reached \(1\.0 KiB of 1000 B in 2026-10 UTC\): 2 pinned file\(s\) stop seeding/.test(l)));
  assert.deepEqual((await host.call('file.pinned', {})).map((m) => m.paused), [true, true]);
  // while paused the heartbeat lists the site only, says how much was used, and a new approval starts no seeding
  const st = await host.heartbeat();
  assert.deepEqual(st.items, [itemId(SITE_IH)]);
  assert.equal(st.monthBytes, 1060);
  assert.equal(st.monthCap, 1000);
  host.files.request({ ih: IH(3), size: 10, author: a });
  assert.equal((await host.files.decide(IH(3), 'accept')).seeding, false);
  assert.ok(!seeder.started.includes(IH(3)));
  assert.ok(host.store.readLog().some((e) => e.action === 'seed-paused' && e.ih === IH(3)));
  // a restart in the same month keeps the count and starts nothing
  await host.tick();
  host.meter.save(true);
  const restarted = new FakeSeeder();
  const again = createPinHost({ profileDir: dir, files: true, monthCap: 1000, now: () => now, seeder: restarted });
  await again.start();
  assert.equal(again.meter.bytes, 1060);
  assert.equal(again.meter.paused(), true);
  assert.deepEqual(restarted.started, [], 'nothing starts while the cap holds');
  if (isPosix) assert.equal(mode(join(dir, 'pin', 'month.json')) & 0o077, 0, 'month.json is private');
  // the next UTC month: the count starts again, the pinned files seed again
  now = Date.UTC(2026, 10, 1, 0, 1, 0);
  const res = await host.observe({ files: [] });
  assert.equal(res.rolled, true);
  assert.equal(res.paused, false);
  assert.equal(host.meter.month, '2026-11');
  assert.equal(host.meter.bytes, 0);
  assert.deepEqual(seeder.started.slice(-3).sort(), [IH(1), IH(2), IH(3)]);
  assert.ok(lines.some((l) => /^a new month \(2026-11 UTC\): 3 pinned file\(s\) seed again$/.test(l)));
  const actions = host.store.readLog().map((e) => e.action);
  assert.ok(actions.indexOf('month-cap') >= 0 && actions.indexOf('month-resume') > actions.indexOf('month-cap'));
  assert.deepEqual((await host.call('file.pinned', {})).map((m) => m.paused), [undefined, undefined, undefined]);
  // without a cap the count is kept for the heartbeat and nothing ever stops
  const nocap = createPinHost({ profileDir: profile(), files: true, now: () => now, seeder: new FakeSeeder() });
  assert.equal(nocap.meter.cap, null);
  assert.equal(nocap.meter.paused(), false);
});

test('MonthMeter: saves at most every 30 s unless the pause state changes, ignores bad samples, refuses a bad cap', () => {
  let now = T0;
  const store = new PinStore({ profileDir: profile(), now: () => now });
  const m = new MonthMeter({ store, cap: 100, now: () => now });
  const saved = () => JSON.parse(readFileSync(store.path('month.json'), 'utf8')).bytes;
  assert.equal(m.sample([{ ih: IH(1), uploaded: 10 }, { ih: 'bad', uploaded: 5 }, { ih: IH(2), uploaded: -1 }, null]), 10);
  assert.equal(saved(), 10, 'the first count is saved at once');
  assert.equal(m.save(), false, 'nothing new to save');
  m.sample([{ ih: IH(1), uploaded: 20 }]);
  assert.equal(saved(), 10, 'within 30 s the file waits');
  assert.equal(m.save(), false);
  now += PIN_C2.monthSaveEveryMs;
  assert.equal(m.save(), true);
  assert.equal(saved(), 20);
  m.sample([{ ih: IH(1), uploaded: 200 }]);
  assert.equal(m.paused(), true);
  assert.deepEqual(JSON.parse(readFileSync(store.path('month.json'), 'utf8')), { v: 1, month: utcMonth(T0), bytes: 200 }, 'the pause is saved at once');
  assert.throws(() => new MonthMeter({ cap: 0 }), TypeError);
  assert.throws(() => new MonthMeter({ cap: 1.5 }), TypeError);
  const fresh = new MonthMeter({ store, cap: 100, now: () => Date.UTC(2026, 11, 1) });
  assert.equal(fresh.bytes, 0, 'another month starts at 0');
});

// ---------------------------------------------------------------------------------------------- the page report

test('parsePinPage: the owner and ledger id come from the page tag verified for the URL\'s host; the page\'s file list is checked', async () => {
  const kp = await generateKeyPair({ extractable: false });
  const owner = { privateKey: kp.privateKey, pub: await exportPublicKey(kp.publicKey) };
  const record = { btih: SITE_IH, owner: owner.pub, seq: 3, exp: Math.floor(Date.now() / 1000) + 86400 * 30, ws: ['http://127.0.0.1:8080/ws/'] };
  const text = formatPointer(await signPointer(record, '127.0.0.1', owner.privateKey));
  const cache = new Map();
  const raw = { btih: SITE_IH, ledgerId: null, mounted: true, pointer: text, files: [{ ih: IH(1), uploaded: 5, complete: true }, { ih: 'bad' }, { ih: IH(2), uploaded: -3, complete: 'yes' }] };
  const r = await parsePinPage(raw, { url: 'http://127.0.0.1:8080/', cache });
  assert.equal(r.site.owner, owner.pub);
  assert.equal(r.site.btih, SITE_IH);
  assert.equal(r.site.mounted, true);
  assert.equal(r.site.ledgerId, await ledgerIdFor(parsePointer(text).record, '127.0.0.1'));
  assert.deepEqual(r.files, [{ ih: IH(1), uploaded: 5, complete: true }, { ih: IH(2), uploaded: null, complete: false }]);
  assert.equal(cache.size, 1, 'a verified tag is remembered');
  const withLedger = await parsePinPage(Object.assign({}, raw, { ledgerId: 'mw1:fromThePageAbcdefghijklmnop' }), { url: 'http://127.0.0.1:8080/', cache });
  assert.equal(withLedger.site.ledgerId, 'mw1:fromThePageAbcdefghijklmnop', 'the loader\'s own ledger id wins');
  const elsewhere = await parsePinPage(raw, { url: 'http://127.0.0.2:8080/' });
  assert.equal(elsewhere.site.owner, null, 'a tag signed for another host names nobody');
  const tampered = await parsePinPage(Object.assign({}, raw, { pointer: text.replace('seq=3', 'seq=4') }), { url: 'http://127.0.0.1:8080/' });
  assert.equal(tampered.site.owner, null);
  const nothing = await parsePinPage(null, { url: 'http://127.0.0.1:8080/' });
  assert.deepEqual(nothing, { site: { btih: null, ledgerId: null, mounted: false, owner: null }, files: null });
  assert.equal((await parsePinPage({ btih: 'XYZ', mounted: 'true' }, {})).site.btih, null);
});

// ---------------------------------------------------------------------------------------------- the E-PS-1 fixture

test('test/fixtures/pin: only 127.0.0.1 URLs; it runs the pin headless with a temporary key and profile, local-only, and cleans up', async () => {
  for (const bad of ['http://localhost:8080/', 'https://127.0.0.1/', 'http://example.com/', 'http://127.0.0.2/', 'nonsense']) {
    assert.throws(() => assertLocalUrl(bad), TypeError, bad);
  }
  assert.equal(assertLocalUrl('http://127.0.0.1:8080/x'), 'http://127.0.0.1:8080/x');
  await assert.rejects(startPin({ url: 'http://example.com/' }), TypeError);
  let seen = null;
  const fakeRun = async (o) => {
    seen = o;
    o.onHost({ fake: true });
    o.log('opening ' + o.url);
    o.log('render: ok, the site frame rendered ("Test")');
    await new Promise((resolve) => o.signal.addEventListener('abort', resolve, { once: true }));
    return 0;
  };
  const pin = await startPin({ url: 'http://127.0.0.1:9/', run: fakeRun });
  assert.match(await pin.ready, /^render: ok/);
  assert.equal(seen.allowRemote, false);
  assert.equal(seen.headless, true);
  assert.equal(seen.maxRestarts, 0);
  assert.equal(seen.files, true);
  assert.equal(seen.autoAccept, 'owner');
  assert.equal(seen.statusFile, pin.statusFile);
  assert.equal(seen.statusEverySec, 2);
  assert.equal(seen.pinKey.pub, pin.pub);
  assert.equal((await loadPinKey(pin.keyFile)).pub, pin.pub);
  if (isPosix) assert.equal(mode(pin.keyFile), 0o600);
  assert.ok(pin.profileDir.startsWith(pin.dir) && existsSync(pin.profileDir));
  assert.deepEqual(pin.host(), { fake: true });
  assert.equal(await pin.waitFor(/^opening /), 'opening http://127.0.0.1:9/');
  await assert.rejects(pin.waitFor(/never/, 50), /no log line matched/);
  assert.equal((await pin.readStatus()).reason, 'no-file');
  // a heartbeat signed with the fixture's key verifies through readStatus and waitForStatus
  const host = createPinHost({ profileDir: profile(), pinKey: await loadPinKey(pin.keyFile) });
  await host.setSite({ btih: SITE_IH, ledgerId: LEDGER, mounted: true });
  await host.writeStatus(pin.statusFile);
  const v = await pin.waitForStatus((x) => x.ok && x.has(SITE_IH), 2000, { site: LEDGER });
  assert.equal(v.count, 1);
  await assert.rejects(pin.waitForStatus(() => false, 300), /never matched/);
  await pin.stop();
  await pin.stop(); // twice is fine
  assert.equal(existsSync(pin.dir), false, 'the temporary key and profile are gone');
  // a page that does not render rejects ready
  const broken = await startPin({ url: 'http://127.0.0.1:9/', run: async (o) => { o.log('render: NOT ok, nothing'); return 0; }, keep: true });
  await assert.rejects(broken.ready, /did not render/);
  await broken.stop();
  assert.equal(existsSync(broken.dir), true, 'keep: true keeps the directory');
  rmSync(broken.dir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------------------------- deploy/pin

test('deploy/pin/Dockerfile: PIN_KEY, PIN_STATUS, PIN_MONTH_CAP and PIN_AUTO_ACCEPT become flags pin.mjs parses; no PIN_URL exits 2', (t) => {
  if (!isPosix) return t.skip('needs /bin/sh');
  const docker = readFileSync(join(ROOT, 'deploy', 'pin', 'Dockerfile'), 'utf8');
  assert.match(docker, /PIN_STATUS=\/srv\/site\/ws\/pin-status\.json/);
  for (const name of ['PIN_URL', 'PIN_KEY', 'PIN_STATUS', 'PIN_MONTH_CAP', 'PIN_AUTO_ACCEPT', 'PIN_PROFILE', 'PIN_INTERVAL']) assert.match(docker, new RegExp('^\\s+' + name + '=', 'm'), name);
  assert.match(docker, /-name '\*\.jwk'.*exit 1/s, 'the build refuses a key file in the image');
  const entry = JSON.parse(/^ENTRYPOINT (\[.*\])$/m.exec(docker)[1]);
  const bin = join(work, 'fakebin-' + ++n);
  rmSync(bin, { recursive: true, force: true });
  spawnSync('mkdir', ['-p', bin]);
  writeFileSync(join(bin, 'node'), '#!/bin/sh\nfor a in "$@"; do printf "%s\\n" "$a"; done\n', { mode: 0o755 });
  const run = (env, args = []) => spawnSync('/bin/sh', ['-c', entry[2], entry[3], ...args], {
    encoding: 'utf8', env: Object.assign({ PATH: bin + ':/usr/bin:/bin', PIN_PROFILE: '/var/lib/mw-pin/profile', PIN_INTERVAL: '60', PIN_STATUS: '/srv/site/ws/pin-status.json' }, env),
  });
  const none = run({});
  assert.equal(none.status, 2);
  assert.match(none.stderr, /set PIN_URL/);
  const argvOf = (r) => r.stdout.split('\n').filter(Boolean).slice(1); // drop tools/pin.mjs
  const plain = argvOf(run({ PIN_URL: 'http://localhost:8080/' }));
  assert.deepEqual(plain, ['http://localhost:8080/', '--headless', '--profile', '/var/lib/mw-pin/profile', '--interval', '60'], 'without the new variables nothing changes');
  const full = argvOf(run({ PIN_URL: 'https://example.com/', PIN_KEY: '/var/lib/mw-pin/pin.jwk', PIN_MONTH_CAP: '500GiB', PIN_AUTO_ACCEPT: 'owner' }, ['--snapshot', '/var/lib/mw-pin/ledger.json.gz']));
  const parsed = parsePinArgs(full);
  assert.equal(parsed.mode, 'run');
  assert.equal(parsed.pinKeyFile, '/var/lib/mw-pin/pin.jwk');
  assert.equal(parsed.options.statusFile, '/srv/site/ws/pin-status.json');
  assert.equal(parsed.options.monthCap, 500 * 1024 ** 3);
  assert.equal(parsed.options.autoAccept, 'owner');
  assert.equal(parsed.options.files, true);
  assert.equal(parsed.options.snapshotFile, '/var/lib/mw-pin/ledger.json.gz');
  const keyOnly = parsePinArgs(argvOf(run({ PIN_URL: 'https://example.com/', PIN_KEY: '/k.jwk', PIN_STATUS: '' })));
  assert.equal(keyOnly.options.statusFile, null, 'an empty PIN_STATUS writes no heartbeat');
  assert.equal(keyOnly.pinKeyFile, '/k.jwk');
  assert.equal(parsePinArgs(argvOf(run({ PIN_URL: 'https://example.com/', PIN_STATUS: '/x.json' }))).options.statusFile, null, 'PIN_STATUS alone does nothing');
});

test('observe keeps the last known site torrent, ledger id and owner through a report that lacks them (a page mid-reload)', async () => {
  const { key } = await newPinKey();
  const owner = await author();
  const host = createPinHost({ profileDir: profile(), pinKey: key });
  await host.observe({ site: { btih: SITE_IH, ledgerId: LEDGER, mounted: true, owner } });
  await host.observe({ site: { btih: null, ledgerId: null, mounted: false, owner: null } });
  assert.deepEqual(host.site(), { btih: SITE_IH, ledgerId: LEDGER, mounted: false, owner });
  assert.equal(typeof await host.call('pin.sign', b64url.encode(receiptBytes(SITE_IH, 9, Date.now()))), 'string', 'the site torrent is still kept');
  const other = await author();
  await host.observe({ site: { btih: IH(4), ledgerId: LEDGER, mounted: true, owner: other } });
  assert.deepEqual(host.site(), { btih: IH(4), ledgerId: LEDGER, mounted: true, owner: other }, 'a new value replaces the old one');
});
