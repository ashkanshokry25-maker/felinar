// Identity core in real browsers (U-ID-1 in Chromium and WebKit; opt-in like the other
// *-browser tests):  MW_BROWSER=1 node --test test/unit/identity-core-browser.test.mjs
// Serves the unbundled src/ modules and test/vectors/identity.json on 127.0.0.1 and checks, in each
// engine: every identity vector (phrase, root* with and without the extra word, labels, the
// signature, the label table), non-extractable imports, PRF and passphrase wrapping, the vault
// blob, a sealed item, and check.js selfTest (IndexedDB included). The Argon2id time at the
// identity origin parameters is printed, not asserted. Chromium runs with chromiumArgs() (no
// remote host resolves); WebKit only ever loads http://127.0.0.1 URLs (docs/DEV-NETWORK.md).
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
import * as d from '/src/identity/derive.js';
import * as w from '/src/identity/wrap.js';
import { Vault } from '/src/identity/vault.js';
import * as sealed from '/src/identity/sealed.js';
import { selfTest } from '/src/identity/check.js';
import { argon2id } from '/src/identity/argon2.js';
import { verify } from '/src/chain/crypto.js';
import { hex, b64url, utf8 } from '/src/chain/canonical.js';

const out = { errors: [], mismatches: [], checked: 0 };
const miss = (id, what) => out.mismatches.push(id + ': ' + what);

async function run() {
  const doc = await (await fetch('/test/vectors/identity.json')).json();
  for (const v of doc.vectors) {
    out.checked++;
    if (v.kind === 'phrase') {
      if (d.rootToPhrase(hex.decode(v.root)).join(' ') !== v.phrase) miss(v.id, 'rootToPhrase');
      if (hex.encode(d.phraseToRoot(v.phrase)) !== v.root) miss(v.id, 'phraseToRoot');
    } else if (v.kind === 'phrase-error') {
      let code = null;
      try { d.phraseToRoot(v.phrase); } catch (e) { code = e.code; }
      if (code !== v.expect.code) miss(v.id, 'error ' + code);
    } else if (v.kind === 'phrase-mistyped') {
      const r = d.phraseToRoot(v.phrase);
      if (hex.encode(r) !== v.root) miss(v.id, 'root');
      if ((await d.checkCode(await d.rootStar(r))) !== v.checkCode) miss(v.id, 'check code');
    } else if (v.kind === 'root-star') {
      const t0 = performance.now();
      const rs = await d.rootStar(hex.decode(v.root), v.extra || undefined);
      if (v.extra) out.extraMs = Math.round(performance.now() - t0);
      if (hex.encode(rs) !== v.rootStar) miss(v.id, 'root*');
      if ((await d.checkCode(rs)) !== v.checkCode) miss(v.id, 'check code');
      if (hex.encode(await d.kVaultHash(rs)) !== v.kVaultHash) miss(v.id, 'K_vaultHash');
    } else if (v.kind === 'label') {
      const rs = hex.decode(v.rootStar);
      const seed = await d.labelSeed(rs, v.label);
      if (hex.encode(seed) !== v.seed) miss(v.id, 'seed');
      const s1 = await d.signScalar(seed, 1);
      const s2 = await d.signScalar(seed, 2);
      if (hex.encode(s1) !== v.signScalar1 || d.publicKeyOf(s1) !== v.pub1) miss(v.id, 'sign key 1');
      if (hex.encode(s2) !== v.signScalar2 || d.publicKeyOf(s2) !== v.pub2) miss(v.id, 'sign key 2');
      if (d.publicKeyOf(await d.recoverScalar(rs, v.label)) !== v.recoverPub) miss(v.id, 'recover key');
      if (hex.encode(await d.kName(seed)) !== v.kName) miss(v.id, 'K_name');
      // The browser's own WebCrypto agrees with the BigInt public point: sign with the imported
      // scalar, verify with the derived public key.
      const key = await d.importScalar(s1);
      const sig = new Uint8Array(await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key, utf8.encode(v.id)));
      if (!(await verify(v.pub1, utf8.encode(v.id), sig))) miss(v.id, 'webcrypto sign/verify');
    } else if (v.kind === 'signature') {
      if (!(await verify(v.pub, utf8.encode(v.message), v.sig))) miss(v.id, 'signature');
    } else if (v.kind === 'label-choice') {
      const got = await d.labelFor(Object.assign({}, v.input, {
        verifyPointer: v.verifyResult ? async () => v.verifyResult : undefined,
        isPublicSuffix: v.publicSuffix === null ? undefined : () => v.publicSuffix,
      }));
      if (JSON.stringify(got) !== JSON.stringify(v.expect)) miss(v.id, JSON.stringify(got));
    } else {
      miss(v.id, 'unknown kind ' + v.kind);
    }
  }

  // U-ID-2: non-extractable imports.
  const dsc = d.scalar(crypto.getRandomValues(new Uint8Array(48)));
  const k = await d.importScalar(dsc, 'sign');
  out.extractable = k.extractable;
  try { await crypto.subtle.exportKey('jwk', k); out.exportThrew = false; } catch (_) { out.exportThrew = true; }
  const kx = await d.importScalar(dsc, 'ecdh');
  try { await crypto.subtle.exportKey('pkcs8', kx); out.exportEcdhThrew = false; } catch (_) { out.exportEcdhThrew = true; }

  // Wrapping and the vault.
  const secrets = w.packSecrets({ rootStar: crypto.getRandomValues(new Uint8Array(32)), kVault: crypto.getRandomValues(new Uint8Array(32)) });
  const prf = crypto.getRandomValues(new Uint8Array(32));
  const pb = await w.wrapWithPrf(prf, secrets, { credId: 'Y3JlZA' });
  out.prfRoundTrip = hex.encode(await w.unwrapWithPrf(prf, pb)) === hex.encode(secrets);
  try { await w.unwrapWithPrf(crypto.getRandomValues(new Uint8Array(32)), pb); out.prfWrongFails = false; } catch (e) { out.prfWrongFails = e.code === 'E_UNWRAP'; }
  const ab = await w.wrapWithPassphrase('blue lantern seven', secrets, { kdf: 'argon2id', params: { m: 256, t: 1, p: 1 } });
  out.argonRoundTrip = hex.encode(await w.unwrapWithPassphrase('blue lantern seven', ab)) === hex.encode(secrets);
  const kb = await w.wrapWithPassphrase('blue lantern seven', secrets, { kdf: 'pbkdf2', params: { iter: 5000 } });
  out.pbkdf2Named = kb.kdf.name;
  try { await w.unwrapWithPassphrase('wrong', kb); out.passWrongFails = false; } catch (e) { out.passWrongFails = e.code === 'E_UNWRAP'; }
  const { vault, kVault } = Vault.create();
  vault.label('o|https://shop.example');
  const vb = await vault.toBlob(kVault);
  out.vaultRoundTrip = JSON.stringify((await Vault.open(kVault, vb)).toJSON()) === JSON.stringify(vault.toJSON());

  // A sealed item.
  const rk = crypto.getRandomValues(new Uint8Array(32));
  const sv = await sealed.seal({ kind: 2, data: 'hello', ledgerId: 'mw1:x', authorPub: 'p256:a', key: rk });
  const so = await sealed.open({ value: sv, ledgerId: 'mw1:x', authorPub: 'p256:a', key: rk });
  out.sealOk = so && utf8.decode(so.data) === 'hello' && b64url.decode(sv.ct).length === 1040;
  out.sealAadFails = (await sealed.open({ value: sv, ledgerId: 'mw1:y', authorPub: 'p256:a', key: rk })) === null;

  out.selfTest = await selfTest(crypto);

  const t0 = performance.now();
  argon2id({ password: 'correct horse battery staple', salt: new Uint8Array(16), m: 65536, t: 3, p: 1 });
  out.argonDefaultMs = Math.round(performance.now() - t0);
}

