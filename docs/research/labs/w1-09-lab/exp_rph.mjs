// Research aid for docs/research/w1-09-protocol-handler-magnet.md (NOT production code).
// EXP-1: navigator.registerProtocolHandler runtime semantics in Chromium, Firefox, WebKit (Playwright builds).
// EXP-2: Chromium manifest "protocol_handlers" parser verdicts via CDP Page.getAppManifest.
// Usage: node exp_rph.mjs <outfile.json>
import http from 'node:http'
import fs from 'node:fs'
import { chromium, firefox, webkit } from '$HOME/Documents/Projects/magnet-web/node_modules/playwright/index.mjs'

const out = process.argv[2] || '/dev/stdout'

// ---------- tiny server ----------
const FRAME = `<!doctype html><meta charset=utf-8><body><script>
const r = {}
const t = (n, f) => { try { f(); r[n] = 'ok' } catch (e) { r[n] = e.name + ': ' + e.message } }
r.hasMethod = typeof navigator.registerProtocolHandler
r.isSecureContext = isSecureContext
r.origin = String(location.origin)
if (r.hasMethod === 'function') t('magnet', () => navigator.registerProtocolHandler('magnet', location.origin + '/#%s'))
parent.postMessage(JSON.stringify(r), '*')
</script>`
const HOST = (sandbox) => `<!doctype html><meta charset=utf-8><body><iframe id=f sandbox="${sandbox}" src="/frame.html"></iframe>
<script>addEventListener('message', e => { window.__frame = JSON.parse(e.data) })</script>`
const PAGE = `<!doctype html><meta charset=utf-8><title>rph</title><body>rph test</body>`
const MANIFESTS = {} // name -> manifest object, filled below

const server = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://x')
  const send = (type, body, status = 200) => { res.writeHead(status, { 'content-type': type, 'cache-control': 'no-store' }); res.end(body) }
  if (u.pathname === '/' || u.pathname === '/index.html') return send('text/html', PAGE)
  if (u.pathname === '/frame.html') return send('text/html', FRAME)
  if (u.pathname === '/host-sameorigin.html') return send('text/html', HOST('allow-scripts allow-same-origin'))
  if (u.pathname === '/host-opaque.html') return send('text/html', HOST('allow-scripts'))
  const m = /^\/mf\/(.+)\.html$/.exec(u.pathname)
  if (m) return send('text/html', `<!doctype html><meta charset=utf-8><link rel=manifest href="/mf/${m[1]}.webmanifest"><title>${m[1]}</title><body>${m[1]}</body>`)
  const w = /^\/mf\/(.+)\.webmanifest$/.exec(u.pathname)
  if (w && MANIFESTS[w[1]]) return send('application/manifest+json', JSON.stringify(MANIFESTS[w[1]]))
  if (u.pathname === '/icon.png') {
    // 1x1 transparent PNG is enough for parsing purposes
    const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64')
    res.writeHead(200, { 'content-type': 'image/png' }); return res.end(png)
  }
  send('text/plain', 'not found', 404)
})
await new Promise((r) => server.listen(0, '127.0.0.1', r))
const base = `http://127.0.0.1:${server.address().port}`

