// Scenario M1: frame-busting, PDF viewer, popup opener (OAuth callback), agent injection vs strict CSP.
import { withLab, openShell, frameOf, sleep, saveResults, engines } from './lib.mjs'
const engArg = process.argv[2] || 'chromium'
const [engine, variant] = engArg.split(':')
const launch = variant === 'full' ? { channel: 'chromium' } : {}
const BASE = 'allow-scripts allow-same-origin allow-forms allow-popups allow-modals allow-downloads allow-top-navigation-by-user-activation'
const out = { engine: engArg, rows: [] }
const rel = (u) => String(u).replace(/^http:\/\/127\.0\.0\.1:\d+/, '')

await withLab(engine, async (lab, browser) => {
  // 1. classic frame-buster at load, with and without sandbox
  for (const [label, sandbox] of [['sandbox without allow-top-navigation*', 'allow-scripts allow-same-origin allow-forms allow-popups allow-modals allow-downloads'], ['sandbox with by-user-activation', BASE], ['no sandbox', null]]) {
    const { ctx, page } = await openShell(browser, lab, { sandbox, mirror: 'load' }, '/a.html')
    lab.clearLog()
    await frameOf(page).click('#to-index').catch(() => {})
    await sleep(500)
    lab.clearLog()
    // navigate the frame to the legacy page via a normal link: use location from the shell to avoid needing a link on a.html
    await page.evaluate(() => { window.__mw.frame.contentWindow.location.assign('/bust.html') })
    await sleep(3500)
    const docReqs = lab.state.log.filter((r) => r.url.startsWith('/_mw/shell.js')).length
    const errs = page.__console.filter((m) => /Unsafe attempt|sandbox|top/i.test(m.text) && !/can escape/.test(m.text)).map((m) => m.text.slice(0, 200)).slice(0, 2)
    out.rows.push({ test: 'frame-buster at load', label, shellLoadsIn3_5s: docReqs, topUrl: rel(page.url()), console: errs })
    await ctx.close()
  }

  // 2. PDF link inside the frame (full Chromium has the PDF viewer; headless shell does not)
  for (const [label, sandbox] of [['sandbox BASE', BASE], ['no sandbox', null]]) {
    const { ctx, page } = await openShell(browser, lab, { sandbox, mirror: 'load' }, '/behaviors.html')
    await frameOf(page).click('#a-pdf').catch(() => {}); await sleep(2500)
    const f = frameOf(page)
    let ct = null; try { ct = await f.evaluate(() => document.contentType) } catch (e) { ct = 'unreadable' }
    out.rows.push({ test: 'pdf link in frame', label, frameUrl: rel(f && f.url()), contentType: ct, downloads: page.__downloads.length, console: page.__console.filter((m) => /pdf|blocked|sandbox/i.test(m.text) && !/can escape/.test(m.text)).map((m) => m.text.slice(0, 160)).slice(0, 2) })
    await ctx.close()
  }

  // 3. popup + window.opener (OAuth callback shape): shell mode loses window.opener inside the popup's frame; agent shim restores it
  for (const [label, extra] of [['no agent', {}], ['agent injected by SW', { injectAgent: true }]]) {
    const { ctx, page } = await openShell(browser, lab, { sandbox: BASE + ' allow-popups-to-escape-sandbox', mirror: 'load', ...extra }, '/behaviors.html')
    await frameOf(page).click('#b-oauth'); await sleep(2500)
    const pp = page.__popups[0]
    let title = 'NO POPUP'
    if (pp) { await pp.waitForLoadState('load').catch(() => {}); await sleep(500); title = await pp.title().catch(() => '?') }
    const res = await frameOf(page).evaluate(() => window.__res).catch(() => null)
    out.rows.push({ test: 'popup callback: window.opener', label, popupTitle: title, openerGotMessages: res && res.msg })
    await ctx.close()
  }

  // 4. agent injection vs strict CSP (meta-delivered vs header-delivered, with and without nonce propagation)
  for (const [label, page_, extra] of [['meta CSP, agent injected before it', '/strictcsp.html', { injectAgent: true }], ['header CSP, agent injected without nonce', '/strictcsp-hdr.html', { injectAgent: true }], ['header CSP, agent injected with the page nonce', '/strictcsp-hdr.html', { injectAgent: true, agentNonce: true }]]) {
    const { ctx, page } = await openShell(browser, lab, { sandbox: BASE, mirror: 'load', ...extra }, page_)
    await sleep(800)
    const st = await frameOf(page).evaluate(() => ({ site: window.__siteScript, agent: window.__agent || null, title: document.title })).catch(() => null)
    const csp = page.__console.filter((m) => /Content Security Policy|Refused to/i.test(m.text)).map((m) => m.text.slice(0, 220)).slice(0, 2)
    out.rows.push({ test: 'agent injection vs strict CSP', label, state: st, console: csp })
    await ctx.close()
  }
}, launch)
for (const r of out.rows) console.log(JSON.stringify(r).slice(0, 700))
console.log('saved', saveResults('misc1', engArg.replace(':', '-'), out))
