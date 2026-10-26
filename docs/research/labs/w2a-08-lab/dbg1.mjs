import { withLab, openShell, frameOf, sleep } from './lib.mjs'
await withLab('chromium', async (lab, browser) => {
  const { ctx, page } = await openShell(browser, lab, { mirror: 'none' }, '/a.html')
  console.log('opened', page.url(), 'frames', page.frames().map(f => f.url()))
  page.on('framenavigated', (f) => console.log('framenavigated', f === page.mainFrame() ? 'MAIN' : 'sub', f.url()))
  await frameOf(page).click('#to-b')
  await sleep(1500)
  console.log('after click', page.url(), 'frames', page.frames().map(f => f.url()))
  console.log('console', JSON.stringify(page.__console.slice(-8)))
  console.log('server log', JSON.stringify(lab.state.log.slice(-12).map(r => `${r.method} ${r.url} dest=${r.dest} mode=${r.mode}`), null, 0))
  await ctx.close()
})
