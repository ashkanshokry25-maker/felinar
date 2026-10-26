// VERIFY lab (claim 6): does a REAL browser navigation to ipfs.io / dweb.link get redirected to inbrowser.link?
// usage: node nav-redirect.mjs  (headless Chromium via the project's Playwright; one read-only GET of a 32-byte public file)
import { createRequire } from 'node:module'
const require = createRequire('$HOME/Documents/Projects/magnet-web/package.json')
const { chromium } = require('playwright')
const CID = 'bafybeifx7yeb55armcsxwwitkymga5xf53dxiarykms3ygqic223w5sk3m'
const targets = [`https://ipfs.io/ipfs/${CID}`, `https://dweb.link/ipfs/${CID}`]
const browser = await chromium.launch()
console.log('# chromium', browser.version(), new Date().toISOString())
for (const ua of ['default-headless', 'stripped-HeadlessChrome']) {
  for (const target of targets) {
    const ctx = await browser.newContext(ua === 'default-headless' ? {} : { userAgent: (await (async () => { const p = await browser.newPage(); const u = await p.evaluate(() => navigator.userAgent); await p.close(); return u.replace('HeadlessChrome', 'Chrome') })()) })
    const page = await ctx.newPage()
    const chain = []
    page.on('response', r => { const req = r.request(); if (req.isNavigationRequest() && req.frame() === page.mainFrame()) chain.push(`${r.status()} ${r.url().slice(0, 120)}${r.headers().location ? ' -> ' + r.headers().location.slice(0, 120) : ''}`) })
    let err = null
    try { await page.goto(target, { waitUntil: 'commit', timeout: 20000 }); await page.waitForTimeout(6000) } catch (e) { err = String(e).slice(0, 160) }
    console.log(JSON.stringify({ ua, target, finalUrl: page.url().slice(0, 140), chain, err }))
    await ctx.close()
  }
}
await browser.close()
