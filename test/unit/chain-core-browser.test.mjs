// Real-browser check of the chain-core modules (opt-in, like sw-browser.test.mjs):
//   MW_BROWSER=1 node --test test/unit/chain-core-browser.test.mjs
// Builds src/chain/pow-worker.js exactly as build.mjs must (esbuild, format 'iife', the
// ARCHITECTURE 10 targets), serves it with the unbundled src/chain modules, and runs in every
// installed Playwright engine (Chromium, Firefox, WebKit): sha256Sync against crypto.subtle,
// mining in the classic worker with progress and abort, the worker-backed verifier pool, the
// inline fallback for a worker that fails to load, and a small Dag + reduce scenario. Timings
// (16-bit mining, reduce over 5 000 blocks) are printed, not asserted. v0.2.1: the golden vectors
// (test/vectors/block.json and pointer.json: salted value hashes, block validity, MW-PTR/1 signing
// inputs and verification) give the same answers in every engine (WebCrypto ECDSA included).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { CHROMIUM_LOCAL_ONLY_ARGS } from '../e2e/browser-args.mjs';

const ENABLED = process.env.MW_BROWSER === '1';
const ROOT = fileURLToPath(new URL('../../', import.meta.url));

const PAGE_SCRIPT = `
import { sha256Sync } from '/src/chain/sha256-sync.js';
import { createMiner } from '/src/chain/pow-client.js';
import { createVerifierPool } from '/src/chain/verify-pool.js';
import { createBlock, validateBlock } from '/src/chain/block.js';
import { Dag } from '/src/chain/dag.js';
import { reduce, snapshot } from '/src/chain/state.js';
import { generateKeyPair, exportPublicKey } from '/src/chain/crypto.js';
import { canonicalize, utf8, hex } from '/src/chain/canonical.js';
import { leadingZeroBits } from '/src/chain/pow.js';
import { valueHash } from '/src/chain/block.js';
import { parsePointer, verifyPointer, signingInput } from '/src/common/pointer.js';

const out = { errors: [] };
const T0 = Date.UTC(2026, 9, 17, 12, 0, 0);
const SITE = 'mw1:browsertestsite000000000000';
const subtleHex = async (u8) => hex.encode(new Uint8Array(await crypto.subtle.digest('SHA-256', u8)));
const ident = async () => { const k = await generateKeyPair(); return { privateKey: k.privateKey, pub: await exportPublicKey(k.publicKey) }; };

async function run() {
  // 1. sha256Sync against WebCrypto.
  let mismatches = 0;
  const sizes = [0, 1, 55, 56, 57, 63, 64, 65, 127, 128, 1000];
  for (let i = 0; i < 40; i++) sizes.push((i * 97) % 2048);
  for (const n of sizes) {
    const b = new Uint8Array(n);
    crypto.getRandomValues(b);
    if (hex.encode(sha256Sync(b)) !== await subtleHex(b)) mismatches++;
  }
  out.shaChecked = sizes.length;
  out.shaMismatches = mismatches;

  // 2. Mining in the classic worker, with progress; 3. abort.
  const entry = { v: 1, site: SITE, author: 'B' + 'A'.repeat(86), seq: 1, prev: [], ts: T0, bits: 12, op: { t: 'put', k: 'x', vh: '0'.repeat(64) }, nonce: '' };
  const miner = createMiner({ workerUrl: '/pow-worker.js' });
  const progress = [];
  const mined = await miner.mine(entry, 12, { onProgress: (n) => progress.push(n) });
  out.minerMode = miner.mode;
  out.minedOk = (await subtleHex(utf8.encode(canonicalize(mined.entry)))) === mined.h && leadingZeroBits(hex.decode(mined.h)) >= 12;
  const ctl = new AbortController();
  const seen = [];
  try {
    await miner.mine(entry, 60, { signal: ctl.signal, onProgress: (n) => { seen.push(n); if (seen.length === 2) ctl.abort(); } });
    out.abortCode = 'not aborted';
  } catch (err) {
    out.abortCode = err.code;
  }
  out.abortProgress = seen.length;
  let t = performance.now();
  await miner.mine(Object.assign({}, entry, { seq: 2 }), 16);
  out.mine16ms = Math.round(performance.now() - t);
  miner.destroy();

  // 4. Worker-backed verifier pool.
  const alice = await ident();
  const block = await createBlock({ identity: alice, site: SITE, op: { t: 'append', l: 'gb' }, value: { text: 'hi' }, ts: T0, bits: 4 });
  const pool = createVerifierPool({ size: 2, workerUrl: '/pow-worker.js' });
  const results = await pool.verifyBlocks([block, Object.assign({}, block, { v: { text: 'HI' } }), Object.assign({}, block, { s: 'A'.repeat(86) })], { minBits: 4 });
  out.poolMode = pool.mode;
  out.poolResults = results;
  pool.destroy();

  // 5. A worker that fails to load falls back to inline mining.
  const broken = createMiner({ workerUrl: '/missing-worker.js' });
  const fb = await broken.mine(Object.assign({}, entry, { seq: 3 }), 10);
  out.fallbackOk = leadingZeroBits(hex.decode(fb.h)) >= 10;
  out.fallbackMode = broken.mode;

  // 6. Dag + reduce.
  const owner = await ident();
  const G = await createBlock({ identity: owner, site: SITE, op: { t: 'policy', writers: 'open', bits: 0 }, ts: T0 });
  const A = await createBlock({ identity: alice, site: SITE, prev: [G.h], op: { t: 'put', k: 'a' }, value: 1, ts: T0 });
  const P = await createBlock({ identity: owner, site: SITE, prev: [A.h], op: { t: 'policy', writers: 'owner' }, ts: T0 });
  const S = await createBlock({ identity: alice, site: SITE, prev: [G.h], seq: 2, op: { t: 'put', k: 'b' }, value: 2, ts: T0 });
  const dag = new Dag();
  for (const b of [S, P, A, G]) dag.add(b);
  for (const b of [G, A, P, S]) if (!(await validateBlock(b)).ok) out.errors.push('invalid block');
  out.snapshot = snapshot(reduce(dag, { genesisOwner: owner.pub }));

  // 7. reduce over 5 000 synthetic blocks.
  const big = new Dag();
  const vh = hex.encode(sha256Sync(utf8.encode('1')));
  const gen = { v: 1, site: SITE, author: owner.pub, seq: 0, prev: [], ts: T0, bits: 0, op: { t: 'policy', writers: 'open', bits: 0 }, nonce: '' };
  const blocks = [{ e: gen, h: hex.encode(sha256Sync(utf8.encode(canonicalize(gen)))), s: 'A'.repeat(86) }];
  for (let i = 1; i < 5000; i++) {
    const prev = [blocks[Math.max(0, i - 1 - (i % 5))].h, blocks[i - 1].h].filter((h, j, a) => a.indexOf(h) === j).sort();
    const e = { v: 1, site: SITE, author: alice.pub, seq: i, prev, ts: T0, bits: 0, op: i % 2 ? { t: 'append', l: 'gb', vh } : { t: 'put', k: 'k' + (i % 50), vh }, nonce: '' };
    blocks.push({ e, h: hex.encode(sha256Sync(utf8.encode(canonicalize(e)))), s: 'A'.repeat(86), v: 1 });
  }
  for (const b of blocks) big.add(b);
  reduce(big, { genesisOwner: owner.pub });
  t = performance.now();
  const st = reduce(big, { genesisOwner: owner.pub });
  out.reduce5000ms = Math.round((performance.now() - t) * 10) / 10;
  out.reduceHeight = st.height;
  out.reduceItems = (st.lists.get('gb') || []).length;

  // 8. Golden vectors (v0.2.1 A2): the same answers as in Node, in this engine.
  const blockDoc = await (await fetch('/test/vectors/block.json')).json();
  const pointerDoc = await (await fetch('/test/vectors/pointer.json')).json();
  out.vectorMismatches = [];
  for (const v of blockDoc.vectors) {
    if (v.kind === 'value-hash') {
      if ((await valueHash(v.value, v.z)) !== v.vh) out.vectorMismatches.push(v.id);
      continue;
    }
    const got = await validateBlock(v.block, v.options);
    const want = v.expect.valid ? { ok: true } : { ok: false, reason: v.expect.reason };
    if (JSON.stringify(got) !== JSON.stringify(want)) out.vectorMismatches.push(v.id + ': ' + JSON.stringify(got));
  }
  // v0.3 (MF-28): a vector named in another vector's "supersedes" keeps its bytes but not its verify expectation
  // (ptr-023 supersedes ptr-010: rot= v1 is deleted); formats-vectors.test.mjs pins its new result.
  const superseded = new Set(pointerDoc.vectors.map((v) => v.supersedes).filter(Boolean));
  for (const v of pointerDoc.vectors) {
    const p = parsePointer(v.text);
    if (!p.ok) {
      if (p.error !== v.expect.parse.error) out.vectorMismatches.push(v.id + ': parse');
      continue;
    }
    if (signingInput(p.record, v.scope) !== v.expect.signingInput) out.vectorMismatches.push(v.id + ': signing input');
    const got = await verifyPointer(p.record, v.scope, v.verifyOptions);
    if (superseded.has(v.id)) continue;
    for (const k of Object.keys(v.expect.verify)) if (got[k] !== v.expect.verify[k]) out.vectorMismatches.push(v.id + ': verify.' + k);
  }
  out.vectorsChecked = blockDoc.vectors.length + pointerDoc.vectors.length;
}

run().catch((err) => out.errors.push(String(err && err.stack || err))).then(() => { window.__results = out; });
`;

