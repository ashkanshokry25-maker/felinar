// Research aid (w1-09): API semantics in the locally installed Brave using a THROWAWAY profile dir. No clicks, no network except 127.0.0.1.
import http from 'node:http'
import fs from 'node:fs'
import { chromium } from '$HOME/Documents/Projects/magnet-web/node_modules/playwright/index.mjs'
const BRAVE = '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser'
const profile = process.argv[2]
const server = http.createServer((req, res) => { res.writeHead(200, { 'content-type': 'text/html' }); res.end('<!doctype html><meta charset=utf-8><title>b</title>b') })
await new Promise((r) => server.listen(0, '127.0.0.1', r))
const base = `http://127.0.0.1:${server.address().port}`
let ctx
try {
  ctx = await chromium.launchPersistentContext(profile, { executablePath: BRAVE, headless: true, args: ['--no-first-run', '--no-default-browser-check'] })
  const page = ctx.pages()[0] || await ctx.newPage()
  await page.goto(base + '/')
  const r = await page.evaluate(async () => {
    const r = {}
    const t = (n, f) => { try { f(); r[n] = 'ok' } catch (e) { r[n] = e.name + ': ' + e.message } }
    r.ua = navigator.userAgent
    r.isBrave = !!(navigator.brave && await navigator.brave.isBrave().catch(() => false))
    r.hasRegister = typeof navigator.registerProtocolHandler
    r.hasUnregister = typeof navigator.unregisterProtocolHandler
    r.isSecureContext = isSecureContext
    const o = location.origin
    const R = (s, u, ...x) => navigator.registerProtocolHandler(s, u, ...x)
    t('magnet /#%s', () => R('magnet', o + '/#%s'))
    t('web+magnetweb', () => R('web+magnetweb', o + '/#%s'))
    t('bittorrent (not safelisted)', () => R('bittorrent', o + '/#%s'))
    t('magnet no %s', () => R('magnet', o + '/'))
    t('magnet cross-origin', () => R('magnet', 'https://example.org/#%s'))
    return r
  })
  console.log(JSON.stringify(r, null, 2))
} catch (e) {
  console.log('BRAVE FAILED:', String(e.message || e).slice(0, 1500))
} finally {
  if (ctx) await ctx.close().catch(() => {})
  server.close()
}
