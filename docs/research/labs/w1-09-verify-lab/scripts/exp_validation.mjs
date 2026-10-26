// Usage: node exp_validation.mjs <engine: chromium|webkit|firefox|brave> <outJson> [profileDir for brave]
import http from 'node:http'
import fs from 'node:fs'
import { chromium, firefox, webkit } from '$HOME/Documents/Projects/magnet-web/node_modules/playwright/index.mjs'
import { PAGE_FN } from './rph_cases.mjs'

const [engine, out, profile] = process.argv.slice(2)
const BRAVE = '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser'

const BASE_HTML = (extra = '') => `<!doctype html><meta charset=utf-8><title>v</title>${extra}<body>v</body>`
const FRAME = `<!doctype html><meta charset=utf-8><body><script>
const r = {}
r.has = typeof navigator.registerProtocolHandler
try { navigator.registerProtocolHandler('magnet', location.origin + '/#%s'); r.call = 'ok' } catch (e) { r.call = e.name + ': ' + e.message }
parent.postMessage(JSON.stringify(r), '*')
</script>`
const HOST = (sb) => `<!doctype html><meta charset=utf-8><body><iframe sandbox="${sb}" src="/frame.html"></iframe><script>addEventListener('message', e => { window.__frame = JSON.parse(e.data) })</script>`

const server = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://x')
  const send = (type, body, status = 200) => { res.writeHead(status, { 'content-type': type, 'cache-control': 'no-store' }); res.end(body) }
  if (u.pathname === '/frame.html') return send('text/html', FRAME)
  if (u.pathname === '/host-same.html') return send('text/html', HOST('allow-scripts allow-same-origin'))
  if (u.pathname === '/host-opaque.html') return send('text/html', HOST('allow-scripts'))
  if (u.pathname === '/with-base.html') return send('text/html', BASE_HTML('<base href="https://example.org/">'))
  send('text/html', BASE_HTML())
})
await new Promise((r) => server.listen(0, '127.0.0.1', r))
const port = server.address().port
const base = `http://127.0.0.1:${port}`

const result = { when: new Date().toISOString(), engine, base }
let browser, ctx
try {
  if (engine === 'brave') {
    ctx = await chromium.launchPersistentContext(profile, { executablePath: BRAVE, headless: true, args: ['--no-first-run', '--no-default-browser-check', '--disable-background-networking', '--disable-component-update', '--disable-sync'] })
    result.version = 'Brave ' + (await ctx.browser()?.version?.())
  } else {
    const bt = { chromium, webkit, firefox }[engine]
    browser = await bt.launch()
    result.version = browser.version()
    ctx = await browser.newContext()
  }
  const page = ctx.pages()[0] || await ctx.newPage()
  await page.goto(base + '/index.html')
  result.main = await page.evaluate(PAGE_FN)
  // <base href> cross-origin + relative template
  const p2 = await ctx.newPage()
  await p2.goto(base + '/with-base.html')
  result.withBaseHref = await p2.evaluate(() => { try { navigator.registerProtocolHandler('magnet', '/#%s'); return 'ok' } catch (e) { return e.name + ': ' + e.message } })
  await p2.close()
  for (const [label, path] of [['iframe sandbox "allow-scripts allow-same-origin"', '/host-same.html'], ['iframe sandbox "allow-scripts" (opaque)', '/host-opaque.html']]) {
    const p3 = await ctx.newPage()
    await p3.goto(base + path)
    await p3.waitForFunction(() => window.__frame, null, { timeout: 8000 }).catch(() => {})
    result[label] = await p3.evaluate(() => window.__frame || 'no message')
    await p3.close()
  }
  // insecure context check: a non-loopback hostname over plain http (needs resolver rule, Chromium family only)
} catch (e) {
  result.error = String(e && e.message || e).slice(0, 2000)
} finally {
  try { if (ctx) await ctx.close() } catch {}
  try { if (browser) await browser.close() } catch {}
  server.close()
}
fs.writeFileSync(out, JSON.stringify(result, null, 2))
console.log('wrote', out, result.error ? 'ERROR: ' + result.error.slice(0, 300) : 'ok')