run().catch((err) => out.errors.push(String(err && err.stack || err))).then(() => { window.__results = out; });
`;

async function serve(t) {
  const server = http.createServer(async (req, res) => {
    const p = decodeURIComponent(new URL(req.url, 'http://127.0.0.1').pathname);
    let file = null;
    let body = null;
    if (p === '/' || p === '/index.html') body = '<!doctype html><meta charset="utf-8"><title>identity</title><script type="module" src="/page.js"></script>';
    else if (p === '/page.js') body = PAGE_SCRIPT;
    else if (p.startsWith('/src/') || p.startsWith('/test/vectors/')) file = path.join(ROOT, p);
    try {
      const data = body !== null ? body : file && !p.includes('..') ? await fs.readFile(file) : null;
      if (data === null) throw new Error('404');
      const type = p.endsWith('.json') ? 'application/json' : p.endsWith('.js') ? 'text/javascript; charset=utf-8' : 'text/html; charset=utf-8';
      res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'no-store' });
      res.end(data);
    } catch (_) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('not found');
    }
  });
  await new Promise((ok) => server.listen(0, '127.0.0.1', ok));
  t.after(() => {
    server.close();
    server.closeAllConnections();
  });
  return 'http://127.0.0.1:' + server.address().port + '/';
}

test('identity core in real browsers (Chromium, WebKit)', {
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
      await page.waitForFunction(() => window.__results !== undefined, null, { timeout: 240000 });
      const r = await page.evaluate(() => window.__results);
      t.diagnostic(name + ' ' + browser.version() + ': Argon2id m=65536 t=3 p=1 ' + r.argonDefaultMs + ' ms; root* with extra word ' + r.extraMs + ' ms');
      assert.deepEqual(r.errors, [], name);
      assert.deepEqual(pageErrors, [], name);
      assert.deepEqual(r.mismatches, [], name + ': identity vectors');
      assert.ok(r.checked >= 38, name + ': ' + r.checked + ' vectors');
      assert.equal(r.extractable, false, name);
      assert.equal(r.exportThrew, true, name);
      assert.equal(r.exportEcdhThrew, true, name);
      assert.equal(r.prfRoundTrip, true, name);
      assert.equal(r.prfWrongFails, true, name);
      assert.equal(r.argonRoundTrip, true, name);
      assert.equal(r.pbkdf2Named, 'pbkdf2-sha256', name);
      assert.equal(r.passWrongFails, true, name);
      assert.equal(r.vaultRoundTrip, true, name);
      assert.equal(r.sealOk, true, name);
      assert.equal(r.sealAadFails, true, name);
      assert.deepEqual(r.selfTest, { idb: true, sign: true, ecdh: true }, name + ': selfTest');
    } finally {
      await browser.close();
    }
  }
  assert.ok(engines > 0, 'at least one browser engine ran');
});
