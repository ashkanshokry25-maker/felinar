// E-SW-1 (navigation overhead of adding a SW to an existing MPA), E-SW-2 (scope rules), E-SW-3 (first-load semantics)
import { openBrowser } from './browsers.mjs'
import fs from 'node:fs'
import { startLab } from './lab.mjs'

const ORIGIN_DELAY_MS = 40       // emulated origin/CDN latency for HTML (only /site/*.html except first.html)
const N = 15
const lab = await startLab({
  withTracker: false,
  delayFor: (url) => (/^\/site\/(index|a|b)\.html$/.test(url.pathname) ? ORIGIN_DELAY_MS : 0),
  headersFor: (url) => (url.pathname === '/blog2/sw.js' ? { 'service-worker-allowed': '/', 'content-type': 'text/javascript' } : {})
})
const WHICH = process.env.BROWSER || 'chromium'
const browser = await openBrowser(WHICH)
const median = (a) => { const s = [...a].sort((x, y) => x - y); return s[Math.floor(s.length / 2)] }
const p90 = (a) => { const s = [...a].sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.floor(s.length * 0.9))] }
const timing = (page) => page.evaluate(() => { const n = performance.getEntriesByType('navigation')[0]; return { workerStart: n.workerStart, fetchStart: n.fetchStart, requestStart: n.requestStart, responseStart: n.responseStart, responseEnd: n.responseEnd, dcl: n.domContentLoadedEventEnd } })

const out = { browser: WHICH + ' ' + browser.version(), originDelayMs: ORIGIN_DELAY_MS, n: N, overhead: {}, scope: null, first: null }
for (const variant of (WHICH === 'chromium' ? ['nosw', 'nofetch', 'passthrough', 'nf', 'nfp'] : [])) {
  const ctx = await browser.newContext(); const page = await ctx.newPage()
  const cdp = await ctx.newCDPSession(page); await cdp.send('ServiceWorker.enable')
  await page.goto(`${lab.origin}/site/index.html`)
  if (variant !== 'nosw') {
    const ok = await page.evaluate(async (v) => { try { const r = await navigator.serviceWorker.register('/site/sw-' + v + '.js', { scope: '/site/' }); await navigator.serviceWorker.ready; await new Promise((res) => setTimeout(res, 200)); return true } catch (e) { return String(e) } }, variant)
    if (ok !== true) { out.overhead[variant] = { error: ok }; await ctx.close(); continue }
  }
  const cold = []; const warm = []
  for (let i = 0; i < N; i++) {
    if (variant !== 'nosw') await cdp.send('ServiceWorker.stopAllWorkers')
    await page.goto(`${lab.origin}/site/a.html`); cold.push(await timing(page))
    await page.goto(`${lab.origin}/site/b.html`); warm.push(await timing(page))
  }
  const sum = (arr) => ({ workerStart_med: +median(arr.map((t) => t.workerStart)).toFixed(1), responseStart_med: +median(arr.map((t) => t.responseStart)).toFixed(1), responseStart_p90: +p90(arr.map((t) => t.responseStart)).toFixed(1), dcl_med: +median(arr.map((t) => t.dcl)).toFixed(1) })
  out.overhead[variant] = { cold_sw_stopped_before_nav: sum(cold), warm_sw_running: sum(warm) }
  console.log(variant, JSON.stringify(out.overhead[variant]))
  await ctx.close()
}
// scope rules
{
  const ctx = await browser.newContext(); const page = await ctx.newPage()
  await page.goto(`${lab.origin}/scope.html`)
  await page.waitForFunction(() => window.__out && window.__out.done, null, { timeout: 10000 })
  out.scope = await page.evaluate(() => window.__out); console.log('scope', JSON.stringify(out.scope)); await ctx.close()
}
// first-load semantics
{
  const ctx = await browser.newContext(); const page = await ctx.newPage()
  await page.goto(`${lab.origin}/site/first.html`)
  await page.waitForFunction(() => window.__out && (window.__out.done || window.__out.error), null, { timeout: 10000 })
  out.first = await page.evaluate(() => window.__out); console.log('first', JSON.stringify(out.first)); await ctx.close()
}
fs.writeFileSync(new URL('./results/sw-' + WHICH + '.json', import.meta.url), JSON.stringify(out, null, 1))
await browser.close(); await lab.close()
