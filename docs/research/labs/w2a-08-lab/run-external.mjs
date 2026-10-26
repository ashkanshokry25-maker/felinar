// Scenario X: navigations that leave the site origin, form posts, X-Frame-Options pages, and Navigation-API interception.
import { withLab, openShell, frameOf, sleep, saveResults } from './lib.mjs'
const engine = process.argv[2] || 'chromium'
const SANDBOX = 'allow-scripts allow-same-origin allow-forms allow-popups allow-modals allow-downloads allow-top-navigation-by-user-activation allow-popups-to-escape-sandbox'
const rel = (u) => String(u).replace(/^http:\/\/127\.0\.0\.1:\d+/, '').replace(/127\.0\.0\.1:\d+/, '127.0.0.1:EXT')
const out = { engine, rows: [] }

const cases = [
  ['cross-origin link click', '#a-ext'],
  ['location.href = external (in click handler)', '#b-ext-js'],
  ['cross-origin form POST -> 303 back to site', '#f-ext-post-btn'],
  ['cross-origin form POST -> X-Frame-Options DENY page', '#f-ext-deny-btn'],
  ['same-origin form POST (static host => 405)', '#f-self-post-btn'],
  ['GET form to /search.html', '#f-get-btn'],
  ['target=_top link to external', '#a-top-ext'],
  ['target=_top same-origin link', '#a-top'],
  ['target=_parent same-origin link', '#a-parent']
]

await withLab(engine, async (lab, browser) => {
  for (const guard of ['none', 'navapi-cancel']) {
    for (const [name, sel] of cases) {
      const cfg = { sandbox: SANDBOX, mirror: 'full', guard: guard === 'none' ? 'none' : 'navapi', guardCancel: guard !== 'none' }
      const { ctx, page } = await openShell(browser, lab, cfg, '/behaviors.html')
      try {
        const popBefore = page.__popups.length
        await frameOf(page).click(sel).catch((e) => { out.err = String(e).slice(0, 100) })
        await sleep(1800)
        const mw = await page.evaluate(() => window.__mw && ({ log: window.__mw.log.map((e) => e.type + (e.url ? '(' + e.url.slice(0, 60) + ')' : '') + (e.navType ? '[' + e.navType + (e.cancelable ? ',cancelable' : '') + (e.external ? ',ext' : '') + ']' : '') + (e.reason ? '(' + e.reason + ')' : '')).slice(-8), mirrors: window.__mw.mirrors })).catch(() => null)
        const f = frameOf(page)
        let text = null
        try { text = (await f.locator('body').innerText({ timeout: 1500 })).replace(/\s+/g, ' ').slice(0, 70) } catch (e) { text = 'n/a:' + String(e).slice(0, 40) }
        out.rows.push({ guard, case: name, topUrl: rel(page.url()), frameUrl: rel(f && f.url()), frameText: text, popups: page.__popups.length - popBefore, topReloaded: mw === null || (mw && mw.log && mw.log[0] === 'top-pageshow'), shellLog: mw && mw.log, console: page.__console.filter((m) => /refused|blocked|sandbox|frame|Unsafe|denied|X-Frame/i.test(m.text) && !/can escape/.test(m.text)).map((m) => m.text.slice(0, 140)).slice(0, 2) })
      } finally { await ctx.close().catch(() => {}) }
    }
  }
})
for (const r of out.rows) console.log(`${r.guard.padEnd(14)} ${r.case.padEnd(52)} top=${r.topUrl.padEnd(22)} frame=${String(r.frameUrl).padEnd(38)} text="${r.frameText}" popups=${r.popups} log=${JSON.stringify(r.shellLog)} ${r.console.length ? 'CONSOLE:' + JSON.stringify(r.console) : ''}`)
console.log('saved', saveResults('external', engine, out))
