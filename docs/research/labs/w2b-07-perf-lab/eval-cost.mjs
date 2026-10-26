// Lab 1b: parse+compile+evaluate cost of the vendored webtorrent bundle in Chromium (desktop M3 as proxy), with CPU throttling,
// and how it changes over repeated loads (V8 code cache) via HTTP cache and via Service Worker Cache Storage, module vs classic script.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '../../../../node_modules/playwright/index.mjs';
import { startServer } from './lab-server.mjs';
const here = path.dirname(fileURLToPath(import.meta.url));
const IMM = 'public, max-age=31536000, immutable';
const routes = {
  '/blank.html': { file: path.join(here, 'www/blank.html'), type: 'text/html' },
  '/wt-esm.js': { file: path.join(here, 'out/wt-esm.js'), type: 'text/javascript', cache: IMM },
  '/wt-classic-plain.js': { file: path.join(here, 'out/wt-classic-plain.js'), type: 'text/javascript', cache: IMM },
  '/wt-classic-iife.js': { file: path.join(here, 'out/wt-classic-iife.js'), type: 'text/javascript', cache: IMM },
};
// service worker that precaches in install (cache.addAll) and serves from cache
const swBody = `
const FILES = ['/sw-esm.js','/sw-classic-iife.js','/sw-classic-plain.js'];
self.addEventListener('install', e => e.waitUntil(caches.open('c1').then(c => c.addAll(FILES)).then(() => self.skipWaiting())));
self.addEventListener('activate', e => e.waitUntil(self.clients.claim()));
self.addEventListener('fetch', e => { const u = new URL(e.request.url); if (FILES.includes(u.pathname)) e.respondWith(caches.match(e.request).then(r => r || fetch(e.request))); });
`;
routes['/sw.js'] = { body: Buffer.from(swBody), type: 'text/javascript' };
routes['/sw-esm.js'] = { file: path.join(here, 'out/wt-esm.js'), type: 'text/javascript' };
routes['/sw-classic-iife.js'] = { file: path.join(here, 'out/wt-classic-iife.js'), type: 'text/javascript' };
routes['/sw-classic-plain.js'] = { file: path.join(here, 'out/wt-classic-plain.js'), type: 'text/javascript' };
const { port, close } = await startServer(routes);
const base = `http://127.0.0.1:${port}`;
const median = (a) => { const s = [...a].sort((x, y) => x - y); return s[Math.floor(s.length / 2)]; };
const OPTS = '{dht:false,lsd:false,utPex:false,natUpnp:false,natPmp:false,tracker:false}';
const measureFn = `async ([kind, url, prewarm]) => {
  if (prewarm) await fetch(url, { cache: 'force-cache' }).then(r => r.arrayBuffer());
  const t0 = performance.now(); let WT;
  if (kind === 'esm') { WT = (await import(url)).default; }
  else { await new Promise((ok, err) => { const s = document.createElement('script'); s.src = url; s.onload = ok; s.onerror = err; document.head.appendChild(s); }); WT = self.WebTorrent; }
  const t1 = performance.now(); const c = new WT(${OPTS}); const t2 = performance.now(); c.destroy();
  return { load: t1 - t0, ctor: t2 - t1 };
}`;
const results = { meta: { chromium: null, cpu: os.cpus()[0].model, date: new Date().toISOString() }, cold: [], codeCache: [] };
const browser = await chromium.launch({ headless: true });
results.meta.chromium = browser.version();
// A) cold: fresh context per run, prewarmed bytes (so we time compile+eval, not the loopback fetch)
for (const rate of [1, 4, 6]) {
  const loads = [], ctors = [];
  for (let i = 0; i < 9; i++) {
    const ctx = await browser.newContext(); const page = await ctx.newPage();
    const cdp = await ctx.newCDPSession(page); await cdp.send('Emulation.setCPUThrottlingRate', { rate });
    await page.goto(base + '/blank.html');
    const r = await page.evaluate(`(${measureFn})`.replace(/^\(/, '(') + `(${JSON.stringify(['esm', base + '/wt-esm.js?r=' + rate + '_' + i, true])})`);
    loads.push(r.load); ctors.push(r.ctor); await ctx.close();
  }
  const row = { rate, loadMedianMs: +median(loads).toFixed(1), loadMinMs: +Math.min(...loads).toFixed(1), loadMaxMs: +Math.max(...loads).toFixed(1), ctorMedianMs: +median(ctors).toFixed(1) };
  results.cold.push(row); console.log('cold ESM, CPU x' + rate, JSON.stringify(row));
}
await browser.close();
// B) repeated loads in a persistent profile (disk cache + code cache) and via SW Cache Storage
async function series(label, kind, urlPath, { sw = false, rate = 1, loads = 5 } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mwperf-'));
  const ctx = await chromium.launchPersistentContext(dir, { headless: true });
  const out = [];
  try {
    if (sw) {
      const p0 = await ctx.newPage(); await p0.goto(base + '/blank.html');
      await p0.evaluate(async () => { await navigator.serviceWorker.register('/sw.js'); await navigator.serviceWorker.ready; });
      await p0.waitForTimeout(800); await p0.close();
    }
    for (let i = 1; i <= loads; i++) {
      const page = await ctx.newPage(); const cdp = await ctx.newCDPSession(page); await cdp.send('Emulation.setCPUThrottlingRate', { rate });
      await page.goto(base + '/blank.html'); await page.waitForTimeout(150);
      const r = await page.evaluate(`(${measureFn})(${JSON.stringify([kind, base + urlPath, false])})`);
      out.push(+r.load.toFixed(1)); await page.close(); await new Promise(ok => setTimeout(ok, 700));
    }
  } finally { await ctx.close(); fs.rmSync(dir, { recursive: true, force: true }); }
  results.codeCache.push({ label, rate, loadsMs: out }); console.log(label.padEnd(58), 'CPU x' + rate, out.join(' | '), 'ms (load #1..#' + loads + ')');
}
for (const rate of [1, 4]) {
  await series('HTTP cache (immutable), ESM module', 'esm', '/wt-esm.js', { rate });
  await series('HTTP cache (immutable), classic script, plain', 'classic', '/wt-classic-plain.js', { rate });
  await series('HTTP cache (immutable), classic script, IIFE-wrapped', 'classic', '/wt-classic-iife.js', { rate });
  await series('SW Cache Storage (addAll in install), ESM module', 'esm', '/sw-esm.js', { sw: true, rate });
  await series('SW Cache Storage (addAll in install), classic plain', 'classic', '/sw-classic-plain.js', { sw: true, rate });
  await series('SW Cache Storage (addAll in install), classic IIFE', 'classic', '/sw-classic-iife.js', { sw: true, rate });
}
fs.writeFileSync(path.join(here, 'out/eval-cost.json'), JSON.stringify(results, null, 1));
close();
