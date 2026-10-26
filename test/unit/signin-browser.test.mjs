// mw-signin-v1 in real browsers (U-SI-1 in Chromium and WebKit; opt-in like the other *-browser
// tests):  MW_BROWSER=1 node --test test/unit/signin-browser.test.mjs
// Serves packages/verify/verify.js, the unbundled src/ modules and test/vectors/signin.json on
// 127.0.0.1 and runs, in each engine: every signin vector through @felinar/verify (high-S and
// DER cases included, so the engine's WebCrypto ECDSA verify is what decides), a build, sign and
// verify round trip with src/identity/signin.js, parseProof on the parse-level vectors, the
// verifier's RFC 8785 serialiser against src/chain/canonical.js, and a local proof with its
// epoch. Chromium runs with chromiumArgs(); WebKit only loads http://127.0.0.1 URLs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromiumArgs } from '../e2e/browser-args.mjs';

const ENABLED = process.env.MW_BROWSER === '1';
const ROOT = fileURLToPath(new URL('../../', import.meta.url));

const PAGE_SCRIPT = `
import { createVerifier, issueChallenge, MemoryNonceStore, statelessNonce, jcs } from '/packages/verify/verify.js';
import * as s from '/src/identity/signin.js';
import * as d from '/src/identity/derive.js';
import { canonicalize } from '/src/chain/canonical.js';

const out = { errors: [], mismatches: [], checked: 0 };

async function run() {
  const doc = await (await fetch('/test/vectors/signin.json')).json();
  for (const v of doc.vectors) {
    out.checked++;
    const now = () => v.verifier.now;
    const store = new MemoryNonceStore({ now });
    let nonce = null;
    try { nonce = JSON.parse(v.proof).c.nonce; } catch (_) {}
    if (nonce && v.nonce !== 'unknown') {
      await store.put(nonce, v.verifier.now + 600000, v.issued);
      if (v.nonce === 'used') await store.consume(nonce);
    }
    const r = await createVerifier(Object.assign({}, v.verifier, { nonces: store, now })).verify(v.proof);
    const want = v.expect.ok ? v.expect : { ok: false, reason: v.expect.reason, at: v.verifier.now };
    if (JSON.stringify(r) !== JSON.stringify(want)) out.mismatches.push(v.id + ': ' + JSON.stringify(r));
    if (v.signingInput && v.signingInput !== 'mw-signin-v1\\n' + jcs(JSON.parse(v.proof).c)) out.mismatches.push(v.id + ': signing input');
    const p = s.parseProof(v.proof);
    if (v.expect.ok && !p.ok) out.mismatches.push(v.id + ': parseProof refused a valid proof');
    if (['si-017', 'si-018', 'si-019', 'si-020', 'si-021', 'si-024', 'si-030', 'si-031', 'si-032'].includes(v.id.slice(0, 6)) && (p.ok || p.reason !== v.expect.reason)) {
      out.mismatches.push(v.id + ': parseProof ' + JSON.stringify(p));
    }
  }

  // Round trip in this engine: IdO-side build and sign, server-side verify.
  const D = await d.signScalar(await d.labelSeed(await d.rootStar(new Uint8Array(16).fill(9)), 'o|http://127.0.0.1'), 1);
  const key = await d.importScalar(D);
  const store = new MemoryNonceStore();
  const ch = await issueChallenge({ statement: 'Sign in to the test page', nonces: store });
  const c = s.buildChallenge({ origin: location.origin, pub: d.publicKeyOf(D), keyMode: 'pairwise', purpose: 'server', challenge: ch, requestId: 'cmVxdWVzdC1pZC0xMjM0NQ', idp: 'https://id.example', build: 'browser' });
  const proof = JSON.stringify(await s.signChallenge(c, key));
  const v = createVerifier({ origin: location.origin, nonces: store });
  out.roundTrip = await v.verify(proof);
  out.replay = await v.verify(proof);
  const sn = statelessNonce(crypto.getRandomValues(new Uint8Array(32)));
  const ch2 = await issueChallenge({ statement: 'Sign in', nonces: sn, origin: location.origin });
  const c2 = s.buildChallenge({ origin: location.origin, pub: d.publicKeyOf(D), keyMode: 'pairwise', purpose: 'server', challenge: ch2, requestId: 'cmVxdWVzdC1pZC0xMjM0NQ', idp: 'https://id.example', build: 'browser' });
  const v2 = createVerifier({ origin: location.origin, nonces: sn });
  const p2 = JSON.stringify(await s.signChallenge(c2, key));
  out.stateless = [(await v2.verify(p2)).ok, (await v2.verify(p2)).reason];

  const samples = [{ b: 1, a: [true, null, 1.5, -0, 1e21, 'x\\u00e9\\n'] }, { '\\u{1F600}': 1, '\\ufb33': 2 }, 'a"b', 0.1 + 0.2];
  out.jcsEqual = samples.every((x) => jcs(x) === canonicalize(x));

  const lp = await s.makeLocalProof({ signKey: key, pub: d.publicKeyOf(D), origin: location.origin, epoch: 1 });
  out.local = [(await s.verifyLocalProof(lp, { origin: location.origin, epoch: 1 })).ok, (await s.verifyLocalProof(lp, { origin: location.origin, epoch: 2 })).reason];
}

run().catch((err) => out.errors.push(String(err && err.stack || err))).then(() => { window.__results = out; });
`;

