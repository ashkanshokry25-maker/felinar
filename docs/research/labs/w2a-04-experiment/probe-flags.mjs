import { chromium } from 'playwright'
import { startLab } from './lab.mjs'
const lab = await startLab({ withTracker: true })
const SETS = {
  'A mdns-off only': ['--disable-features=WebRtcHideLocalIpsWithMdns'],
  'B +force ip policy default': ['--disable-features=WebRtcHideLocalIpsWithMdns', '--force-webrtc-ip-handling-policy=default'],
  'C +allow loopback ice': ['--disable-features=WebRtcHideLocalIpsWithMdns', '--force-webrtc-ip-handling-policy=default_public_and_private_interfaces'],
  'D no-sandbox': ['--disable-features=WebRtcHideLocalIpsWithMdns', '--no-sandbox'],
}
for (const [name, args] of Object.entries(SETS)) {
  const browser = await chromium.launch({ channel: 'chromium', headless: true, args })
  const ctxA = await browser.newContext(); const ctxB = await browser.newContext()
  const seed = await ctxA.newPage(); const leech = await ctxB.newPage()
  const tracker = `ws://127.0.0.1:${lab.trackerPort}`; const base = `${lab.origin}/csp.html?csp=none&tracker=${encodeURIComponent(tracker)}`
  await seed.goto(base + '&role=seed'); await seed.waitForFunction(() => window.__out && window.__out.magnet, null, { timeout: 15000 })
  const magnet = await seed.evaluate(() => window.__out.magnet)
  await leech.goto(base + '&role=leech&magnet=' + encodeURIComponent(magnet))
  await leech.waitForFunction(() => window.__out && window.__out.done, null, { timeout: 8000 }).catch(() => {})
  const o = await leech.evaluate(() => window.__out)
  console.log(name, '=> done:', !!o.done, 'firstWire:', o.t.firstWire)
  await browser.close()
}
await lab.close()
