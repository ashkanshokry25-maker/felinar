// U-ID-3 in real browsers (R 2.2.4, MF-08, MF-09, MF-17; opt-in like the other *-browser tests):
//   MW_BROWSER=1 node --test test/unit/idp-browser.test.mjs
// Chromium: the passkey of the identity origin with the virtual authenticator over the DevTools protocol (PRF
// requested at create(), one get() only when create() returned none, the self-test reuses the output, the same
// PRF output on a later sign-in and for a discoverable get(); RP ID = this host, 16-byte random user.id,
// userVerification 'required'). Chromium and WebKit: the passphrase KDF under the identity origin's real CSP
// (Argon2id), under a CSP without 'wasm-unsafe-eval' and with WebAssembly removed (PBKDF2, named on the card), and
// frames keep coming while Argon2id runs at the real parameters, and the backup file downloads from the press on its
// save button and counts as saved only after "I saved the file" (code review v0.3: argon2idAsync, saveBackup).
// Chromium runs with chromiumArgs() and opens http://localhost (WebAuthn needs a domain RP ID); WebKit only ever
// loads http://127.0.0.1 URLs (docs/DEV-NETWORK.md). The server binds 127.0.0.1.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromiumArgs } from '../e2e/browser-args.mjs';
import { parseHeadersFile, headersFor } from '../fixtures/idp/serve.mjs';

const ENABLED = process.env.MW_BROWSER === '1';
const ROOT = fileURLToPath(new URL('../../', import.meta.url));

const PRF_PAGE = `
import * as pk from '/src/idp/passkey.js';
import { wrapWithPrf, unwrapWithPrf, packSecrets } from '/src/identity/wrap.js';
const out = { errors: [], ceremonies: { create: 0, get: 0 } };
const eq = (a, b) => a && b && a.length === b.length && a.every((x, i) => x === b[i]);
const realCreate = navigator.credentials.create.bind(navigator.credentials);
const realGet = navigator.credentials.get.bind(navigator.credentials);
navigator.credentials.create = (o) => {
  out.ceremonies.create++;
  const p = o.publicKey;
  out.options = { rpId: p.rp.id, userIdBytes: p.user.id.length, uv: p.authenticatorSelection.userVerification, rk: p.authenticatorSelection.residentKey,
    salt: Array.from(new Uint8Array(p.extensions.prf.eval.first)) };
  return realCreate(o);
};
navigator.credentials.get = (o) => { out.ceremonies.get++; out.getUv = o.publicKey.userVerification; return realGet(o); };
async function run() {
  out.salt = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode('mw-idp-prf-v1'))));
  out.caps = await pk.capabilities();
  const created = await pk.create({ nickname: 'test identity' });
  out.createPrf = Boolean(created.prf);
  out.prfEnabled = created.prfEnabled;
  const got = await pk.prfFor({ created });
  out.prfLen = got.prf ? got.prf.length : 0;
  out.enrolCeremonies = out.ceremonies.create + out.ceremonies.get;
  const secrets = packSecrets({ rootStar: crypto.getRandomValues(new Uint8Array(32)), kVault: crypto.getRandomValues(new Uint8Array(32)) });
  const blob = await wrapWithPrf(got.prf, secrets, { credId: created.credId });
  out.selfTest = eq(await unwrapWithPrf(got.prf, blob), secrets);
  out.afterSelfTest = out.ceremonies.create + out.ceremonies.get;
  const again = await pk.get({ credId: created.credId });
  out.samePrf = eq(again.prf, got.prf);
  out.againUv = again.uv;
  out.unlockAgain = eq(await unwrapWithPrf(again.prf, blob), secrets);
  const disc = await pk.get({});
  out.discoverable = disc.credId === created.credId && eq(disc.prf, got.prf);
}
run().catch((e) => out.errors.push(String((e && e.stack) || e))).then(() => { window.__results = out; });
`;

