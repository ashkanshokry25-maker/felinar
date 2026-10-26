// docs/research/labs/c2-calls-lab/probe.mjs: loopback-only probe for the C2 calls design
// (docs/research/v03/SEEDING-AND-ZERO-SETUP-DESIGN.md, section 3.5).
//
//   node docs/research/labs/c2-calls-lab/probe.mjs "$PWD"      (from the repository root)
//
// Measures, in Playwright Chromium and Playwright WebKit on this machine:
//   1. fake (Chromium) and mock (WebKit) capture devices: getUserMedia, getDisplayMedia from script and (WebKit)
//      from a trusted click, labels and settings;
//   2. a two-party audio and video call over RTCPeerConnection with iceServers: [] (no STUN, no TURN):
//      connection state, DTLS state, bytes each way after 4 s, the default audio and video send targets;
//   3. RTCRtpSender.setParameters (maxBitrate, scaleResolutionDownBy) and replaceTrack(null);
//   4. SDP sizes of an offer and an answer (audio, video and one negotiated data channel);
//   5. Media Session videoconference actions, Document Picture-in-Picture, navigator.audioSession;
//   6. WebKit only: whether a second capturing page in the same browser mutes the first one.
//
// Network policy (docs/DEV-NETWORK.md): every URL is http://127.0.0.1:<port>; Chromium runs with
// chromiumArgs() (no remote name resolves). SAFETY: Chromium ALWAYS gets --use-fake-device-for-media-stream
// together with --use-fake-ui-for-media-stream. The fake-UI flag alone auto-grants the REAL camera and
// microphone of the machine (seen once while this lab was written; nothing was recorded or kept).
import { createServer } from 'node:http'

const ROOT = process.argv[2]
if (!ROOT) { console.error('usage: node probe.mjs <repository root>'); process.exit(2) }
const pw = await import(ROOT + '/node_modules/playwright/index.mjs')
const { chromiumArgs } = await import(ROOT + '/test/e2e/browser-args.mjs')
const CHROMIUM_FLAGS = ['--allow-loopback-in-peer-connection', '--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream']

const server = createServer((req, res) => { res.writeHead(200, { 'content-type': 'text/html' }); res.end('<!doctype html><meta charset=utf-8><title>c2-calls-lab</title><body>lab</body>') })
await new Promise((r) => server.listen(0, '127.0.0.1', r))
const URL_ = 'http://127.0.0.1:' + server.address().port + '/'
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const GATHER = 'new Promise((res) => { const pc = window.__pc; if (pc.iceGatheringState === "complete") return res(); pc.addEventListener("icegatheringstatechange", () => { if (pc.iceGatheringState === "complete") res() }); setTimeout(res, 4000) })'

const launchChromium = () => pw.chromium.launch({ headless: true, args: chromiumArgs({ allowRemote: false }).concat(CHROMIUM_FLAGS) })
const launchWebkit = () => pw.webkit.launch({ headless: true })

async function openPage (browser) {
  const ctx = await browser.newContext({ permissions: ['camera', 'microphone'] })
  const page = await ctx.newPage()
  await page.goto(URL_)
  return page
}

const features = (page) => page.evaluate(async () => {
  const r = { secure: window.isSecureContext }
  try {
    const s = await navigator.mediaDevices.getUserMedia({ audio: true, video: { width: 640, height: 360 } })
    r.gum = s.getTracks().map((t) => t.kind + ': ' + t.label)
    s.getTracks().forEach((t) => t.stop())
  } catch (e) { r.gum = e.name }
  try {
    const s = await navigator.mediaDevices.getDisplayMedia({ video: true })
    const st = s.getVideoTracks()[0].getSettings()
    r.gdm = 'ok: ' + s.getVideoTracks()[0].label + ', ' + st.width + 'x' + st.height + ', ' + st.displaySurface
    s.getTracks().forEach((t) => t.stop())
  } catch (e) { r.gdm = e.name + ': ' + e.message }
  r.mediaSession = {}
  for (const a of ['togglemicrophone', 'togglecamera', 'hangup', 'enterpictureinpicture']) {
    try { navigator.mediaSession.setActionHandler(a, () => {}); r.mediaSession[a] = 'ok' } catch (e) { r.mediaSession[a] = e.name }
  }
  r.documentPictureInPicture = 'documentPictureInPicture' in window
  r.audioSession = typeof navigator.audioSession === 'object' ? 'present' : 'absent'
  r.wakeLock = 'wakeLock' in navigator
  return r
})

