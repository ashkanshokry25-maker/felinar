import { withLab, sleep, back } from './lib.mjs'
for (const eng of ['chromium', 'webkit']) await withLab(eng, async (lab, browser) => {
  for (const [label, how] of [['iframe nav via link click (frame.click)', 'click'], ['iframe nav via location.assign from inside the frame', 'assign']]) {
    const ctx = await browser.newContext(); const page = await ctx.newPage()
    await page.goto(lab.origin + '/__site/parent-plain.html'); await sleep(600)
    const fr = () => page.frames().find((f) => f !== page.mainFrame())
    await fr().evaluate(() => window.scrollTo(0, 1500)); await sleep(500)
    if (how === 'click') { await fr().evaluate(() => { document.getElementById('to-a').setAttribute('href', '/__site/a.html') }); await fr().click('#to-a') } else { await fr().evaluate(() => location.assign('/__site/a.html')) }
    await sleep(900)
    await back(page); await sleep(1500)
    console.log(eng.padEnd(9), label.padEnd(56), 'frame scrollY after Back =', await fr().evaluate(() => Math.round(scrollY)), '| url', fr().url().replace(/^http:\/\/127.0.0.1:\d+/, ''))
    await ctx.close()
  }
})
