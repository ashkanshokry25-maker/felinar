// Scenario M7: what Referer do third-party embeds receive from a site rendered in the shell, per Referrer-Policy choice?
import { withLab, openShell, frameOf, sleep, saveResults } from './lib.mjs'
const engine = process.argv[2] || 'chromium'
const BASE = 'allow-scripts allow-same-origin allow-forms allow-popups allow-modals allow-downloads allow-top-navigation-by-user-activation allow-popups-to-escape-sandbox'
const out = { engine, rows: [] }
await withLab(engine, async (lab, browser) => {
  for (const [label, docReferrerPolicy] of [['SW sets Referrer-Policy: no-referrer on site documents (ARCH 7.1)', 'no-referrer'], ['SW sets nothing (browser default strict-origin-when-cross-origin)', ''], ['SW sets strict-origin-when-cross-origin', 'strict-origin-when-cross-origin']]) {
    const { ctx, page } = await openShell(browser, lab, { sandbox: BASE, mirror: 'load', docReferrerPolicy }, '/embeds.html')
    await sleep(1200)
    const log = await (await ctx.request.get(lab.ext + '/__extlog')).json()
    out.rows.push({ label, extRequests: log.filter((r) => r.path !== '/__extlog').map((r) => `${r.path} (${r.dest}) referer=${r.referer}`) })
    await ctx.close()
  }
})
for (const r of out.rows) console.log(JSON.stringify(r))
console.log('saved', saveResults('misc7', engine, out))
