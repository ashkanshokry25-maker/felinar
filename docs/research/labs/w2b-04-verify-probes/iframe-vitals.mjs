// VERIFY claim 4 experiment: can PerformanceObserver in the TOP frame see LCP / layout-shift / event timing of content inside an iframe?
import http from 'node:http'
const PROJ = new URL('../../../../', import.meta.url).pathname.replace(/\/$/, '') // <repo root>
const { chromium, webkit } = await import(PROJ + '/node_modules/playwright/index.mjs')
const OBS = `
window.__obs = { lcp: [], ls: [], ev: [] };
new PerformanceObserver(l => l.getEntries().forEach(e => __obs.lcp.push({ t: Math.round(e.startTime), size: e.size, el: (e.element && (e.element.tagName + '#' + e.element.id)) || null }))).observe({ type: 'largest-contentful-paint', buffered: true });
new PerformanceObserver(l => l.getEntries().forEach(e => __obs.ls.push({ v: +e.value.toFixed(4), hadInput: e.hadRecentInput }))).observe({ type: 'layout-shift', buffered: true });
try { new PerformanceObserver(l => l.getEntries().forEach(e => __obs.ev.push({ name: e.name, dur: e.duration }))).observe({ type: 'event', durationThreshold: 16, buffered: true }) } catch (e) { __obs.evErr = String(e) }
`
const TOP = (inner) => `<!doctype html><meta charset=utf-8><body style="margin:0"><p id="shellp" style="font:14px sans-serif;margin:8px">Loader shell (small text)</p><iframe id="f" src="${inner}" style="width:700px;height:600px;border:0"></iframe><script>${OBS}</script>`
const INNER = `<!doctype html><meta charset=utf-8><body style="margin:0"><div id="hero" style="font:700 64px sans-serif;width:640px;height:300px;background:#c33;color:#fff">SITE HERO CONTENT</div><div id="below" style="height:200px">below</div><button id="btn" style="font-size:24px;margin:8px" onclick="const t=performance.now();while(performance.now()-t<150){};const d=document.createElement('div');d.style.cssText='height:120px;background:#39c';d.id='shifter';document.body.insertBefore(d,document.getElementById('hero'))">click me (150ms busy + shift)</button><script>${OBS}</script>`
const srv = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://x'); res.writeHead(200, { 'content-type': 'text/html' })
  if (u.pathname === '/inner') return res.end(INNER)
  const p = new URL(req.url, 'http://x').searchParams
  res.end(TOP(p.get('inner')))
})
await new Promise((r) => srv.listen(0, '0.0.0.0', r))
const port = srv.address().port
for (const [name, engine] of [['chromium', chromium], ['webkit', webkit]]) {
  const browser = await engine.launch({ headless: true })
  console.log('###', name, browser.version())
  for (const [label, inner] of [['same-origin iframe', `/inner`], ['cross-origin iframe (localhost vs 127.0.0.1)', `http://localhost:${port}/inner`]]) {
    const page = await (await browser.newContext()).newPage()
    await page.goto(`http://127.0.0.1:${port}/?inner=${encodeURIComponent(inner)}`)
    await page.waitForTimeout(1200)
    const frame = page.frames().find((f) => f !== page.mainFrame())
    await frame.click('#btn')
    await page.waitForTimeout(1200)
    const top = await page.evaluate(() => window.__obs)
    const inn = await frame.evaluate(() => window.__obs)
    console.log(`--- ${label}`)
    console.log('  TOP frame observer  :', JSON.stringify(top))
    console.log('  IFRAME own observer :', JSON.stringify(inn))
    await page.close()
  }
  await browser.close()
}
srv.close(); process.exit(0)
