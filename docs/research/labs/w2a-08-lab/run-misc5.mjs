// Scenario M5: beforeunload on tab close with the handler inside the frame; accessibility tree of the shell.
import { withLab, openShell, frameOf, sleep, saveResults } from './lib.mjs'
const engine = process.argv[2] || 'chromium'
const BASE = 'allow-scripts allow-same-origin allow-forms allow-popups allow-downloads allow-top-navigation-by-user-activation'
const out = { engine, rows: [] }
await withLab(engine, async (lab, browser) => {
  for (const [label, sandbox] of [['sandbox without allow-modals (spec 7.2)', BASE], ['sandbox with allow-modals', BASE + ' allow-modals']]) {
    const { ctx, page } = await openShell(browser, lab, { sandbox, mirror: 'load' }, '/behaviors.html')
    await frameOf(page).click('#b-unload'); await sleep(200)
    const seen = []
    page.removeAllListeners('dialog')
    page.on('dialog', async (d) => { seen.push(d.type()); await d.dismiss().catch(() => {}) })
    await page.close({ runBeforeUnload: true }).catch(() => {})
    await sleep(800)
    out.rows.push({ test: 'tab close with beforeunload handler inside the frame', label, dialogsSeen: seen, pageStillOpen: !page.isClosed() })
    await ctx.close().catch(() => {})
  }
  for (const title of ['Site content', '']) {
    const { ctx, page } = await openShell(browser, lab, { sandbox: BASE + ' allow-modals', mirror: 'load', frameTitle: title }, '/a.html')
    await sleep(500)
    let snap = ''
    try { snap = await page.locator('body').ariaSnapshot({ timeout: 4000 }) } catch (e) { snap = 'ariaSnapshot unavailable: ' + String(e).slice(0, 80) }
    out.rows.push({ test: 'aria snapshot of shell (iframe title=' + JSON.stringify(title) + ')', snapshot: snap.slice(0, 500) })
    await ctx.close()
  }
})
for (const r of out.rows) console.log(JSON.stringify(r).slice(0, 700))
console.log('saved', saveResults('misc5', engine, out))
