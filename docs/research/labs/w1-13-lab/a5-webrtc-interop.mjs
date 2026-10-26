// w1-13 A5: isolate the WebRTC layer. Node (node-datachannel polyfill) <-> browser RTCPeerConnection with manual,
// non-trickle signalling. Prints candidates from both sides so we can see which address families/types are used.
// Usage: node docs/research/labs/w1-13-lab/a5-webrtc-interop.mjs
import { chromium, webkit } from 'playwright'
import { RTCPeerConnection as NodePC } from 'node-datachannel/polyfill'
import os from 'node:os'

const waitGather = pc => new Promise(res => { if (pc.iceGatheringState === 'complete') return res(); pc.addEventListener('icegatheringstatechange', () => pc.iceGatheringState === 'complete' && res()) })
const candLines = sdp => sdp.split('\r\n').filter(l => l.startsWith('a=candidate:')).map(l => { const p = l.split(' '); return `${p[2].toLowerCase()} ${p[4]}:${p[5]} ${p[7]}` })

async function attempt (label, browserLauncher, iceServers, nodeIceServers, nodeExtra = {}) {
  const out = { label, iceServers: JSON.stringify(iceServers) }
  const browser = await browserLauncher()
  out.browserVersion = browser.version()
  try {
    const page = await browser.newPage()
    await page.goto('about:blank')
    // Node creates the offer
    const npc = new NodePC({ iceServers: nodeIceServers, ...nodeExtra })
    const dc = npc.createDataChannel('x')
    let opened = false; let echoed = null
    dc.addEventListener('open', () => { opened = true; dc.send('ping-from-node') })
    dc.addEventListener('message', e => { echoed = String(e.data) })
    await npc.setLocalDescription(await npc.createOffer())
    await waitGather(npc)
    out.nodeOfferCandidates = candLines(npc.localDescription.sdp)
    const answer = await page.evaluate(async ({ offerSdp, iceServers }) => {
      const pc = new RTCPeerConnection({ iceServers })
      window.pc = pc; window.log = []
      pc.ondatachannel = e => { e.channel.onmessage = m => { window.log.push('got:' + m.data); e.channel.send('echo:' + m.data) }; e.channel.onopen = () => window.log.push('open') }
      await pc.setRemoteDescription({ type: 'offer', sdp: offerSdp })
      await pc.setLocalDescription(await pc.createAnswer())
      await new Promise(res => { if (pc.iceGatheringState === 'complete') return res(); pc.addEventListener('icegatheringstatechange', () => pc.iceGatheringState === 'complete' && res()); setTimeout(res, 8000) })
      return pc.localDescription.sdp
    }, { offerSdp: npc.localDescription.sdp, iceServers })
    out.browserAnswerCandidates = candLines(answer)
    await npc.setRemoteDescription({ type: 'answer', sdp: answer })
    const t0 = Date.now()
    while (!echoed && Date.now() - t0 < 15000) await new Promise(r => setTimeout(r, 100))
    out.nodeConnectionState = npc.connectionState; out.nodeIceState = npc.iceConnectionState
    out.channelOpened = opened; out.echo = echoed; out.msToEcho = echoed ? Date.now() - t0 : null
    out.browserLog = await page.evaluate(() => ({ log: window.log, ice: window.pc.iceConnectionState, conn: window.pc.connectionState }))
    npc.close()
  } catch (e) { out.error = String(e && e.message || e).split('\n')[0] }
  await browser.close()
  return out
}
const res = []
const ifaces = Object.entries(os.networkInterfaces()).map(([n, a]) => `${n}: ${a.map(x => x.address + (x.internal ? '(lo)' : '')).join(',')}`)
const mdnsOff = () => chromium.launch({ headless: true, args: ['--disable-features=WebRtcHideLocalIpsWithMdns'] })
const mdnsOn = () => chromium.launch({ headless: true })
const wk = () => webkit.launch({ headless: true })
const loop = () => chromium.launch({ headless: true, args: ['--disable-features=WebRtcHideLocalIpsWithMdns', '--allow-loopback-in-peer-connection'] })
res.push(await attempt('chromium mdns-off + --allow-loopback-in-peer-connection, node bindAddress=127.0.0.1', loop, [], [], { bindAddress: '127.0.0.1' }))
res.push(await attempt('webkit default, node bindAddress=127.0.0.1', wk, [], [], { bindAddress: '127.0.0.1' }))
console.log(JSON.stringify({ ifaces, res }, null, 1))
process.exit(0)
