// E-BFC-1: which connection types make a page ineligible for the back/forward cache in Chromium 156?
import { openBrowser } from './browsers.mjs'
import fs from 'node:fs'
import { startLab } from './lab.mjs'
const NOSTORE = process.env.NOSTORE === '1'
const lab = await startLab({ withTracker: true, headersFor: (u) => (NOSTORE && u.pathname === '/bf.html' ? { 'cache-control': 'no-store' } : {}) })
const WHICH = process.env.BROWSER || 'chromium'
const browser = await openBrowser(WHICH, { ignoreDefaultArgs: ['--disable-back-forward-cache'], args: ['--disable-features=WebRtcHideLocalIpsWithMdns', '--js-flags=--expose-gc'] })
console.log('browser', WHICH, browser.version())
const KINDS = (process.argv[2] || 'base,ws-open,ws-closed,rtc-open,rtc-closed,rtc-created-only,rtc-created-closed-early,lock,idb-open').split(',')
const results = []
for (const kind of KINDS) {
  const ctx = await browser.newContext(); const page = await ctx.newPage()
  const notUsed = []
  if (WHICH === 'chromium') { const cdp = await ctx.newCDPSession(page); await cdp.send('Page.enable'); cdp.on('Page.backForwardCacheNotUsed', (e) => notUsed.push(e.notRestoredExplanations.map((x) => x.reason))) }
  const ws = `ws://127.0.0.1:${lab.trackerPort}`
  const before = lab.reports.length
  await page.goto(`${lab.origin}/bf.html?kind=${kind}&ws=${encodeURIComponent(ws)}`)
  await page.waitForFunction(() => true); await new Promise((r) => setTimeout(r, 3800))
  await page.goto(`http://localhost:${lab.port}/blank.html`)  // cross-site => proactive BrowsingInstance swap
  await new Promise((r) => setTimeout(r, 300))
  await page.evaluate(() => history.back()); await new Promise((r) => setTimeout(r, 1800))
  const shows = lab.reports.slice(before).filter((r) => r.kind === kind && r.ev === 'pageshow').map((r) => r.persisted)
  const restored = shows.length >= 2 && shows[shows.length - 1] === true
  const evs = lab.reports.slice(before).filter((r) => r.kind === kind).map((r) => r.ev)
  const r = { kind, setupCompleted: evs.includes('ready'), iceStates: [...new Set(evs.filter((e) => e.startsWith('ice1:')))], dataChannelOpened: evs.includes('dc-open'), pageshowPersistedSequence: shows, restoredFromBfcache: restored, notRestoredReasons: [...new Set(notUsed.flat())] }
  results.push(r); console.log(JSON.stringify(r))
  await ctx.close()
}
fs.writeFileSync(new URL('./results/bfcache-' + WHICH + (NOSTORE ? '-nostore' : '') + (process.argv[2] ? '-extra' : '') + '.json', import.meta.url), JSON.stringify({ browser: WHICH + ' ' + browser.version(), results }, null, 1))
await browser.close(); await lab.close()
