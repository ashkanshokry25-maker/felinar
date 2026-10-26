// Service-worker coexistence lab. One origin, several SW scripts, observed with real Chromium.
import http from 'node:http';
import { pathToFileURL } from 'node:url';
const _pw = await import(new URL('../../../../../node_modules/playwright/index.mjs', import.meta.url).href);
const chromium = _pw[process.env.ENGINE || 'chromium'];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const swNamed = (name) => `self.addEventListener('install',()=>self.skipWaiting());self.addEventListener('activate',e=>e.waitUntil(clients.claim()));self.addEventListener('fetch',e=>{if(new URL(e.request.url).pathname==='/whoami')e.respondWith(new Response(${JSON.stringify(name)}))});`;
// old site's SW: precaches the HTML shell and serves navigations cache-first (Workbox/CRA/next-pwa style)
const legacySW = `const C='legacy-precache-v1';self.addEventListener('install',e=>e.waitUntil(caches.open(C).then(c=>c.add('/'))));self.addEventListener('activate',e=>e.waitUntil(clients.claim()));self.addEventListener('fetch',e=>{const r=e.request;if(r.mode==='navigate'){e.respondWith(caches.match('/').then(m=>m||fetch(r)))}});`;
// loader SW at the same URL: takes over immediately, deletes foreign caches
const loaderSW = (skip) => `${skip ? "self.addEventListener('install',()=>self.skipWaiting());" : ''}self.addEventListener('activate',e=>e.waitUntil((async()=>{for(const k of await caches.keys()){if(!k.startsWith('mw-'))await caches.delete(k)}${skip ? 'await clients.claim();' : ''}})()));self.addEventListener('fetch',e=>{if(new URL(e.request.url).pathname==='/whoami')e.respondWith(new Response('LOADER'))});`;
const state = { sw: 'legacy', html: 'OLD SITE', skip: true };
const srv = http.createServer((q, r) => {
  const p = new URL(q.url, 'http://x').pathname;
  const js = (b) => { r.writeHead(200, { 'content-type': 'text/javascript', 'cache-control': 'no-cache' }); r.end(b); };
  const html = (b) => { r.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); r.end(b); };
  if (p === '/sw-a.js') return js(swNamed('A'));
  if (p === '/sw-b.js') return js(swNamed('B'));
  if (p === '/sw-c.js') return js(swNamed('C'));
  if (p === '/core.js') return js(`self.addEventListener('fetch',e=>{const u=new URL(e.request.url).pathname;if(u==='/mw-core'||u==='/both')e.respondWith(new Response('CORE'))});`);
  if (p === '/sw-x.js') return js(`importScripts('/core.js');self.addEventListener('install',()=>self.skipWaiting());self.addEventListener('activate',e=>e.waitUntil(clients.claim()));self.addEventListener('fetch',e=>{const u=new URL(e.request.url).pathname;if(u==='/whoami'||u==='/both')e.respondWith(new Response('X'))});`);
  if (p === '/w.js') return js(`fetch('/whoami').then(r=>r.text()).then(t=>postMessage(t))`);
  if (p === '/sw.js') return js(state.sw === 'legacy' ? legacySW : loaderSW(state.skip));
  if (p === '/' || p === '/app/x' || p.startsWith('/page')) return html(`<!doctype html><title>${state.html}</title><body>${state.html}`);
  r.writeHead(404); r.end('nf');
});
await new Promise((r) => srv.listen(0, '127.0.0.1', r));
const origin = 'http://127.0.0.1:' + srv.address().port;
const browser = await chromium.launch();
const go = async (page, path) => { for (let i = 0; i < 6; i++) { try { return await page.goto(origin + path); } catch (e) { await sleep(2000); } } };
const reg = (page, script, scope) => page.evaluate(async ([s, sc]) => { try { const r = await navigator.serviceWorker.register(s, sc ? { scope: sc } : undefined); await new Promise((res) => setTimeout(res, 600)); const w = r.active || r.waiting || r.installing; return { scope: r.scope.replace(location.origin, ''), script: w ? w.scriptURL.replace(location.origin, '') : null, state: w && w.state, installing: !!r.installing, waiting: !!r.waiting }; } catch (e) { return { error: e.name + ': ' + e.message.slice(0, 100) }; } }, [script, scope]);
const regs = (page) => page.evaluate(async () => (await navigator.serviceWorker.getRegistrations()).map((r) => r.scope.replace(location.origin, '') + ' -> ' + ((r.active || r.waiting || r.installing) || {}).scriptURL?.replace(location.origin, '')));
const who = (page, p = '/whoami') => page.evaluate(async (u) => { try { return await (await fetch(u)).text(); } catch (e) { return 'ERR'; } }, p);
const R = {};

