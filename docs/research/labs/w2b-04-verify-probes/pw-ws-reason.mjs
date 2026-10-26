// VERIFY claim 1 (second half): can a Playwright/CDP-driven real browser (a CI canary) read WHY a page's WebSocket failed?
import http from 'node:http'
import net from 'node:net'
const PROJ = new URL('../../../../', import.meta.url).pathname.replace(/\/$/, '') // <repo root>
const { chromium, webkit } = await import(PROJ + '/node_modules/playwright/index.mjs')
const srv = http.createServer((req, res) => { res.writeHead(200, { 'content-type': 'text/html' }); res.end('<!doctype html><title>x</title>') })
srv.on('upgrade', (req, socket) => { socket.on('error', () => {}); if (req.url === '/http-403') socket.end('HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\nConnection: close\r\n\r\n'); else socket.end('HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: close\r\n\r\nhi') })
await new Promise((r) => srv.listen(0, '127.0.0.1', r)); const port = srv.address().port
const tmp = net.createServer(); await new Promise((r) => tmp.listen(0, '127.0.0.1', r)); const dead = tmp.address().port; await new Promise((r) => tmp.close(r))
const cases = [['refused', `ws://127.0.0.1:${dead}/`], ['dns', 'ws://no-such-host-7f3a91.invalid/'], ['http-403', `ws://127.0.0.1:${port}/http-403`], ['non-ws-200', `ws://127.0.0.1:${port}/non`]]
for (const [name, eng] of [['chromium', chromium], ['webkit', webkit]]) {
  const b = await eng.launch({ headless: true }); const page = await (await b.newContext()).newPage()
  const log = []
  page.on('websocket', (ws) => { ws.on('socketerror', (e) => log.push({ via: 'pw socketerror', text: String(e).slice(0, 140) })); ws.on('close', () => log.push({ via: 'pw ws close' })) })
  page.on('console', (m) => { if (m.type() === 'error') log.push({ via: 'pw console', text: m.text().slice(0, 140) }) })
  await page.goto(`http://127.0.0.1:${port}/`)
  console.log('###', name, b.version())
  for (const [label, url] of cases) {
    log.length = 0
    const pageSees = await page.evaluate((u) => new Promise((res) => { const ws = new WebSocket(u); const ev = []; ws.onerror = (e) => ev.push('error:' + e.constructor.name); ws.onclose = (e) => { ev.push(`close:${e.code}`); res(ev.join(' ')) } }), url)
    await new Promise((r) => setTimeout(r, 120))
    console.log(`- ${label.padEnd(10)} page script sees: ${pageSees}   | harness sees: ${JSON.stringify(log.filter((x) => x.via !== 'pw ws close'))}`)
  }
  await b.close()
}
srv.close(); process.exit(0)
