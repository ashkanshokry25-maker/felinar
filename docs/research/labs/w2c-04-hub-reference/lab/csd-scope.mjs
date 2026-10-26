// Does Clear-Site-Data sent from label A touch sibling label B (same registrable domain, no PSL entry)?
// Run: node csd-scope.mjs > results-csd-scope.json
import http from 'node:http'
import { launchChrome } from './chrome.mjs'
const srv = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://x')
  if (u.pathname === '/sw.js') { res.writeHead(200, { 'content-type': 'text/javascript' }); return res.end("self.addEventListener('fetch',()=>{})") }
  if (u.pathname === '/csd') { res.writeHead(200, { 'content-type': 'text/plain', 'clear-site-data': u.searchParams.get('v'), 'cache-control': 'no-store' }); return res.end('x') }
  res.writeHead(200, { 'content-type': 'text/html', 'set-cookie': [], 'cache-control': 'no-store' }); res.end('<!doctype html><body>shell</body>')
})
await new Promise(r => srv.listen(0, '127.0.0.1', r)); const P = srv.address().port
const chrome = await launchChrome()
const results = []
for (const directive of ['"storage"', '"cache", "storage"', '"cookies"']) {
  const ctx = await chrome.browser.newContext()
  const seed = async (host) => { const p = await ctx.newPage(); await p.goto(`http://${host}:${P}/`); await p.evaluate(async (d) => { localStorage.setItem('k', 'v'); document.cookie = `c=1; Domain=${d}; Path=/`; await navigator.serviceWorker.register('/sw.js'); await navigator.serviceWorker.ready }, 'hub.localhost'); return p }
  const A = 'a.hub.localhost', B = 'b.hub.localhost'
  const pa = await seed(A), pb = await seed(B)
  await pa.evaluate(async (v) => (await fetch('/csd?v=' + encodeURIComponent(v), { cache: 'no-store' })).status, directive)
  await new Promise(r => setTimeout(r, 800))
  const snap = (p) => p.evaluate(async () => ({ localStorage: localStorage.getItem('k'), swRegistrations: (await navigator.serviceWorker.getRegistrations()).length, cookie: document.cookie }))
  results.push({ directiveSentFromA: directive, A_after: await snap(pa), B_after_sibling: await snap(pb) })
  await ctx.close()
}
console.log(JSON.stringify({ browser: chrome.browser.version(), when: new Date().toISOString(), note: 'registrable domain hub.localhost is NOT in the PSL (*.localhost is a secure context in Chromium); cookie was set with Domain=hub.localhost by each page', results }, null, 2))
await chrome.close(); srv.close()
