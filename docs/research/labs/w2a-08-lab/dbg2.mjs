import { withLab, openShell, frameOf, sleep, back, forward } from './lib.mjs'
await withLab('chromium', async (lab, browser) => {
  const { ctx, page } = await openShell(browser, lab, { mirror: 'none' }, '/a.html')
  const hist = async (l) => { const h = await page.evaluate(() => ({ n: history.length, url: location.href, mw: !!window.__mw })).catch(e => ({ err: String(e).slice(0, 80) })); console.log(l, JSON.stringify(h), 'frames', page.frames().map(f => f.url().replace(/^http:\/\/127.0.0.1:\d+/, '')).join(',')) }
  await hist('open')
  await frameOf(page).click('#to-b'); await sleep(500); await hist('click B')
  await frameOf(page).click('#to-c'); await sleep(500); await hist('click C')
  await back(page); await sleep(800); await hist('back1')
  await back(page); await sleep(800); await hist('back2')
  await forward(page); await sleep(800); await hist('fwd1')
  await ctx.close()
})
