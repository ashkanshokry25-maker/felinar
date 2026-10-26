// Unit tests for `node tools/publish.mjs --withdraw` (tools/withdraw.mjs; v0.2.1, DIGEST-AMENDMENTS
// A3): the signed st=withdrawn record, its outputs, its verification, and the command line.
// No network: files in a temporary directory only.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';

import { withdraw, WITHDRAW_EXP_DAYS } from '../../tools/withdraw.mjs';
import { keygen } from '../../tools/keygen.mjs';
import { UsageError, ROOT } from '../../tools/lib.mjs';
import {
  parsePointer, verifyPointer, verifyRotation, joinTxtData, ledgerIdFor, magnetFromRecord, ZERO_BTIH, MAX_EXP_DAYS,
} from '../../src/common/pointer.js';

const work = mkdtempSync(join(tmpdir(), 'mw-withdraw-test-'));
after(() => rmSync(work, { recursive: true, force: true }));
let counter = 0;
const fresh = (label) => {
  const dir = join(work, label + '-' + ++counter);
  mkdirSync(dir, { recursive: true });
  return dir;
};
const NOW = Date.UTC(2026, 9, 19, 12, 0, 30);
const NOW_SEC = Math.floor(NOW / 1000);

async function ownerKey(label = 'owner') {
  const dir = fresh(label);
  const file = join(dir, 'owner.jwk');
  const res = await keygen({ out: file });
  return { file, pub: res.pub };
}

