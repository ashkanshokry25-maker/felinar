// Unit tests for src/chain/{pow,pow-worker,pow-client,verify-pool}.js.
// The worker protocol runs in-process through a FakeWorker that structured-clones every message
// and delivers it asynchronously; the real classic bundle is also built with esbuild (format
// 'iife', the build targets) and executed as a script with a fake `self`.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import {
  leadingZeroBits, hashEntry, mine, verifyPow, powAbortedError, NONCE_WIDTH, PROGRESS_EVERY, MINE_BATCH,
} from '../../src/chain/pow.js';
import { sha256Sync } from '../../src/chain/sha256-sync.js';
import { installWorker } from '../../src/chain/pow-worker.js';
import { createMiner } from '../../src/chain/pow-client.js';
import { createVerifierPool } from '../../src/chain/verify-pool.js';
import { createBlock, redact } from '../../src/chain/block.js';
import { generateKeyPair, exportPublicKey } from '../../src/chain/crypto.js';
import { canonicalize, hex, utf8 } from '../../src/chain/canonical.js';

const WORKER_SRC = fileURLToPath(new URL('../../src/chain/pow-worker.js', import.meta.url));
const SITE = 'mw1:powtestsite000000000000000';
const T0 = Date.UTC(2026, 9, 17, 12, 0, 0);
const NONCE_RE = new RegExp('^[0-9a-z]{' + NONCE_WIDTH + '}$');
const tick = () => new Promise((resolve) => setImmediate(resolve));

function sampleEntry(extra = {}) {
  return Object.assign({
    v: 1, site: SITE, author: 'A'.repeat(87), seq: 3, prev: [], ts: T0, bits: 8,
    op: { t: 'put', k: 'greeting', vh: '0'.repeat(64) }, nonce: '',
  }, extra);
}

function nodeHashHex(entry) {
  return createHash('sha256').update(utf8.encode(canonicalize(entry))).digest('hex');
}

async function makeIdentity() {
  const kp = await generateKeyPair();
  return { privateKey: kp.privateKey, pub: await exportPublicKey(kp.publicKey) };
}

// In-process stand-in for a dedicated worker running pow-worker.js. terminate() cancels every
// job it was given, as killing a real worker would.
class FakeWorker {
  constructor(url) {
    FakeWorker.instances.push(this);
    this.url = url;
    this.terminated = false;
    this.posted = [];
    this.onmessage = null;
    this.onerror = null;
    this.onmessageerror = null;
    const outer = this;
    this.scope = installWorker({
      onmessage: null,
      postMessage(msg) {
        const data = structuredClone(msg);
        setImmediate(() => {
          if (!outer.terminated && outer.onmessage) outer.onmessage({ data });
        });
      },
    });
  }

  postMessage(msg) {
    if (this.terminated) throw new Error('worker terminated');
    const data = structuredClone(msg);
    this.posted.push(data);
    setImmediate(() => {
      if (!this.terminated) this.scope.onmessage({ data });
    });
  }

  terminate() {
    if (this.terminated) return;
    this.terminated = true;
    for (const msg of this.posted) if (msg.entry !== undefined) this.scope.onmessage({ data: { id: msg.id, cancel: true } });
  }

  fail() {
    this.terminate();
    if (this.onerror) this.onerror({ type: 'error', preventDefault() {} });
  }
}
FakeWorker.instances = [];

// ---------------------------------------------------------------------------------------------
// pow.js
// ---------------------------------------------------------------------------------------------

test('leadingZeroBits', () => {
  assert.equal(leadingZeroBits(new Uint8Array([])), 0);
  assert.equal(leadingZeroBits(new Uint8Array([0x80])), 0);
  assert.equal(leadingZeroBits(new Uint8Array([0x01])), 7);
  assert.equal(leadingZeroBits(new Uint8Array([0x00, 0x0f])), 12);
  assert.equal(leadingZeroBits(new Uint8Array([0x00, 0x00, 0x01, 0xff])), 23);
  assert.equal(leadingZeroBits(new Uint8Array(32)), 256);
  assert.equal(leadingZeroBits(new Uint8Array([0, 0, 0, 0x20]).buffer), 26, 'ArrayBuffer input');
});

