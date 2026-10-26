// E5 re-run with request logging: does the browser re-fetch /sw.js on navigation, and how long does a returning visitor stay on the old precached site?
import http from 'node:http';
import { pathToFileURL } from 'node:url';
const _pw = await import(new URL('../../../../../node_modules/playwright/index.mjs', import.meta.url).href);
const chromium = _pw[process.env.ENGINE || 'chromium'];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const legacySW = `const C='legacy-precache-v1';self.addEventListener('install',e=>e.waitUntil(caches.open(C).then(c=>c.add('/'))));self.addEventListener('activate',e=>e.waitUntil(clients.claim()));self.addEventListener('fetch',e=>{const r=e.request;if(r.mode==='navigate'){e.respondWith(caches.match('/').then(m=>m||fetch(r)))}});`;
const loaderSW = (skip) => `${skip ? "self.addEventListener('install',()=>self.skipWaiting());" : ''}self.addEventListener('activate',e=>e.waitUntil((async()=>{for(const k of await caches.keys()){if(!k.startsWith('mw-'))await caches.delete(k)}${skip ? 'await clients.claim();' : ''}})()));self.addEventListener('fetch',e=>{});`;
const state = { sw: 'legacy', html: 'OLD SITE', skip: true, swHits: [] , cacheControl: 'no-cache'};
const srv = http.createServer((q, r) => {
  const p = new URL(q.url, 'http://x').pathname;
  if (p === '/sw.js') { state.swHits.push({ t: Date.now(), hdr: q.headers['service-worker'] || '', cc: q.headers['cache-control'] || '', ims: q.headers['if-none-match'] || q.headers['if-modified-since'] || '' }); r.writeHead(200, { 'content-type': 'text/javascript', 'cache-control': state.cacheControl }); return r.end(state.sw === 'legacy' ? legacySW : loaderSW(state.skip)); }
  if (p === '/sw-loader.js') { state.swHits.push({ t: Date.now(), hdr: 'loader-url' }); r.writeHead(200, { 'content-type': 'text/javascript', 'cache-control': 'no-cache' }); return r.end(loaderSW(true)); }
  if (p === '/') { r.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); return r.end(`<!doctype html><title>${state.html.replace(/<.*/,'').trim()}</title><body>${state.html}`); }
  r.writeHead(404); r.end('nf');
});
await new Promise((r) => srv.listen(0, '127.0.0.1', r));
const origin = 'http://127.0.0.1:' + srv.address().port;
const browser = await chromium.launch();
const go = async (page, path) => { for (let i = 0; i < 6; i++) { try { return await page.goto(origin + path); } catch (e) { await sleep(2000); } } };
const info = (page) => page.evaluate(async () => { const c = navigator.serviceWorker.controller; const rs = await navigator.serviceWorker.getRegistrations(); return { title: document.title, controller: c && c.scriptURL.replace(location.origin, ''), caches: await caches.keys(), regs: rs.map((r) => ({ active: r.active && r.active.state, waiting: !!r.waiting, installing: !!r.installing })) }; });
const out = [];
for (const variant of [{ name: 'same-URL loader SW WITHOUT skipWaiting/claim', skip: false, cc: 'no-cache' }, { name: 'loader SW at NEW URL /sw-loader.js; old /sw.js left byte-identical', skip: true, cc: 'no-cache', newUrl: true }]) {
  const ctx = await browser.newContext(); const page = await ctx.newPage();
  Object.assign(state, { sw: 'legacy', html: 'OLD SITE', skip: variant.skip, cacheControl: 'no-cache', swHits: [] });
  await go(page, '/'); await page.evaluate(() => navigator.serviceWorker.register('/sw.js', { scope: '/' }).then(() => navigator.serviceWorker.ready)); await sleep(700);
  state.swHits = [];
  Object.assign(state, { sw: variant.newUrl ? 'legacy' : 'loader', html: variant.newUrl ? 'NEW SITE <script>navigator.serviceWorker.register("/sw-loader.js")</script>' : 'NEW SITE', cacheControl: variant.cc });
  const rows = [];
  for (let i = 1; i <= 6; i++) {
    const before = state.swHits.length;
    await go(page, '/'); await sleep(1500);
    const inf = await info(page);
    rows.push(`nav #${i}: shown="${inf.title}" controller=${inf.controller} caches=${JSON.stringify(inf.caches)} /sw.js fetched during this nav: ${state.swHits.length - before}`);
  }
  // explicit update()
  const before = state.swHits.length;
  await page.evaluate(async () => { const r = await navigator.serviceWorker.getRegistration(); await r.update(); }); await sleep(1200);
  await go(page, '/'); await sleep(1200); const inf = await info(page);
  rows.push(`after explicit registration.update() + nav: shown="${inf.title}" controller=${inf.controller} caches=${JSON.stringify(inf.caches)} /sw.js hits=${state.swHits.length - before}`);
  out.push({ variant: variant.name, rows }); await ctx.close();
}
await browser.close(); srv.close();
console.log(JSON.stringify(out, null, 1));
