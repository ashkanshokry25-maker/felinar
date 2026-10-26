// E-CSP-1: does the unmodified webtorrent@3.0.21 bundle work under a strict site CSP?
import { openBrowser } from './browsers.mjs'
import fs from 'node:fs'
import { startLab } from './lab.mjs'

const VARIANTS = (TP) => ({
  none: null,
  strict: `default-src 'none'; script-src 'self'; connect-src 'self' ws://127.0.0.1:${TP}; worker-src 'self'`,
  'strict-no-ws': `default-src 'none'; script-src 'self'; connect-src 'self'; worker-src 'self'`,
  'strict-tt': `default-src 'none'; script-src 'self'; connect-src 'self' ws://127.0.0.1:${TP}; worker-src 'self'; require-trusted-types-for 'script'`,
  'strict-blob': `default-src 'none'; script-src 'self'; connect-src 'self' ws://127.0.0.1:${TP}; worker-src 'self' blob:`
})
const ONLY = process.argv[2] ? process.argv[2].split(',') : null
const SCENARIOS_ALL = [
  { name: '1 no CSP, native createWritable', csp: 'none', sim: false },
  { name: '2 strict CSP (script/worker self, connect self+tracker), native', csp: 'strict', sim: false },
  { name: '3 strict CSP but tracker NOT in connect-src', csp: 'strict-no-ws', sim: false },
  { name: '4 strict CSP + require-trusted-types-for script', csp: 'strict-tt', sim: false },
  { name: '5 strict CSP + simulated Safari<26 (createWritable deleted -> polyfill)', csp: 'strict', sim: true },
  { name: '6 same as 5 but worker-src self blob:', csp: 'strict-blob', sim: true }
]
const SCENARIOS = SCENARIOS_ALL.filter((s) => !ONLY || ONLY.includes(s.name[0]))
let labRef
const lab = await startLab({
  headersFor (url) {
    if (url.pathname !== '/csp.html') return {}
    const v = VARIANTS(lab.trackerPort)[url.searchParams.get('csp')]
    return v ? { 'content-security-policy': v } : {}
  }
})
labRef = lab
console.log('lab', lab.origin, 'tracker', lab.trackerPort)
const WHICH = process.env.BROWSER || 'chromium'
const browser = await openBrowser(WHICH)
console.log('browser', WHICH, browser.version())
const results = []
for (const sc of SCENARIOS) {
  const ctxA = await browser.newContext(); const ctxB = await browser.newContext()
  if (sc.sim) { for (const c of [ctxA, ctxB]) await c.addInitScript(() => { try { delete FileSystemFileHandle.prototype.createWritable; delete window.FileSystemWritableFileStream } catch (e) {} }) }
  const consoleMsgs = []
  const mk = async (ctx, tag) => { const p = await ctx.newPage(); p.on('console', (m) => { const t = m.text(); if (/Content Security Policy|Refused|Trusted Type/i.test(t)) consoleMsgs.push(tag + ': ' + t.slice(0, 220)) }); p.on('pageerror', (e) => consoleMsgs.push(tag + ' pageerror: ' + String(e.message).slice(0, 200))); return p }
  const seed = await mk(ctxA, 'seed'); const leech = await mk(ctxB, 'leech')
  const tracker = `ws://127.0.0.1:${lab.trackerPort}`
  const base = `${lab.origin}/csp.html?csp=${sc.csp}&tracker=${encodeURIComponent(tracker)}`
  await seed.goto(base + '&role=seed')
  let magnet = null
  try { await seed.waitForFunction(() => window.__out && window.__out.magnet, null, { timeout: 15000 }); magnet = await seed.evaluate(() => window.__out.magnet) } catch (e) {}
  const seedOut = await seed.evaluate(() => window.__out).catch(() => null)
  let leechOut = null
  if (magnet) {
    await leech.goto(base + '&role=leech&magnet=' + encodeURIComponent(magnet))
    try { await leech.waitForFunction(() => window.__out && (window.__out.done || window.__out.errors.length), null, { timeout: 15000 }) } catch (e) {}
    leechOut = await leech.evaluate(() => window.__out).catch(() => null)
  }
  const r = { scenario: sc.name, csp: sc.csp, sim: sc.sim, seedViolations: seedOut && seedOut.violations, seedErrors: seedOut && seedOut.errors, seeded: !!magnet, leech: leechOut && { done: !!leechOut.done, bytes: leechOut.bytes, violations: leechOut.violations, errors: leechOut.errors, warnings: leechOut.warnings, t: leechOut.t, cwBefore: leechOut.cwNativeBeforeImport, cwAfter: leechOut.cwAfterImport }, console: consoleMsgs.slice(0, 6) }
  results.push(r)
  console.log(JSON.stringify(r))
  await ctxA.close(); await ctxB.close()
}
fs.writeFileSync(new URL('./results/csp-' + WHICH + (ONLY ? '-' + ONLY.join('') : '') + '.json', import.meta.url), JSON.stringify({ browser: WHICH + ' ' + browser.version(), when: new Date().toISOString(), results }, null, 1))
await browser.close(); await lab.close()
