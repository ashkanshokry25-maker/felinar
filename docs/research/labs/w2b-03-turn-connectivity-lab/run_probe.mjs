import { chromium, webkit } from '../../../../node_modules/playwright/index.mjs'
import fs from 'node:fs'
const cred = { username: 'u', credential: 'p' }
const A = 'stun:127.0.0.1:34780', B = 'stun:127.0.0.1:34781', C = 'stun:127.0.0.1:34782', BH = 'stun:127.0.0.1:34791'
const scenarios = [
  ['easy: stun A + C', { stun: [A, C] }],
  ['hard: stun A + B', { stun: [A, B] }],
  ['single stun A', { stun: [A] }],
  ['udp dead: stun BLACKHOLE x2', { stun: [BH, 'stun:127.0.0.1:34792'] }],
  ['hard + turn OK', { stun: [A, B], turn: [{ urls: ['turn:127.0.0.1:34790?transport=udp'], ...cred }] }],
  ['easy + turn dead (blackhole)', { stun: [A, C], turn: [{ urls: ['turn:127.0.0.1:34791?transport=udp'], ...cred }] }],
  ['easy + turn tcp refused', { stun: [A, C], turn: [{ urls: ['turn:127.0.0.1:34792?transport=tcp'], ...cred }] }],
  ['stun A+B + turn tcp OK', { stun: [A, B], turn: [{ urls: ['turn:127.0.0.1:34790?transport=tcp'], ...cred }] }],
]
const out = {}
for (const [name, bt, args] of [['chromium', chromium, ['--disable-features=WebRtcHideLocalIpsWithMdns']], ['chromium-mdns-default', chromium, []], ['chromium-no-udp-policy', chromium, ['--force-webrtc-ip-handling-policy=disable_non_proxied_udp']], ['webkit', webkit, []]]) {
  const b = await bt.launch({ headless: true, args }); const ctx = await b.newContext(); const page = await ctx.newPage()
  await page.goto('http://127.0.0.1:18090/probe.html'); await page.waitForFunction(() => window.probeReady)
  out[name] = { version: b.version(), runs: [] }
  for (const [label, opts] of scenarios) {
    const r = await page.evaluate((o) => window.probeConnectivity(o), { ...opts, budgetMs: 2500 })
    out[name].runs.push({ label, cls: r.cls, mappingVaries: r.mappingVaries, reason: r.reason, tDone: r.tDone, tFirstSrflx: r.tFirstSrflx, tRelay: r.tRelay, srflx: r.srflx.map(s => s.key), relay: r.relay.map(x => x.proto), errors: r.errors.map(e => e.code + ':' + e.text) })
    console.error(name, '|', label, '|', r.cls, '| varies', r.mappingVaries, '| reason', r.reason, '| tDone', r.tDone, '| tSrflx', r.tFirstSrflx, '| tRelay', r.tRelay, '| errs', r.errors.map(e => e.code).join(','))
  }
  await ctx.close(); await b.close()
}
fs.writeFileSync('res-probe.json', JSON.stringify(out, null, 1))
console.error('done')
