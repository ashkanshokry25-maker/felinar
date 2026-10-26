// Scenario M2: top-level navigations to NON-HTML files (PDF, text, json) in shell mode: shell vs direct file.
import { withLab, openShell, frameOf, sleep, saveResults } from './lib.mjs'
const engArg = process.argv[2] || 'chromium:full'
const [engine, variant] = engArg.split(':')
const launch = variant === 'full' ? { channel: 'chromium' } : {}
const BASE = 'allow-scripts allow-same-origin allow-forms allow-popups allow-modals allow-downloads allow-top-navigation-by-user-activation'
const rel = (u) => String(u).replace(/^http:\/\/127\.0\.0\.1:\d+/, '')
const out = { engine: engArg, rows: [] }
await withLab(engine, async (lab, browser) => {
  for (const nonHtmlDirect of [false, true]) {
    for (const target of ['/file.pdf', '/dl.txt']) {
      // first visit to the site installs the SW, then a fresh top-level navigation to the non-HTML URL
      const { ctx, page } = await openShell(browser, lab, { sandbox: BASE, mirror: 'load', nonHtmlDirect }, '/a.html')
      await page.goto(lab.origin + target, { waitUntil: 'load' }).catch(() => {})
      await sleep(1500)
      const f = frameOf(page)
      let kind = '?'
      try { kind = await page.evaluate(() => document.contentType + ' hasShell=' + !!window.__mw) } catch (e) { kind = 'n/a ' + String(e).slice(0, 50) }
      let fk = null
      if (f) { try { fk = await f.evaluate(() => document.contentType) } catch (e) { fk = 'unreadable' } }
      out.rows.push({ nonHtmlDirect, target, topUrl: rel(page.url()), topDoc: kind, frameUrl: f && rel(f.url()), frameContentType: fk, downloads: page.__downloads.length })
      await ctx.close()
    }
  }
}, launch)
for (const r of out.rows) console.log(JSON.stringify(r))
console.log('saved', saveResults('misc2', engArg.replace(':', '-'), out))