test('withdraw: a signed st=withdrawn record with a zero infohash, why= and ct=, and nothing that names content', async () => {
  const key = await ownerKey();
  const out = fresh('out');
  writeFileSync(join(out, 'magnet.txt'), 'magnet:?xt=urn:btih:' + 'a'.repeat(40) + '\n'); // from an earlier publish
  const res = await withdraw({ scope: 'Example.COM', key: key.file, why: 'copyright', ct: 'mailto:abuse@example.com', out, now: NOW, quiet: true });
  assert.equal(res.mode, 'withdraw');
  assert.equal(res.scope, 'example.com');
  assert.equal(res.seq, NOW_SEC, 'seq defaults to the Unix time');
  assert.equal(res.exp, NOW_SEC + WITHDRAW_EXP_DAYS * 86400);
  assert.equal(WITHDRAW_EXP_DAYS, MAX_EXP_DAYS - 1, 'a withdrawal stays valid as long as the tools sign (one day under the limit)');
  // Code review round 1: a visitor whose clock lags the signer's still accepts the default withdrawal.
  const lagging = await verifyPointer(parsePointer(res.pointer).record, 'example.com', { now: NOW - 3600 * 1000 });
  assert.equal(lagging.ok, true);
  assert.equal(lagging.withdrawn, true);
  const text = readFileSync(join(out, 'pointer.txt'), 'utf8').trim();
  assert.equal(text, res.pointer);
  assert.match(text, /^v=mw1; st=withdrawn; btih=0{40}; owner=p256:[A-Za-z0-9_-]{87}; ct=mailto:abuse@example\.com; why=copyright; seq=\d+; exp=\d+; sig=[A-Za-z0-9_-]{86}$/);
  for (const k of ['xs=', 'ws=', 'tr=', 'gen=', 'dn=', 'cs=']) assert.ok(!text.includes(k), 'a withdrawal names no content: ' + k);
  const r = parsePointer(text).record;
  assert.equal(r.withdrawn, true);
  assert.equal(r.btih, ZERO_BTIH);
  assert.equal(r.owner, key.pub);
  assert.equal(r.why, 'copyright');
  const v = await verifyPointer(r, 'example.com', { now: NOW, cachedSeq: NOW_SEC - 100 });
  assert.deepEqual([v.ok, v.withdrawn, v.status], [true, true, 'withdrawn']);
  assert.throws(() => magnetFromRecord(r), (err) => err.code === 'E_WITHDRAWN');
  // Outputs: the meta tag, the TXT strings (joined without spaces they give the record back), a summary.
  assert.equal(existsSync(join(out, 'magnet.txt')), false, 'a stale magnet.txt is removed');
  assert.deepEqual(res.outputs, ['pointer.txt', 'meta.html', 'dns.txt', 'summary.json']);
  const meta = readFileSync(join(out, 'meta.html'), 'utf8');
  assert.match(meta, /^<meta name="mw-pointer" content="v=mw1; st=withdrawn; /);
  const dns = readFileSync(join(out, 'dns.txt'), 'utf8');
  const value = /^value: (.*)$/m.exec(dns)[1];
  assert.equal(joinTxtData(value), text);
  assert.match(dns, /^name: {2}_magnet\.example\.com$/m);
  const summary = JSON.parse(readFileSync(join(out, 'summary.json'), 'utf8'));
  assert.equal(summary.mode, 'withdraw');
  assert.equal(summary.withdrawn, true);
  assert.equal(summary.pointer, text);
  assert.equal(summary.ledgerId, await ledgerIdFor(r, 'example.com'), 'the same ledger id as the site it withdraws');
  assert.ok(res.budget.withinShould, 'a withdrawal is small: ' + res.budget.bytes + ' bytes');
});

test('withdraw: free-text why is allowed but short and noted; chain=, an explicit seq and a key rotation', async () => {
  const oldKey = await ownerKey('old');
  const newKey = await ownerKey('new');
  const out = fresh('out');
  const res = await withdraw({ scope: 'example.com', key: newKey.file, prevKey: oldKey.file, chain: 'guestbook', why: 'Moved to a new address', seq: 42, exp: 30, out, now: NOW, quiet: true });
  assert.equal(res.seq, 42);
  assert.equal(res.exp, NOW_SEC + 30 * 86400);
  assert.ok(res.warnings.some((w) => /shown to visitors as written/.test(w)));
  const r = parsePointer(res.pointer).record;
  assert.equal(r.why, 'Moved to a new address');
  assert.ok(res.pointer.includes('why=Moved%20to%20a%20new%20address'));
  assert.equal(r.chain, 'guestbook');
  assert.equal(await verifyRotation(r, oldKey.pub, 'example.com'), true, 'rot= lets a visitor who pinned the old key accept it silently');
  assert.equal(await verifyRotation(r, oldKey.pub, 'shop.example'), false, 'for this scope only (code review round 1)');
  const v = await verifyPointer(r, 'example.com', { now: NOW, pinnedOwner: oldKey.pub });
  assert.deepEqual([v.ok, v.rotated, v.withdrawn], [true, true, true]);
  assert.equal(res.summary.ledgerId, await ledgerIdFor(r, 'example.com'));
});

test('withdraw: refuses a missing scope or key, hub scopes, bad contacts, long or control-character reasons', async () => {
  const key = await ownerKey();
  const out = fresh('out');
  const base = { scope: 'example.com', key: key.file, out, now: NOW, quiet: true };
  await assert.rejects(withdraw({ ...base, scope: undefined }), UsageError);
  await assert.rejects(withdraw({ ...base, key: undefined }), UsageError);
  await assert.rejects(withdraw({ ...base, scope: 'btih:' + 'a'.repeat(40) }), /hostname/);
  await assert.rejects(withdraw({ ...base, ct: 'http://example.com/report' }), /https: or mailto:/);
  await assert.rejects(withdraw({ ...base, ct: 'javascript:alert(1)' }), /https: or mailto:/);
  await assert.rejects(withdraw({ ...base, why: 'x'.repeat(121) }), /at most 120 bytes/);
  await assert.rejects(withdraw({ ...base, why: 'a\nb' }), /control characters/);
  await assert.rejects(withdraw({ ...base, exp: 401 }), /--exp/);
  await assert.rejects(withdraw({ ...base, prevKey: key.file }), /same key/);
});

test('publish --withdraw on the command line: no site directory, prints the record, exit 0', async () => {
  const key = await ownerKey();
  const out = fresh('cli');
  const run = (args) => spawnSync(process.execPath, [join(ROOT, 'tools', 'publish.mjs'), ...args], { encoding: 'utf8', cwd: out });
  const ok = run(['--withdraw', '--scope', 'example.com', '--key', key.file, '--why', 'owner', '--out', out]);
  assert.equal(ok.status, 0, ok.stderr);
  const line = ok.stdout.split('\n').find((l) => l.startsWith('v=mw1; st=withdrawn;'));
  assert.ok(line, ok.stdout);
  const r = parsePointer(line).record;
  assert.equal(r.why, 'owner');
  const left = r.exp - Math.floor(Date.now() / 1000);
  assert.ok(left > 398 * 86400 && left <= 399 * 86400, 'the command line defaults to 399 days');
  const withExp = run(['--withdraw', '--scope', 'example.com', '--key', key.file, '--exp', '10', '--out', out, '--quiet']);
  assert.equal(withExp.status, 0, withExp.stderr);
  const r10 = parsePointer(readFileSync(join(out, 'pointer.txt'), 'utf8').trim()).record;
  assert.ok(r10.exp - Math.floor(Date.now() / 1000) <= 10 * 86400);
  const extra = run(['--withdraw', 'site-dir', '--scope', 'example.com', '--key', key.file]);
  assert.equal(extra.status, 2, 'a usage error: --withdraw takes no site directory');
});
