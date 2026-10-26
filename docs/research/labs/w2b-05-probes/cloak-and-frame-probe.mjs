// Scratchpad-only: (1) can a server tell script / fetch() / SW-script / import() requests apart?  (2) does a SW-synthesized
// CSP frame-ancestors header get enforced on a navigation response?  Chromium only.
import http from 'node:http'
import { chromium } from '$HOME/Documents/Projects/magnet-web/node_modules/playwright/index.mjs'
const seen = []
const SWJS = `self.addEventListener('install',e=>e.waitUntil(self.skipWaiting()));self.addEventListener('activate',e=>e.waitUntil(self.clients.claim()));
self.addEventListener('fetch',e=>{ if(e.request.mode==='navigate' && new URL(e.request.url).pathname==='/protected'){ e.respondWith(new Response('<!doctype html><p id=s>PROTECTED-BY-SW</p>',{headers:{'content-type':'text/html','content-security-policy':"frame-ancestors 'none'"}})) } });`
function mk (log) {
  return http.createServer((req, res) => {
    const u = new URL(req.url, 'http://x')
    if (log) seen.push({ path: u.pathname, dest: req.headers['sec-fetch-dest'], mode: req.headers['sec-fetch-mode'], site: req.headers['sec-fetch-site'], sw: req.headers['service-worker'] || null })
    if (u.pathname === '/sw.js') { res.writeHead(200, { 'content-type': 'text/javascript', 'cache-control': 'no-cache' }); return res.end(SWJS) }
    if (u.pathname === '/probe.js') { res.writeHead(200, { 'content-type': 'text/javascript', 'cache-control': 'no-store', 'access-control-allow-origin': '*' }); return res.end('window.__probe=(window.__probe||0)+1') }
    if (u.pathname === '/mod.js') { res.writeHead(200, { 'content-type': 'text/javascript', 'cache-control': 'no-store' }); return res.end('export default 1') }
    if (u.pathname === '/protected') { res.writeHead(200, { 'content-type': 'text/html' }); return res.end('<p>PROTECTED-FROM-NETWORK</p>') }
    if (u.pathname === '/embedder') { res.writeHead(200, { 'content-type': 'text/html' }); return res.end(`<iframe id=f src="http://localhost:${victimPort}/protected"></iframe>`) }
    if (u.pathname === '/') { res.writeHead(200, { 'content-type': 'text/html', 'cache-control': 'no-store' }); return res.end(`<!doctype html><title>t</title><script src="/probe.js"></script><script type=module>import('/mod.js').then(m=>{window.__dyn=m.default});await fetch('/probe.js').then(r=>r.text());navigator.serviceWorker.register('/sw.js').then(()=>{window.__reg=1})</script>`) }
    res.writeHead(404); res.end('nf')
  })
}
let victimPort = 0
const victim = mk(true); await new Promise(r => victim.listen(0, '127.0.0.1', r)); victimPort = victim.address().port
const attacker = mk(false); await new Promise(r => attacker.listen(0, '127.0.0.1', r)); const attackerPort = attacker.address().port
const browser = await chromium.launch({ headless: true })
const ctx = await browser.newContext(); const page = await ctx.newPage()
await page.goto(`http://localhost:${victimPort}/`)
await page.waitForFunction(() => window.__reg === 1 && window.__dyn === 1, null, { timeout: 10000 })
await page.waitForFunction(async () => { const r = await navigator.serviceWorker.getRegistration(); return r && r.active })
const out = { chromium: browser.version(), requestFingerprintsAtServer: seen.filter(s => ['/probe.js', '/mod.js', '/sw.js', '/'].includes(s.path)).map(s => `${s.path}  dest=${s.dest}  mode=${s.mode}  site=${s.site}  Service-Worker=${s.sw}`) }
// frame test: attacker origin embeds victim /protected, whose SW adds frame-ancestors 'none'
const p2 = await ctx.newPage()
await p2.goto(`http://127.0.0.1:${attackerPort}/embedder`)  // different origin (127.0.0.1 vs localhost)
await new Promise(r => setTimeout(r, 1500))
const frames = p2.frames().map(f => ({ url: f.url(), blocked: f.url().startsWith('chrome-error') }))
out.cspFrameAncestorsFromSwResponse = { frames, note: 'control: the same /protected from the network has no CSP header' }
// control without SW: fresh context
const ctx2 = await browser.newContext(); const p3 = await ctx2.newPage()
await p3.goto(`http://127.0.0.1:${attackerPort}/embedder`); await new Promise(r => setTimeout(r, 1000))
out.controlNoSw = p3.frames().map(f => ({ url: f.url() }))
console.log(JSON.stringify(out, null, 1))
await browser.close(); victim.close(); attacker.close(); process.exit(0)
