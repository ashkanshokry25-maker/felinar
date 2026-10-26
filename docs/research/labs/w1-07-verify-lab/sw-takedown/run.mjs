// Experiment for fact-check of claim 8 (w1-07): can an edge reach an already-installed Service Worker?
// Runs per browser: install SW -> verify local answers (edge sees nothing) -> edge returns 404/410/500 for the SW script
// -> does update() evict? -> edge returns a 200 "kill" script -> does it evict? -> does a long Cache-Control on sw.js hide updates?
import http from 'node:http';
import { chromium, firefox, webkit } from '$HOME/Documents/Projects/magnet-web/node_modules/playwright/index.mjs';

const which = process.argv[2] || 'chromium';
const engines = { chromium, firefox, webkit };

let mode = 'v1';            // what the "edge" serves at /sw.js
const log = [];             // every request the edge sees
const swSource = (ver) => `
const VERSION = ${JSON.stringify(ver)};
self.addEventListener('install', e => self.skipWaiting());
self.addEventListener('activate', e => e.waitUntil(self.clients.claim()));
self.addEventListener('fetch', e => {
  const u = new URL(e.request.url);
  if (u.pathname === '/hello') e.respondWith(new Response('hello from SW ' + VERSION, {headers: {'content-type': 'text/plain'}}));
});`;
const killSource = `
self.addEventListener('install', e => self.skipWaiting());
self.addEventListener('activate', e => e.waitUntil((async () => { await self.registration.unregister(); })()));`;

const server = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://x');
  log.push({ t: Date.now(), path: u.pathname, mode, sw: req.headers['service-worker'] || null, accept: req.headers['accept'] || null });
  if (u.pathname === '/') {
    res.writeHead(200, { 'content-type': 'text/html', 'cache-control': 'no-store' });
    res.end(`<!doctype html><meta charset=utf-8><title>t</title><script>navigator.serviceWorker.register('/sw.js').catch(e=>{window.__regErr=String(e)})</script>ok`);
  } else if (u.pathname === '/sw.js') {
    const h = { 'content-type': 'text/javascript', 'cache-control': 'public, max-age=31536000, immutable' };
    if (mode === 'v1') { res.writeHead(200, h); res.end(swSource('v1')); }
    else if (mode === 'v2') { res.writeHead(200, h); res.end(swSource('v2')); }
    else if (mode === 'kill') { res.writeHead(200, h); res.end(killSource); }
    else if (mode === '404') { res.writeHead(404, { 'content-type': 'text/plain' }); res.end('gone'); }
    else if (mode === '410') { res.writeHead(410, { 'content-type': 'text/plain' }); res.end('gone'); }
    else if (mode === '500') { res.writeHead(500, { 'content-type': 'text/plain' }); res.end('err'); }
    else { res.writeHead(500); res.end(); }
  } else if (u.pathname === '/hello') {
    res.writeHead(200, { 'content-type': 'text/plain' }); res.end('hello from NETWORK');
  } else { res.writeHead(404); res.end('nf'); }
});
await new Promise(r => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}`;
const out = { browser: which, version: null, steps: [] };
const step = (name, data) => { out.steps.push({ name, ...data }); };
const hits = (p) => log.filter(l => l.path === p).length;

const browser = await engines[which].launch({ headless: true });
out.version = browser.version();
try {
  const ctx = await browser.newContext({ serviceWorkers: 'allow' });
  const page = await ctx.newPage();
  await page.goto(base + '/');
  await page.evaluate(async () => { await navigator.serviceWorker.ready; });
  await page.waitForTimeout(300);
  await page.reload();            // now controlled by the SW
  await page.waitForTimeout(300);
  const controlled = await page.evaluate(() => !!navigator.serviceWorker.controller);
  const helloBefore = hits('/hello');
  const r1 = await page.evaluate(() => fetch('/hello').then(r => r.text()));
  step('A. installed + controlling; page fetches /hello', { controlled, answer: r1, edgeHelloHitsDuringSWAnswer: hits('/hello') - helloBefore, swJsHitsSoFar: hits('/sw.js') });

  const swBeforeNav = hits('/sw.js');
  await page.reload(); await page.waitForTimeout(500);
  step('B. plain reload (fresh registration, <24h)', { newSwJsRequestsOnNavigation: hits('/sw.js') - swBeforeNav });

  const tryUpdate = async () => page.evaluate(async () => {
    const reg = await navigator.serviceWorker.getRegistration();
    let upd; try { await reg.update(); upd = 'resolved'; } catch (e) { upd = 'rejected: ' + e.name; }
    await new Promise(r => setTimeout(r, 600));
    const reg2 = await navigator.serviceWorker.getRegistration();
    let hello; try { hello = await fetch('/hello').then(r => r.text()); } catch (e) { hello = 'ERR ' + e; }
    return { update: upd, registrationStillPresent: !!reg2, activeScriptURL: reg2 && reg2.active && reg2.active.scriptURL, hello };
  });

  for (const m of ['404', '410', '500']) {
    mode = m;
    const before = hits('/sw.js');
    const r = await tryUpdate();
    step(`C. edge answers ${m} for /sw.js, then registration.update()`, { ...r, swJsRequestsDuringUpdate: hits('/sw.js') - before });
  }

  mode = 'v2';
  { const before = hits('/sw.js'); const r = await tryUpdate();
    step('D. edge serves NEW 200 script (v2) with Cache-Control: max-age=1y immutable, then update()', { ...r, swJsRequestsDuringUpdate: hits('/sw.js') - before }); }

  mode = 'kill';
  { const before = hits('/sw.js');
    const r = await page.evaluate(async () => {
      const reg = await navigator.serviceWorker.getRegistration();
      let upd; try { await reg.update(); upd = 'resolved'; } catch (e) { upd = 'rejected: ' + e.name; }
      await new Promise(r => setTimeout(r, 1500));
      const reg2 = await navigator.serviceWorker.getRegistration();
      return { update: upd, registrationStillPresent: !!reg2 };
    });
    await page.reload(); await page.waitForTimeout(500);
    const helloBefore2 = hits('/hello');
    const afterReload = await page.evaluate(() => fetch('/hello').then(r => r.text()));
    step('E. edge serves 200 self-unregistering "kill" script, then update(); reload; fetch /hello', { ...r, swJsRequestsDuringUpdate: hits('/sw.js') - before, controlledAfterReload: await page.evaluate(() => !!navigator.serviceWorker.controller), helloAfterReload: afterReload, edgeHelloHitsNow: hits('/hello') - helloBefore2 });
  }

  // First-install case: a brand-new visitor when the edge refuses the script
  mode = '410';
  const ctx2 = await browser.newContext({ serviceWorkers: 'allow' });
  const p2 = await ctx2.newPage();
  await p2.goto(base + '/'); await p2.waitForTimeout(800);
  const first = await p2.evaluate(async () => ({ regErr: window.__regErr || null, registration: !!(await navigator.serviceWorker.getRegistration()) }));
  step('F. brand-new visitor while edge answers 410 for /sw.js', first);
} catch (e) {
  out.error = String(e && e.stack || e);
} finally {
  await browser.close(); server.close();
}
console.log(JSON.stringify(out, null, 1));
