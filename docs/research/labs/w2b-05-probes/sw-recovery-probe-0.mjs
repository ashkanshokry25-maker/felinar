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
  if ('serviceWorker' in navigator) { try { await navigator.serviceWorker.register('/sw.js', { updateViaCache: 'none' }) } catch (e) { window.__regErr = String(e) } }
})()
</script>`

const server = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://x')
  state.hits.push({ path: u.pathname, sw: req.headers['service-worker'] || null, dest: req.headers['sec-fetch-dest'] || null, t: Date.now() })
  if (u.pathname === '/sw.js') {
    if (state.sw === 'redirect') { res.writeHead(301, { Location: '/sw2.js' }); return res.end() }
    if (state.sw === 'html404') { res.writeHead(200, { 'content-type': 'text/html' }); return res.end('<!doctype html>not a script') }
    const body = { broken: SW_BROKEN, passthru: SW_PASSTHRU, nohandler: SW_NOHANDLER, tomb: SW_TOMB }[state.sw]
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
const results = { chromium: version }

// ---- S0: is sw.js re-fetched on every navigation? (broken SW answers navigations from cache)
{
  const { ctx, page } = await freshContext('broken')
  results.S0 = { afterSetup: await probe(page) }
  state.hits = []
  for (let i = 0; i < 3; i++) { await page.goto(origin + '/?n=' + i); await sleep(600) }
  results.S0.swScriptFetchesDuring3Navigations = state.hits.filter(h => h.path === '/sw.js').length
  results.S0.swScriptRequestHeaders = state.hits.filter(h => h.path === '/sw.js').map(h => ({ serviceWorkerHeader: h.sw, secFetchDest: h.dest }))
  results.S0.navigationsServedBySw = (await probe(page)).text
  await ctx.close()
}

// ---- S1: self-destroying tombstone SW recovers a bricked SW
{
  const { ctx, page } = await freshContext('broken')
  state.sw = 'tomb'; state.hits = []
  const t0 = Date.now()
  await page.goto(origin + '/?s1=1')
  const first = await probe(page) // what user sees on first navigation after the fix is deployed
  let recoveredAfterMs = null; let last = null
  for (let i = 0; i < 40; i++) { await sleep(250); try { last = await probe(page) } catch (_) { continue } if (last.text === 'HEALTHY-NETWORK-PAGE' && last.regs === 0) { recoveredAfterMs = Date.now() - t0; break } }
  results.S1_tombstone = { firstNavigationShows: first.text, recoveredAfterMs, final: last }
  await ctx.close()
}

// ---- S2: Clear-Site-Data on the sw.js UPDATE response (spec 1.1.4 "kill switch")
for (const [label, header, newSw] of [['storage, same bytes', '"storage"', 'broken'], ['storage, new bytes', '"storage"', 'nohandler'], ['cache+storage, new bytes', '"cache", "storage"', 'nohandler'], ['wildcard, new bytes', '"*"', 'nohandler']]) {
  const { ctx, page } = await freshContext('broken')
  state.sw = newSw; state.csdSw = header
  await page.goto(origin + '/?s2=1'); await sleep(2500)
  let p = null
  try { p = await probe(page) } catch (e) { p = { err: e.message } }
  results['S2_CSD_on_sw_js: ' + label] = p
  await ctx.close()
}

// ---- S3: Clear-Site-Data on a navigation response: served via SW respondWith(fetch) vs. no respondWith
for (const [label, swMode] of [['SW respondWith(fetch(request))', 'passthru'], ['SW without fetch handler (network direct)', 'nohandler']]) {
  const { ctx, page } = await freshContext(swMode)
  state.csdNav = '"storage"'
  await page.goto(origin + '/?s3=1'); await sleep(1500)
  let p = null
  try { p = await probe(page) } catch (e) { p = { err: e.message } }
  results['S3_CSD_on_navigation: ' + label] = p
  await ctx.close()
}

// ---- S4: sw.js update failures keep the old SW (redirect / wrong MIME)
for (const bad of ['redirect', 'html404']) {
  const { ctx, page } = await freshContext('broken')
  state.sw = bad
  let updateResult = null
  updateResult = await page.evaluate(async () => { try { const r = await navigator.serviceWorker.getRegistration(); await r.update(); return 'update() resolved' } catch (e) { return 'update() rejected: ' + e.name + ': ' + e.message.slice(0, 120) } })
  await page.goto(origin + '/?s4=1'); await sleep(800)
  results['S4_' + bad] = { updateResult, afterNav: await probe(page) }
  await ctx.close()
}

console.log(JSON.stringify(results, null, 2))
await browser.close(); server.close(); process.exit(0)
