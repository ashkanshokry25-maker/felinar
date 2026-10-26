import { withLab, openShell, frameOf, sleep } from './lib.mjs'
const BASE = 'allow-scripts allow-same-origin allow-forms allow-popups allow-modals allow-downloads allow-top-navigation-by-user-activation'
const PROD_CSP = "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self' https: wss:; img-src 'self' blob: data:; frame-src 'self'; worker-src 'self' blob:; object-src 'none'; base-uri 'none'; form-action 'none'"
for (const eng of ['chromium', 'webkit']) await withLab(eng, async (lab, browser) => {
  const { ctx, page } = await openShell(browser, lab, { sandbox: BASE, mirror: 'none', shellCsp: PROD_CSP }, '/form.html')
  await sleep(400)
  await page.evaluate(() => { const f = document.createElement('iframe'); f.id = 'degraded'; f.setAttribute('sandbox', 'allow-scripts allow-same-origin allow-forms'); f.setAttribute('style', 'position:fixed;left:0;top:0;width:300px;height:100px'); f.srcdoc = '<form id="sf" method="get" action="/search.html"><input name="q" value="x"><button id="sgo">go</button></form><a id="lnk" href="/a.html">link</a>'; document.body.appendChild(f) })
  await sleep(800)
  console.log(eng, 'frames:', page.frames().map((f) => f.url().replace(/^http:\/\/127.0.0.1:\d+/, '')))
  const df = page.frames().find((f) => f.url() === 'about:srcdoc')
  if (df) {
    await df.click('#sgo').catch((e) => console.log('click err', String(e).slice(0, 80))); await sleep(900)
    console.log(eng, 'srcdoc frame after form submit ->', df.url().replace(/^http:\/\/127.0.0.1:\d+/, ''), '| console CSP:', JSON.stringify(page.__console.filter((m) => /Content Security|form-action|Refused/i.test(m.text)).map((m) => m.text.slice(0, 160))))
    await df.click('#lnk').catch(() => {}); await sleep(700)
    console.log(eng, 'srcdoc frame after link click ->', df.url().replace(/^http:\/\/127.0.0.1:\d+/, ''))
  }
  await ctx.close()
})
