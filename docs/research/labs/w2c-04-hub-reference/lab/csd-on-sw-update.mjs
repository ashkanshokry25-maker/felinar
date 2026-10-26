// Does Clear-Site-Data on the Service Worker script response (update check) evict an installed worker and its data, including when the
// response is a non-2xx such as 451? (w2b-05 F20 measured the 200 case; the edge answers 451 for denylisted labels, also for /mw-sw.js.)
// Also measures when Chromium re-fetches the SW script after a navigation (spec: only when stale > 24 h).
// One fresh Chrome per scenario: a Clear-Site-Data wipe running in the browser process stalled the NEXT navigation in a shared browser.
// Run: node csd-on-sw-update.mjs > results-csd-on-sw-update.json   (CSD_VALUE env overrides the header value, default "storage")
import http from 'node:http'
import { launchChrome } from './chrome.mjs'
let mode = 'ok'            // how /mw-sw.js answers: ok | csd200 | csd451 | csd404 | csd500
let swFetches = []
const CSD = process.env.CSD_VALUE || '"storage"'
const sw = "self.addEventListener('install',e=>self.skipWaiting());self.addEventListener('activate',e=>e.waitUntil(clients.claim()));self.addEventListener('fetch',e=>{})"
const srv = http.createServer((req, res) => {
  const p = new URL(req.url, 'http://x').pathname
  if (p === '/mw-sw.js') {
    swFetches.push(Date.now())
    const h = { 'content-type': 'text/javascript', 'cache-control': 'no-cache' }
    if (mode === 'ok') { res.writeHead(200, h); return res.end(sw) }
    const status = Number(mode.slice(3)); h['clear-site-data'] = CSD
    if (status === 200) { res.writeHead(200, h); return res.end(sw) }
    h['content-type'] = 'text/plain'; res.writeHead(status, h); return res.end('x')
  }
  res.writeHead(200, { 'content-type': 'text/html', 'cache-control': 'no-store' }); res.end('<!doctype html><body>shell</body>')
})
await new Promise(r => srv.listen(0, '127.0.0.1', r)); const P = srv.address().port
const results = {}
let version
const snap = (page) => page.evaluate(async () => ({ registrations: (await navigator.serviceWorker.getRegistrations()).length, localStorage: localStorage.getItem('k'), cacheStorage: (await caches.keys()).length, indexedDB: (await indexedDB.databases()).length }))
async function scenario(label, run) {
  const chrome = await launchChrome(); version = chrome.browser.version()
  try {
    const ctx = await chrome.browser.newContext(); const page = await ctx.newPage()
    const host = `${label}.u.localhost:${P}`
    mode = 'ok'; await page.goto(`http://${host}/`, { timeout: 15000 })
    await page.evaluate(async () => {
      await navigator.serviceWorker.register('/mw-sw.js', { updateViaCache: 'none' }); await navigator.serviceWorker.ready
      if (!navigator.serviceWorker.controller) await new Promise(r => navigator.serviceWorker.addEventListener('controllerchange', r, { once: true }))
      localStorage.setItem('k', 'v'); await caches.open('mw-x')
      await new Promise(r => { const q = indexedDB.open('db', 1); q.onupgradeneeded = () => q.result.createObjectStore('s'); q.onsuccess = () => { q.result.transaction('s', 'readwrite').objectStore('s').put(1, 'k'); r() } })
    })
    return await run({ page, host })
  } catch (e) { return { error: String(e.message).split('\n')[0].slice(0, 120) } }
  finally { await chrome.close() }
}
for (const m of ['csd200', 'csd451', 'csd404', 'csd500']) {
  results[`update() while /mw-sw.js answers ${m.slice(3)} + Clear-Site-Data ${CSD}`] = await scenario(m, async ({ page }) => {
    mode = m
    const upd = await page.evaluate(async () => { const r = await navigator.serviceWorker.getRegistration(); try { await r.update(); return 'resolved' } catch (e) { return 'rejected' } })
    await new Promise(r => setTimeout(r, 2000))
    let after; try { after = await snap(page) } catch (e) { after = 'ERR ' + e.message.slice(0, 50) }
    return { update: upd, after }
  })
}
results['sw script re-fetch after a navigation (registration not stale)'] = await scenario('timing', async ({ page, host }) => {
  mode = 'ok'; swFetches = []; const t0 = Date.now()
  await page.goto(`http://${host}/?nav=1`, { timeout: 15000 }); await new Promise(r => setTimeout(r, 6000))
  return { refetchesInSixSeconds: swFetches.length, firstRefetchMsAfterNavStart: swFetches.length ? swFetches[0] - t0 : null }
})
console.log(JSON.stringify({ browser: version, when: new Date().toISOString(), csdValue: CSD, results }, null, 2))
srv.close()