const KDF_PAGE = `
import { wasmAvailable, chooseKdf } from '/src/idp/idp.js';
import { wrapWithPassphrase, unwrapWithPassphrase, describeKdf } from '/src/identity/wrap.js';
import { createCards } from '/src/idp/cards.js';
const out = { errors: [] };
async function run() {
  out.wasm = wasmAvailable();
  out.kdf = chooseKdf(out.wasm);
  const secrets = crypto.getRandomValues(new Uint8Array(64));
  const params = out.kdf === 'argon2id' ? { m: 1024, t: 1, p: 1 } : undefined;
  const blob = await wrapWithPassphrase('blue lantern seven', secrets, { kdf: out.kdf, params });
  out.named = describeKdf(blob);
  out.iter = blob.kdf.iter || null;
  const back = await unwrapWithPassphrase('blue lantern seven', blob);
  out.roundTrip = back.length === 64 && back.every((x, i) => x === secrets[i]);
  const cards = createCards({ doc: document, win: window, lang: 'en', minPressMs: 0 });
  cards.passphrase({ mode: 'unlock', kdf: out.named });
  out.cardText = document.body.textContent;
}
run().catch((e) => out.errors.push(String((e && e.stack) || e))).then(() => { window.__results = out; });
`;

// Code review v0.3 (browser): the passphrase is stretched in slices (argon2idAsync), so the busy card paints and frames
// keep coming while Argon2id runs at the real parameters (m = 64 MiB, t = 3), instead of a 2 to 3 second freeze.
const PAINT_PAGE = `
import { createCards } from '/src/idp/cards.js';
import { wrapWithPassphrase, unwrapWithPassphrase } from '/src/identity/wrap.js';
const out = { errors: [] };
async function run() {
  const secrets = crypto.getRandomValues(new Uint8Array(64));
  const blob = await wrapWithPassphrase('blue lantern seven violet', secrets, { kdf: 'argon2id' });
  const cards = createCards({ doc: document, win: window, lang: 'en', minPressMs: 0 });
  cards.busy();
  const frames = [];
  let running = true;
  const t0 = performance.now();
  const tick = () => { frames.push(performance.now() - t0); if (running) requestAnimationFrame(tick); };
  requestAnimationFrame(tick);
  let progress = 0;
  const back = await unwrapWithPassphrase('blue lantern seven violet', blob, { onProgress: (f) => { progress = f; cards.progress(f); } });
  running = false;
  out.ms = performance.now() - t0;
  out.frames = frames.length;
  out.firstFrame = frames.length ? frames[0] : null;
  out.maxGap = frames.reduce((m, f, i) => (i ? Math.max(m, f - frames[i - 1]) : m), 0);
  out.progress = progress;
  out.roundTrip = back.length === 64 && back.every((x, i) => x === secrets[i]);
  out.busy = document.body.textContent;
}
run().catch((e) => out.errors.push(String((e && e.stack) || e))).then(() => { window.__results = out; });
`;

// Code review v0.3 (browser): the backup file is saved by the person's press on its own card, and counts as saved only
// after "I saved the file".
const BACKUP_PAGE = `
import { createCards } from '/src/idp/cards.js';
import { createIdp } from '/src/idp/idp.js';
const out = { errors: [] };
try {
  const idp = createIdp({ locks: null });
  const cards = createCards({ doc: document, win: window, lang: 'en', minPressMs: 0 });
  window.__text = JSON.stringify({ type: 'mw-identity', v: 3, note: 'browser test' });
  cards.saveBackup({ text: window.__text, download: idp.startDownload, copy: () => {} })
    .then((r) => { out.result = r; window.__results = out; }, (e) => { out.errors.push(String(e)); window.__results = out; });
} catch (e) {
  out.errors.push(String((e && e.stack) || e));
  window.__results = out;
}
window.__ready = true;
`;

