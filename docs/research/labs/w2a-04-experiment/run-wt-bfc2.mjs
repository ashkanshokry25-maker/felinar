import { openBrowser } from './browsers.mjs'
import fs from 'node:fs'
import { startLab } from './lab.mjs'
const lab = await startLab({ withTracker: true })
const browser = await openBrowser('chromium', { ignoreDefaultArgs: ['--disable-back-forward-cache'], args: ['--disable-features=WebRtcHideLocalIpsWithMdns'] })
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const out = { browser: 'chromium ' + browser.version(), cases: [] }
for (const mode of ['alone', 'alone-destroy-on-pagehide']) {
  const ctx = await browser.newContext(); const page = await ctx.newPage()
  const cdp = await ctx.newCDPSession(page); await cdp.send('Page.enable'); const reasons = []
  cdp.on('Page.backForwardCacheNotUsed', (e) => reasons.push(...e.notRestoredExplanations.map((x) => x.reason)))
  await page.goto(`${lab.origin}/bfwt.html?mode=${mode}&tracker=${encodeURIComponent('ws://127.0.0.1:' + lab.trackerPort)}`)
  await page.waitForFunction(() => window.__ready, null, { timeout: 25000 }).catch(() => {})
  const o = await page.evaluate(() => window.__out)
  await page.evaluate(() => { window.__marker = 'alive' }); await sleep(500)
  await page.goto(`http://localhost:${lab.port}/blank.html`); await sleep(300)
  await page.evaluate(() => history.back()); await sleep(1800)
  const marker = await page.evaluate(() => window.__marker || null)
  out.cases.push({ mode, p2pDownloadCompleted: o.done, wires: o.wires, restoredFromBfcache: marker === 'alive', notRestoredReasons: [...new Set(reasons)] })
  console.log(JSON.stringify(out.cases.at(-1)))
  await ctx.close()
}
fs.writeFileSync(new URL('./results/wt-bfcache.json', import.meta.url), JSON.stringify(out, null, 1))
await browser.close(); await lab.close()
