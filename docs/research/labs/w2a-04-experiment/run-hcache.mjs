// E-CACHE-1: does cache:'force-cache' re-use big files, i.e. how much would the v0.2 SW web-seed rewrite re-download?
import { openBrowser } from './browsers.mjs'
import { chromium, webkit } from 'playwright'
import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs'
import { startLab } from './lab.mjs'
const WHICH = process.env.BROWSER || 'chromium'
const HDR = {
  'no-cache+etag': { 'cache-control': 'no-cache', etag: '"v1"' },
  'max-age=600 (GitHub Pages style)': { 'cache-control': 'max-age=600', etag: '"v1"' },
  'no-store': { 'cache-control': 'no-store' },
  'immutable 1y': { 'cache-control': 'public, max-age=31536000, immutable' }
}
const lab = await startLab({ withTracker: false, headersFor: (url) => HDR[url.searchParams.get('h')] || {} })
const PERSIST = process.env.PERSIST === '1'
const browser = PERSIST ? { version: () => (WHICH + ' persistent profile'), close: async () => {}, newContext: null } : await openBrowser(WHICH)
let profN = 0
const out = { browser: WHICH + ' ' + browser.version(), n_fetches: 5, rows: [] }
for (const h of Object.keys(HDR)) {
  for (const mb of [1, 10, 50, 120]) {
    let ctx, page
    if (PERSIST) { const dir = path.join(path.dirname(new URL(import.meta.url).pathname), 'prof-h' + (profN++)); fs.rmSync(dir, { recursive: true, force: true }); ctx = await (WHICH === 'webkit' ? webkit : chromium).launchPersistentContext(dir, WHICH === 'webkit' ? { headless: true } : { channel: 'chromium', headless: true }); page = ctx.pages()[0] || await ctx.newPage() } else { ctx = await browser.newContext(); page = await ctx.newPage() }
    await page.goto(`${lab.origin}/blank.html`)
    const url = `/big/f${mb}.bin?h=${encodeURIComponent(h)}`
    const before = lab.hits.filter((x) => x.path === url).length
    const t0 = Date.now()
    const bytes = await page.evaluate(async (u) => { let n = 0; for (let i = 0; i < 5; i++) { const r = await fetch(u, { cache: 'force-cache' }); n += (await r.arrayBuffer()).byteLength } return n }, url)
    const hits = lab.hits.filter((x) => x.path === url).length - before
    out.rows.push({ header: h, sizeMB: mb, serverGETs: hits, ok: bytes === 5 * mb * 1024 * 1024, ms: Date.now() - t0 })
    console.log(JSON.stringify(out.rows.at(-1)))
    await ctx.close(); if (PERSIST) fs.rmSync(path.join(path.dirname(new URL(import.meta.url).pathname), 'prof-h' + (profN - 1)), { recursive: true, force: true })
  }
}
fs.writeFileSync(new URL('./results/hcache-' + WHICH + (PERSIST ? '-persistent' : '') + '.json', import.meta.url), JSON.stringify(out, null, 1))
await browser.close(); await lab.close()