test('hashEntry is sha256(utf8(canonical(entry))) via WebCrypto', async () => {
  const entry = sampleEntry({ nonce: 'abc' });
  const { hashU8, hashHex } = await hashEntry(entry);
  assert.ok(hashU8 instanceof Uint8Array);
  assert.equal(hashHex, nodeHashHex(entry));
  assert.equal(hex.encode(hashU8), hashHex);
  const reordered = Object.fromEntries(Object.entries(entry).reverse());
  assert.equal((await hashEntry(reordered)).hashHex, hashHex, 'key order does not matter');
});

test('mine at 8 bits: a valid, deterministic nonce that verifies', async () => {
  const entry = sampleEntry();
  const before = JSON.stringify(entry);
  const res = await mine(entry, 8);
  assert.equal(JSON.stringify(entry), before, 'the input entry is not mutated');
  assert.match(res.entry.nonce, NONCE_RE);
  assert.equal(res.h, nodeHashHex(res.entry));
  assert.equal((await hashEntry(res.entry)).hashHex, res.h);
  assert.ok(leadingZeroBits(hex.decode(res.h)) >= 8);
  assert.equal(await verifyPow(res.h, 8), true);
  const { nonce: _ignored, ...rest } = res.entry;
  assert.deepEqual(rest, (({ nonce, ...r }) => r)(entry), 'only the nonce changes');
  const again = await mine(entry, 8);
  assert.equal(again.entry.nonce, res.entry.nonce, 'the search order is deterministic');
});

test('mine: the midstate path and a plain hash function find the same nonce', async () => {
  // Long entry (many 64-byte blocks before and after the nonce) with multi-byte UTF-8 before it.
  const entry = sampleEntry({ author: String.fromCharCode(0xe9).repeat(70) + 'x', op: { t: 'put', k: 'k'.repeat(200), vh: 'f'.repeat(64) } });
  const fast = await mine(entry, 10);
  const plain = await mine(entry, 10, { sha: (bytes) => sha256Sync(bytes) });
  const asyncSha = await mine(entry, 10, {
    sha: async (bytes) => new Uint8Array(await globalThis.crypto.subtle.digest('SHA-256', bytes)),
  });
  assert.equal(plain.entry.nonce, fast.entry.nonce);
  assert.equal(plain.h, fast.h);
  assert.equal(asyncSha.h, fast.h);
  assert.equal(fast.h, nodeHashHex(fast.entry));
});

test('mine at 0 bits takes the first nonce; bad arguments throw TypeError', async () => {
  const res = await mine(sampleEntry(), 0);
  assert.equal(res.entry.nonce, '0'.repeat(NONCE_WIDTH));
  assert.equal(res.h, nodeHashHex(res.entry));
  await assert.rejects(mine(null, 8), TypeError);
  await assert.rejects(mine([], 8), TypeError);
  await assert.rejects(mine(sampleEntry(), -1), TypeError);
  await assert.rejects(mine(sampleEntry(), 1.5), TypeError);
  await assert.rejects(mine(sampleEntry(), 257), TypeError);
  await assert.rejects(mine(sampleEntry(), 8, { sha: 'nope' }), TypeError);
  await assert.rejects(mine({ v: 1, bad: undefined }, 8), TypeError, 'non-JSON entries are refused');
});

