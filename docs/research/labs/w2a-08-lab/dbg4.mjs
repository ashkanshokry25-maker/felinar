import { withLab, openShell, frameOf, sleep, back } from './lib.mjs'
const BASE = 'allow-scripts allow-same-origin allow-forms allow-popups allow-modals allow-downloads allow-top-navigation-by-user-activation'
for (const eng of ['chromium', 'webkit']) await withLab(eng, async (lab, browser) => {
  for (const [label, cfg] of [['mirror none', { mirror: 'none' }], ['mirror load (replaceState)', { mirror: 'load' }], ['mirror none + no sandbox', { mirror: 'none', sandbox: null }], ['mirror load + no sandbox', { mirror: 'load', sandbox: null }]]) {
    const { ctx, page } = await openShell(browser, lab, { sandbox: BASE, ...cfg }, '/long.html')
    await sleep(400)
    await frameOf(page).evaluate(() => window.scrollTo(0, 1500)); await sleep(500)
    await frameOf(page).evaluate(() => document.getElementById('to-a').click()); await sleep(900)
    await back(page); await sleep(1500)
    const y = await frameOf(page).evaluate(() => Math.round(scrollY))
    console.log(eng.padEnd(9), label.padEnd(32), 'frame scrollY after in-frame Back =', y)
    await ctx.close()
  }
})
