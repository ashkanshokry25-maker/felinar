// Scenario M4: mobile viewport meta, vh/auto-height, print, permissions policy, CSP inheritance into srcdoc.
import { withLab, openShell, frameOf, sleep, saveResults, engines } from './lib.mjs'
import { devices } from '../../../../node_modules/playwright/index.mjs'
const engine = process.argv[2] || 'chromium'
const BASE = 'allow-scripts allow-same-origin allow-forms allow-popups allow-modals allow-downloads allow-top-navigation-by-user-activation'
const out = { engine, rows: [] }
const dev = engine === 'webkit' ? devices['iPhone 15'] : devices['Pixel 7']

await withLab(engine, async (lab, browser) => {
  // ---- 1. viewport meta: the site's own <meta name=viewport content="width=1024"> inside the frame is ignored ----
  const measure = (f) => f.evaluate(() => ({ innerWidth, vvWidth: Math.round(visualViewport.width), dpr: devicePixelRatio, small: matchMedia('(max-width: 600px)').matches }))
  {
    const ctx = await browser.newContext({ ...dev }); const page = await ctx.newPage()
    await page.goto(lab.origin + '/__site/index.html'); await sleep(500)
    out.rows.push({ test: 'viewport: control, site loaded top-level (its own width=1024 applies)', device: dev.userAgent.includes('iPhone') ? 'iPhone 15' : 'Pixel 7', ...(await measure(page)) })
    await ctx.close()
  }
  for (const [label, meta] of [['shell viewport = device-width', 'width=device-width, initial-scale=1'], ['shell has NO viewport meta', '']]) {
    const { ctx, page } = await openShell(browser, lab, { sandbox: BASE, mirror: 'load', shellViewport: meta }, '/', { ...dev })
    await sleep(600)
    out.rows.push({ test: 'viewport: ' + label + ' (site page has width=1024)', top: await page.evaluate(() => ({ innerWidth, vvWidth: Math.round(visualViewport.width) })), frame: await measure(frameOf(page)) })
    await ctx.close()
  }

  // ---- 2. vh units and auto-height frames (desktop viewport) ----
  for (const [label, cfg] of [['full-viewport fixed iframe', {}], ['auto-height iframe (grow to content, top document scrolls)', { autoheight: true, frameStyle: 'position:absolute;top:0;left:0;width:100%;height:100px;border:0', shellCss: 'html,body{overflow:auto!important;height:auto!important}' }]]) {
    const { ctx, page } = await openShell(browser, lab, { sandbox: BASE, mirror: 'load', ...cfg }, '/vh.html', { viewport: { width: 1000, height: 700 } })
    await sleep(2500)
    const st = await page.evaluate(() => ({ iframeH: window.__mw.frame.getBoundingClientRect().height, resizes: window.__mw.resizes || 0 }))
    const heroH = await frameOf(page).evaluate(() => document.querySelector('.hero').getBoundingClientRect().height)
    await sleep(2500)
    const st2 = await page.evaluate(() => ({ iframeH: window.__mw.frame.getBoundingClientRect().height, resizes: window.__mw.resizes || 0 }))
    out.rows.push({ test: 'vh: ' + label + ' (viewport 700 px, site has .hero{min-height:100vh}, default 8px body margin)', t2_5s: st, heroH_at_2_5s: heroH, t5s: st2 })
    await ctx.close()
  }
  for (const [label, cfg] of [['full-viewport fixed iframe', {}], ['auto-height iframe', { autoheight: true, frameStyle: 'position:absolute;top:0;left:0;width:100%;height:100px;border:0', shellCss: 'html,body{overflow:auto!important;height:auto!important}' }]]) {
    const { ctx, page } = await openShell(browser, lab, { sandbox: BASE, mirror: 'load', ...cfg }, '/fixed.html', { viewport: { width: 1000, height: 700 } })
    await sleep(1500)
    const r = await frameOf(page).evaluate(() => ({ footerTop: Math.round(document.getElementById('ft').getBoundingClientRect().top), headerTop: Math.round(document.getElementById('hd').getBoundingClientRect().top), innerHeight, heroH: Math.round(document.getElementById('hero').getBoundingClientRect().height) }))
    const vis = await page.evaluate(() => innerHeight)
    out.rows.push({ test: 'position:fixed in frame: ' + label, topViewportH: vis, ...r })
    await ctx.close()
  }

  // ---- 3. print (Chromium only: page.pdf) ----
  if (engine === 'chromium') {
    const pages = (buf) => (buf.toString('latin1').match(/\/Type\s*\/Page[^s]/g) || []).length
    {
      const ctx = await browser.newContext(); const page = await ctx.newPage()
      await page.goto(lab.origin + '/__site/long.html'); await sleep(300)
      out.rows.push({ test: 'print: control (plain long page) PDF pages', pages: pages(await page.pdf({ format: 'A4' })) })
      await ctx.close()
    }
    for (const [label, cfg] of [
      ['shell, fixed full-viewport iframe (spec 7.2)', {}],
      ['shell + beforeprint grows the iframe to content height + @media print static', { printFix: true }]
    ]) {
      const extraCss = cfg.printFix ? '@media print{iframe{position:absolute!important;inset:auto!important;top:0;left:0;width:100%!important}html,body{overflow:visible!important;height:auto!important}}' : ''
      const { ctx, page } = await openShell(browser, lab, { sandbox: BASE, mirror: 'load', shellCss: extraCss }, '/long.html', { viewport: { width: 1000, height: 700 } })
      await sleep(600)
      if (cfg.printFix) await page.evaluate(() => { window.addEventListener('beforeprint', () => { const f = window.__mw.frame; f.style.height = f.contentDocument.documentElement.scrollHeight + 'px' }) })
      out.rows.push({ test: 'print: ' + label, pages: pages(await page.pdf({ format: 'A4' })) })
      await ctx.close()
    }
  }

  // ---- 4. Permissions Policy: is allow= needed for a same-origin frame? (Chromium only API) ----
  if (engine === 'chromium') {
    for (const [label, allow] of [['no allow attribute', ''], ['allow="fullscreen; clipboard-write; picture-in-picture"', 'fullscreen; clipboard-write; picture-in-picture']]) {
      const { ctx, page } = await openShell(browser, lab, { sandbox: BASE, mirror: 'load', allow }, '/behaviors.html')
      const r = await page.evaluate(() => {
        const names = ['fullscreen', 'picture-in-picture', 'geolocation', 'camera', 'microphone', 'payment', 'publickey-credentials-get', 'publickey-credentials-create', 'web-share', 'clipboard-read', 'clipboard-write', 'screen-wake-lock', 'autoplay', 'encrypted-media', 'display-capture', 'gamepad', 'midi', 'usb', 'serial', 'hid', 'bluetooth', 'accelerometer', 'gyroscope', 'magnetometer', 'xr-spatial-tracking', 'idle-detection', 'storage-access', 'cross-origin-isolated']
        const top = document.featurePolicy, fr = window.__mw.frame.contentDocument.featurePolicy
        const diff = names.filter((n) => top.allowsFeature(n) !== fr.allowsFeature(n))
        return { topAllowed: names.filter((n) => top.allowsFeature(n)).length, frameAllowed: names.filter((n) => fr.allowsFeature(n)).length, featuresDifferingTopVsFrame: diff, frameDisallowed: names.filter((n) => !fr.allowsFeature(n)) }
      })
      out.rows.push({ test: 'permissions policy: ' + label, ...r })
      await ctx.close()
    }
  }

  // ---- 5. CSP inheritance: the shell's form-action 'none' reaches srcdoc (degraded) frames, not SW-served frames ----
  {
    const PROD_CSP = "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self' https: wss:; img-src 'self' blob: data:; frame-src 'self'; worker-src 'self' blob:; object-src 'none'; base-uri 'none'; form-action 'none'"
    const { ctx, page } = await openShell(browser, lab, { sandbox: BASE, mirror: 'load', shellCsp: PROD_CSP }, '/form.html')
    await sleep(400)
    await frameOf(page).click('#go').catch(() => {}); await sleep(900)
    const swFrame = page.frames().find((f) => f !== page.mainFrame())
    const swResult = { frameUrl: swFrame && swFrame.url().replace(/^http:\/\/127\.0\.0\.1:\d+/, '') }
    await page.evaluate(() => { const f = document.createElement('iframe'); f.id = 'degraded'; f.setAttribute('sandbox', 'allow-scripts allow-same-origin allow-forms'); f.setAttribute('style', 'position:fixed;left:0;top:0;width:300px;height:100px'); f.srcdoc = '<form id="sf" method="get" action="/search.html"><input name="q" value="x"><button id="sgo">go</button></form>'; document.body.appendChild(f) })
    await sleep(700)
    const df = page.frames().find((f) => f.name() === '' && f.url() === 'about:srcdoc')
    let degraded = 'no srcdoc frame'
    if (df) { await df.click('#sgo').catch(() => {}); await sleep(700); degraded = 'frame url after submit: ' + df.url().replace(/^http:\/\/127\.0\.0\.1:\d+/, '') }
    out.rows.push({ test: 'CSP: shell form-action none vs SW-served frame and srcdoc (degraded-mode) frame', swServedFrameAfterSubmit: swResult, degradedFrame: degraded, cspViolations: page.__console.filter((m) => /Content Security Policy|form-action/i.test(m.text)).map((m) => m.text.slice(0, 200)).slice(0, 3) })
    await ctx.close()
  }
}, engine === 'chromium' ? {} : {})
for (const r of out.rows) console.log(JSON.stringify(r).slice(0, 900))
console.log('saved', saveResults('misc4', engine, out))