// ---------- EXP-1 runtime semantics ----------
async function exp1 (name, bt) {
  const res = { engine: name }
  let browser
  try {
    browser = await bt.launch()
    res.version = browser.version()
    const ctx = await browser.newContext()
    const page = await ctx.newPage()
    await page.goto(base + '/index.html')
    res.ua = await page.evaluate(() => navigator.userAgent)
    res.cases = await page.evaluate(() => {
      const r = {}
      const t = (n, f) => { try { const v = f(); r[n] = 'ok' + (v === undefined ? '' : ' -> ' + String(v)) } catch (e) { r[n] = e.name + ': ' + e.message } }
      r.hasRegister = typeof navigator.registerProtocolHandler
      r.hasUnregister = typeof navigator.unregisterProtocolHandler
      r.hasIsRegistered = typeof navigator.isProtocolHandlerRegistered
      r.isSecureContext = isSecureContext
      if (typeof navigator.registerProtocolHandler !== 'function') return r
      const o = location.origin
      const R = (s, u, ...rest) => navigator.registerProtocolHandler(s, u, ...rest)
      t('magnet absolute /#%s', () => R('magnet', o + '/#%s'))
      t('magnet relative /#%s', () => R('magnet', '/#%s'))
      t('magnet legacy 3-arg (title)', () => R('magnet', o + '/#%s', 'Title'))
      t('MAGNET (uppercase scheme)', () => R('MAGNET', o + '/#%s'))
      t('web+magnetweb', () => R('web+magnetweb', o + '/#%s'))
      t('web+magnet2 (digit)', () => R('web+magnet2', o + '/#%s'))
      t('web+ (empty suffix)', () => R('web+', o + '/#%s'))
      t('bittorrent (not safelisted)', () => R('bittorrent', o + '/#%s'))
      t('magnet: (trailing colon)', () => R('magnet:', o + '/#%s'))
      t('https (hijack core scheme)', () => R('https', o + '/#%s'))
      t('magnet no %s', () => R('magnet', o + '/'))
      t('magnet cross-origin https', () => R('magnet', 'https://example.org/#%s'))
      t('magnet cross-origin http', () => R('magnet', 'http://example.org/#%s'))
      t('magnet %s in host', () => R('magnet', 'http://%s.example/'))
      t('magnet ?m=%s query form', () => R('magnet', o + '/?m=%s'))
      return r
    })
    // sandboxed iframe behaviour (hub-mode flags vs opaque origin)
    for (const [label, path] of [['iframe sandbox allow-scripts allow-same-origin', '/host-sameorigin.html'], ['iframe sandbox allow-scripts (opaque origin)', '/host-opaque.html']]) {
      const p2 = await ctx.newPage()
      await p2.goto(base + path)
      await p2.waitForFunction(() => window.__frame, null, { timeout: 8000 }).catch(() => {})
      res[label] = await p2.evaluate(() => window.__frame || 'no message from frame')
      await p2.close()
    }
    // private/incognito window
    await ctx.close()
  } catch (e) {
    res.error = String(e && e.message || e)
  } finally {
    if (browser) await browser.close().catch(() => {})
  }
  return res
}

// ---------- EXP-2 manifest verdicts (Chromium only) ----------
const base_manifest = (extra) => ({ name: 'T', short_name: 'T', start_url: '/', scope: '/', display: 'standalone', icons: [{ src: '/icon.png', sizes: '192x192', type: 'image/png' }], ...extra })
const CASES = {
  c01_magnet_fragment: [{ protocol: 'magnet', url: '/#%s' }],
  c02_magnet_query: [{ protocol: 'magnet', url: '/?m=%s' }],
  c03_magnet_path_fragment: [{ protocol: 'magnet', url: '/open#%s' }],
  c04_web_magnetweb: [{ protocol: 'web+magnetweb', url: '/#%s' }],
  c05_bittorrent_not_safelisted: [{ protocol: 'bittorrent', url: '/#%s' }],
  c06_magnet_no_token: [{ protocol: 'magnet', url: '/' }],
  c07_magnet_cross_origin: [{ protocol: 'magnet', url: 'https://other.example/#%s' }],
  c08_magnet_uppercase: [{ protocol: 'MAGNET', url: '/#%s' }],
  c09_two_handlers_one_bad: [{ protocol: 'magnet', url: '/#%s' }, { protocol: 'nope', url: '/#%s' }],
  c10_magnet_outside_scope: [{ protocol: 'magnet', url: '/#%s' }] // paired with scope /app/ below
}
async function exp2 (bt) {
  const res = { engine: 'chromium' }
  let browser
  try {
    browser = await bt.launch()
    res.version = browser.version()
    for (const [name, handlers] of Object.entries(CASES)) {
      const scoped = name === 'c10_magnet_outside_scope'
      MANIFESTS[name] = base_manifest({ protocol_handlers: handlers, ...(scoped ? { start_url: '/app/', scope: '/app/' } : {}) })
      const ctx = await browser.newContext()
      const page = await ctx.newPage()
      await page.goto(`${base}/mf/${name}.html`)
      const cdp = await ctx.newCDPSession(page)
      await cdp.send('Page.enable').catch(() => {})
      let r
      try { r = await cdp.send('Page.getAppManifest') } catch (e) { r = { cdpError: String(e.message || e) } }
      res[name] = { handlers, errors: (r.errors || []).map((e) => `${e.critical ? 'CRITICAL ' : ''}${e.message}`), cdpError: r.cdpError, hasData: !!r.data }
      await ctx.close()
    }
  } catch (e) {
    res.error = String(e && e.message || e)
  } finally {
    if (browser) await browser.close().catch(() => {})
  }
  return res
}

const result = { date: new Date().toISOString(), base, exp1: [], exp2: null }
for (const [n, bt] of [['chromium', chromium], ['firefox', firefox], ['webkit', webkit]]) result.exp1.push(await exp1(n, bt))
result.exp2 = await exp2(chromium)
fs.writeFileSync(out, JSON.stringify(result, null, 2))
server.close()
console.log('wrote', out)
