// w2a-07 experiment: can a real browser use public host X as a BEP-19 web seed?
// For each target URL we (1) download the identity bytes with Node fetch (reference copy), then
// (2) from a page whose origin is https://example.org/ run two cross-origin fetches in the browser:
//   A) WebTorrent 3.0.21's exact request (cache:'no-store', Cache-Control, user-agent, Range)  -> "stock"
//   B) Range only (what a patched webconn would send; Range bytes=N-M is CORS-safelisted)     -> "range-only"
// and compare the returned bytes with the reference slice. Chromium also reports the negotiated protocol via CDP.
// Read-only: GET/OPTIONS requests only. No uploads, no credentials.
import { chromium, webkit } from '$HOME/Documents/Projects/magnet-web/node_modules/playwright/index.mjs'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
const H = 'b1674191a88ec5cdd733e4240a81803105dc412d6c6708d53ab94fc248f4f553'
const CID = 'QmRA3NWM82ZGynMbYzAgYTSXCVM14Wx1RZ8fKP42G6gjgj'
const TARGETS = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'))
const OUT = process.argv[3]
const START = 1000, END = 4999 // 4000-byte slice (all targets are >= 5000 bytes unless noted)
const sha = b => createHash('sha256').update(b).digest('hex').slice(0, 16)
async function reference(url) {
  try {
    const r = await fetch(url, { headers: { 'accept-encoding': 'identity' }, signal: AbortSignal.timeout(30000), redirect: 'follow' })
    if (!r.ok) return { err: 'ref HTTP ' + r.status }
    const b = new Uint8Array(await r.arrayBuffer())
    return { len: b.length, slice: b.subarray(START, Math.min(END + 1, b.length)), enc: r.headers.get('content-encoding') }
  } catch (e) { return { err: 'ref ' + e.name + ': ' + e.message } }
}
const results = []
for (const [engineName, engine] of [['chromium', chromium], ['webkit', webkit]]) {
  let browser
  try { browser = await engine.launch({ headless: true }) } catch (e) { console.log(engineName, 'launch failed', String(e).split('\n')[0]); continue }
  const ctx = await browser.newContext()
  const page = await ctx.newPage()
  const protocols = {}
  let cdp = null
  if (engineName === 'chromium') {
    cdp = await ctx.newCDPSession(page)
    await cdp.send('Network.enable')
    cdp.on('Network.responseReceived', e => { protocols[e.response.url] = (protocols[e.response.url] || []).concat(e.response.protocol + (e.type ? '' : '')) })
  }
  try { await page.goto('https://example.org/', { waitUntil: 'domcontentloaded', timeout: 30000 }) } catch (e) { console.log(engineName, 'could not load the https://example.org/ origin page, skipping this engine:', String(e).split('\n')[0]); await browser.close(); continue }
  for (const t of TARGETS) {
    const ref = await reference(t.url)
    const row = { engine: engineName, browser: browser.version(), label: t.label, url: t.url, ref: ref.err ? ref.err : `${ref.len} B identity` }
    for (const variant of ['stock', 'range-only']) {
      const init = variant === 'stock'
        ? { cache: 'no-store', method: 'GET', headers: { 'Cache-Control': 'no-store', 'user-agent': 'WebTorrent/3.0.21 (https://webtorrent.io)', range: `bytes=${START}-${END}` } }
        : { method: 'GET', headers: { range: `bytes=${START}-${END}` } }
      const r = await page.evaluate(async ([u, init]) => {
        try {
          const x = await fetch(u, init)
          const b = new Uint8Array(await x.arrayBuffer())
          return { ok: x.ok, status: x.status, len: b.length, acr: x.headers.get('content-range'), type: x.type, redirected: x.redirected, bytes: Array.from(b.subarray(0, 4000)) }
        } catch (e) { return { err: e.name + ': ' + e.message } }
      }, [t.url, init])
      let verdict
      if (r.err) verdict = 'BLOCKED/FAILED (' + r.err.slice(0, 60) + ')'
      else if (!r.ok) verdict = 'HTTP ' + r.status
      else if (ref.err) verdict = `HTTP ${r.status}, ${r.len} B (no reference)`
      else {
        const same = r.len === ref.slice.length && sha(Uint8Array.from(r.bytes)) === sha(ref.slice)
        verdict = same ? `OK exact slice (${r.status}, ${r.len} B)` : `WRONG BYTES (${r.status}, got ${r.len} B, wanted ${ref.slice.length} B)`
      }
      row[variant] = verdict
    }
    if (cdp) { const p = protocols[t.url]; row.protocol = p ? [...new Set(p)].join('/') : '?' }
    results.push(row)
    console.log(`${engineName.padEnd(8)} ${t.label.padEnd(30)} stock: ${String(row.stock).padEnd(58)} range-only: ${String(row['range-only']).padEnd(48)} ${row.protocol || ''}`)
  }
  await browser.close()
  fs.writeFileSync(OUT, JSON.stringify(results, null, 1))
}
fs.writeFileSync(OUT, JSON.stringify(results, null, 1))
