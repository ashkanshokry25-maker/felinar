// How can a hub evict an ALREADY-INSTALLED Service Worker + its stored site data?
// Tested: update check with sw.js answering 404/410/451/500; a self-unregistering sw.js; Clear-Site-Data on a fetch() and on a navigation.
// Run: node takedown-mechanics.mjs > results-takedown-mechanics.json
import http from 'node:http'
import { launchChrome } from './chrome.mjs'
let swMode = 'ok', csdMode = 'storage'
const swOk = `self.addEventListener('install',e=>self.skipWaiting());self.addEventListener('activate',e=>e.waitUntil(clients.claim()));self.addEventListener('fetch',e=>{const u=new URL(e.request.url);if(u.pathname==='/swhello')e.respondWith(new Response('sw'))})`
const swKill = (nav) => `self.addEventListener('install',()=>self.skipWaiting());self.addEventListener('activate',e=>e.waitUntil((async()=>{await self.registration.unregister();${nav ? "(await clients.matchAll({type:'window'})).forEach(c=>c.navigate(c.url));" : ''}})()))`
const srv = http.createServer((req, res) => {
  const p = new URL(req.url, 'http://x').pathname
  if (p === '/sw.js') {
    const h = { 'content-type': 'text/javascript', 'cache-control': 'no-cache' }
    if (swMode === 'ok') { res.writeHead(200, h); return res.end(swOk) }
    if (swMode === 'killer') { res.writeHead(200, h); return res.end(swKill(true)) }
    if (swMode === 'killer-no-navigate') { res.writeHead(200, h); return res.end(swKill(false)) }
    res.writeHead(Number(swMode), { 'content-type': 'text/plain', 'cache-control': 'no-store' }); return res.end('x')
  }
  if (p === '/csd') { res.writeHead(200, { 'content-type': 'text/plain', 'clear-site-data': csdMode, 'cache-control': 'no-store' }); return res.end('csd') }
  res.writeHead(200, { 'content-type': 'text/html', 'cache-control': 'no-store' }); res.end('<!doctype html><body>shell</body>')
})
await new Promise(r => srv.listen(0, '127.0.0.1', r)); const P = srv.address().port
const chrome = await launchChrome()
const results = {}
async function fresh(label) {
  const ctx = await chrome.browser.newContext(); const page = await ctx.newPage()
  const host = `${label}.t.localhost:${P}`
  await page.goto(`http://${host}/`); swMode = 'ok'
  await page.evaluate(async () => {
    await navigator.serviceWorker.register('/sw.js'); await navigator.serviceWorker.ready
    if (!navigator.serviceWorker.controller) await new Promise(r => navigator.serviceWorker.addEventListener('controllerchange', r, { once: true }))
    localStorage.setItem('data', 'site-data'); await caches.open('site').then(c => c.put('/x', new Response('cached')))
    await new Promise(r => { const q = indexedDB.open('db', 1); q.onupgradeneeded = () => q.result.createObjectStore('s'); q.onsuccess = () => { q.result.transaction('s', 'readwrite').objectStore('s').put(1, 'k'); r() } })
  })
  return { ctx, page, host }
}
const snap = (page) => page.evaluate(async () => ({ registrations: (await navigator.serviceWorker.getRegistrations()).length, localStorage: localStorage.getItem('data'), cacheStorage: await caches.keys(), indexedDB: (await indexedDB.databases()).map(d => d.name) }))
const update = (page) => page.evaluate(async () => { const r = await navigator.serviceWorker.getRegistration(); try { await r.update(); return 'resolved' } catch (e) { return 'rejected' } })
for (const mode of ['404', '410', '451', '500', 'killer-no-navigate', 'killer']) {
  const { ctx, page } = await fresh('u' + mode); swMode = mode
  const u = await update(page); await new Promise(r => setTimeout(r, 1500))
  results[`sw.js answers ${mode}`] = { update: u, after: await snap(page) }
  await ctx.close()
}
for (const csd of ['"storage"', '"cache", "storage"', '"executionContexts"']) {
  const { ctx, page, host } = await fresh('c' + csd.replace(/\W/g, '')); csdMode = csd
  const status = await page.evaluate(async () => (await fetch('/csd', { cache: 'no-store' })).status); await new Promise(r => setTimeout(r, 800))
  const viaFetch = await snap(page)
  const nav = await ctx.newPage(); await nav.goto(`http://${host}/csd`); await new Promise(r => setTimeout(r, 800))
  const p3 = await ctx.newPage(); await p3.goto(`http://${host}/`)
  results[`Clear-Site-Data: ${csd}`] = { onFetch: { status, after: viaFetch }, onNavigation: { after: await snap(p3) } }
  await ctx.close()
}
console.log(JSON.stringify({ browser: chrome.browser.version(), when: new Date().toISOString(), results }, null, 2))
await chrome.close(); srv.close()
