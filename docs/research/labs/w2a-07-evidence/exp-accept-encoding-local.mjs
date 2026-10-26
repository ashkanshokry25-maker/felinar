// w2a-07: what Accept-Encoding does each browser engine send on a cross-origin fetch() with and without a Range header?
// Local-only: two loopback servers (page origin A, "web seed" origin B). B logs the request headers it receives.
import http from 'node:http'
import { chromium, webkit, firefox } from '$HOME/Documents/Projects/magnet-web/node_modules/playwright/index.mjs'
const seen = []
const B = http.createServer((req, res) => {
  const cors = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': 'GET', 'access-control-expose-headers': 'content-range' }
  if (req.method === 'OPTIONS') { res.writeHead(204, cors); return res.end() }
  seen.push({ url: req.url, range: req.headers.range || '-', ae: req.headers['accept-encoding'] ?? '(none)', cc: req.headers['cache-control'] ?? '-' })
  res.writeHead(206, { ...cors, 'content-type': 'application/octet-stream', 'content-range': 'bytes 0-3/10', 'content-length': '4' }); res.end('abcd')
})
await new Promise(r => B.listen(0, '127.0.0.1', r))
const bport = B.address().port
const A = http.createServer((req, res) => { res.setHeader('content-type', 'text/html'); res.end('<!doctype html><body>x') })
await new Promise(r => A.listen(0, '127.0.0.1', r))
const aport = A.address().port
for (const [name, eng] of [['chromium', chromium], ['webkit', webkit], ['firefox', firefox]]) {
  let b
  try { b = await eng.launch({ headless: true }) } catch (e) { console.log(`${name}: launch failed: ${String(e).split('\n')[0]}`); continue }
  const p = await (await b.newContext()).newPage()
  await p.goto(`http://127.0.0.1:${aport}/`)
  for (const [label, init] of [
    ['no Range', {}],
    ['Range bytes=0-3', { headers: { range: 'bytes=0-3' } }],
    ['WebTorrent stock (cache no-store + Range)', { cache: 'no-store', headers: { 'Cache-Control': 'no-store', 'user-agent': 'WebTorrent/3.0.21', range: 'bytes=0-3' } }]
  ]) {
    seen.length = 0
    const r = await p.evaluate(async ([u, init]) => { try { const x = await fetch(u, init); await x.arrayBuffer(); return x.status } catch (e) { return 'err ' + e.name } }, [`http://127.0.0.1:${bport}/f?${Math.random()}`, init])
    await p.waitForTimeout(150)
    console.log(`${name} ${b.version()} | ${label.padEnd(42)} | fetch -> ${r} | server saw: ${seen.map(s => `Range=${s.range} Accept-Encoding=${s.ae}`).join(' ; ') || '(nothing)'}`)
  }
  await b.close()
}
A.close(); B.close()
