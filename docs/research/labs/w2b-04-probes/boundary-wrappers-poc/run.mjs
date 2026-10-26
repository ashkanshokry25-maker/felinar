// w2b-04 PoC runner: local bittorrent-tracker (ws://127.0.0.1:8010), static server (127.0.0.1:8011), Playwright Chromium.
// Run from anywhere: node run.mjs [before|after|both]     (default both; prints a compact summary, full JSON for 'before')
import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from '../../../../../node_modules/playwright/index.mjs'
import { Server } from '../../../../../node_modules/bittorrent-tracker/index.js'

const here = path.dirname(fileURLToPath(import.meta.url))
const WT = path.resolve(here, '../../../../../node_modules/webtorrent/dist/webtorrent.min.js')
const modes = process.argv[2] && process.argv[2] !== 'both' ? [process.argv[2]] : ['before', 'after']

const tracker = new Server({ udp: false, http: false, ws: true, stats: false })
await new Promise((res, rej) => { tracker.on('error', rej); tracker.listen(8010, '127.0.0.1', res) })
const web = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://x')
  if (u.pathname === '/webtorrent.min.js') { res.writeHead(200, { 'content-type': 'text/javascript' }); fs.createReadStream(WT).pipe(res) } else { res.writeHead(200, { 'content-type': 'text/html' }); fs.createReadStream(path.join(here, 'page.html')).pipe(res) }
}).listen(8011, '127.0.0.1')

const browser = await chromium.launch({ headless: true, args: ['--disable-features=WebRtcHideLocalIpsWithMdns'] }) // needed for same-machine WebRTC in headless
console.log('Chromium', browser.version())
for (const mode of modes) {
  const page = await (await browser.newContext()).newPage()
  page.on('pageerror', (e) => console.log('pageerror', String(e).slice(0, 200)))
  await page.goto('http://127.0.0.1:8011/?mode=' + mode)
  await page.waitForFunction(() => window.__result, null, { timeout: 40000 }).catch(() => {})
  const r = await page.evaluate(() => window.__result || null)
  console.log('=== wrappers installed ' + mode.toUpperCase() + ' the webtorrent import ===')
  console.log(JSON.stringify(r && mode === 'before' ? r : r && { mode: r.mode, done: r.done, wires: r.wires.length, wsCount: r.wsCount, pcCount: r.pcCount }, null, mode === 'before' ? 1 : 0))
  await page.close()
}
await browser.close(); web.close(); tracker.close()
process.exit(0)
