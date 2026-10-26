import http from 'node:http';
import { pathToFileURL } from 'node:url';
const _pw = await import(new URL('../../../../../node_modules/playwright/index.mjs', import.meta.url).href);
const chromium = _pw[process.env.ENGINE || 'chromium'];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const sw = (n) => `self.addEventListener('install',()=>self.skipWaiting());self.addEventListener('activate',e=>e.waitUntil(clients.claim()));self.addEventListener('fetch',e=>{if(new URL(e.request.url).pathname==='/whoami')e.respondWith(new Response(${JSON.stringify(n)}))});`;
let allowHeader = false;
const srv = http.createServer((q, r) => {
  const p = new URL(q.url, 'http://x').pathname;
  const js = (b, h = {}) => { r.writeHead(200, { 'content-type': 'text/javascript', 'cache-control': 'no-cache', ...h }); r.end(b); };
  if (p === '/sw-ours.js') return js(sw('OURS'));
  if (p === '/app/sw-site.js') return js(sw('SITE'));
  if (p === '/repo/mw-sw.js') return js(sw('REPO'), allowHeader ? { 'Service-Worker-Allowed': '/' } : {});
  if (p === '/modals.html') { r.writeHead(200, { 'content-type': 'text/html' }); return r.end(`<!doctype html><script>
    const out = {}; 
    try { out.confirm = confirm('delete?'); } catch (e) { out.confirm = 'ERR ' + e.name; }
    try { out.prompt = prompt('x', 'dflt'); } catch (e) { out.prompt = 'ERR ' + e.name; }
    try { out.alert = alert('x'); } catch (e) { out.alert = 'ERR ' + e.name; }
    try { out.print = (print(), 'returned'); } catch (e) { out.print = 'ERR ' + e.name; }
    parent.postMessage({ modals: out }, '*');<\/script>`); }
  r.writeHead(200, { 'content-type': 'text/html' }); r.end('<!doctype html><title>t</title><body>page');
});
await new Promise((r) => srv.listen(0, '127.0.0.1', r));
const origin = 'http://127.0.0.1:' + srv.address().port;
const browser = await chromium.launch(); const R = {};
const go = async (page, path) => { for (let i = 0; i < 6; i++) { try { return await page.goto(origin + path); } catch (e) { await sleep(2000); } } };
// ---- A: getRegistration('/') vs getRegistration(page URL)
{
  const ctx = await browser.newContext(); const page = await ctx.newPage(); await go(page, '/app/x');
  const reg = (s, sc) => page.evaluate(async ([s, sc]) => { const r = await navigator.serviceWorker.register(s, { scope: sc }); await new Promise((res) => setTimeout(res, 700)); return r.scope.replace(location.origin, ''); }, [s, sc]);
  const probe = () => page.evaluate(async () => { const a = await navigator.serviceWorker.getRegistration('/'); const b = await navigator.serviceWorker.getRegistration(location.href); const all = (await navigator.serviceWorker.getRegistrations()).map((r) => r.scope.replace(location.origin, '')); return { "getRegistration('/')": a ? a.scope.replace(location.origin, '') : null, 'getRegistration(location.href)': b ? b.scope.replace(location.origin, '') : null, getRegistrations: all }; });
  const A = {};
  A.registered_site_only = await reg('/app/sw-site.js', '/app/');
  await go(page, '/app/x'); A.only_site_registration_at_app = await probe();
  A.registered_ours = await reg('/sw-ours.js', '/');
  await go(page, '/app/x'); A.both_registrations = await probe();
  A.controller_of_app_page = await page.evaluate(() => navigator.serviceWorker.controller && navigator.serviceWorker.controller.scriptURL.replace(location.origin, ''));
  A.whoami_on_app_page = await page.evaluate(async () => (await fetch('/whoami')).text());
  R.A_getRegistration_semantics = A; await ctx.close();
}
// ---- B: non-root SW mount
{
  const out = {};
  for (const hdr of [false, true]) {
    allowHeader = hdr; const ctx = await browser.newContext(); const page = await ctx.newPage(); await go(page, '/repo/index.html');
    out['Service-Worker-Allowed header=' + hdr] = await page.evaluate(async () => {
      const res = {};
      try { const r = await navigator.serviceWorker.register('/repo/mw-sw.js'); res.defaultScope = r.scope.replace(location.origin, ''); } catch (e) { res.defaultScope = 'ERR ' + e.name; }
      try { const r = await navigator.serviceWorker.register('/repo/mw-sw.js', { scope: '/' }); res.scopeRoot = r.scope.replace(location.origin, ''); } catch (e) { res.scopeRoot = 'ERR ' + e.name + ': ' + e.message.slice(0, 90); }
      return res;
    }); await ctx.close();
  }
  R.B_nonroot_sw_scope = out;
}
// ---- C: sandbox allow-modals
{
  const out = {};
  for (const flags of ['allow-scripts allow-same-origin allow-forms allow-popups allow-downloads allow-top-navigation-by-user-activation', 'allow-scripts allow-same-origin allow-forms allow-popups allow-downloads allow-top-navigation-by-user-activation allow-modals']) {
    const ctx = await browser.newContext(); const page = await ctx.newPage(); const msgs = [];
    page.on('console', (m) => msgs.push(m.text().slice(0, 140))); page.on('dialog', (d) => { msgs.push('DIALOG:' + d.type()); d.dismiss().catch(() => {}); });
    await go(page, '/');
    const res = await page.evaluate((fl) => new Promise((resolve) => { addEventListener('message', (e) => resolve(e.data.modals)); const f = document.createElement('iframe'); f.setAttribute('sandbox', fl); f.src = '/modals.html'; document.body.appendChild(f); setTimeout(() => resolve('timeout'), 6000); }), flags);
    out[flags.includes('allow-modals') ? 'with allow-modals' : 'v0.2 flags (no allow-modals)'] = { result: res, console: msgs.filter((m) => /sandbox|modal|Ignored|DIALOG/i.test(m)) }; await ctx.close();
  }
  R.C_sandbox_modals = out;
}
await browser.close(); srv.close();
console.log(JSON.stringify(R, null, 1));
