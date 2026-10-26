// E-BFC-2: end-to-end: real WebTorrent leech connected to a seeder; navigate away and back; is the page restored from bfcache?
import { openBrowser } from './browsers.mjs'
import fs from 'node:fs'
import { startLab } from './lab.mjs'
const lab = await startLab({ withTracker: true })
const browser = await openBrowser('chromium', { ignoreDefaultArgs: ['--disable-back-forward-cache'], args: ['--disable-features=WebRtcHideLocalIpsWithMdns'] })
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const out = { browser: 'chromium ' + browser.version(), cases: [] }
for (const c of [{ name: 'engine left running', destroy: '0', host: false }, { name: 'client.destroy() on pagehide', destroy: '1', host: false }, { name: 'host-only (no tracker, no peers; page never connects)', destroy: '0', host: true }]) {
  const ctxA = await browser.newContext(); const ctxB = await browser.newContext()
  const seed = await ctxA.newPage(); const leech = await ctxB.newPage()
  const cdp = await ctxB.newCDPSession(leech); await cdp.send('Page.enable'); const reasons = []
  cdp.on('Page.backForwardCacheNotUsed', (e) => reasons.push(...e.notRestoredExplanations.map((x) => x.reason)))
  const tracker = `ws://127.0.0.1:${lab.trackerPort}`; const base = `${lab.origin}/csp.html?csp=none&tracker=${encodeURIComponent(tracker)}`
  await seed.goto(base + '&role=seed'); await seed.waitForFunction(() => window.__out && window.__out.magnet, null, { timeout: 15000 })
  const magnet = await seed.evaluate(() => window.__out.magnet)
  let done = false, firstWire = null
  if (c.host) { await leech.goto(`${lab.origin}/blank.html`) } else {
    await leech.goto(base + '&role=leech&destroy=' + c.destroy + '&magnet=' + encodeURIComponent(magnet))
    await leech.waitForFunction(() => window.__out && window.__out.done, null, { timeout: 15000 }).catch(() => {})
    const o = await leech.evaluate(() => window.__out); done = !!o.done; firstWire = o.t.firstWire
  }
  await leech.evaluate(() => { window.__marker = 'alive' })
  await sleep(500)
  await leech.goto(`http://localhost:${lab.port}/blank.html`); await sleep(300)
  await leech.evaluate(() => history.back()); await sleep(1800)
  const marker = await leech.evaluate(() => window.__marker || null)
  out.cases.push({ case: c.name, downloadedViaPeers: done, firstWireMs: firstWire, restoredFromBfcache: marker === 'alive', notRestoredReasons: [...new Set(reasons)] })
  console.log(JSON.stringify(out.cases.at(-1)))
  await ctxA.close(); await ctxB.close()
}
fs.writeFileSync(new URL('./results/wt-bfcache.json', import.meta.url), JSON.stringify(out, null, 1))
await browser.close(); await lab.close()