// ---- E1: two scripts for the SAME scope: last register() wins; alternating page loads flip-flop
{
  const ctx = await browser.newContext(); const page = await ctx.newPage(); const steps = [];
  await go(page, '/'); steps.push(['page A registers /sw-a.js', await reg(page, '/sw-a.js', '/')]); steps.push(['whoami', await who(page)]);
  await go(page, '/page-b'); steps.push(['page B registers /sw-b.js (same scope /)', await reg(page, '/sw-b.js', '/')]); steps.push(['whoami (still same tab, after claim)', await who(page)]); steps.push(['getRegistrations', await regs(page)]);
  await go(page, '/'); steps.push(['page A again registers /sw-a.js', await reg(page, '/sw-a.js', '/')]); steps.push(['whoami', await who(page)]);
  await go(page, '/page-b'); steps.push(['page B again', await reg(page, '/sw-b.js', '/')]); steps.push(['whoami', await who(page)]); steps.push(['getRegistrations', await regs(page)]);
  R.E1_same_scope_replace_and_flipflop = steps; await ctx.close();
}
// ---- E2: same script URL again is a no-op
{
  const ctx = await browser.newContext(); const page = await ctx.newPage(); await go(page, '/');
  const a = await reg(page, '/sw-a.js', '/'); const b = await reg(page, '/sw-a.js', '/');
  R.E2_same_script_url_noop = { first: a, second: b }; await ctx.close();
}
// ---- E3: scope separation, longest-scope match, controlled clients send ALL fetches to their SW, workers matched by script URL
{
  const ctx = await browser.newContext(); const page = await ctx.newPage(); await go(page, '/');
  const out = {};
  out.regA = await reg(page, '/sw-a.js', '/'); out.regC = await reg(page, '/sw-c.js', '/app/');
  await go(page, '/'); out.page_root_whoami = await who(page); out.page_root_controller = await page.evaluate(() => navigator.serviceWorker.controller && navigator.serviceWorker.controller.scriptURL.replace(location.origin, ''));
  await go(page, '/app/x'); out.page_app_controller = await page.evaluate(() => navigator.serviceWorker.controller && navigator.serviceWorker.controller.scriptURL.replace(location.origin, ''));
  out.page_app_whoami_outside_scope_url = await who(page, '/whoami');
  out.worker_from_app_page_with_script_outside_app_scope = await page.evaluate(() => new Promise((res) => { const w = new Worker('/w.js'); w.onmessage = (e) => res(e.data); setTimeout(() => res('timeout'), 4000); }));
  R.E3_scope_separation = out; await ctx.close();
}
// ---- E4: compose via importScripts in ONE SW: both fetch listeners run, first respondWith wins
{
  const ctx = await browser.newContext(); const page = await ctx.newPage(); await go(page, '/');
  const out = { reg: await reg(page, '/sw-x.js', '/') }; await go(page, '/');
  out.whoami_from_site_listener = await who(page, '/whoami'); out.mw_core_from_imported_listener = await who(page, '/mw-core'); out.both_first_registered_wins = await who(page, '/both');
  R.E4_importScripts_compose = out; await ctx.close();
}
// ---- E5: migrating a site that already has a precaching SW
for (const variant of ['same-URL loader SW, skipWaiting+claim', 'same-URL loader SW, NO skipWaiting', 'loader SW at a NEW URL, old /sw.js left untouched']) {
  const ctx = await browser.newContext(); const page = await ctx.newPage();
  state.sw = 'legacy'; state.html = 'OLD SITE'; state.skip = true;
  await go(page, '/'); await reg(page, '/sw.js', '/'); await sleep(500);
  const seq = [];
  await go(page, '/'); seq.push('visit with old SW installed: ' + await page.title());
  // deploy the migration
  state.html = 'NEW SITE (loads loader)'; 
  if (variant.startsWith('same-URL')) { state.sw = 'loader'; state.skip = variant.includes('skipWaiting+claim'); }
  for (let i = 1; i <= 4; i++) {
    await go(page, '/'); await sleep(900);
    const t = await page.title();
    const ctl = await page.evaluate(() => navigator.serviceWorker.controller && navigator.serviceWorker.controller.scriptURL.replace(location.origin, ''));
    const caches_ = await page.evaluate(async () => await caches.keys());
    const rs = await regs(page);
    seq.push(`visit after deploy #${i}: title="${t}" controller=${ctl} caches=${JSON.stringify(caches_)} registrations=${JSON.stringify(rs)}`);
    if (variant.startsWith('loader SW at a NEW URL') && t.startsWith('NEW')) { await reg(page, '/sw-b.js', '/'); }
  }
  R['E5_migration: ' + variant] = seq; await ctx.close();
}
await browser.close(); srv.close();
console.log(JSON.stringify(R, null, 1));
