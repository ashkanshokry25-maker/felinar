// w2a-07: does fetch(url, { cache: 'no-store', headers: { range } }) trigger a CORS preflight? (candidate patched web-seed request)
import http from 'node:http'
import { chromium, webkit } from '$HOME/Documents/Projects/magnet-web/node_modules/playwright/index.mjs'
const log = []
const B = http.createServer((req, res) => {
  log.push(`${req.method} range=${req.headers.range || '-'} acrh=${req.headers['access-control-request-headers'] || '-'} cache-control=${req.headers['cache-control'] || '-'} pragma=${req.headers.pragma || '-'}`)
  if (req.method === 'OPTIONS') { res.writeHead(405); return res.end() }   // a host that refuses every preflight (like GitHub Pages)
  res.writeHead(206, { 'access-control-allow-origin': '*', 'content-range': 'bytes 0-3/10', 'content-length': '4', 'content-type': 'application/octet-stream' }); res.end('abcd')
})
await new Promise(r => B.listen(0, '127.0.0.1', r))
const A = http.createServer((req, res) => { res.setHeader('content-type', 'text/html'); res.end('<!doctype html><body>x') })
await new Promise(r => A.listen(0, '127.0.0.1', r))
for (const [name, eng] of [['chromium', chromium], ['webkit', webkit]]) {
  const b = await eng.launch({ headless: true })
  const p = await (await b.newContext()).newPage()
  await p.goto(`http://127.0.0.1:${A.address().port}/`)
  for (const [label, init] of [
    ['Range only', { headers: { range: 'bytes=0-3' } }],
    ['cache:no-store + Range', { cache: 'no-store', headers: { range: 'bytes=0-3' } }],
    ['cache:no-store + Range + AbortSignal.timeout', { cache: 'no-store', headers: { range: 'bytes=0-3' }, signal: AbortSignal.timeout(60000) }],
    ['stock (Cache-Control + user-agent + Range)', { cache: 'no-store', headers: { 'Cache-Control': 'no-store', 'user-agent': 'WebTorrent/3.0.21', range: 'bytes=0-3' } }]
  ]) {
    log.length = 0
    const r = await p.evaluate(async ([u, init]) => {
      if (init.signal === 'TIMEOUT') init.signal = AbortSignal.timeout(60000)
      try { const x = await fetch(u, init); await x.arrayBuffer(); return 'resolved ' + x.status } catch (e) { return 'rejected ' + e.name }
    }, [`http://127.0.0.1:${B.address().port}/f?${Math.random()}`, label.includes('AbortSignal') ? { cache: 'no-store', headers: { range: 'bytes=0-3' }, signal: 'TIMEOUT' } : init])
    await p.waitForTimeout(150)
    console.log(`${name} ${b.version()} | ${label.padEnd(46)} | fetch ${r.padEnd(14)} | server saw: ${log.join(' ; ') || '(nothing)'}`)
  }
  await b.close()
}
A.close(); B.close()
