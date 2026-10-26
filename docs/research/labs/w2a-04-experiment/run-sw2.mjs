// E-SW-1b: verify real cold starts: SW boot timestamp changes + time from navigation start to fetch-event dispatch.
import { chromium } from 'playwright'
import fs from 'node:fs'
import { startLab } from './lab.mjs'
const DELAY = Number(process.argv[2] || 40), N = 15
const lab = await startLab({ withTracker: false, delayFor: (u) => (/^\/site\/(index|a|b)\.html$/.test(u.pathname) ? DELAY : 0) })
const browser = await chromium.launch({ headless: true })
const med = (a) => { const s = [...a].sort((x, y) => x - y); return s[Math.floor(s.length / 2)] }
const res = { browser: browser.version(), delayMs: DELAY, variants: {} }
const VARIANTS = (process.argv[3] || 'nf-i,nfp-i').split(',')
for (const v of VARIANTS) {
  const ctx = await browser.newContext(); const page = await ctx.newPage()
  const cdp = await ctx.newCDPSession(page); await cdp.send('ServiceWorker.enable')
  const states = []; cdp.on('ServiceWorker.workerVersionUpdated', (e) => e.versions.forEach((x) => states.push(x.runningStatus)))
  await page.goto(`${lab.origin}/site/index.html`)
  await page.evaluate(async (v) => { await navigator.serviceWorker.register('/site/sw-' + v + '.js', { scope: '/site/' }); await navigator.serviceWorker.ready; await new Promise((r) => setTimeout(r, 300)) }, v)
  const rows = []; let lastBoot = null
  for (let mode of ['cold', 'warm']) {
    for (let i = 0; i < N; i++) {
      if (mode === 'cold') { await cdp.send('ServiceWorker.stopAllWorkers'); await new Promise((r) => setTimeout(r, 150)) }
      const resp = await page.goto(`${lab.origin}/site/a.html`)
      const h = resp.headers(); const origin = await page.evaluate(() => performance.timeOrigin)
      const nav = await page.evaluate(() => { const n = performance.getEntriesByType('navigation')[0]; return { responseStart: n.responseStart, workerStart: n.workerStart, fetchStart: n.fetchStart } })
      rows.push({ mode, readMs: h['x-sw-read-ms'] === undefined ? null : Number(h['x-sw-read-ms']), booted: h['x-sw-boot'] !== lastBoot, dispatch_ms: +(Number(h['x-sw-t']) - origin).toFixed(1), preload: h['x-sw-preload'], responseStart: +nav.responseStart.toFixed(1), workerStart: +nav.workerStart.toFixed(1), fetchStart: +nav.fetchStart.toFixed(1) })
      lastBoot = h['x-sw-boot']
    }
  }
  const agg = (mode) => { const r = rows.filter((x) => x.mode === mode); return { restarts: r.filter((x) => x.booted).length + '/' + r.length, dispatch_ms_med: med(r.map((x) => x.dispatch_ms)), workerStart_med: med(r.map((x) => x.workerStart)), fetchStart_med: med(r.map((x) => x.fetchStart)), responseStart_med: med(r.map((x) => x.responseStart)), responseStart_max: Math.max(...r.map((x) => x.responseStart)), preloadUsed: r.filter((x) => x.preload === '1').length, readMs_med: r[0].readMs === null ? null : med(r.map((x) => x.readMs)) } }
  res.variants[v] = { cold: agg('cold'), warm: agg('warm'), runningStatusesSeen: [...new Set(states)] }
  console.log(v, JSON.stringify(res.variants[v]))
  await ctx.close()
}
fs.writeFileSync(new URL('./results/sw2-delay' + DELAY + (process.argv[3] ? '-' + process.argv[3].replace(/,/g,'_') : '') + '.json', import.meta.url), JSON.stringify(res, null, 1))
await browser.close(); await lab.close()
