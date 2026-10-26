import { openBrowser } from './browsers.mjs'
import dgram from 'node:dgram'
import os from 'node:os'
import fs from 'node:fs'
import { startLab } from './lab.mjs'
const lanIps = Object.values(os.networkInterfaces()).flat().filter((i) => i.family === 'IPv4' && !i.internal).map((i) => i.address)
const targets = [{ label: 'loopback 127.0.0.1', ip: '127.0.0.1' }, ...(lanIps[0] ? [{ label: 'LAN ' + 'x.x.x.x', ip: lanIps[0] }] : [])]
const CSPS = { none: null, 'connect-none': "default-src 'none'; script-src 'self'; connect-src 'none'", 'webrtc-block': "default-src 'none'; script-src 'self'; webrtc 'block'" }
const lab = await startLab({ withTracker: false, headersFor (url) { const v = CSPS[url.searchParams.get('csp')]; return url.pathname === '/ice.html' && v ? { 'content-security-policy': v } : {} } })
const WHICH = process.env.BROWSER || 'chromium'
const browser = await openBrowser(WHICH)
const results = []
for (const tg of targets) {
  for (const csp of Object.keys(CSPS)) {
    const sock = dgram.createSocket('udp4'); let stunReq = 0
    sock.on('message', (m) => { if (m.length >= 20 && m.readUInt16BE(0) === 0x0001 && m.readUInt32BE(4) === 0x2112a442) stunReq++ })
    await new Promise((r) => sock.bind(0, tg.ip, r))
    const port = sock.address().port
    const ctx = await browser.newContext(); const page = await ctx.newPage(); const msgs = []; page.on('console', (m) => { if (/webrtc|Content Security|directive/i.test(m.text())) msgs.push(m.text().slice(0, 160)) })
    await page.goto(`${lab.origin}/ice.html?csp=${csp}&stun=${tg.ip}:${port}`)
    await page.waitForFunction(() => window.__out && window.__out.done, null, { timeout: 10000 }).catch(() => {})
    const out = await page.evaluate(() => window.__out)
    const r = { target: tg.label, csp, stunBindingRequestsSeenByServer: stunReq, gathering: out.state, candidateCount: out.cands.length, violations: out.violations, error: out.error, consoleHints: msgs.slice(0, 2) }
    results.push(r); console.log(JSON.stringify(r))
    await ctx.close(); sock.close()
  }
}
fs.writeFileSync(new URL('./results/ice-' + WHICH + '.json', import.meta.url), JSON.stringify({ browser: WHICH + ' ' + browser.version(), results }, null, 1))
await browser.close(); await lab.close()
