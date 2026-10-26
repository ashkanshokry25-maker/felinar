// w2b-04 experiment: what does Chromium tell a page about STUN reachability? Needs Playwright (repo devDependency) + its Chromium.
// Cases: (A) Cloudflare STUN by IP literal + blackhole 192.0.2.1 (TEST-NET-1), (B) Google STUN by hostname, (C) Google STUN by IP literal.
// Output has no IP addresses of this host: only candidate TYPE counts, error codes/texts and timings.
// Run: node rtc-ice-gather.mjs     (case A waits 50 s on purpose)
import dns from 'node:dns/promises'
import { chromium } from '../../../../node_modules/playwright/index.mjs'

const cf = (await dns.lookup('stun.cloudflare.com', { family: 4 })).address
const gg = (await dns.lookup('stun.l.google.com', { family: 4 })).address

const PAGE_FN = async ({ servers, waitMs }) => {
  const t0 = performance.now(); const T = () => Math.round(performance.now() - t0)
  const pc = new RTCPeerConnection({ iceServers: servers.map((u) => ({ urls: u })) })
  const rec = { cand: {}, errors: [], states: [] }
  pc.addEventListener('icecandidate', (e) => {
    if (!e.candidate) { rec.states.push(['gathering-complete', T()]); return }
    const m = / typ (\w+)/.exec(e.candidate.candidate); const t = m ? m[1] : '?'
    rec.cand[t] = (rec.cand[t] || 0) + 1
    if (t === 'srflx' && !rec.firstSrflxMs) rec.firstSrflxMs = T()
  })
  pc.addEventListener('icecandidateerror', (e) => rec.errors.push({ code: e.errorCode, text: (e.errorText || '').slice(0, 70), url: e.url, atMs: T() }))
  pc.addEventListener('icegatheringstatechange', () => rec.states.push(['gather:' + pc.iceGatheringState, T()]))
  pc.createDataChannel('x'); await pc.setLocalDescription(await pc.createOffer())
  await new Promise((r) => setTimeout(r, waitMs))
  pc.close(); return rec
}

const run = async (label, servers, waitMs) => {
  const browser = await chromium.launch({ headless: true, args: ['--disable-features=WebRtcHideLocalIpsWithMdns'] })
  const page = await (await browser.newContext()).newPage(); await page.goto('about:blank')
  const r = await page.evaluate(PAGE_FN, { servers, waitMs }); const v = browser.version(); await browser.close()
  const scrub = (s) => String(s).replace(/\b\d{1,3}(\.\d{1,3}){3}\b/g, (ip) => ip === '192.0.2.1' ? ip : '<ip>')
  console.log('--- ' + label + '  [Chromium ' + v + ']'); console.log(scrub(JSON.stringify(r)))
}
await run('A: Cloudflare STUN by IP literal + blackhole 192.0.2.1 (wait 50 s)', [`stun:${cf}:3478`, 'stun:192.0.2.1:3478'], 50000)
await run('B: Google STUN by hostname (system DNS path) (wait 8 s)', ['stun:stun.l.google.com:19302'], 8000)
await run('C: Google STUN by IP literal (wait 8 s)', [`stun:${gg}:19302`], 8000)
