// Does a cross-origin fetch() with a simple Range header trigger a CORS preflight? (relevant to untrusted ws= web seeds)
import http from 'node:http'
import { chromium, firefox, webkit } from '$HOME/Documents/Projects/magnet-web/node_modules/playwright/index.mjs'
const victimLog = []
const victim = http.createServer((req, res) => { victimLog.push(`${req.method} ${req.url} range=${req.headers.range || '-'} origin=${req.headers.origin || '-'} acrh=${req.headers['access-control-request-headers'] || '-'}`); res.statusCode = 404; res.end('no') })
await new Promise(r => victim.listen(0, '127.0.0.1', r))
const vport = victim.address().port
const site = http.createServer((req, res) => { res.setHeader('content-type', 'text/html'); res.end('<!doctype html><body>x') })
await new Promise(r => site.listen(0, '127.0.0.1', r))
const sport = site.address().port
for (const [name, bt] of [['chromium', chromium], ['webkit', webkit]]) {
  victimLog.length = 0
  let b
  try { b = await bt.launch({ headless: true }) } catch (e) { console.log(name, 'launch failed:', String(e).split('\n')[0]); continue }
  const p = await (await b.newContext()).newPage()
  await p.goto(`http://127.0.0.1:${sport}/`)
  const tests = [
    ['webtorrent webconn exact headers', { 'Cache-Control': 'no-store', 'user-agent': 'WebTorrent/3.0.21 (https://webtorrent.io)', range: 'bytes=0-262143' }],
    ['simple range bytes=0-262143', { Range: 'bytes=0-262143' }],
    ['open range bytes=100-', { Range: 'bytes=100-' }],
    ['suffix range bytes=-500', { Range: 'bytes=-500' }],
    ['multi range bytes=0-1,5-6', { Range: 'bytes=0-1,5-6' }]
  ]
  for (const [label, headers] of tests) {
    victimLog.length = 0
    const r = await p.evaluate(async ([u, h]) => { try { const x = await fetch(u, { headers: h }); return 'resolved ' + x.status } catch (e) { return 'rejected ' + e.name } }, [`http://127.0.0.1:${vport}/seed/file`, headers])
    await p.waitForTimeout(200)
    console.log(`${name} ${b.version()} | ${label} | fetch ${r} | victim saw: ${victimLog.join(' ; ') || '(nothing)'}`)
  }
  await b.close()
}
victim.close(); site.close()
