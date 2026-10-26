import { chromium, webkit } from '../../../../node_modules/playwright/index.mjs';
import { startServer } from './lab-server.mjs';
const { port, close } = await startServer({ '/b.html': { body: Buffer.from('<!doctype html><meta charset=utf-8><title>b</title><body>b'), type: 'text/html' } });
const fn = `async ([cfg, n, closeEach]) => {
  const out = [];
  for (let i = 0; i < n; i++) {
    const a = new RTCPeerConnection(cfg); a.createDataChannel('x'); const t0 = performance.now(); let first = 0;
    a.addEventListener('icecandidate', e => { if (e.candidate && !first) first = Math.round(performance.now() - t0); });
    await a.setLocalDescription(await a.createOffer());
    await new Promise(ok => { const chk = () => a.iceGatheringState === 'complete' ? ok() : setTimeout(chk, 2); chk(); });
    out.push([first, Math.round(performance.now() - t0)]); if (closeEach) a.close();
    await new Promise(ok => setTimeout(ok, 300));
  }
  return out;
}`;
for (const [name, type, args] of [['chromium', chromium, ['--disable-features=WebRtcHideLocalIpsWithMdns']], ['webkit', webkit, []]]) {
  const browser = await type.launch({ headless: true, args });
  for (const cfg of [{}, { iceServers: [{ urls: 'stun:stun.cloudflare.com:3478' }] }]) {
    const page = await (await browser.newContext()).newPage(); await page.goto(`http://127.0.0.1:${port}/b.html`);
    const r = await page.evaluate(`(${fn})(${JSON.stringify([cfg, 12, true])})`);
    console.log(name, browser.version(), JSON.stringify(cfg), '[first-candidate ms, complete ms] x12:', JSON.stringify(r));
  }
  await browser.close();
}
close();
