// VERIFY claim 1 experiment: what can PAGE SCRIPT observe for different WebSocket failure classes?
// usage: node ws-failure-matrix.mjs <chromium|webkit|firefox> [certDir]   (certDir optional: a throwaway cert is generated)
import http from 'node:http'
import https from 'node:https'
import net from 'node:net'
import fs from 'node:fs'
import crypto from 'node:crypto'
import { createRequire } from 'node:module'

const PROJ = new URL('../../../../', import.meta.url).pathname.replace(/\/$/, '') // <repo root>
const require = createRequire(PROJ + '/package.json')
const { WebSocketServer } = require('ws')
const pw = await import(PROJ + '/node_modules/playwright/index.mjs')
const engineName = process.argv[2] || 'chromium'
import { execFileSync } from 'node:child_process'
import os from 'node:os'
import path from 'node:path'
let CERT_DIR = process.argv[3]
if (!CERT_DIR) { // throwaway self-signed cert for the wss:// case (requires openssl on PATH)
  CERT_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'mw-verify-cert-'))
  execFileSync('openssl', ['req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:prime256v1', '-nodes', '-keyout', CERT_DIR + '/key.pem', '-out', CERT_DIR + '/cert.pem', '-days', '2', '-subj', '/CN=127.0.0.1', '-addext', 'subjectAltName=IP:127.0.0.1'], { stdio: 'ignore' })
}
const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11'
const accept = (key) => crypto.createHash('sha1').update(key + GUID).digest('base64')
const listen = (srv) => new Promise((res) => srv.listen(0, '127.0.0.1', () => res(srv.address().port)))

const tmp = net.createServer(); const refusedPort = await listen(tmp); await new Promise((r) => tmp.close(r))

const wss = new WebSocketServer({ noServer: true })
const PAGE = `<!doctype html><meta charset=utf-8><title>ws failure matrix</title><script>
window.runCase = (label, url, opts = {}) => new Promise((resolve) => {
  const rec = { label, url, ctorThrew: null, events: [], csp: [] }
  const t0 = performance.now(); const T = () => Math.round((performance.now() - t0) * 10) / 10
  const onspv = (e) => rec.csp.push({ t: T(), directive: e.violatedDirective, blocked: e.blockedURI })
  document.addEventListener('securitypolicyviolation', onspv)
  let ws
  try { ws = new WebSocket(url, opts.protocols) } catch (e) { rec.ctorThrew = { name: e.name, message: String(e.message).slice(0, 140) }; document.removeEventListener('securitypolicyviolation', onspv); return resolve(rec) }
  const fin = () => { document.removeEventListener('securitypolicyviolation', onspv); resolve(rec) }
  ws.addEventListener('open', () => rec.events.push({ type: 'open', t: T() }))
  ws.addEventListener('error', (e) => rec.events.push({ type: 'error', t: T(), ctor: e.constructor.name, ownKeys: Object.keys(e), hasMessage: 'message' in e }))
  ws.addEventListener('close', (e) => { rec.events.push({ type: 'close', t: T(), code: e.code, reason: e.reason, wasClean: e.wasClean }); setTimeout(fin, 60) })
  setTimeout(() => { if (!rec.events.some((x) => x.type === 'close')) { rec.stillPendingAfterMs = opts.timeout || 4000; rec.readyState = ws.readyState } fin() }, opts.timeout || 4000)
})
window.runStreamCase = async (label, url) => {
  const rec = { label }
  if (typeof WebSocketStream === 'undefined') return { label, unsupported: true }
  const t0 = performance.now()
  try {
    const s = new WebSocketStream(url)
    await Promise.race([s.opened, new Promise((_, rj) => setTimeout(() => rj(new Error('timeout-4s')), 4000))])
    rec.opened = true
    try { const c = await Promise.race([s.closed, new Promise((_, rj) => setTimeout(() => rj(new Error('closed-timeout')), 3000))]); rec.closed = { code: c.closeCode, reason: c.reason } } catch (e) { rec.closedErr = { name: e.name, ctor: e.constructor.name, closeCode: e.closeCode, reason: e.reason, message: String(e.message).slice(0, 100) } }
  } catch (e) { rec.openErr = { name: e.name, ctor: e.constructor.name, closeCode: e.closeCode, reason: e.reason, message: String(e.message).slice(0, 100) } }
  rec.ms = Math.round(performance.now() - t0)
  return rec
}
</script>`
const CSP_PAGE = PAGE.replace('<title>', '<meta http-equiv="Content-Security-Policy" content="connect-src \'none\'"><title>')

