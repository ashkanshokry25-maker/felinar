// Usage: node exp_manifest.mjs <chromium|brave> <outJson> [braveProfileDir]
import http from 'node:http'
import fs from 'node:fs'
import { chromium } from '$HOME/Documents/Projects/magnet-web/node_modules/playwright/index.mjs'
const [engine, out, profile] = process.argv.slice(2)
const BRAVE = '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser'
const mk = (extra) => ({ name: 'T', short_name: 'T', start_url: '/', scope: '/', display: 'standalone', icons: [{ src: '/icon.png', sizes: '192x192', type: 'image/png' }], ...extra })
const PH = (arr, extra = {}) => mk({ protocol_handlers: arr, ...extra })
const CASES = {
  'A magnet "/#%s" scope "/"': PH([{ protocol: 'magnet', url: '/#%s' }]),
  'B magnet "/?m=%s"': PH([{ protocol: 'magnet', url: '/?m=%s' }]),
  'C magnet "/open#%s"': PH([{ protocol: 'magnet', url: '/open#%s' }]),
  'D magnet "./#%s" (relative to manifest URL)': PH([{ protocol: 'magnet', url: './#%s' }]),
  'E magnet "#%s" (fragment only)': PH([{ protocol: 'magnet', url: '#%s' }]),
  'F magnet "%s" (bare)': PH([{ protocol: 'magnet', url: '%s' }]),
  'G web+magnetweb "/#%s"': PH([{ protocol: 'web+magnetweb', url: '/#%s' }]),
  'H MAGNET "/#%s"': PH([{ protocol: 'MAGNET', url: '/#%s' }]),
  'I bittorrent "/#%s"': PH([{ protocol: 'bittorrent', url: '/#%s' }]),
  'J magnet "/" (no %s)': PH([{ protocol: 'magnet', url: '/' }]),
  'K magnet cross-origin https://other.example/#%s': PH([{ protocol: 'magnet', url: 'https://other.example/#%s' }]),
  'L scope "/app/" start "/app/" url "/#%s" (outside scope)': PH([{ protocol: 'magnet', url: '/#%s' }], { scope: '/app/', start_url: '/app/' }),
  'M scope "/app/" start "/app/" url "/app/#%s" (inside scope)': PH([{ protocol: 'magnet', url: '/app/#%s' }], { scope: '/app/', start_url: '/app/' }),
  'N two entries: good magnet + bad scheme': PH([{ protocol: 'magnet', url: '/#%s' }, { protocol: 'nope', url: '/#%s' }]),
  'O magnet: (trailing colon)': PH([{ protocol: 'magnet:', url: '/#%s' }]),
  'P magnet "/#%s" duplicate x2': PH([{ protocol: 'magnet', url: '/#%s' }, { protocol: 'magnet', url: '/#%s' }]),
  'Q ipfs "/#%s" (Chromium extra)': PH([{ protocol: 'ipfs', url: '/#%s' }]),
  'R magnet "http://127.0.0.1:1/#%s" other port': PH([{ protocol: 'magnet', url: 'http://127.0.0.1:1/#%s' }]),
  'S magnet "/#%s" with %s in host form': PH([{ protocol: 'magnet', url: 'http://%s.example/' }])
}
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64')
const names = Object.keys(CASES)
const server = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://x')
  const send = (type, body, status = 200) => { res.writeHead(status, { 'content-type': type, 'cache-control': 'no-store' }); res.end(body) }
  const m = /^\/mf\/(\d+)\.html$/.exec(u.pathname)
  if (m) return send('text/html', `<!doctype html><meta charset=utf-8><link rel=manifest href="/mf/${m[1]}.webmanifest"><title>${m[1]}</title><body>${m[1]}</body>`)
  const w = /^\/mf\/(\d+)\.webmanifest$/.exec(u.pathname)
  if (w) return send('application/manifest+json', JSON.stringify(CASES[names[Number(w[1])]]))
  if (u.pathname === '/icon.png') { res.writeHead(200, { 'content-type': 'image/png' }); return res.end(png) }
  send('text/plain', 'nf', 404)
})
await new Promise((r) => server.listen(0, '127.0.0.1', r))
const base = `http://127.0.0.1:${server.address().port}`
const result = { when: new Date().toISOString(), engine, base, cases: {} }
let browser, ctx
try {
  if (engine === 'brave') {
    ctx = await chromium.launchPersistentContext(profile, { executablePath: BRAVE, headless: true, args: ['--no-first-run', '--no-default-browser-check', '--disable-background-networking', '--disable-component-update', '--disable-sync'] })
  } else {
    browser = await chromium.launch(); result.version = browser.version(); ctx = await browser.newContext()
  }
  for (let i = 0; i < names.length; i++) {
    const page = await ctx.newPage()
    await page.goto(`${base}/mf/${i}.html`)
    const cdp = await ctx.newCDPSession(page)
    await cdp.send('Page.enable').catch(() => {})
    let r
    try { r = await cdp.send('Page.getAppManifest') } catch (e) { r = { cdpError: String(e.message || e) } }
    result.cases[names[i]] = { errors: (r.errors || []).map((e) => e.message), cdpError: r.cdpError }
    await page.close()
  }
} catch (e) { result.error = String(e && e.message || e).slice(0, 1500) } finally {
  try { if (ctx) await ctx.close() } catch {}
  try { if (browser) await browser.close() } catch {}
  server.close()
}
fs.writeFileSync(out, JSON.stringify(result, null, 2))
console.log('wrote', out, result.error || 'ok')
