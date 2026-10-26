// Scratchpad-only experiment harness: service-worker recovery / kill-switch behaviour in Chromium.
// Own code, written for docs/research/w2b-05. Run: node swkill.mjs
import http from 'node:http'
import { chromium } from '$HOME/Documents/Projects/magnet-web/node_modules/playwright/index.mjs'

const state = { sw: 'broken', csdSw: null, csdNav: null, navMode: 'network', hits: [] }

const SW_BROKEN = `
const C='mw-shell-v1';
self.addEventListener('install', e => e.waitUntil(caches.open(C).then(c=>c.put('/__shell', new Response('<!doctype html><title>x</title><p id=s>BROKEN-SW-SHELL</p>',{headers:{'content-type':'text/html'}}))).then(()=>self.skipWaiting())));
self.addEventListener('activate', e => e.waitUntil(self.clients.claim()));
self.addEventListener('fetch', e => { if (e.request.mode==='navigate') e.respondWith(caches.match('/__shell')); });
`
const SW_PASSTHRU = `
self.addEventListener('install', e => e.waitUntil(self.skipWaiting()));
self.addEventListener('activate', e => e.waitUntil(self.clients.claim()));
self.addEventListener('fetch', e => { if (e.request.mode==='navigate') e.respondWith(fetch(e.request)); });
`
const SW_NOHANDLER = `
self.addEventListener('install', e => e.waitUntil(self.skipWaiting()));
self.addEventListener('activate', e => e.waitUntil(self.clients.claim()));
`
const SW_SYNTH = `
self.addEventListener('install', e => e.waitUntil(self.skipWaiting()));
self.addEventListener('activate', e => e.waitUntil(self.clients.claim()));
self.addEventListener('fetch', e => { if (e.request.mode==='navigate') e.respondWith(new Response('<!doctype html><p id=s>SYNTHESIZED-BY-SW</p>', { headers: { 'content-type': 'text/html', 'clear-site-data': '"storage"' } })); });
`
const SW_SYNTAXERR = `self.addEventListener('install', e => { this is not valid javascript `
const SW_INSTALLFAIL = `self.addEventListener('install', e => e.waitUntil(Promise.reject(new Error('precache failed'))));`
const SW_FETCHTHROW = `
self.addEventListener('install', e => e.waitUntil(self.skipWaiting()));
self.addEventListener('activate', e => e.waitUntil(self.clients.claim()));
self.addEventListener('fetch', e => { if (e.request.mode==='navigate') e.respondWith(Promise.reject(new Error('handler bug'))); });
`
const SW_TOMB = `
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', e => e.waitUntil((async () => {
  const keys = await caches.keys(); await Promise.all(keys.map(k => caches.delete(k)));
  await self.registration.unregister();
  const cs = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
  cs.forEach(c => { try { c.navigate(c.url) } catch (_) {} });
})()));
`
const PAGE = `<!doctype html><meta charset=utf-8><title>swkill</title><body><p id=s>HEALTHY-NETWORK-PAGE</p>
<script>
window.__ready = (async () => {
  if ('serviceWorker' in navigator && !location.search.includes('noreg')) { try { await navigator.serviceWorker.register('/sw.js', { updateViaCache: 'none' }) } catch (e) { window.__regErr = String(e) } }
})()
</script>`

const server = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://x')
  state.hits.push({ path: u.pathname, sw: req.headers['service-worker'] || null, dest: req.headers['sec-fetch-dest'] || null, t: Date.now() })
  if (u.pathname === '/sw.js') {
    if (state.sw === 'redirect') { res.writeHead(301, { Location: '/sw2.js' }); return res.end() }
    if (state.sw === 'html404') { res.writeHead(200, { 'content-type': 'text/html' }); return res.end('<!doctype html>not a script') }
    const body = { broken: SW_BROKEN, passthru: SW_PASSTHRU, nohandler: SW_NOHANDLER, tomb: SW_TOMB, synth: SW_SYNTH, syntaxerr: SW_SYNTAXERR, installfail: SW_INSTALLFAIL, fetchthrow: SW_FETCHTHROW }[state.sw]
    const h = { 'content-type': 'text/javascript', 'cache-control': 'no-cache' }
    if (state.csdSw) h['clear-site-data'] = state.csdSw
    res.writeHead(200, h); return res.end(body)
  }
  if (u.pathname === '/sw2.js') { res.writeHead(200, { 'content-type': 'text/javascript' }); return res.end(SW_NOHANDLER) }
  if (u.pathname === '/' || u.pathname === '/index.html') {
    const h = { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' }
    if (state.csdNav) h['clear-site-data'] = state.csdNav
    res.writeHead(200, h); return res.end(PAGE)
  }
  res.writeHead(404); res.end('nf')
})
await new Promise(r => server.listen(0, '127.0.0.1', r))
const port = server.address().port
const origin = `http://localhost:${port}`

