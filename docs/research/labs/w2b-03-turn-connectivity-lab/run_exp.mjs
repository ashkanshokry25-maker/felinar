import { chromium, webkit, firefox } from '../../../../node_modules/playwright/index.mjs'
import fs from 'node:fs'
const ENGINES = (process.env.ENGINES || 'chromium,webkit').split(',')
const WHAT = (process.env.WHAT || 'ice,peer,alloc,thr').split(',')
const LOG = process.env.FAKE_LOG
const T = { u: 'turn:127.0.0.1:34790?transport=udp', t: 'turn:127.0.0.1:34790?transport=tcp', bu: 'turn:127.0.0.1:34791?transport=udp', bt: 'turn:127.0.0.1:34791?transport=tcp', ru: 'turn:127.0.0.1:34792?transport=udp', rt: 'turn:127.0.0.1:34792?transport=tcp' }
const cred = { username: 'u', credential: 'p' }
const S = { a: { urls: 'stun:127.0.0.1:34780' }, b: { urls: 'stun:127.0.0.1:34781' }, c: { urls: 'stun:127.0.0.1:34782' } }
const iceScenarios = [
  ['no-servers', []],
  ['stun A', [S.a]],
  ['stun A+C (same mapping)', [S.a, S.c]],
  ['stun A+B (mapping varies by dest)', [S.a, S.b]],
  ['turn udp OK', [{ urls: T.u, ...cred }]],
  ['turn tcp OK', [{ urls: T.t, ...cred }]],
  ['turn udp+tcp OK (one entry, 2 urls)', [{ urls: [T.u, T.t], ...cred }]],
  ['turn udp BLACKHOLE', [{ urls: T.bu, ...cred }]],
  ['turn tcp BLACKHOLE', [{ urls: T.bt, ...cred }]],
  ['turn udp REFUSED (closed port)', [{ urls: T.ru, ...cred }]],
  ['turn tcp REFUSED (closed port)', [{ urls: T.rt, ...cred }]],
  ['stun A + turn udp OK', [S.a, { urls: T.u, ...cred }]],
  ['stun A + turn udp OK + BLACKHOLE udp', [S.a, { urls: [T.u, T.bu], ...cred }]],
  ['policy=relay, turn udp OK', [{ urls: T.u, ...cred }], 'relay'],
  ['policy=relay, no servers', [], 'relay'],
]
const peerScenarios = [
  ['no-servers', []],
  ['stun A', [S.a]],
  ['turn udp OK', [{ urls: T.u, ...cred }]],
  ['turn udp BLACKHOLE', [{ urls: T.bu, ...cred }]],
  ['6 urls (CF-like): udp OK, udp refused, tcp OK, tcp blackhole, tcp refused, tcp blackhole', [{ urls: [T.u, T.ru, T.t, T.bt, T.rt, 'turn:127.0.0.1:34791?transport=tcp'], ...cred }]],
  ['2 urls: udp OK + tcp OK', [{ urls: [T.u, T.t], ...cred }]],
  ['policy=relay + turn udp OK', [{ urls: T.u, ...cred }], 'relay'],
  ['policy=relay + no servers', [], 'relay'],
  ['policy=relay + turn udp BLACKHOLE', [{ urls: T.bu, ...cred }], 'relay', 60000],
]
const out = {}
const engines = { chromium, webkit, firefox }
for (const name of ENGINES) {
  const res = out[name] = {}
  let browser
  try {
    const args = ((name === 'chromium' && !process.env.NOFLAG) ? ['--disable-features=WebRtcHideLocalIpsWithMdns'] : []).concat(process.env.EXTRA_ARGS ? process.env.EXTRA_ARGS.split(' ') : [])
    browser = await engines[name].launch({ headless: true, args })
    res.version = browser.version()
    const ctx = await browser.newContext()
    const page = await ctx.newPage()
    page.setDefaultTimeout(120000)
    await page.goto('http://127.0.0.1:18090/blank.html')
    await page.addScriptTag({ url: '/sp-bundle.js' })
    await page.addScriptTag({ url: '/probe-lib.js' })
    if (WHAT.includes('ice')) {
      res.ice = []
      for (const [label, iceServers, policy] of iceScenarios) {
        if (process.env.ONLY && !process.env.ONLY.split('|').some(x => label.includes(x))) continue
        const r = await page.evaluate((o) => window.runIce(o), { label, iceServers, policy, maxMs: +(process.env.MAXMS || 8000) })
        res.ice.push(r)
        console.error(name, 'ice', label, 'complete@', r.tComplete, 'cands', r.cands.map(c => c.type + (c.proto ? '/' + c.proto : '') + (c.relayProto ? '/' + c.relayProto : '')).join(','), 'err', r.errors.map(e => e.code).join(','))
      }
    }
    if (WHAT.includes('peer')) {
      res.peer = []
      for (const [label, iceServers, policy, waitMs] of peerScenarios) {
        if (process.env.ONLYPEER && !process.env.ONLYPEER.split('|').some(x => label.includes(x))) continue
        const r = await page.evaluate((o) => window.runPeer(o), { label, iceServers, policy, waitMs })
        res.peer.push(r)
        console.error(name, 'peer', label, JSON.stringify(r))
      }
    }
    if (WHAT.includes('alloc')) {
      const t0 = Date.now() / 1000
      const rs = []
      for (let i = 0; i < 10; i++) rs.push(await page.evaluate((o) => window.runIce(o), { label: 'alloc-' + i, iceServers: [{ urls: T.u, ...cred }], maxMs: 8000 }))
      res.alloc = { t0, t1: Date.now() / 1000, n: rs.length, gatherMs: rs.map(r => r.tComplete) }
    }
    if (WHAT.includes('thr')) {
      try {
        res.thr = await page.evaluate((o) => window.thr(o), { label: name, sizes: [1024, 4096, 16384, 65536, 262144], totalBytes: 32 * 1048576 })
        console.error(name, 'thr', JSON.stringify(res.thr))
      } catch (e) { res.thr = { error: String(e).slice(0, 300) }; console.error(name, 'thr ERR', res.thr.error) }
    }
    await ctx.close()
  } catch (e) {
    res.error = String(e).slice(0, 500)
    console.error(name, 'ERR', res.error)
  } finally { if (browser) await browser.close().catch(() => {}) }
}
fs.writeFileSync(process.env.OUT || 'results.json', JSON.stringify(out, null, 1))
console.error('done')
