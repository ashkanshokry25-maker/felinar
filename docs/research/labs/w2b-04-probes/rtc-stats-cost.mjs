// w2b-04 experiment: cost and size of RTCPeerConnection.getStats() across many loopback peer connections in Chromium.
// "projected" = only transport + data-channel + nominated candidate-pair, a handful of numeric fields (what a bundle should keep).
// Run: node rtc-stats-cost.mjs
import { chromium } from '../../../../node_modules/playwright/index.mjs'

const FN = async ({ pairs, rounds }) => {
  const pcs = []
  const mkPair = async () => {
    const a = new RTCPeerConnection(); const b = new RTCPeerConnection()
    a.onicecandidate = (e) => e.candidate && b.addIceCandidate(e.candidate).catch(() => {})
    b.onicecandidate = (e) => e.candidate && a.addIceCandidate(e.candidate).catch(() => {})
    const dc = a.createDataChannel('x'); const open = new Promise((r) => { dc.onopen = r })
    await a.setLocalDescription(await a.createOffer()); await b.setRemoteDescription(a.localDescription)
    await b.setLocalDescription(await b.createAnswer()); await a.setRemoteDescription(b.localDescription)
    await Promise.race([open, new Promise((r) => setTimeout(r, 8000))])
    pcs.push(a, b)
  }
  for (let i = 0; i < pairs; i++) await mkPair()
  await new Promise((r) => setTimeout(r, 500))
  const times = []; const sizes = []; const selSizes = []
  for (let r = 0; r < rounds; r++) {
    const t0 = performance.now()
    const reps = await Promise.all(pcs.map((pc) => pc.getStats()))
    times.push(performance.now() - t0)
    let tot = 0; let sel = 0
    for (const rep of reps) {
      const all = []; rep.forEach((v) => all.push(v)); tot += JSON.stringify(all).length
      const keep = all.filter((v) => v.type === 'transport' || v.type === 'data-channel' || (v.type === 'candidate-pair' && v.nominated))
      sel += JSON.stringify(keep.map(({ type, state, nominated, currentRoundTripTime, bytesSent, bytesReceived, dtlsState, iceState, messagesSent, messagesReceived }) => ({ type, state, nominated, currentRoundTripTime, bytesSent, bytesReceived, dtlsState, iceState, messagesSent, messagesReceived }))).length
    }
    sizes.push(tot); selSizes.push(sel)
    await new Promise((r) => setTimeout(r, 100))
  }
  times.sort((a, b) => a - b)
  const med = (arr) => arr.slice().sort((a, b) => a - b)[Math.floor(arr.length / 2)]
  const res = { pcs: pcs.length, getStatsAllMs: { median: +med(times).toFixed(1), p90: +times[Math.floor(times.length * 0.9)].toFixed(1), max: +times[times.length - 1].toFixed(1) }, fullJsonBytes: med(sizes), projectedJsonBytes: med(selSizes) }
  pcs.forEach((p) => p.close()); return res
}

const browser = await chromium.launch({ headless: true, args: ['--disable-features=WebRtcHideLocalIpsWithMdns'] })
const ver = browser.version(); const page = await (await browser.newContext()).newPage(); await page.goto('about:blank')
for (const pairs of [5, 15]) console.log(ver, JSON.stringify(await page.evaluate(FN, { pairs, rounds: 20 })))
await browser.close()