const browser = await chromium.launch({ headless: true })
const version = browser.version()
const sleep = ms => new Promise(r => setTimeout(r, ms))

async function probe (page) {
  return page.evaluate(async () => {
    const out = { text: document.body ? document.body.innerText.trim().slice(0, 40) : null }
    try { out.regs = (await navigator.serviceWorker.getRegistrations()).length } catch (e) { out.regs = 'ERR ' + e.message }
    out.controlled = !!navigator.serviceWorker.controller
    out.ls = localStorage.getItem('marker')
    out.caches = await caches.keys()
    out.idb = await new Promise(res => { const r = indexedDB.open('markerdb'); r.onsuccess = () => { const db = r.result; const has = db.objectStoreNames.contains('s'); if (!has) { db.close(); return res('empty-db') } const g = db.transaction('s').objectStore('s').get('k'); g.onsuccess = () => { db.close(); res(g.result || 'no-value') }; g.onerror = () => res('err') }; r.onerror = () => res('err') })
    return out
  })
}
async function plant (page) {
  await page.evaluate(async () => {
    localStorage.setItem('marker', 'ls-planted')
    await (await caches.open('user-data-cache')).put('/x', new Response('x'))
    await new Promise((res, rej) => { const r = indexedDB.open('markerdb', 1); r.onupgradeneeded = () => r.result.createObjectStore('s'); r.onsuccess = () => { const tx = r.result.transaction('s', 'readwrite'); tx.objectStore('s').put('idb-planted', 'k'); tx.oncomplete = () => { r.result.close(); res() } }; r.onerror = () => rej(r.error) })
  })
}
async function freshContext (swMode) {
  state.sw = swMode; state.csdSw = null; state.csdNav = null; state.hits = []
  const ctx = await browser.newContext()
  const page = await ctx.newPage()
  await page.goto(origin + '/')
  await page.evaluate(() => window.__ready)
  await page.waitForFunction(async () => { const r = await navigator.serviceWorker.getRegistration(); return r && r.active }, null, { timeout: 10000 })
  await page.reload() // now controlled
  await plant(page)
  return { ctx, page }
}
const swHits = () => state.hits.filter(h => h.path === '/sw.js').length



const results = { chromium: version, runs: [] }
for (let i = 0; i < 6; i++) {
  const { ctx, page } = await freshContext('broken')
  // (a) first sw.js fetch after a plain navigation
  state.hits = []
  const t0 = Date.now()
  await page.goto(origin + '/?t=' + i + '&noreg=1')
  let first = null
  for (let k = 0; k < 60 && first === null; k++) { await sleep(100); const h = state.hits.find(x => x.path === '/sw.js'); if (h) first = h.t - t0 }
  // (b) tombstone recovery
  state.sw = 'tomb'; state.hits = []
  const t1 = Date.now()
  await page.goto(origin + '/?r=' + i + '&noreg=1')
  let rec = null
  for (let k = 0; k < 80; k++) { await sleep(100); let p; try { p = await probe(page) } catch (_) { continue } if (p.text === 'HEALTHY-NETWORK-PAGE' && p.regs === 0) { rec = Date.now() - t1; break } }
  results.runs.push({ run: i, firstSwScriptFetchMsAfterGoto: first, tombstoneRecoveryMs: rec })
  await ctx.close()
}
const med = (a) => { const b = a.filter(x => x != null).sort((x, y) => x - y); return b.length ? b[Math.floor(b.length / 2)] : null }
results.median = { firstSwScriptFetchMsAfterGoto: med(results.runs.map(r => r.firstSwScriptFetchMsAfterGoto)), tombstoneRecoveryMs: med(results.runs.map(r => r.tombstoneRecoveryMs)) }
results.min = { firstFetch: Math.min(...results.runs.map(r => r.firstSwScriptFetchMsAfterGoto ?? 1e9)), recovery: Math.min(...results.runs.map(r => r.tombstoneRecoveryMs ?? 1e9)) }
results.max = { firstFetch: Math.max(...results.runs.map(r => r.firstSwScriptFetchMsAfterGoto ?? -1)), recovery: Math.max(...results.runs.map(r => r.tombstoneRecoveryMs ?? -1)) }
console.log(JSON.stringify(results, null, 1))
await browser.close(); server.close(); process.exit(0)