test('mine: abort before and during mining rejects with E_POW_ABORTED; progress fires every ~2 000 hashes', async () => {
  const pre = new AbortController();
  pre.abort();
  await assert.rejects(mine(sampleEntry(), 8, { signal: pre.signal }), (err) => err.code === 'E_POW_ABORTED');

  const controller = new AbortController();
  const progress = [];
  let timerFired = false;
  setTimeout(() => { timerFired = true; }, 0);
  const started = Date.now();
  await assert.rejects(
    mine(sampleEntry(), 48, {
      signal: controller.signal,
      onProgress: (n) => {
        progress.push(n);
        if (progress.length === 5) controller.abort();
      },
    }),
    (err) => err.code === 'E_POW_ABORTED' && err.name === 'AbortError',
  );
  assert.ok(Date.now() - started < 10000);
  assert.equal(progress.length, 5, 'mining stops at the next batch after the abort');
  assert.ok(progress[0] >= PROGRESS_EVERY && progress[0] < PROGRESS_EVERY + MINE_BATCH, 'first report near 2 000');
  for (let i = 1; i < progress.length; i++) {
    const step = progress[i] - progress[i - 1];
    assert.ok(step >= PROGRESS_EVERY - MINE_BATCH && step <= PROGRESS_EVERY + MINE_BATCH, 'step ' + step);
  }
  assert.ok(progress.every((n) => n % MINE_BATCH === 0), 'reports at batch boundaries');

  // A long run yields to the event loop, so timers (and a worker's cancel message) get through.
  const c2 = new AbortController();
  const running = mine(sampleEntry(), 48, { signal: c2.signal });
  await new Promise((resolve) => setTimeout(resolve, 60));
  assert.equal(timerFired, true);
  c2.abort();
  await assert.rejects(running, (err) => err.code === 'E_POW_ABORTED');
  // A throwing progress callback does not stop mining.
  const res = await mine(sampleEntry(), 12, { onProgress: () => { throw new Error('ui bug'); } });
  assert.ok(await verifyPow(res.h, 12));
  assert.equal(powAbortedError().code, 'E_POW_ABORTED');
});

test('verifyPow', async () => {
  const zeros = '0'.repeat(64);
  assert.equal(await verifyPow(zeros, 256), true);
  assert.equal(await verifyPow('00f' + 'f'.repeat(61), 8), true);
  assert.equal(await verifyPow('00f' + 'f'.repeat(61), 9), false);
  assert.equal(await verifyPow('8' + '0'.repeat(63), 0), true);
  assert.equal(await verifyPow('8' + '0'.repeat(63), 1), false);
  assert.equal(await verifyPow('00F' + 'f'.repeat(61), 8), false, 'uppercase is not a block hash');
  assert.equal(await verifyPow('00', 8), false);
  assert.equal(await verifyPow(null, 0), false);
  assert.equal(await verifyPow(zeros, -1), false);
  assert.equal(await verifyPow(zeros, 1.5), false);
});

// ---------------------------------------------------------------------------------------------
// pow-worker.js
// ---------------------------------------------------------------------------------------------

function fakeScope() {
  const messages = [];
  const waiters = [];
  const scope = {
    onmessage: null,
    postMessage(msg) {
      messages.push(structuredClone(msg));
      for (const w of waiters.splice(0)) w();
    },
  };
  const next = async (predicate) => {
    for (;;) {
      const found = messages.find(predicate);
      if (found) return found;
      await new Promise((resolve) => waiters.push(resolve));
    }
  };
  return { scope, messages, next };
}

