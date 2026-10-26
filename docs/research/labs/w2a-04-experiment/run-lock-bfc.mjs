// E-LOCK-2: A holds the engine lock and navigates away (page may enter bfcache holding the lock). Does tab B get the lock?
import { openBrowser } from './browsers.mjs'
import fs from 'node:fs'
import { startLab } from './lab.mjs'
const WHICH = process.env.BROWSER || 'chromium'
const lab = await startLab({ withTracker: false })
const browser = await openBrowser(WHICH, { ignoreDefaultArgs: ['--disable-back-forward-cache'] })
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const ev = (id) => lab.reports.filter((r) => r.lock && r.id === id)
const out = { browser: WHICH + ' ' + browser.version(), trials: [] }
for (let i = 0; i < 5; i++) {
  const ctx = await browser.newContext(); const A = await ctx.newPage(); const B = await ctx.newPage()
  const ida = 'A' + i, idb = 'B' + i
  await A.goto(`${lab.origin}/lock.html?id=${ida}&p=1`); await sleep(300)
  // A navigates to a CROSS-SITE page so the lock-holding page can be stored in bfcache
  await A.goto(`http://localhost:${lab.port}/blank.html`); await sleep(300)
  const tNavAway = Date.now()
  await B.goto(`${lab.origin}/lock.html?id=${idb}&p=1`)
  let gotAt = null
  for (let k = 0; k < 40; k++) { const l = ev(idb).find((x) => x.ev === 'LEADER'); if (l) { gotAt = l.t; break } await sleep(100) }
  out.trials.push({ B_got_lock: gotAt !== null, wait_ms_after_B_load: gotAt ? gotAt - ev(idb).find((x) => x.ev === 'loaded').t : null })
  await ctx.close()
}
console.log(JSON.stringify(out)); fs.writeFileSync(new URL('./results/lock-bfc-' + WHICH + '.json', import.meta.url), JSON.stringify(out, null, 1))
await browser.close(); await lab.close()
