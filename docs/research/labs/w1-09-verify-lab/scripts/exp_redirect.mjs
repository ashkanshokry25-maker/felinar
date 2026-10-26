// Does a 302 with a fragment-less Location keep the fragment client-side (RFC 9110 10.2.2) without the server ever seeing it? Also cross-origin redirect (127.0.0.1 -> localhost).
import http from 'node:http'
import fs from 'node:fs'
import { chromium, webkit } from '$HOME/Documents/Projects/magnet-web/node_modules/playwright/index.mjs'
const [engine, out] = process.argv.slice(2)
const SECRET = 'magnet%3A%3Fxt%3Durn%3Abtih%3Aabc'
const seen = []
let portB
const mk = (name) => http.createServer((req, res) => {
  seen.push({ server: name, url: req.url, host: req.headers.host, referer: req.headers.referer || null })
  if (req.url === '/hop-same') { res.writeHead(302, { location: '/landing' }); return res.end() }
  if (req.url === '/hop-cross') { res.writeHead(302, { location: `http://localhost:${portB}/landing` }); return res.end() }
  res.writeHead(200, { 'content-type': 'text/html' }); res.end('<!doctype html><title>l</title><script>document.title=location.href</script>landing')
})
const A = mk('A'); const B = mk('B')
await new Promise(r => A.listen(0, '127.0.0.1', r)); await new Promise(r => B.listen(0, '127.0.0.1', r))
const portA = A.address().port; portB = B.address().port
const result = { engine }
const browser = await ({ chromium, webkit }[engine]).launch(); result.version = browser.version()
const page = await (await browser.newContext()).newPage()
for (const [label, path] of [['same-origin 302', '/hop-same'], ['cross-origin 302 (127.0.0.1 -> localhost)', '/hop-cross']]) {
  await page.goto('about:blank'); seen.length = 0
  await page.goto(`http://127.0.0.1:${portA}${path}#${SECRET}`)
  await page.waitForTimeout(200)
  result[label] = { finalUrl: await page.evaluate(() => location.href), fragmentKept: (await page.evaluate(() => location.hash)) === '#' + SECRET, serverRequests: seen.slice(), fragmentSeenByAnyServer: seen.some(s => JSON.stringify(s).includes('magnet')) }
}
await browser.close(); A.close(); B.close()
fs.writeFileSync(out, JSON.stringify(result, null, 2)); console.log(JSON.stringify(result, null, 1))