test('pow-worker protocol: mine, progress, cancel, verify', async () => {
  const { scope, messages, next } = fakeScope();
  installWorker(scope);
  assert.equal(typeof scope.onmessage, 'function');

  scope.onmessage({ data: { id: 1, entry: sampleEntry(), bits: 8 } });
  const done = await next((m) => m.id === 1 && m.h);
  assert.equal(done.h, nodeHashHex(done.entry));
  assert.ok(await verifyPow(done.h, 8));

  scope.onmessage({ data: { id: 2, entry: sampleEntry(), bits: 60 } });
  await next((m) => m.id === 2 && m.progress >= 3 * PROGRESS_EVERY);
  scope.onmessage({ data: { id: 2, cancel: true } });
  const cancelled = await next((m) => m.id === 2 && m.error);
  assert.equal(cancelled.error.code, 'E_POW_ABORTED');
  assert.equal(typeof cancelled.error.message, 'string');
  const progressMsgs = messages.filter((m) => m.id === 2 && m.progress !== undefined);
  assert.ok(progressMsgs.length >= 3);

  scope.onmessage({ data: { id: 3, entry: null, bits: 8 } });
  const failed = await next((m) => m.id === 3 && m.error);
  assert.equal(failed.error.code, 'E_POW');

  const id = await makeIdentity();
  const block = await createBlock({ identity: id, site: SITE, op: { t: 'put', k: 'a' }, value: 1, ts: T0, bits: 4 });
  scope.onmessage({ data: { id: 4, verify: block, opts: { minBits: 4 } } });
  assert.deepEqual((await next((m) => m.id === 4)).result, { ok: true });
  scope.onmessage({ data: { id: 5, verify: Object.assign({}, block, { v: 2 }) } });
  assert.deepEqual((await next((m) => m.id === 5)).result, { ok: false, reason: 'value-hash' });
  scope.onmessage({ data: { id: 6, verify: block, opts: { minBits: 30 } } });
  assert.deepEqual((await next((m) => m.id === 6)).result, { ok: false, reason: 'pow' });

  const count = messages.length;
  scope.onmessage({ data: null });
  scope.onmessage({ data: 'hello' });
  scope.onmessage(undefined);
  scope.onmessage({ data: { id: 99, cancel: true } });
  await tick();
  assert.equal(messages.length, count, 'junk and unknown cancels are ignored');
});

test('pow-worker builds as a classic IIFE bundle that installs self.onmessage and works', async () => {
  const esbuild = await import('esbuild');
  const out = await esbuild.build({
    entryPoints: [WORKER_SRC],
    bundle: true,
    format: 'iife',
    write: false,
    target: ['es2020', 'safari15.4', 'chrome110', 'firefox115'],
    logLevel: 'silent',
  });
  const code = out.outputFiles[0].text;
  assert.doesNotMatch(code, /^\s*(import|export)\s/m, 'no module syntax in the bundle');
  new vm.Script(code, { filename: 'pow-worker.js' }); // parses as a classic script (no top-level await)

  const { scope, next } = fakeScope();
  // Run it like a worker: `self` is the scope, no window, no setImmediate (browser path).
  // eslint-disable-next-line no-new-func
  new Function('self', 'window', 'setImmediate', code)(scope, undefined, undefined);
  assert.equal(typeof scope.onmessage, 'function', 'installed on self');

  scope.onmessage({ data: { id: 'a', entry: sampleEntry(), bits: 9 } });
  const done = await next((m) => m.id === 'a' && m.h);
  assert.equal(done.h, nodeHashHex(done.entry));
  assert.ok(await verifyPow(done.h, 9));

  scope.onmessage({ data: { id: 'b', entry: sampleEntry(), bits: 60 } });
  await next((m) => m.id === 'b' && m.progress !== undefined);
  scope.onmessage({ data: { id: 'b', cancel: true } });
  assert.equal((await next((m) => m.id === 'b' && m.error)).error.code, 'E_POW_ABORTED');

  const id = await makeIdentity();
  const block = await createBlock({ identity: id, site: SITE, op: { t: 'append', l: 'log' }, value: 'x', ts: T0 });
  scope.onmessage({ data: { id: 'c', verify: block } });
  assert.deepEqual((await next((m) => m.id === 'c')).result, { ok: true });

  // In a window (or in Node's main thread) the bundle installs nothing.
  const pageScope = { onmessage: null, postMessage() {} };
  // eslint-disable-next-line no-new-func
  new Function('self', 'window', code)(pageScope, {});
  assert.equal(pageScope.onmessage, null);
});

// ---------------------------------------------------------------------------------------------
// pow-client.js
// ---------------------------------------------------------------------------------------------

