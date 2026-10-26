// Lab 4c': mDNS host-candidate obfuscation vs gathering time. Chromium default (mDNS on) vs flag off, WebKit candidate trace.
import { chromium, webkit } from '../../../../node_modules/playwright/index.mjs';
import { startServer } from './lab-server.mjs';
const { port, close } = await startServer({ '/b.html': { body: Buffer.from('<!doctype html><meta charset=utf-8><title>b</title><body>b'), type: 'text/html' } });
const fn = `async (cfg) => {
  const rows = [];
  for (let i = 0; i < 5; i++) {
    const a = new RTCPeerConnection(cfg); a.createDataChannel('x'); const t0 = performance.now(); const ev = [];
    a.addEventListener('icecandidate', e => ev.push([Math.round(performance.now() - t0), e.candidate ? e.candidate.candidate.split(' ').slice(4, 8).join(' ') : 'null']));
    a.addEventListener('icegatheringstatechange', () => ev.push([Math.round(performance.now() - t0), 'state:' + a.iceGatheringState]));
    await a.setLocalDescription(await a.createOffer());
    await new Promise(ok => { const chk = () => a.iceGatheringState === 'complete' ? ok() : setTimeout(chk, 5); chk(); });
    rows.push(ev); a.close();
  }
  return rows;
}`;
for (const [name, type, args] of [['chromium (mDNS ON, default)', chromium, []], ['chromium (mDNS OFF flag)', chromium, ['--disable-features=WebRtcHideLocalIpsWithMdns']], ['webkit', webkit, []]]) {
  const browser = await type.launch({ headless: true, args });
  const page = await (await browser.newContext()).newPage(); await page.goto(`http://127.0.0.1:${port}/b.html`);
  const r = await page.evaluate(`(${fn})(${JSON.stringify({ iceServers: [{ urls: 'stun:stun.cloudflare.com:3478' }] })})`);
  console.log('\n' + name + ' ' + browser.version());
  for (const ev of r.slice(0, 3)) console.log('  ', JSON.stringify(ev));
  await browser.close();
}
close();
