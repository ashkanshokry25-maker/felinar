// dynamic viewport meta: can the shell change the frame's layout width at runtime by editing its own <meta name=viewport>?
import { withLab, openShell, frameOf, sleep } from './lib.mjs'
import { devices } from '../../../../node_modules/playwright/index.mjs'
const BASE = 'allow-scripts allow-same-origin allow-forms allow-popups allow-modals allow-downloads allow-top-navigation-by-user-activation'
for (const eng of ['chromium', 'webkit']) await withLab(eng, async (lab, browser) => {
  const dev = eng === 'webkit' ? devices['iPhone 15'] : devices['Pixel 7']
  const { ctx, page } = await openShell(browser, lab, { sandbox: BASE, mirror: 'none', shellViewport: 'width=device-width, initial-scale=1' }, '/', { ...dev })
  await sleep(500)
  const w = async () => frameOf(page).evaluate(() => innerWidth)
  const before = await w()
  await page.evaluate(() => { document.querySelector('meta[name=viewport]').setAttribute('content', 'width=1024') }); await sleep(800)
  const after1 = await w()
  await page.evaluate(() => { document.querySelector('meta[name=viewport]').setAttribute('content', 'width=device-width, initial-scale=1') }); await sleep(800)
  const after2 = await w()
  console.log(eng, dev.userAgent.includes('iPhone') ? 'iPhone15' : 'Pixel7', 'frame innerWidth: initial', before, '| after shell meta -> width=1024:', after1, '| back to device-width:', after2)
  await ctx.close()
})
