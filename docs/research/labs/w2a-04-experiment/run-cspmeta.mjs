import { openBrowser } from './browsers.mjs'
import fs from 'node:fs'
import { startLab } from './lab.mjs'
const HEADERS = { none: null, 'connect-src none': "connect-src 'none'" }
const lab = await startLab({ withTracker: false, headersFor: (u) => { const h = HEADERS[u.searchParams.get('hdr')]; return u.pathname === '/cspmeta.html' && h ? { 'content-security-policy': h } : {} } })
const res = {}
for (const WHICH of ['chromium', 'webkit']) {
  const b = await openBrowser(WHICH); res[WHICH + ' ' + b.version()] = []
  for (const c of [{ hdr: 'none', meta: "connect-src 'none'", label: 'no header; JS inserts meta connect-src none' }, { hdr: 'connect-src none', meta: 'connect-src *', label: "header connect-src 'none'; JS inserts meta connect-src *" }]) {
    const ctx = await b.newContext(); const p = await ctx.newPage()
    await p.goto(`${lab.origin}/cspmeta.html?hdr=${encodeURIComponent(c.hdr)}&meta=${encodeURIComponent(c.meta)}&case=${encodeURIComponent(c.label)}`)
    await p.waitForFunction(() => window.__out && window.__out.done, null, { timeout: 8000 }).catch(() => {})
    const o = await p.evaluate(() => window.__out); res[WHICH + ' ' + b.version()].push(o); console.log(WHICH, JSON.stringify(o))
    await ctx.close()
  }
  await b.close()
}
fs.writeFileSync(new URL('./results/csp-meta.json', import.meta.url), JSON.stringify(res, null, 1)); await lab.close()
