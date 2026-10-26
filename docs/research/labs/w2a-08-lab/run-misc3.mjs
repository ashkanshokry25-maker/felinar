// Scenario M3: keyboard focus, scroll restoration, text fragments.
import { withLab, openShell, frameOf, sleep, saveResults, back } from './lib.mjs'
const engine = process.argv[2] || 'chromium'
const BASE = 'allow-scripts allow-same-origin allow-forms allow-popups allow-modals allow-downloads allow-top-navigation-by-user-activation'
const out = { engine, rows: [] }
const rel = (u) => String(u).replace(/^http:\/\/127\.0\.0\.1:\d+/, '')
const fy = (page) => frameOf(page).evaluate(() => Math.round(window.scrollY))

await withLab(engine, async (lab, browser) => {
  // ---- focus / keyboard scrolling ----
  for (const focusOnLoad of [false, true]) {
    const { ctx, page } = await openShell(browser, lab, { sandbox: BASE, mirror: 'load', focusOnLoad }, '/long.html')
    await sleep(500)
    const st = await page.evaluate(() => ({ topActive: document.activeElement && document.activeElement.tagName, topHasFocus: document.hasFocus(), frameHasFocus: (() => { try { return window.__mw.frame.contentDocument.hasFocus() } catch (e) { return 'err' } })(), frameActive: (() => { try { return window.__mw.frame.contentDocument.activeElement.tagName } catch (e) { return 'err' } })() }))
    const y0 = await fy(page)
    await page.keyboard.press('PageDown'); await sleep(500)
    const y1 = await fy(page)
    await page.keyboard.press('Space'); await sleep(500)
    const y2 = await fy(page)
    // after an in-frame navigation, does keyboard scrolling still work without a click?
    await frameOf(page).click('#to-a'); await sleep(900)
    const ya = await fy(page)
    await page.keyboard.press('PageDown'); await sleep(500)
    const yb = await fy(page)
    const st2 = await page.evaluate(() => ({ topActive: document.activeElement && document.activeElement.tagName, frameActive: (() => { try { return window.__mw.frame.contentDocument.activeElement.tagName } catch (e) { return 'err' } })() }))
    out.rows.push({ test: 'keyboard scroll without clicking into the frame', focusOnLoad, state: st, scrollY: { start: y0, afterPageDown: y1, afterSpace: y2 }, afterInFrameLinkClick: { startY: ya, afterPageDown: yb, active: st2 } })
    await ctx.close()
  }

  // ---- scroll restoration ----
  const controlPage = async () => {
    const ctx = await browser.newContext(); const page = await ctx.newPage()
    await page.goto(lab.origin + '/__site/long.html'); await page.evaluate(() => scrollTo(0, 1500)); await sleep(400)
    const before = await page.evaluate(() => Math.round(scrollY))
    await page.reload({ waitUntil: 'load' }); await sleep(600)
    const afterReload = await page.evaluate(() => Math.round(scrollY))
    await page.evaluate(() => scrollTo(0, 1500)); await sleep(300)
    await page.goto(lab.origin + '/__site/a.html'); await sleep(500)
    await back(page); await sleep(1200)
    const afterBack = await page.evaluate(() => Math.round(scrollY))
    await ctx.close()
    return { before, afterReload, afterBack }
  }
  out.rows.push({ test: 'scroll: control (plain top-level page)', ...(await controlPage()) })
  for (const [label, extra] of [['shell, no restore logic', {}], ['shell + sessionStorage restore', { saveScroll: true, restoreScroll: true }]]) {
    const { ctx, page } = await openShell(browser, lab, { sandbox: BASE, mirror: 'load', ...extra }, '/long.html')
    await sleep(400)
    await frameOf(page).evaluate(() => window.scrollTo(0, 1500)); await sleep(500)
    const before = await fy(page)
    await page.reload({ waitUntil: 'load' })
    await page.waitForFunction(() => window.__mw && window.__mw.loads >= 1, null, { timeout: 15000 }); await sleep(900)
    const afterReload = await fy(page)
    await frameOf(page).evaluate(() => window.scrollTo(0, 1500)); await sleep(500)
    await frameOf(page).evaluate(() => document.getElementById('to-a').click()); await sleep(900)   // programmatic click: Playwright's click() would scroll the link into view and change the saved offset
    await back(page); await sleep(1300)
    const afterBack = await fy(page)
    out.rows.push({ test: 'scroll: ' + label, before, afterTopReload: afterReload, afterInFrameBack: afterBack })
    await ctx.close()
  }

  // ---- text fragments ----
  const TF = '#:~:text=quick%20needle%20phrase'
  {
    const ctx = await browser.newContext(); const page = await ctx.newPage()
    await page.goto(lab.origin + '/__site/long.html' + TF, { waitUntil: 'load' }); await sleep(1200)
    out.rows.push({ test: 'text fragment: control (plain top-level)', scrollY: await page.evaluate(() => Math.round(scrollY)), locationHash: await page.evaluate(() => location.hash), navEntryName: await page.evaluate(() => performance.getEntriesByType('navigation')[0].name.replace(/^http:\/\/127\.0\.0\.1:\d+/, '')) })
    await ctx.close()
  }
  for (const [label, extra] of [['shell passes location.hash', { passHash: true }], ['shell passes navigation-entry hash', { passHash: true, tfFromNav: true }]]) {
    const { ctx, page } = await openShell(browser, lab, { sandbox: BASE, mirror: 'load', ...extra }, '/long.html' + TF)
    await sleep(1500)
    const info = await page.evaluate(() => ({ log: window.__mw.log.filter((e) => /hash|nav-entry/.test(e.type)).map((e) => JSON.stringify(e)), frameSrc: window.__mw.frame.getAttribute('src') }))
    out.rows.push({ test: 'text fragment: ' + label, frameScrollY: await fy(page), frameSrc: info.frameSrc, shellSaw: info.log })
    await ctx.close()
  }
})
for (const r of out.rows) console.log(JSON.stringify(r).slice(0, 800))
console.log('saved', saveResults('misc3', engine, out))