test('createMiner without a Worker mines inline; abort and destroy stop it', async () => {
  const miner = createMiner({ workerUrl: '/_mw/pow-worker.js' }); // Node has no Worker
  assert.equal(miner.mode, 'inline');
  const res = await miner.mine(sampleEntry(), 8);
  assert.equal(res.h, nodeHashHex(res.entry));
  const controller = new AbortController();
  const running = miner.mine(sampleEntry(), 60, { signal: controller.signal });
  setTimeout(() => controller.abort(), 20);
  await assert.rejects(running, (err) => err.code === 'E_POW_ABORTED');
  const longJob = miner.mine(sampleEntry(), 60);
  setTimeout(() => miner.destroy(), 20);
  await assert.rejects(longJob, (err) => err.code === 'E_POW_ABORTED');
  await assert.rejects(miner.mine(sampleEntry(), 8), (err) => err.code === 'E_POW_ABORTED');
  assert.equal(createMiner().mode, 'inline', 'no workerUrl means inline');
});

test('createMiner with a worker: results, progress, cancel, destroy', async () => {
  FakeWorker.instances = [];
  const miner = createMiner({ workerUrl: '/_mw/pow-worker.js', Worker: FakeWorker });
  assert.equal(miner.mode, 'worker');
  const progress = [];
  const res = await miner.mine(sampleEntry(), 13, { onProgress: (n) => progress.push(n) });
  assert.equal(FakeWorker.instances.length, 1);
  assert.equal(FakeWorker.instances[0].url, '/_mw/pow-worker.js');
  assert.equal(res.h, nodeHashHex(res.entry));
  assert.ok(await verifyPow(res.h, 13));
  assert.ok(progress.every((n) => typeof n === 'number'));

  // The same worker serves later jobs; bits 0 never needs it.
  const zero = await miner.mine(sampleEntry(), 0);
  assert.equal(zero.entry.nonce, '0'.repeat(NONCE_WIDTH));
  const worker = FakeWorker.instances[0];
  assert.equal(worker.posted.filter((m) => m.entry !== undefined).length, 1);

  const controller = new AbortController();
  const seen = [];
  const job = miner.mine(sampleEntry(), 60, {
    signal: controller.signal,
    onProgress: (n) => {
      seen.push(n);
      if (seen.length === 2) controller.abort();
    },
  });
  await assert.rejects(job, (err) => err.code === 'E_POW_ABORTED');
  const jobId = worker.posted[worker.posted.length - 1].id;
  await tick();
  assert.ok(worker.posted.some((m) => m.id === jobId && m.cancel === true), 'cancel reached the worker');

  const pending = miner.mine(sampleEntry(), 60);
  await tick();
  miner.destroy();
  await assert.rejects(pending, (err) => err.code === 'E_POW_ABORTED');
  assert.equal(worker.terminated, true);
  await assert.rejects(miner.mine(sampleEntry(), 8), (err) => err.code === 'E_POW_ABORTED');
});

test('createMiner falls back to inline mining when the worker cannot start or fails', async () => {
  class Throwing {
    constructor() {
      throw new Error('blocked by CSP');
    }
  }
  const m1 = createMiner({ workerUrl: '/x.js', Worker: Throwing });
  const r1 = await m1.mine(sampleEntry(), 8);
  assert.equal(r1.h, nodeHashHex(r1.entry));
  assert.equal(m1.mode, 'inline');

  FakeWorker.instances = [];
  const m2 = createMiner({ workerUrl: '/missing.js', Worker: FakeWorker });
  const job = m2.mine(sampleEntry(), 11);
  FakeWorker.instances[0].fail(); // e.g. the script 404s before answering
  const r2 = await job;
  assert.equal(r2.h, nodeHashHex(r2.entry));
  assert.ok(await verifyPow(r2.h, 11));
  assert.equal(m2.mode, 'inline');
  const r3 = await m2.mine(sampleEntry({ seq: 9 }), 8);
  assert.equal(r3.h, nodeHashHex(r3.entry));
  assert.equal(FakeWorker.instances.length, 1, 'no new worker after a failure');

  const m3 = createMiner({ workerUrl: '/x.js', Worker: FakeWorker });
  const pre = new AbortController();
  pre.abort();
  await assert.rejects(m3.mine(sampleEntry(), 8, { signal: pre.signal }), (err) => err.code === 'E_POW_ABORTED');
  m3.destroy();
});

