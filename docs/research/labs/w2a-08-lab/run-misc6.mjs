// Scenario M6: PDF opened in a NEW TAB from the sandboxed frame: does the popup inherit the sandbox (PDF viewer blocked)?
import { withLab, openShell, frameOf, sleep, saveResults } from './lib.mjs'
const BASE = 'allow-scripts allow-same-origin allow-forms allow-popups allow-modals allow-downloads allow-top-navigation-by-user-activation'
const out = { rows: [] }
await withLab('chromium', async (lab, browser) => {
  for (const [label, sandbox] of [['sandbox BASE (popups inherit sandbox)', BASE], ['sandbox BASE + allow-popups-to-escape-sandbox', BASE + ' allow-popups-to-escape-sandbox']]) {
    for (const nonHtmlDirect of [true]) {
      const { ctx, page } = await openShell(browser, lab, { sandbox, mirror: 'load', nonHtmlDirect }, '/behaviors.html')
      const before = page.__popups.length
      await frameOf(page).evaluate(() => { window.open('/file.pdf', '_blank') }); await sleep(2500)
      const pp = page.__popups[before]
      let info = 'NO POPUP'
      if (pp) { await pp.waitForLoadState('load').catch(() => {}); await sleep(500); info = { url: pp.url().replace(/^http:\/\/127\.0\.0\.1:\d+/, ''), contentType: await pp.evaluate(() => document.contentType).catch(() => 'n/a'), frames: pp.frames().map((f) => f.url().replace(/^http:\/\/127\.0\.0\.1:\d+/, '').slice(0, 60)) } }
      out.rows.push({ label, nonHtmlDirect, popup: info })
      await ctx.close()
    }
  }
}, { channel: 'chromium' })
for (const r of out.rows) console.log(JSON.stringify(r))
console.log('saved', saveResults('misc6', 'chromium-full', out))
