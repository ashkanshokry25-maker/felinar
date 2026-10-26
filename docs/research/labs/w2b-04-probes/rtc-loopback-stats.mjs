// w2b-04 experiment: same-page loopback pair per engine; what can a diagnostics panel observe (events, candidate types, getStats shape)?
// Output has NO IP addresses: only types/counts/booleans/sizes. Needs Playwright browsers (Chromium; Firefox and WebKit are tried too).
// Observed 2026-10-17 on macOS 27.0 / Apple M3: Chromium 156.0.8078.4 connects in ~24 ms; WebKit 27.2 did not connect in 15 s (cause not isolated);
// Playwright's Firefox (Nightly build 1555) failed to start ("Could not find profile folder").
// Run: node rtc-loopback-stats.mjs
import { chromium, firefox, webkit } from '../../../../node_modules/playwright/index.mjs'

const PAGE_FN = async () => {
  const out = { t0: performance.now() }
  const T = () => Math.round(performance.now() - out.t0)
  const ice = [{ urls: 'stun:stun.cloudflare.com:3478' }, { urls: 'stun:192.0.2.1:3478' }, { urls: 'stun:no-such-host.invalid:3478' }]
  const mk = (label) => {
    const pc = new RTCPeerConnection({ iceServers: ice })
    const rec = { label, cand: { host: 0, srflx: 0, relay: 0, prflx: 0, mdns: 0 }, errors: [], states: [] }
    pc.addEventListener('icecandidate', (e) => {
      if (!e.candidate) { rec.states.push(['gathering-complete', T()]); return }
      const c = e.candidate.candidate || ''; const m = / typ (\w+)/.exec(c); const typ = m ? m[1] : 'unknown'
      rec.cand[typ] = (rec.cand[typ] || 0) + 1; if (/\.local /.test(c)) rec.cand.mdns++
    })
    pc.addEventListener('icecandidateerror', (e) => rec.errors.push({ code: e.errorCode, text: (e.errorText || '').slice(0, 60), urlHost: (e.url || '').replace(/^stun:/, '').replace(/:\d+$/, ''), hasAddress: !!e.address, atMs: T() }))
    pc.addEventListener('iceconnectionstatechange', () => rec.states.push(['ice:' + pc.iceConnectionState, T()]))
    pc.addEventListener('connectionstatechange', () => rec.states.push(['conn:' + pc.connectionState, T()]))
    pc.addEventListener('icegatheringstatechange', () => rec.states.push(['gather:' + pc.iceGatheringState, T()]))
    return { pc, rec }
  }
  const A = mk('A'); const B = mk('B')
  A.pc.addEventListener('icecandidate', (e) => { if (e.candidate) B.pc.addIceCandidate(e.candidate).catch(() => {}) })
  B.pc.addEventListener('icecandidate', (e) => { if (e.candidate) A.pc.addIceCandidate(e.candidate).catch(() => {}) })
  const dc = A.pc.createDataChannel('x')
  const got = new Promise((res) => { B.pc.ondatachannel = (ev) => { let n = 0; ev.channel.onmessage = (m) => { n += (m.data.byteLength || m.data.length || 0); if (n >= 262144) res(n) } } })
  const opened = new Promise((res) => { dc.onopen = res })
  const offer = await A.pc.createOffer(); await A.pc.setLocalDescription(offer)
  await B.pc.setRemoteDescription(offer)
  const ans = await B.pc.createAnswer(); await B.pc.setLocalDescription(ans)
  await A.pc.setRemoteDescription(ans)
  const to = (ms, v) => new Promise((r) => setTimeout(() => r(v), ms))
  const ok = await Promise.race([opened.then(() => true), to(15000, false)])
  out.channelOpen = ok; out.channelOpenMs = T()
  if (ok) { const chunk = new Uint8Array(16384); for (let i = 0; i < 16; i++) dc.send(chunk); await Promise.race([got, to(8000, null)]) }
  await to(1500, 0)
  const summarize = async (pc) => {
    const rep = await pc.getStats(); const byType = {}; const keys = new Set(); let addrFields = 0; let pair = null; const all = []
    rep.forEach((v) => { byType[v.type] = (byType[v.type] || 0) + 1; all.push(v); Object.keys(v).forEach((k) => keys.add(v.type + '.' + k)) })
    for (const v of all) {
      if ((v.type === 'local-candidate' || v.type === 'remote-candidate') && (v.address || v.ip)) addrFields++
      if (v.type === 'candidate-pair' && (v.nominated || v.state === 'succeeded') && v.bytesSent > 0 && !pair) pair = { state: v.state, nominated: !!v.nominated, rtt: v.currentRoundTripTime ?? null, bytesSent: v.bytesSent, bytesReceived: v.bytesReceived }
    }
    return { jsonBytes: JSON.stringify(all).length, byType, addrFieldsOnCandidates: addrFields, remoteCandidateAddressAllNull: all.filter((v) => v.type === 'remote-candidate').every((v) => v.address == null && v.ip == null), pair, distinctFieldCount: keys.size }
  }
  out.statsA = await summarize(A.pc); out.A = A.rec; out.B = B.rec
  A.pc.close(); B.pc.close(); return out
}

for (const [name, bt, args] of [['chromium', chromium, ['--disable-features=WebRtcHideLocalIpsWithMdns']], ['firefox', firefox, []], ['webkit', webkit, []]]) {
  let browser
  try {
    browser = await bt.launch({ headless: true, args })
    const ver = browser.version(); const page = await (await browser.newContext()).newPage(); await page.goto('about:blank')
    const res = await Promise.race([page.evaluate(PAGE_FN), new Promise((r) => setTimeout(() => r({ error: 'harness-timeout-40s' }), 40000))])
    console.log('=== ' + name + ' ' + ver + ' ==='); console.log(JSON.stringify(res).slice(0, 3000))
  } catch (e) { console.log('=== ' + name + ' FAILED: ' + String(e.message).split('\n')[0]) } finally { try { await browser.close() } catch {} }
}
