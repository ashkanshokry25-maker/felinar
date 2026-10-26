import http from 'node:http'
import { firefox } from '$HOME/Documents/Projects/magnet-web/node_modules/playwright/index.mjs'
const server = http.createServer((req, res) => { res.writeHead(200, { 'content-type': 'text/html' }); res.end('<!doctype html><meta charset=utf-8><title>ff</title>ff') })
await new Promise((r) => server.listen(0, '127.0.0.1', r))
const base = `http://127.0.0.1:${server.address().port}`
const profile = process.argv[2]
let ctx
try {
  ctx = await firefox.launchPersistentContext(profile, { headless: true })
  const page = ctx.pages()[0] || await ctx.newPage()
  await page.goto(base + '/')
  const r = await page.evaluate(() => {
    const r = {}
    const t = (n, f) => { try { f(); r[n] = 'ok' } catch (e) { r[n] = e.name + ': ' + e.message } }
    r.ua = navigator.userAgent
    r.hasRegister = typeof navigator.registerProtocolHandler
    r.hasUnregister = typeof navigator.unregisterProtocolHandler
    r.isSecureContext = isSecureContext
    const o = location.origin
    const R = (s, u, ...x) => navigator.registerProtocolHandler(s, u, ...x)
    t('magnet /#%s', () => R('magnet', o + '/#%s'))
    t('magnet legacy 3-arg', () => R('magnet', o + '/#%s', 'Title'))
    t('web+magnetweb', () => R('web+magnetweb', o + '/#%s'))
    t('web+magnet2', () => R('web+magnet2', o + '/#%s'))
    t('bittorrent', () => R('bittorrent', o + '/#%s'))
    t('magnet no %s', () => R('magnet', o + '/'))
    t('magnet cross-origin', () => R('magnet', 'https://example.org/#%s'))
    return r
  })
  console.log(JSON.stringify(r, null, 2))
} catch (e) {
  console.log('FIREFOX FAILED:', String(e.message || e))
} finally {
  if (ctx) await ctx.close().catch(() => {})
  server.close()
}
