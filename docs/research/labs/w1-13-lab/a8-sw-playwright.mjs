// w1-13 A8: Service Workers under Playwright on plain http: localhost / 127.0.0.1 / LAN IP, per engine; 'block' option; secure-context flag.
import http from 'node:http'
import os from 'node:os'
import { chromium, webkit } from 'playwright'
const lanIp = Object.values(os.networkInterfaces()).flat().find(a => a.family === 'IPv4' && !a.internal && a.address.startsWith('192.168.18.'))?.address
const swSrc = `self.addEventListener('install', e => self.skipWaiting()); self.addEventListener('activate', e => e.waitUntil(self.clients.claim()));
self.addEventListener('fetch', e => { const u = new URL(e.request.url); if (u.pathname.startsWith('/virtual/')) e.respondWith(new Response('from-sw:' + u.pathname + ':' + (e.request.headers.get('range') || ''), { status: 200, headers: { 'content-type': 'text/plain', 'x-sw': '1' } })) })`
const srv = http.createServer((q, r) => {
  if (q.url === '/sw.js') { r.writeHead(200, { 'content-type': 'text/javascript', 'cache-control': 'no-store' }); return r.end(swSrc) }
  if (q.url.startsWith('/virtual/')) { r.writeHead(404); return r.end('NETWORK-404') }
  r.writeHead(200, { 'content-type': 'text/html', 'cache-control': 'no-store' }); r.end('<!doctype html><title>sw</title>ok')
})
await new Promise(r => srv.listen(0, '0.0.0.0', r))
const port = srv.address().port
const probe = async page => page.evaluate(async () => {
  const o = { isSecureContext, swApi: 'serviceWorker' in navigator, origin: location.origin }
  if (!o.swApi) return o
  try {
    const reg = await Promise.race([navigator.serviceWorker.register('/sw.js'), new Promise((_, rj) => setTimeout(() => rj(new Error('register timeout 5s')), 5000))])
    await Promise.race([navigator.serviceWorker.ready, new Promise((_, rj) => setTimeout(() => rj(new Error('ready timeout 5s')), 5000))])
    o.registered = true
    if (!navigator.serviceWorker.controller) await new Promise(r => { navigator.serviceWorker.addEventListener('controllerchange', r, { once: true }); setTimeout(r, 2000) })
    o.controlled = !!navigator.serviceWorker.controller
    const res = await fetch('/virtual/a.txt', { headers: { range: 'bytes=0-9' } })
    o.fetchStatus = res.status; o.fetchBody = await res.text(); o.xSw = res.headers.get('x-sw')
    // iframe navigation served by the SW
    const fr = document.createElement('iframe'); fr.src = '/virtual/page.html'; document.body.appendChild(fr)
    await new Promise(r => { fr.onload = r; setTimeout(r, 2000) })
    try { o.iframeText = fr.contentDocument?.body?.textContent?.slice(0, 40) ?? null } catch (e) { o.iframeText = 'ERR ' + e.name }
    await reg.unregister()
  } catch (e) { o.error = String(e.message || e) }
  return o
})
const out = {}
async function run (label, launcher, launchOpts, ctxOpts, url) {
  const b = await launcher.launch({ headless: true, ...launchOpts })
  const ctx = await b.newContext(ctxOpts)
  const page = await ctx.newPage()
  try { await page.goto(url); out[label] = { ver: b.version(), ...(await probe(page)) } } catch (e) { out[label] = { error: String(e.message).split('\n')[0] } }
  if (launcher === chromium) { try { out[label].playwrightSeesServiceWorkers = ctx.serviceWorkers().length } catch (e) { out[label].playwrightSeesServiceWorkers = 'n/a: ' + e.message.split('\n')[0] } } else { try { out[label].playwrightSeesServiceWorkers = ctx.serviceWorkers().length } catch (e) { out[label].playwrightSeesServiceWorkers = 'n/a: ' + String(e.message).split('\n')[0] } }
  await b.close()
}
await run('chromium http://localhost', chromium, {}, {}, `http://localhost:${port}/`)
await run('chromium http://127.0.0.1', chromium, {}, {}, `http://127.0.0.1:${port}/`)
await run('webkit http://localhost', webkit, {}, {}, `http://localhost:${port}/`)
await run('webkit http://127.0.0.1', webkit, {}, {}, `http://127.0.0.1:${port}/`)
await run("chromium localhost + serviceWorkers:'block'", chromium, {}, { serviceWorkers: 'block' }, `http://localhost:${port}/`)
await run("webkit localhost + serviceWorkers:'block'", webkit, {}, { serviceWorkers: 'block' }, `http://localhost:${port}/`)
if (lanIp) {
  await run(`chromium LAN http://${lanIp} (insecure)`, chromium, {}, {}, `http://${lanIp}:${port}/`)
  await run(`chromium LAN with --unsafely-treat-insecure-origin-as-secure`, chromium, { args: [`--unsafely-treat-insecure-origin-as-secure=http://${lanIp}:${port}`] }, {}, `http://${lanIp}:${port}/`)
  await run(`webkit LAN http://${lanIp} (insecure)`, webkit, {}, {}, `http://${lanIp}:${port}/`)
}
srv.close()
console.log(JSON.stringify(out, null, 1)); process.exit(0)
