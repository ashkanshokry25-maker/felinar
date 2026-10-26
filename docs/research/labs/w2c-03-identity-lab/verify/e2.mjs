// E2: does Playwright's default context persist IndexedDB/localStorage across browser restarts (is it "normal" or incognito-like)?
//     and do non-extractable CryptoKeys survive a browser RESTART in a persistent profile (WebKit vs Chromium)?
// Usage: node e2.mjs <engine> <mode: new|persistent> <phase: write|read> [profileDir]
import * as pw from '$HOME/Documents/Projects/magnet-web/node_modules/playwright/index.mjs';
import http from 'node:http'; import fs from 'node:fs'; import path from 'node:path';
const [engine, mode, phase, profileDir] = process.argv.slice(2);
const PORT = 53217;
const srv = http.createServer((req, res) => { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' }).end('<!doctype html><meta charset="utf-8"><title>e2</title>e2'); });
await new Promise((r) => srv.listen(PORT, '127.0.0.1', r));
const origin = `http://localhost:${PORT}/`;
let browser, ctx;
if (mode === 'persistent') { ctx = await pw[engine].launchPersistentContext(profileDir, { headless: true }); }
else { browser = await pw[engine].launch({ headless: true }); ctx = await browser.newContext(); }
const page = ctx.pages()[0] || await ctx.newPage();
await page.goto(origin);
const out = { engine, mode, phase, version: (browser ? browser.version() : ctx.browser()?.version()) };
out.res = await page.evaluate(async (phase) => {
  const r = {};
  const ALGS = { ecdsa: [{ name: 'ECDSA', namedCurve: 'P-256' }, { name: 'ECDSA', hash: 'SHA-256' }], ed25519: [{ name: 'Ed25519' }, { name: 'Ed25519' }] };
  const open = () => new Promise((res, rej) => { const q = indexedDB.open('e2', 1); q.onupgradeneeded = () => q.result.createObjectStore('keys'); q.onsuccess = () => res(q.result); q.onerror = () => rej(q.error); });
  const db = await open();
  const put = (k, v) => new Promise((res, rej) => { const tx = db.transaction('keys', 'readwrite'); tx.objectStore('keys').put(v, k); tx.oncomplete = res; tx.onerror = () => rej(tx.error); tx.onabort = () => rej(tx.error || new Error('abort')); });
  const get = (k) => new Promise((res, rej) => { const q = db.transaction('keys').objectStore('keys').get(k); q.onsuccess = () => res(q.result); q.onerror = () => rej(q.error); });
  if (phase === 'write') {
    localStorage.setItem('marker', 'written-' + Date.now());
    for (const [name, [gen, sig]] of Object.entries(ALGS)) {
      try { const pair = await crypto.subtle.generateKey(gen, false, ['sign', 'verify']); await put(name, pair); r[name + '_write'] = 'ok'; }
      catch (e) { r[name + '_write'] = e.name + ': ' + String(e.message).slice(0, 100); }
    }
    r.persisted = await navigator.storage.persisted(); r.persistGranted = await navigator.storage.persist();
  } else {
    r.marker = localStorage.getItem('marker');
    for (const [name, [gen, sig]] of Object.entries(ALGS)) {
      try { const pair = await get(name); if (!pair) { r[name + '_read'] = 'no record'; continue; } const m = new Uint8Array([1, 2, 3]); const s = await crypto.subtle.sign(sig, pair.privateKey, m); r[name + '_read'] = { signs: s.byteLength, verifies: await crypto.subtle.verify(sig, pair.publicKey, s, m), privExtractable: pair.privateKey.extractable }; }
      catch (e) { r[name + '_read'] = e.name + ': ' + String(e.message).slice(0, 100); }
    }
  }
  return r;
}, phase);
console.log(JSON.stringify(out));
await ctx.close(); if (browser) await browser.close(); srv.close();
