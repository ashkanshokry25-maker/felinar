// w1-13 A7: why does Playwright WebKit produce no ICE candidates here? Log gathering events with/without STUN, with a media permission grant.
import { webkit } from 'playwright'
import http from 'node:http'
const srv = http.createServer((q, r) => { r.writeHead(200, { 'content-type': 'text/html' }); r.end('<!doctype html><title>x</title>ok') })
await new Promise(r => srv.listen(0, '127.0.0.1', r))
const url = `http://localhost:${srv.address().port}/`
const out = {}
for (const [label, ctxOpts, iceServers] of [
  ['default, no STUN', {}, []],
  ['default, google STUN', {}, [{ urls: 'stun:stun.l.google.com:19302' }]],
  ['permissions camera+microphone granted', { permissions: ['camera', 'microphone'] }, []]
]) {
  const browser = await webkit.launch({ headless: true })
  const ctx = await browser.newContext(ctxOpts)
  const page = await ctx.newPage()
  await page.goto(url)
  out[label] = await page.evaluate(async iceServers => {
    const ev = []; const t0 = performance.now()
    const pc = new RTCPeerConnection({ iceServers })
    pc.createDataChannel('x')
    pc.onicecandidate = e => ev.push([Math.round(performance.now() - t0), e.candidate ? e.candidate.candidate.split(' ').slice(2, 8).join(' ') : 'END'])
    pc.onicegatheringstatechange = () => ev.push([Math.round(performance.now() - t0), 'gathering:' + pc.iceGatheringState])
    pc.onicecandidateerror = e => ev.push([Math.round(performance.now() - t0), 'ERR:' + e.errorCode + ' ' + (e.errorText || '') + ' ' + (e.url || '')])
    await pc.setLocalDescription(await pc.createOffer())
    await new Promise(r => setTimeout(r, 6000))
    return { events: ev.slice(0, 12), finalGathering: pc.iceGatheringState, sdpCandidateLines: (pc.localDescription.sdp.match(/a=candidate:/g) || []).length }
  }, iceServers)
  await browser.close()
}
srv.close()
console.log(JSON.stringify(out, null, 1)); process.exit(0)