async function serve(t) {
  const server = http.createServer(async (req, res) => {
    const p = decodeURIComponent(new URL(req.url, 'http://127.0.0.1').pathname);
    let body = null;
    if (p === '/' || p === '/index.html') body = '<!doctype html><meta charset="utf-8"><title>signin</title><script type="module" src="/page.js"></script>';
    else if (p === '/page.js') body = PAGE_SCRIPT;
    else if (!p.includes('..') && (p.startsWith('/src/') || p.startsWith('/packages/verify/') || p.startsWith('/test/vectors/'))) {
      try { body = await fs.readFile(path.join(ROOT, p)); } catch (_) { body = null; }
    }
    if (body === null) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('not found');
      return;
    }
    const type = p.endsWith('.json') ? 'application/json' : p.endsWith('.js') ? 'text/javascript; charset=utf-8' : 'text/html; charset=utf-8';
    res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'no-store' });
    res.end(body);
  });
  await new Promise((ok) => server.listen(0, '127.0.0.1', ok));
  t.after(() => {
    server.close();
    server.closeAllConnections();
  });
  return 'http://127.0.0.1:' + server.address().port + '/';
}

test('mw-signin-v1 and @felinar/verify in real browsers (Chromium, WebKit)', {
  skip: ENABLED ? false : 'set MW_BROWSER=1 to run (needs Playwright browsers)',
  timeout: 300000,
}, async (t) => {
  const playwright = await import('playwright');
  const base = await serve(t);
  let engines = 0;
  for (const name of ['chromium', 'webkit']) {
    let browser;
    try {
      browser = await playwright[name].launch(name === 'chromium' ? { args: chromiumArgs() } : {});
    } catch (err) {
      t.diagnostic(name + ': not available (' + String(err.message).split('\n')[0] + ')');
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
      t.diagnostic(name + ' ' + browser.version() + ': ' + r.checked + ' signin vectors');
      assert.deepEqual(r.errors, [], name);
      assert.deepEqual(pageErrors, [], name);
      assert.deepEqual(r.mismatches, [], name + ': signin vectors');
      assert.ok(r.checked >= 30, name);
      assert.equal(r.roundTrip.ok, true, name + ': ' + JSON.stringify(r.roundTrip));
      assert.equal(r.roundTrip.keyMode, 'pairwise', name);
      assert.equal(r.replay.reason, 'replay', name);
      assert.deepEqual(r.stateless, [true, 'replay'], name);
      assert.equal(r.jcsEqual, true, name);
      assert.deepEqual(r.local, [true, 'revoked'], name);
    } finally {
      await browser.close();
    }
  }
  assert.ok(engines > 0, 'at least one browser engine ran');
});
