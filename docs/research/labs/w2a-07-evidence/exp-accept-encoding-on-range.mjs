// w2a-07: does Chromium send Accept-Encoding on a fetch() that carries a Range header? (and what comes back)
// Uses CDP Network.requestWillBeSentExtraInfo / responseReceivedExtraInfo to see the REAL wire headers.
import { chromium } from '$HOME/Documents/Projects/magnet-web/node_modules/playwright/index.mjs'
const targets = JSON.parse(process.argv[2])
const browser = await chromium.launch({ headless: true })
const ctx = await browser.newContext()
const page = await ctx.newPage()
const cdp = await ctx.newCDPSession(page)
await cdp.send('Network.enable')
const log = []
cdp.on('Network.requestWillBeSentExtraInfo', e => log.push({ t: 'req', id: e.requestId, h: e.headers }))
cdp.on('Network.responseReceivedExtraInfo', e => log.push({ t: 'resp', id: e.requestId, status: e.statusCode, h: e.headers }))
cdp.on('Network.requestWillBeSent', e => log.push({ t: 'meta', id: e.requestId, url: e.request.url, method: e.request.method }))
await page.goto('https://example.org/', { waitUntil: 'domcontentloaded', timeout: 60000 })
for (const [label, url] of targets) {
  for (const variant of ['no-range', 'range']) {
    log.length = 0
    const init = variant === 'range' ? { headers: { range: 'bytes=1000-4999' } } : {}
    const r = await page.evaluate(async ([u, init]) => {
      try { const x = await fetch(u, init); const b = await x.arrayBuffer(); return { status: x.status, len: b.byteLength } } catch (e) { return { err: e.message } }
    }, [url, init])
    await page.waitForTimeout(300)
    const metas = log.filter(l => l.t === 'meta' && l.method !== 'OPTIONS')
    const out = []
    for (const m of metas) {
      const rq = log.find(l => l.t === 'req' && l.id === m.id), rs = log.find(l => l.t === 'resp' && l.id === m.id)
      const get = (h, k) => h ? Object.entries(h).find(([n]) => n.toLowerCase() === k)?.[1] : undefined
      out.push(`${m.method} AE-sent=${get(rq?.h, 'accept-encoding') ?? '(none)'} -> ${rs?.status} content-encoding=${get(rs?.h, 'content-encoding') ?? '-'} content-range=${get(rs?.h, 'content-range') ?? '-'} content-length=${get(rs?.h, 'content-length') ?? '-'}`)
    }
    console.log(`${label} [${variant}] fetch=${JSON.stringify(r)} | ${out.join(' ; ') || '(no GET seen)'}`)
  }
}
await browser.close()
