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


const results = { chromium: version }
const rel = (t0) => Date.now() - t0

// ---- S0': when does Chromium re-fetch sw.js after a navigation? (broken SW answers navigations from cache)
{
  const { ctx, page } = await freshContext('broken')
  results.S0 = []
  for (let i = 0; i < 3; i++) {
    state.hits = []
    const t0 = Date.now()
    await page.goto(origin + '/?n=' + i + '&noreg=1')
    let first = null
    for (let k = 0; k < 40 && first === null; k++) { await sleep(250); const h = state.hits.find(x => x.path === '/sw.js'); if (h) first = h.t - t0 }
    results.S0.push({ nav: i, swScriptFetchedMsAfterGoto: first, headers: state.hits.filter(h => h.path === '/sw.js').map(h => ({ serviceWorkerHeader: h.sw, secFetchDest: h.dest })) })
    await sleep(500)
  }
  // quick successive navigations (600 ms apart)
  state.hits = []
  for (let i = 0; i < 3; i++) { await page.goto(origin + '/?q=' + i + '&noreg=1'); await sleep(600) }
  results.S0_rapid_3_navigations_600ms_apart_swFetches = state.hits.filter(h => h.path === '/sw.js').length
  await sleep(4000)
  results.S0_rapid_followup_after_4s_total_swFetches = state.hits.filter(h => h.path === '/sw.js').length
  await ctx.close()
}

// ---- S2': Clear-Site-Data variants on the sw.js response; page script does not re-register (noreg)
for (const [label, header] of [['"storage"', '"storage"'], ['"cache" only', '"cache"'], ['"cookies" only', '"cookies"'], ['no header (control)', null]]) {
  const { ctx, page } = await freshContext('broken')
  state.csdSw = header
  await page.goto(origin + '/?s2=1&noreg=1'); await sleep(3500)
  results['S2_CSD_on_sw_js: ' + label] = await probe(page)
  await ctx.close()
}

// ---- S3': Clear-Site-Data on a navigation response
for (const [label, swMode, csd] of [['control: SW passthru, NO header', 'passthru', null], ['SW respondWith(fetch(request)) + header', 'passthru', '"storage"'], ['SW without fetch handler + header', 'nohandler', '"storage"'], ['SW synthesizes the response incl. header', 'synth', null]]) {
  const { ctx, page } = await freshContext(swMode)
  state.csdNav = csd
  await page.goto(origin + '/?s3=1&noreg=1'); await sleep(1500)
  let p = null
  try { p = await probe(page) } catch (e) { p = { err: e.message } }
  results['S3_CSD_on_navigation: ' + label] = p
  await ctx.close()
}

// ---- S6: failed new SW versions keep the previous one; a new SW whose fetch handler throws is healed by the next deploy
for (const bad of ['syntaxerr', 'installfail']) {
  const { ctx, page } = await freshContext('broken')
  state.sw = bad
  const r = await page.evaluate(async () => { try { const reg = await navigator.serviceWorker.getRegistration(); await reg.update(); return 'update() resolved; installing=' + !!reg.installing + ' waiting=' + !!reg.waiting + ' active=' + (reg.active && reg.active.state) } catch (e) { return 'update() rejected: ' + e.name } })
  await sleep(800)
  results['S6_' + bad] = { updateResult: r, afterNav: await (async () => { await page.goto(origin + '/?s6=1&noreg=1'); return probe(page) })() }
  await ctx.close()
}
{
  const { ctx, page } = await freshContext('broken')
  state.sw = 'fetchthrow'          // deploy a SW whose navigation handler rejects
  await page.goto(origin + '/?s6b=1&noreg=1'); await sleep(3500)   // update check + skipWaiting activation
  const afterBug = await page.goto(origin + '/?s6b2=1&noreg=1').then(() => 'navigation OK').catch(e => 'navigation failed: ' + e.message.split('\n')[0])
  results.S6_fetchthrow_afterBugDeployed = afterBug
  state.sw = 'nohandler'           // deploy the fix (valid sw.js, no navigation handler)
  state.hits = []
  const t0 = Date.now()
  let healed = null; let attempts = 0
  for (let k = 0; k < 30; k++) {
    attempts++
    const r = await page.goto(origin + '/?probe=' + k + '&noreg=1').then(() => page.evaluate(() => document.body.innerText.trim().slice(0, 40))).catch(() => 'err')
    if (r === 'HEALTHY-NETWORK-PAGE') { healed = Date.now() - t0; break }
    await sleep(400)
  }
  results.S6_fetchthrow_healed = { afterMs: healed, navigationAttempts: attempts, swScriptFetches: state.hits.filter(h => h.path === '/sw.js').length }
  await ctx.close()
}

console.log(JSON.stringify(results, null, 2))
await browser.close(); server.close(); process.exit(0)
