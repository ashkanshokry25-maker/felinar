// Claim 5 support: (1) does the fragment reach the HTTP server (request line, Referer on subresources)?  (2) does a Service Worker see it in FetchEvent.request.url?
import http from 'node:http'
import fs from 'node:fs'
import { chromium, webkit } from '$HOME/Documents/Projects/magnet-web/node_modules/playwright/index.mjs'
const [engine, out] = process.argv.slice(2)
const SECRET = 'magnet%3A%3Fxt%3Durn%3Abtih%3A0123456789abcdef0123456789abcdef01234567%26tr%3Dwss%253A%252F%252Ft.example'
const log = []
const SW = `let last=null; self.addEventListener('install',()=>self.skipWaiting()); self.addEventListener('activate',e=>e.waitUntil(self.clients.claim()));
self.addEventListener('fetch',e=>{ if(e.request.mode==='navigate'){ last=e.request.url } });
self.addEventListener('message',e=>{ e.source.postMessage({lastNavigateUrl:last}) });`
const PAGE = `<!doctype html><meta charset=utf-8><title>f</title><script src="/sub.js"></script><body>f</body>`
const server = http.createServer((req, res) => {
  log.push({ method: req.method, url: req.url, referer: req.headers.referer || null })
  const send = (t, b, s = 200) => { res.writeHead(s, { 'content-type': t, 'cache-control': 'no-store', ...(req.url.startsWith('/sw.js') ? { 'service-worker-allowed': '/' } : {}) }); res.end(b) }
  if (req.url.startsWith('/sw.js')) return send('text/javascript', SW)
  if (req.url.startsWith('/sub.js')) return send('text/javascript', 'window.__sub=1')
  send('text/html', PAGE)
})
await new Promise((r) => server.listen(0, '127.0.0.1', r))
const base = `http://127.0.0.1:${server.address().port}`
const result = { engine, base }
let browser
try {
  browser = await ({ chromium, webkit }[engine]).launch()
  result.version = browser.version()
  const ctx = await browser.newContext()
  const page = await ctx.newPage()
  await page.goto(base + '/')                                   // first visit: install SW
  await page.evaluate(async () => { await navigator.serviceWorker.register('/sw.js'); await navigator.serviceWorker.ready })
  await page.waitForFunction(() => navigator.serviceWorker.controller || true)
  await page.goto('about:blank')                                // leave the document so the next goto is a real cross-document navigation
  log.length = 0
  // navigation exactly as a handler template 'http://host/#%s' would produce: fragment = encodeURIComponent(magnet)
  await page.goto(base + '/#' + SECRET)
  await page.waitForTimeout(300)
  result.pageHash = await page.evaluate(() => location.hash)
  result.pageHashEqualsSecret = result.pageHash === '#' + SECRET
  result.requestLog = log.slice()
  result.fragmentAppearsInAnyServerRequest = log.some(l => (l.url || '').includes('magnet') || (l.url || '').includes('#') || (l.referer || '').includes('magnet') || (l.referer || '').includes('#'))
  // SW view: reload so that the SW controls the navigation, then ask it
  await page.goto(base + '/other#' + SECRET)                    // SW-controlled navigation
  await page.waitForTimeout(300)
  result.swControlled = await page.evaluate(() => !!navigator.serviceWorker.controller)
  result.swSaw = await page.evaluate(() => new Promise((resolve) => {
    navigator.serviceWorker.addEventListener('message', (e) => resolve(e.data), { once: true })
    navigator.serviceWorker.controller && navigator.serviceWorker.controller.postMessage('q')
    setTimeout(() => resolve('no reply'), 3000)
  }))
  result.swSawFragment = JSON.stringify(result.swSaw).includes('magnet%3A')
} catch (e) { result.error = String(e && e.message || e).slice(0, 800) } finally { try { await browser?.close() } catch {} server.close() }
fs.writeFileSync(out, JSON.stringify(result, null, 2)); console.log(JSON.stringify(result, null, 1).slice(0, 2500))
