// Does Chromium honour Clear-Site-Data on non-2xx responses (the edge answers 451 for denylisted labels)?
// Run: node csd-status-codes.mjs > results-csd-status-codes.json   (CSD_VALUE env overrides the header value, default "storage")
import http from 'node:http'
import { launchChrome } from './chrome.mjs'
const srv = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://x')
  if (u.pathname === '/sw.js') { res.writeHead(200, { 'content-type': 'text/javascript' }); return res.end("self.addEventListener('fetch',()=>{})") }
  if (u.pathname === '/csd') {
    const status = Number(u.searchParams.get('s') || 200)
    res.writeHead(status, { 'content-type': 'text/plain', 'clear-site-data': process.env.CSD_VALUE || '"storage"', 'cache-control': 'no-store' }); return res.end('x')
  }
  res.writeHead(200, { 'content-type': 'text/html', 'cache-control': 'no-store' }); res.end('<!doctype html><body>shell</body>')
})
await new Promise(r => srv.listen(0, '127.0.0.1', r)); const P = srv.address().port
const chrome = await launchChrome()
const results = []
for (const status of [200, 404, 410, 451, 500, 503]) {
  for (const via of ['fetch', 'navigation']) {
    const ctx = await chrome.browser.newContext(); const page = await ctx.newPage()
    const host = `s${status}${via}.c.localhost:${P}`
    await page.goto(`http://${host}/`)
    await page.evaluate(async () => { await navigator.serviceWorker.register('/sw.js'); await navigator.serviceWorker.ready; localStorage.setItem('k', 'v'); await caches.open('c') })
    if (via === 'fetch') await page.evaluate(async (s) => (await fetch('/csd?s=' + s, { cache: 'no-store' })).status, status)
    else { try { await page.goto(`http://${host}/csd?s=${status}`) } catch {} }
    await new Promise(r => setTimeout(r, 900))
    const check = await ctx.newPage(); await check.goto(`http://${host}/`)
    const after = await check.evaluate(async () => ({ registrations: (await navigator.serviceWorker.getRegistrations()).length, localStorage: localStorage.getItem('k'), caches: (await caches.keys()).length }))
    results.push({ status, via, cleared: after.registrations === 0 && after.localStorage === null && after.caches === 0, after })
    await ctx.close()
  }
}
console.log(JSON.stringify({ browser: chrome.browser.version(), when: new Date().toISOString(), csdValue: process.env.CSD_VALUE || '"storage"', results }, null, 2))
await chrome.close(); srv.close()