async function serve(t) {
  const headersText = await fs.readFile(path.join(ROOT, 'src/idp/_headers'), 'utf8');
  const idoHeaders = headersFor(parseHeadersFile(headersText), '/');
  const pages = {
    '/prf': { script: '/prf.js', csp: null },
    '/kdf-ido-csp': { script: '/kdf.js', csp: idoHeaders['Content-Security-Policy'] },
    '/kdf-no-wasm-csp': { script: '/kdf.js', csp: "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'" },
    '/kdf-paint': { script: '/paint.js', csp: idoHeaders['Content-Security-Policy'] },
    '/backup': { script: '/backup.js', csp: idoHeaders['Content-Security-Policy'] },
  };
  const server = http.createServer(async (req, res) => {
    const p = decodeURIComponent(new URL(req.url, 'http://127.0.0.1').pathname);
    try {
      if (pages[p]) {
        const h = { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' };
        if (pages[p].csp) h['Content-Security-Policy'] = pages[p].csp;
        res.writeHead(200, h);
        res.end('<!doctype html><meta charset="utf-8"><title>idp</title><body></body><script type="module" src="' + pages[p].script + '"></script>');
        return;
      }
      let body = null;
      if (p === '/prf.js') body = PRF_PAGE;
      else if (p === '/kdf.js') body = KDF_PAGE;
      else if (p === '/paint.js') body = PAINT_PAGE;
      else if (p === '/backup.js') body = BACKUP_PAGE;
      else if (p.startsWith('/src/') && !p.includes('..')) body = await fs.readFile(path.join(ROOT, p));
      if (body === null) throw new Error('404');
      res.writeHead(200, { 'Content-Type': 'text/javascript; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(body);
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
  return server.address().port;
}

async function results(page, url) {
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  await page.goto(url);
  await page.waitForFunction(() => window.__results !== undefined, null, { timeout: 120000 });
  const r = await page.evaluate(() => window.__results);
  return Object.assign(r, { pageErrors: errors });
}

test('passkey PRF at the identity origin (Chromium virtual authenticator) and the KDF choice under the IdO CSP (Chromium, WebKit)', {
  skip: ENABLED ? false : 'set MW_BROWSER=1 to run (needs Playwright browsers)',
  timeout: 300000,
}, async (t) => {
  const playwright = await import('playwright');
  const port = await serve(t);
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
    const host = name === 'chromium' ? 'localhost' : '127.0.0.1';
    try {
      // KDF: the real IdO CSP keeps WebAssembly; without 'wasm-unsafe-eval' or without WebAssembly: PBKDF2, named.
      const ctx = await browser.newContext();
      const withCsp = await results(await ctx.newPage(), 'http://' + host + ':' + port + '/kdf-ido-csp');
      assert.deepEqual(withCsp.errors, [], name);
      assert.deepEqual(withCsp.pageErrors, [], name);
      assert.equal(withCsp.wasm, true, name + ': WebAssembly compiles under script-src \'self\' \'wasm-unsafe-eval\'');
      assert.equal(withCsp.kdf, 'argon2id');
      assert.equal(withCsp.named, 'argon2id');
      assert.equal(withCsp.roundTrip, true);
      assert.ok(withCsp.cardText.includes('Argon2id'), name + ': the card names the KDF');
      const noWasm = await results(await ctx.newPage(), 'http://' + host + ':' + port + '/kdf-no-wasm-csp');
      assert.deepEqual(noWasm.errors, [], name);
      assert.equal(noWasm.wasm, false, name + ': no \'wasm-unsafe-eval\', no WebAssembly');
      assert.equal(noWasm.kdf, 'pbkdf2');
      assert.equal(noWasm.named, 'pbkdf2-sha256');
      assert.equal(noWasm.iter, 600000);
      assert.equal(noWasm.roundTrip, true);
      assert.ok(noWasm.cardText.includes('PBKDF2-SHA-256 (600,000 rounds)'), name + ': PBKDF2 is named on the card, never a silent downgrade');
      t.diagnostic(name + ' ' + browser.version() + ': IdO CSP ' + withCsp.kdf + ', no \'wasm-unsafe-eval\' ' + noWasm.named + ' (' + noWasm.iter + ' iterations)');
      const deleted = await ctx.newPage();
      await deleted.addInitScript(() => { delete globalThis.WebAssembly; });
      const gone = await results(deleted, 'http://' + host + ':' + port + '/kdf-ido-csp');
      assert.deepEqual(gone.errors, [], name);
      assert.equal(gone.wasm, false, name + ': WebAssembly removed');
      assert.equal(gone.named, 'pbkdf2-sha256');
      // The page keeps painting while Argon2id runs (the old synchronous run gave no frame until it was done).
      const paint = await results(await ctx.newPage(), 'http://' + host + ':' + port + '/kdf-paint');
      assert.deepEqual(paint.errors, [], name);
      assert.deepEqual(paint.pageErrors, [], name);
      assert.equal(paint.roundTrip, true, name);
      t.diagnostic(name + ' ' + browser.version() + ': Argon2id unwrap ' + Math.round(paint.ms) + ' ms, ' + paint.frames + ' frames, first at ' +
        Math.round(paint.firstFrame) + ' ms, longest gap ' + Math.round(paint.maxGap) + ' ms');
      assert.ok(paint.firstFrame !== null && paint.firstFrame < 250, name + ': a frame within 250 ms of the start (' + paint.firstFrame + ')');
      assert.ok(paint.frames >= Math.min(10, Math.floor(paint.ms / 200)), name + ': frames keep coming while the KDF runs (' + paint.frames + ' in ' + Math.round(paint.ms) + ' ms)');
      assert.ok(paint.maxGap < 500, name + ': no gap of half a second (' + Math.round(paint.maxGap) + ' ms)');
      assert.ok(paint.progress > 0.99, name + ': the progress line reached the end');
      // The backup file: the save button's press starts the download; only "I saved the file" counts it as saved.
      const bpage = await ctx.newPage();
      const berrors = [];
      bpage.on('pageerror', (e) => berrors.push(String(e)));
      await bpage.goto('http://' + host + ':' + port + '/backup');
      await bpage.waitForFunction(() => window.__ready === true, null, { timeout: 30000 });
      const [download] = await Promise.all([
        bpage.waitForEvent('download', { timeout: 15000 }),
        bpage.getByRole('button', { name: 'Save the backup file' }).click(),
      ]);
      assert.equal(download.suggestedFilename(), 'magnet-web-identity-backup.json', name);
      const saved = await fs.readFile(await download.path(), 'utf8');
      assert.equal(saved, await bpage.evaluate(() => window.__text), name + ': the file holds the backup text');
      assert.equal(await bpage.evaluate(() => window.__results === undefined), true, name + ': not counted as saved by the download alone');
      await bpage.getByRole('button', { name: 'I saved the file' }).click();
      await bpage.waitForFunction(() => window.__results !== undefined, null, { timeout: 15000 });
      const b = await bpage.evaluate(() => window.__results);
      assert.deepEqual(b.errors, [], name);
      assert.deepEqual(berrors, [], name);
      assert.equal(b.result, 'saved', name);
      t.diagnostic(name + ' ' + browser.version() + ': the backup download started from the save button (' + saved.length + ' bytes)');
      await ctx.close();

      if (name === 'chromium') {
        const pctx = await browser.newContext();
        const page = await pctx.newPage();
        const cdp = await pctx.newCDPSession(page);
        await cdp.send('WebAuthn.enable', { enableUI: false });
        await cdp.send('WebAuthn.addVirtualAuthenticator', {
          options: { protocol: 'ctap2', ctap2Version: 'ctap2_1', transport: 'internal', hasResidentKey: true, hasUserVerification: true, isUserVerified: true, hasPrf: true, automaticPresenceSimulation: true },
        });
        const r = await results(page, 'http://localhost:' + port + '/prf');
        t.diagnostic('chromium ' + browser.version() + ': PRF at create() ' + r.createPrf + ' (enabled ' + r.prfEnabled + '), enrolment ceremonies ' + r.enrolCeremonies + ', getClientCapabilities prf ' + (r.caps && r.caps.prf));
        assert.deepEqual(r.errors, []);
        assert.deepEqual(r.pageErrors, []);
        assert.equal(r.options.rpId, 'localhost', 'RP ID = this host');
        assert.equal(r.options.userIdBytes, 16);
        assert.equal(r.options.uv, 'required');
        assert.equal(r.options.rk, 'required', 'one discoverable credential');
        assert.deepEqual(r.options.salt, r.salt, 'PRF eval first = SHA-256("mw-idp-prf-v1")');
        assert.equal(r.getUv, 'required');
        assert.equal(r.prfLen, 32);
        assert.ok(r.enrolCeremonies <= 2, 'create(), plus one get() only when create() gave no PRF output');
        assert.equal(r.enrolCeremonies, r.createPrf ? 1 : 2);
        assert.equal(r.selfTest, true);
        assert.equal(r.afterSelfTest, r.enrolCeremonies, 'the self-test reuses the output (no extra prompt)');
        assert.equal(r.samePrf, true, 'a later sign-in gets the same PRF output');
        assert.notEqual(r.againUv, false);
        assert.equal(r.unlockAgain, true);
        assert.equal(r.discoverable, true, 'found without a credential id (the IdO lost its storage)');
        await pctx.close();
      }
    } finally {
      await browser.close();
    }
  }
  assert.ok(engines > 0, 'at least one browser engine ran');
});
