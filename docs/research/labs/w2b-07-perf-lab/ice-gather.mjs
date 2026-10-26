// Lab 4c: how long does non-trickle ICE gathering take (what simple-peer waits for before an offer/answer is sent to the tracker)?
// Offerer vs answerer, with/without STUN, with iceCandidatePoolSize, Chromium 156 and WebKit 27.2 on this Mac (network: real internet for STUN).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, webkit } from '../../../../node_modules/playwright/index.mjs';
import { startServer } from './lab-server.mjs';
const here = path.dirname(fileURLToPath(import.meta.url));
const { port, close } = await startServer({ '/b.html': { body: Buffer.from('<!doctype html><meta charset=utf-8><title>b</title><body>b'), type: 'text/html' } });
const fn = `async ([cfgs, reps]) => {
  const med = (a) => [...a].sort((x, y) => x - y)[Math.floor(a.length / 2)];
  const waitComplete = (pc) => new Promise(ok => { if (pc.iceGatheringState === 'complete') return ok(); pc.addEventListener('icegatheringstatechange', () => pc.iceGatheringState === 'complete' && ok()); });
  const res = {};
  for (const [name, cfg] of cfgs) {
    const off = [], first = [], srflx = [], ans = [];
    for (let i = 0; i < reps; i++) {
      const a = new RTCPeerConnection(cfg); a.createDataChannel('x'); let t0 = performance.now(), tFirst = 0, tSrflx = 0;
      a.addEventListener('icecandidate', e => { if (e.candidate) { if (!tFirst) tFirst = performance.now() - t0; if (/ typ srflx /.test(e.candidate.candidate) && !tSrflx) tSrflx = performance.now() - t0; } });
      await a.setLocalDescription(await a.createOffer()); await waitComplete(a); off.push(performance.now() - t0); first.push(tFirst); if (tSrflx) srflx.push(tSrflx);
      const b = new RTCPeerConnection(cfg); await b.setRemoteDescription(a.localDescription); t0 = performance.now(); await b.setLocalDescription(await b.createAnswer()); await waitComplete(b); ans.push(performance.now() - t0);
      a.close(); b.close();
    }
    res[name] = { offerCompleteMs: +med(off).toFixed(0), firstCandMs: +med(first).toFixed(0), srflxMs: srflx.length ? +med(srflx).toFixed(0) : null, answerCompleteMs: +med(ans).toFixed(0) };
  }
  return res;
}`;
const cfgs = [
  ['no ICE servers', {}],
  ['no ICE servers, pool=2', { iceCandidatePoolSize: 2 }],
  ['STUN cloudflare', { iceServers: [{ urls: 'stun:stun.cloudflare.com:3478' }] }],
  ['STUN cloudflare + twilio (project default list)', { iceServers: [{ urls: 'stun:stun.cloudflare.com:3478' }, { urls: 'stun:global.stun.twilio.com:3478' }] }],
  ['STUN google (simple-peer default 1st)', { iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] }],
  ['STUN cloudflare, pool=2', { iceServers: [{ urls: 'stun:stun.cloudflare.com:3478' }], iceCandidatePoolSize: 2 }],
];
const out = { date: new Date().toISOString(), engines: {} };
for (const [name, type, args] of [['chromium', chromium, ['--disable-features=WebRtcHideLocalIpsWithMdns']], ['webkit', webkit, []]]) {
  let browser; try { browser = await type.launch({ headless: true, args }); } catch (e) { console.log(name, 'launch failed'); continue; }
  const ctx = await browser.newContext(); const page = await ctx.newPage(); await page.goto(`http://127.0.0.1:${port}/b.html`);
  const r = await page.evaluate(`(${fn})(${JSON.stringify([cfgs, 7])})`);
  out.engines[name + ' ' + browser.version()] = r; console.log('\n' + name + ' ' + browser.version());
  for (const [k, v] of Object.entries(r)) console.log(k.padEnd(52), JSON.stringify(v));
  await browser.close();
}
fs.writeFileSync(path.join(here, 'out/ice-gather.json'), JSON.stringify(out, null, 1)); close();
