import { withLab, sleep } from './lib.mjs'
for (const eng of ['chromium', 'webkit']) await withLab(eng, async (lab, browser) => {
  const ctx = await browser.newContext(); const page = await ctx.newPage()
  await page.goto(lab.origin + '/__site/long.html'); await sleep(300)
  await page.evaluate(() => scrollTo(0, 1500)); await sleep(400)
  console.log(eng, 'scrolled', await page.evaluate(() => Math.round(scrollY)))
  await page.click('#to-a'); await sleep(600)
  console.log(eng, 'url after click', page.url().replace(/^http:\/\/127.0.0.1:\d+/, ''))
  await page.goBack({ timeout: 5000 }).catch((e) => console.log('goBack err', String(e).slice(0, 60)))
  await sleep(1200)
  console.log(eng, 'url after back', page.url().replace(/^http:\/\/127.0.0.1:\d+/, ''), 'scrollY', await page.evaluate(() => Math.round(scrollY)), 'scrollRestoration', await page.evaluate(() => history.scrollRestoration))
  await ctx.close()
})