test('chain-core in real browsers (Chromium, Firefox, WebKit)', {
  skip: ENABLED ? false : 'set MW_BROWSER=1 to run (needs Playwright browsers)',
  timeout: 300000,
}, async (t) => {
  const esbuild = await import('esbuild');
  const playwright = await import('playwright');
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'mw-chain-'));
  await esbuild.build({
    entryPoints: [path.join(ROOT, 'src/chain/pow-worker.js')],
    bundle: true,
    format: 'iife',
    target: ['es2020', 'safari15.4', 'chrome110', 'firefox115'],
    outfile: path.join(dir, 'pow-worker.js'),
    logLevel: 'silent',
  });
  await fs.writeFile(path.join(dir, 'index.html'), '<!doctype html><meta charset="utf-8"><title>chain</title><script type="module" src="/page.js"></script>');
  await fs.writeFile(path.join(dir, 'page.js'), PAGE_SCRIPT);
  const server = http.createServer(async (req, res) => {
    const p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    const file = p.startsWith('/src/') || p.startsWith('/test/vectors/') ? path.join(ROOT, p) : path.join(dir, p === '/' ? 'index.html' : p.slice(1));
    try {
      const data = await fs.readFile(file);
      const type = file.endsWith('.html') ? 'text/html; charset=utf-8' : file.endsWith('.json') ? 'application/json' : 'text/javascript; charset=utf-8';
      res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'no-store' });
      res.end(data);
    } catch (_) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('not found');
    }
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = 'http://127.0.0.1:' + server.address().port + '/';
  t.after(async () => {
    server.close();
    server.closeAllConnections();
    await fs.rm(dir, { recursive: true, force: true });
  });

  let engines = 0;
  for (const name of ['chromium', 'firefox', 'webkit']) {
    let browser;
    try {
      browser = await playwright[name].launch(name === 'chromium' ? { args: CHROMIUM_LOCAL_ONLY_ARGS } : {});
    } catch (err) {
      t.diagnostic(`${name}: not available (${String(err.message).split('\n')[0]})`);
      continue;
    }
    engines++;
    try {
      const page = await browser.newPage();
      const pageErrors = [];
      page.on('pageerror', (e) => pageErrors.push(String(e)));
      await page.goto(base);
      await page.waitForFunction(() => window.__results !== undefined, null, { timeout: 120000 });
      const r = await page.evaluate(() => window.__results);
      t.diagnostic(`${name} ${browser.version()}: mine 16 bits ${r.mine16ms} ms, reduce 5000 blocks ${r.reduce5000ms} ms`);
      assert.deepEqual(r.errors, [], name);
      assert.deepEqual(pageErrors, [], name);
      assert.equal(r.shaMismatches, 0, name);
      assert.ok(r.shaChecked >= 50);
      assert.equal(r.minerMode, 'worker', name);
      assert.equal(r.minedOk, true, name);
      assert.equal(r.abortCode, 'E_POW_ABORTED', name);
      assert.equal(r.abortProgress, 2, name);
      assert.equal(r.poolMode, 'worker', name);
      assert.deepEqual(r.poolResults[0], { ok: true }, name);
      assert.deepEqual(r.poolResults[1], { ok: false, reason: 'value-hash' }, name);
      assert.deepEqual(r.poolResults[2], { ok: false, reason: 'sig' }, name);
      assert.equal(r.fallbackOk, true, name);
      assert.equal(r.fallbackMode, 'inline', name);
      assert.deepEqual(r.snapshot.kv, { a: 1 }, name);
      assert.equal(r.snapshot.policy.writers, 'owner', name);
      assert.equal(r.reduceHeight, 5000, name);
      assert.ok(r.reduceItems > 0, name);
      assert.deepEqual(r.vectorMismatches, [], name + ': golden vectors');
      assert.ok(r.vectorsChecked >= 25, name + ': ' + r.vectorsChecked + ' vectors');
    } finally {
      await browser.close();
    }
  }
  assert.ok(engines > 0, 'at least one browser engine ran');
});
