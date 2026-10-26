import http from 'node:http';
import { chromium, webkit } from '../../../../node_modules/playwright/index.mjs';
const server = http.createServer((q, r) => { r.writeHead(200, { 'content-type': 'text/html' }); r.end('<!doctype html><title>x</title>'); });
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const url = `http://localhost:${server.address().port}/`;
async function inpage(label, type, ctxOpts, gum) {
  const browser = await type.launch(type === chromium ? { headless: true, args: ['--disable-features=WebRtcHideLocalIpsWithMdns'] } : { headless: true });
  const ctx = await browser.newContext(ctxOpts); const page = await ctx.newPage(); await page.goto(url);
  const res = await page.evaluate(async (gum) => {
    if (gum) { try { window.__s = await navigator.mediaDevices.getUserMedia({ audio: true }); } catch (e) { return { gumErr: e.name }; } }
    const t0 = performance.now();
    const pc1 = new RTCPeerConnection({ iceServers: [] }), pc2 = new RTCPeerConnection({ iceServers: [] });
    const cands = []; pc1.onicecandidate = (e) => { if (e.candidate) { cands.push(e.candidate.candidate.split(' ').slice(4, 8).join(' ')); pc2.addIceCandidate(e.candidate); } };
    pc2.onicecandidate = (e) => { if (e.candidate) pc1.addIceCandidate(e.candidate); };
    const dc1 = pc1.createDataChannel('x'); let got = null;
    const open = new Promise((r) => { pc2.ondatachannel = (e) => { e.channel.onmessage = (m) => { got = m.data; r(true); }; }; });
    dc1.onopen = () => dc1.send('hello');
    await pc1.setLocalDescription(await pc1.createOffer()); await pc2.setRemoteDescription(pc1.localDescription);
    await pc2.setLocalDescription(await pc2.createAnswer()); await pc1.setRemoteDescription(pc2.localDescription);
    const ok = await Promise.race([open, new Promise((r) => setTimeout(() => r(false), 10000))]);
    return { connected: ok, got, ms: Math.round(performance.now() - t0), candidates: cands, ice1: pc1.iceConnectionState, ice2: pc2.iceConnectionState };
  }, gum);
  console.log(label, JSON.stringify(res));
  await browser.close();
}
await inpage('chromium in-page', chromium, {}, false);
await inpage('webkit in-page (no gUM)', webkit, {}, false);
await inpage('webkit in-page (perm + gUM)', webkit, { permissions: ['camera', 'microphone'] }, true);
server.close();