const raw = http.createServer((req, res) => {
  if (req.url === '/csp') { res.writeHead(200, { 'content-type': 'text/html' }); return res.end(CSP_PAGE) }
  res.writeHead(200, { 'content-type': 'text/html' }); res.end(PAGE)
})
raw.on('clientError', (e, s) => { try { s.destroy() } catch (_) {} })
process.on('uncaughtException', (e) => { if (!/ECONNRESET|EPIPE/.test(String(e))) console.log('uncaught', String(e).slice(0, 200)) })
raw.on('upgrade', (req, socket, head) => {
  socket.on('error', () => {})
  const key = req.headers['sec-websocket-key']; const p = req.url
  const resp = (s) => socket.end(s)
  if (p === '/non-ws-200') resp('HTTP/1.1 200 OK\r\nContent-Type: text/plain\r\nContent-Length: 5\r\nConnection: close\r\n\r\nhello')
  else if (p === '/http-403') resp('HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\nConnection: close\r\n\r\n')
  else if (p === '/http-500') resp('HTTP/1.1 500 Internal Server Error\r\nContent-Length: 0\r\nConnection: close\r\n\r\n')
  else if (p === '/redirect-302') resp('HTTP/1.1 302 Found\r\nLocation: /elsewhere\r\nContent-Length: 0\r\nConnection: close\r\n\r\n')
  else if (p === '/bad-accept') resp('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: AAAAAAAAAAAAAAAAAAAAAAAAAAA=\r\n\r\n')
  else if (p === '/unoffered-subprotocol') { socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept(key)}\r\nSec-WebSocket-Protocol: chat\r\n\r\n`); setTimeout(() => socket.destroy(), 300) }
  else if (p === '/ok-abrupt') wss.handleUpgrade(req, socket, head, (ws) => { ws._socket.destroy() })
  else if (p === '/ok-close-4001') wss.handleUpgrade(req, socket, head, (ws) => { ws.close(4001, 'app-reason') })
  else if (p === '/ok-close-1000') wss.handleUpgrade(req, socket, head, (ws) => { ws.close(1000, 'bye') })
  else if (p === '/ok-hold') wss.handleUpgrade(req, socket, head, () => {})
  else socket.destroy()
})
const rawPort = await listen(raw)

const tlsServer = https.createServer({ key: fs.readFileSync(CERT_DIR + '/key.pem'), cert: fs.readFileSync(CERT_DIR + '/cert.pem') }, (req, res) => { res.writeHead(200, { 'content-type': 'text/html' }); res.end(PAGE) })
const tlsWss = new WebSocketServer({ server: tlsServer })
tlsWss.on('connection', (ws) => ws.close(1000, 'tls-ok'))
tlsServer.on('tlsClientError', () => {}); tlsServer.on('clientError', (e, s) => { try { s.destroy() } catch (_) {} })
const tlsPort = await listen(tlsServer)

const H = `127.0.0.1`
const cases = [
  ['ok-open-then-clean-close-1000', `ws://${H}:${rawPort}/ok-close-1000`],
  ['ok-open-then-app-close-4001', `ws://${H}:${rawPort}/ok-close-4001`],
  ['ok-open-then-server-abrupt-tcp-drop', `ws://${H}:${rawPort}/ok-abrupt`],
  ['tcp-connection-refused', `ws://${H}:${refusedPort}/`],
  ['dns-unresolvable-host', `ws://no-such-host-7f3a91.invalid/`],
  ['non-websocket-server-200', `ws://${H}:${rawPort}/non-ws-200`],
  ['http-403-on-upgrade', `ws://${H}:${rawPort}/http-403`],
  ['http-500-on-upgrade', `ws://${H}:${rawPort}/http-500`],
  ['http-302-on-upgrade', `ws://${H}:${rawPort}/redirect-302`],
  ['bad-Sec-WebSocket-Accept', `ws://${H}:${rawPort}/bad-accept`],
  ['unoffered-subprotocol', `ws://${H}:${rawPort}/unoffered-subprotocol`],
  ['tls-selfsigned-cert (wss)', `wss://${H}:${tlsPort}/`],
  ['wss-to-plain-http-port (TLS handshake fails)', `wss://${H}:${rawPort}/ok-close-1000`],
  ['restricted-port-6000 (browser port block list)', `ws://${H}:6000/`],
  ['invalid-url-with-fragment', `ws://${H}:${rawPort}/#frag`],
  ['blackhole-192.0.2.1 (env-dependent, 5s window)', `ws://192.0.2.1:81/`, { timeout: 5000 }]
]

const browser = await pw[engineName].launch({ headless: true })
console.log(JSON.stringify({ engine: engineName, version: browser.version() }))
const ctx = await browser.newContext()
const page = await ctx.newPage()
const consoleBuf = []
page.on('console', (m) => consoleBuf.push(`[${m.type()}] ${m.text().slice(0, 200)}`))
await page.goto(`http://${H}:${rawPort}/`)
const out = []
for (const [label, url, o] of cases) {
  consoleBuf.length = 0
  const rec = await page.evaluate(([l, u, oo]) => window.runCase(l, u, oo || {}), [label, url, o])
  await new Promise((r) => setTimeout(r, 80))
  rec.devtoolsConsole = [...consoleBuf]
  out.push(rec)
}
// CSP case
const page2 = await ctx.newPage(); const cb2 = []; page2.on('console', (m) => cb2.push(`[${m.type()}] ${m.text().slice(0, 200)}`))
await page2.goto(`http://${H}:${rawPort}/csp`)
const cspRec = await page2.evaluate(([u]) => window.runCase('csp-connect-src-none', u), [`ws://${H}:${rawPort}/ok-close-1000`])
await new Promise((r) => setTimeout(r, 80)); cspRec.devtoolsConsole = cb2; out.push(cspRec)
// mixed content: https page -> ws://
const ctx3 = await browser.newContext({ ignoreHTTPSErrors: true }); const page3 = await ctx3.newPage()
await page3.goto(`https://${H}:${tlsPort}/`)
out.push(await page3.evaluate(() => window.runCase('mixed-content (https page -> ws://non-loopback)', 'ws://example.invalid:81/')))

console.log('=== WebSocket API (events seen by script) ===')
for (const r of out) {
  const ev = r.events.map((e) => e.type === 'close' ? `close(code=${e.code},reason=${JSON.stringify(e.reason)},wasClean=${e.wasClean})@${e.t}ms` : e.type === 'error' ? `error[${e.ctor}${e.hasMessage ? '+message' : ''},ownKeys=${e.ownKeys.length}]@${e.t}ms` : `${e.type}@${e.t}ms`).join(' -> ')
  console.log(`- ${r.label}\n    ctorThrew=${JSON.stringify(r.ctorThrew)} ${r.stillPendingAfterMs ? 'STILL-PENDING-after-' + r.stillPendingAfterMs + 'ms(readyState=' + r.readyState + ')' : ''} csp=${JSON.stringify(r.csp)}\n    events: ${ev || '(none)'}\n    devtoolsConsole(not readable by page script): ${JSON.stringify((r.devtoolsConsole || []).slice(0, 2))}`)
}
if (engineName === 'chromium') {
  console.log('=== WebSocketStream API ===')
  for (const [label, url] of cases.slice(0, 15)) {
    const r = await page.evaluate(([l, u]) => window.runStreamCase(l, u), [label, url])
    console.log('- ' + JSON.stringify(r))
  }
}
await browser.close(); raw.close(); tlsServer.close()
process.exit(0)
