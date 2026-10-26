import { openBrowser } from './browsers.mjs'
import fs from 'node:fs'
import { startLab } from './lab.mjs'
const WHICH = process.env.BROWSER || 'chromium'
const lab = await startLab({ withTracker: false })
const browser = await openBrowser(WHICH)
const out = { browser: WHICH + ' ' + browser.version(), trials: [] }
for (let i = 0; i < 4; i++) {
  const ctx = await browser.newContext(); const page = await ctx.newPage(); const before = lab.reports.length
  await page.goto(`${lab.origin}/rc/rc1.html`)
  for (let k = 0; k < 60; k++) { if (lab.reports.slice(before).some((r) => r.rc)) break; await new Promise((r) => setTimeout(r, 100)) }
  out.trials.push(lab.reports.slice(before).find((r) => r.rc) || { timeout: true })
  await ctx.close()
}
console.log(JSON.stringify(out)); fs.writeFileSync(new URL('./results/rc-' + WHICH + '.json', import.meta.url), JSON.stringify(out, null, 1))
await browser.close(); await lab.close()