async function call (A, B) {
  const setup = (p) => p.evaluate(async () => {
    const pc = new RTCPeerConnection({ iceServers: [] })
    window.__pc = pc
    const s = await navigator.mediaDevices.getUserMedia({ audio: true, video: { width: 640, height: 360 } })
    for (const t of s.getTracks()) pc.addTrack(t, s)
    pc.createDataChannel('mw-call', { negotiated: true, id: 0 })
  })
  await setup(A); await setup(B)
  const offer = await A.evaluate(async (g) => {
    const pc = window.__pc; const o = await pc.createOffer(); const initial = o.sdp.length
    await pc.setLocalDescription(o); await eval(g)
    return { initial, complete: pc.localDescription.sdp.length, sdp: pc.localDescription.sdp }
  }, GATHER)
  const answer = await B.evaluate(async ([sdp, g]) => {
    const pc = window.__pc; await pc.setRemoteDescription({ type: 'offer', sdp }); const a = await pc.createAnswer(); const initial = a.sdp.length
    await pc.setLocalDescription(a); await eval(g)
    return { initial, complete: pc.localDescription.sdp.length, sdp: pc.localDescription.sdp }
  }, [offer.sdp, GATHER])
  await A.evaluate(async (sdp) => { await window.__pc.setRemoteDescription({ type: 'answer', sdp }) }, answer.sdp)
  await sleep(4000)
  const stats = (p) => p.evaluate(async () => {
    const pc = window.__pc; const o = { state: pc.connectionState }
    ;(await pc.getStats()).forEach((s) => {
      if (s.type === 'outbound-rtp') { o['sent-' + s.kind] = s.bytesSent; o['target-' + s.kind] = s.targetBitrate }
      if (s.type === 'inbound-rtp') o['received-' + s.kind] = s.bytesReceived
    })
    const snd = pc.getSenders().find((x) => x.track && x.track.kind === 'video')
    o.dtls = snd && snd.transport ? snd.transport.state : 'n/a'
    try {
      const prm = snd.getParameters(); if (!prm.encodings || !prm.encodings.length) prm.encodings = [{}]
      prm.encodings[0].maxBitrate = 150000; prm.encodings[0].scaleResolutionDownBy = 2
      await snd.setParameters(prm)
      const q = snd.getParameters().encodings[0]
      o.setParameters = 'maxBitrate ' + q.maxBitrate + ', scaleResolutionDownBy ' + q.scaleResolutionDownBy
    } catch (e) { o.setParameters = e.name }
    try { await snd.replaceTrack(null); o.replaceTrackNull = 'ok' } catch (e) { o.replaceTrackNull = e.name }
    o.remoteFingerprint = /a=fingerprint:sha-256 /.test(pc.remoteDescription.sdp)
    return o
  })
  return { sdp: { offerInitial: offer.initial, offerComplete: offer.complete, answerInitial: answer.initial, answerComplete: answer.complete }, A: await stats(A), B: await stats(B) }
}

const out = { date: new Date().toISOString(), playwright: JSON.parse((await import('node:fs')).readFileSync(ROOT + '/node_modules/playwright/package.json', 'utf8')).version }

// Chromium: two contexts of one browser (fake devices).
{
  const b = await launchChromium()
  out.chromium = { version: b.version() }
  const A = await openPage(b); const B = await openPage(b)
  out.chromium.features = await features(A)
  out.chromium.call = await call(A, B)
  await b.close()
}
// WebKit: does a second capturing page in the same browser mute the first?
{
  const b = await launchWebkit()
  out.webkit = { version: b.version() }
  const A = await openPage(b); const B = await openPage(b)
  out.webkit.features = await features(A)
  const cap = (p) => p.evaluate(async () => {
    const s = await navigator.mediaDevices.getUserMedia({ audio: true, video: true })
    window.__keep = s
    window.__events = []
    for (const t of s.getTracks()) { t.onmute = () => window.__events.push(t.kind + ' muted'); t.onended = () => window.__events.push(t.kind + ' ended') }
  })
  await cap(A); await sleep(500); await cap(B); await sleep(1000)
  out.webkit.firstPageAfterSecondCaptures = await A.evaluate(() => ({ tracks: window.__keep.getTracks().map((t) => t.kind + ': ' + (t.muted ? 'muted' : 'live')), events: window.__events }))
  await b.close()
}
// WebKit: one browser per participant; screen capture from a trusted click first.
async function displayFromClick (page) {
  await page.evaluate(() => {
    const b = document.createElement('button'); b.id = 'share'; b.textContent = 'share'; window.__gdm = null
    b.onclick = async () => {
      try { const s = await navigator.mediaDevices.getDisplayMedia({ video: true }); window.__gdm = 'ok: ' + s.getVideoTracks()[0].label; s.getTracks().forEach((t) => t.stop()) } catch (e) { window.__gdm = e.name + ': ' + e.message }
    }
    document.body.appendChild(b)
  })
  await page.click('#share')
  await page.waitForFunction(() => window.__gdm !== null, null, { timeout: 5000 }).catch(() => {})
  return page.evaluate(() => window.__gdm)
}
{
  const b1 = await launchWebkit(); const b2 = await launchWebkit()
  const P = await openPage(b1); const Q = await openPage(b2)
  out.webkit.displayFromClick = await displayFromClick(P)
  out.webkit.callTwoBrowsers = await call(P, Q)
  await b1.close(); await b2.close()
}
server.close()
console.log(JSON.stringify(out, null, 1))