test('createBlock mines through a miner object', async () => {
  FakeWorker.instances = [];
  const miner = createMiner({ workerUrl: '/_mw/pow-worker.js', Worker: FakeWorker });
  const id = await makeIdentity();
  const block = await createBlock({ identity: id, site: SITE, op: { t: 'put', k: 'k' }, value: 1, ts: T0, bits: 10, miner });
  assert.equal(FakeWorker.instances.length, 1);
  assert.ok(leadingZeroBits(hex.decode(block.h)) >= 10);
  miner.destroy();
});

// ---------------------------------------------------------------------------------------------
// verify-pool.js
// ---------------------------------------------------------------------------------------------

test('createVerifierPool verifies inline in Node', async () => {
  const id = await makeIdentity();
  const block = await createBlock({ identity: id, site: SITE, op: { t: 'put', k: 'a' }, value: { x: 1 }, ts: T0, bits: 2 });
  const pool = createVerifierPool();
  assert.equal(pool.mode, 'inline');
  assert.deepEqual(await pool.verifyBlock(block), { ok: true });
  assert.deepEqual(await pool.verifyBlock(block, { minBits: 20 }), { ok: false, reason: 'pow' });
  assert.deepEqual(await pool.verifyBlock(redact(block), { requireValue: true }), { ok: false, reason: 'value-hash' });
  const tampered = Object.assign({}, block, { s: block.s.slice(0, -2) + (block.s.endsWith('AA') ? 'BA' : 'AA') });
  const results = await pool.verifyBlocks([block, tampered, { nope: 1 }]);
  assert.equal(results[0].ok, true);
  assert.equal(results[1].ok, false);
  assert.deepEqual(results[2], { ok: false, reason: 'shape' });
  pool.destroy();
  await assert.rejects(pool.verifyBlock(block), (err) => err.code === 'E_ABORTED');
});

test('createVerifierPool spreads work over its workers and survives a crash', async () => {
  const id = await makeIdentity();
  const blocks = [];
  for (let i = 0; i < 8; i++) blocks.push(await createBlock({ identity: id, site: SITE, seq: i, op: { t: 'append', l: 'l' }, value: i, ts: T0 }));
  FakeWorker.instances = [];
  const pool = createVerifierPool({ size: 2, workerUrl: '/_mw/pow-worker.js', Worker: FakeWorker });
  const results = await pool.verifyBlocks(blocks);
  assert.ok(results.every((r) => r.ok === true));
  assert.equal(FakeWorker.instances.length, 2, 'size bounds the worker count');
  for (const w of FakeWorker.instances) assert.ok(w.posted.length > 0, 'both workers got work');
  assert.equal(pool.mode, 'worker');

  // A crashing worker hands its pending jobs to the inline verifier.
  const p = pool.verifyBlocks(blocks.slice(0, 4));
  FakeWorker.instances[0].fail();
  FakeWorker.instances[1].fail();
  const after = await p;
  assert.ok(after.every((r) => r.ok === true));
  assert.equal(pool.mode, 'inline');
  assert.deepEqual(await pool.verifyBlock(blocks[0]), { ok: true });

  const pool2 = createVerifierPool({ size: 1, workerUrl: '/x.js', Worker: FakeWorker });
  const waiting = pool2.verifyBlock(blocks[1]);
  pool2.destroy();
  await assert.rejects(waiting, (err) => err.code === 'E_ABORTED');
});
