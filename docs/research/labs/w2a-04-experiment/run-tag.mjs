import { openBrowser } from './browsers.mjs'
import fs from 'node:fs'
import { startLab } from './lab.mjs'
const lab = await startLab({ withTracker: false })
const res = {}
for (const WHICH of ['chromium', 'webkit']) {
  const browser = await openBrowser(WHICH); const ctx = await browser.newContext(); const page = await ctx.newPage()
  const before = lab.reports.length
  await page.goto(`${lab.origin}/tag.html`); await new Promise((r) => setTimeout(r, 800))
  const rep = lab.reports.slice(before).find((r) => r.tag)
  res[WHICH + ' ' + browser.version()] = { module: rep && rep.module, api: rep && rep.api, classic: await page.evaluate(() => window.__tag && window.__tag.classic) }
  console.log(WHICH, JSON.stringify(res[WHICH + ' ' + browser.version()]))
  await ctx.close(); await browser.close()
}
fs.writeFileSync(new URL('./results/tag-api.json', import.meta.url), JSON.stringify(res, null, 1))
await lab.close()
