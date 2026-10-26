// Are http://<32-char base32 label>.hub.localhost:PORT origins usable as a no-certificate stand-in for <label>.hub-sites.example in tests?
// Run: node localhost-origins.mjs > results-localhost-origins.json
import http from 'node:http'
import { launchChrome } from './chrome.mjs'
const sw = `self.addEventListener('install',e=>self.skipWaiting());self.addEventListener('activate',e=>e.waitUntil(clients.claim()));self.addEventListener('fetch',e=>{const u=new URL(e.request.url);if(u.pathname==='/swhello')e.respondWith(new Response('sw:'+self.location.host))})`
const srv = http.createServer((req, res) => {
  const p = new URL(req.url, 'http://x').pathname
  if (p === '/sw.js') { res.writeHead(200, { 'content-type': 'text/javascript' }); return res.end(sw) }
  res.writeHead(200, { 'content-type': 'text/html' }); res.end('<!doctype html><body>shell</body>')
})
await new Promise(r => srv.listen(0, '127.0.0.1', r)); const P = srv.address().port
const chrome = await launchChrome()
const ctx = await chrome.browser.newContext()
const labels = ['abcdefghijklmnopqrstuvwxyz234567', '765432zyxwvutsrqponmlkjihgfedcba']
const out = { browser: chrome.browser.version(), labels: {} }
for (const l of labels) {
  const page = await ctx.newPage(); await page.goto(`http://${l}.hub.localhost:${P}/`)
  out.labels[l] = await page.evaluate(async () => {
    const reg = await navigator.serviceWorker.register('/sw.js'); await navigator.serviceWorker.ready
    if (!navigator.serviceWorker.controller) await new Promise(r => navigator.serviceWorker.addEventListener('controllerchange', r, { once: true }))
    localStorage.setItem('who', location.host)
    return { isSecureContext, origin: location.origin, scope: reg.scope, swAnswer: await (await fetch('/swhello')).text(), cryptoSubtle: !!crypto.subtle }
  })
  await page.close()
}
const p2 = await ctx.newPage(); await p2.goto(`http://${labels[1]}.hub.localhost:${P}/`)
out.isolation_seen_from_label2 = await p2.evaluate(async () => ({ registrations: (await navigator.serviceWorker.getRegistrations()).map(r => r.scope), localStorageWho: localStorage.getItem('who') }))
console.log(JSON.stringify(out, null, 2))
await chrome.close(); srv.close()
