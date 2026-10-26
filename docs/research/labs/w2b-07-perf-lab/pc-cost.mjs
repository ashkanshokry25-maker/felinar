// Lab 5: what does an RTCPeerConnection cost? Chromium 156 on this Mac (desktop proxy; phones differ, ratios and order of magnitude are the point).
// (a) N connected loopback pairs with one data channel each (2N PeerConnections in one page); (b) N "unanswered offer" PCs (what each tracker announce leaves behind for up to 50 s).
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { chromium } from '../../../../node_modules/playwright/index.mjs';
import { startServer } from './lab-server.mjs';
const here = path.dirname(fileURLToPath(import.meta.url));
const { port, close } = await startServer({ '/b.html': { body: Buffer.from('<!doctype html><meta charset=utf-8><title>b</title><body>b'), type: 'text/html' } });
const browser = await chromium.launch({ headless: true, args: ['--disable-features=WebRtcHideLocalIpsWithMdns'] });
const rss = (pids) => pids.length ? execFileSync('ps', ['-o', 'rss=', '-p', pids.join(',')]).toString().trim().split('\n').reduce((a, s) => a + (parseInt(s, 10) || 0), 0) / 1024 : 0;
async function procInfo() { const s = await browser.newBrowserCDPSession(); const i = await s.send('SystemInfo.getProcessInfo'); await s.detach(); return i.processInfo; }
const out = { chromium: browser.version(), runs: [] };
async function run(kind, n) {
  const ctx = await browser.newContext(); const page = await ctx.newPage(); await page.goto(`http://127.0.0.1:${port}/b.html`);
  const procs0 = await procInfo(); const pids = procs0.map(p => p.id).concat(browser.process ? [] : []);
  const base = rss(pids) , cpu0 = procs0.reduce((a, p) => a + p.cpuTime, 0);
  const t0 = Date.now();
  const mk = kind === 'pairs'
    ? `async (n) => { window.__keep = []; const t = performance.now(); for (let i = 0; i < n; i++) { const a = new RTCPeerConnection({ iceServers: [] }), b = new RTCPeerConnection({ iceServers: [] }); const dc = a.createDataChannel('x'); const open = new Promise(ok => dc.onopen = ok);
        a.onicecandidate = e => e.candidate && b.addIceCandidate(e.candidate); b.onicecandidate = e => e.candidate && a.addIceCandidate(e.candidate); b.ondatachannel = e => { e.channel.onmessage = () => {}; };
        await a.setLocalDescription(await a.createOffer()); await b.setRemoteDescription(a.localDescription); await b.setLocalDescription(await b.createAnswer()); await a.setRemoteDescription(b.localDescription); await open; window.__keep.push(a, b, dc); }
        return performance.now() - t; }`
    : `async (n) => { window.__keep = []; const t = performance.now(); for (let i = 0; i < n; i++) { const a = new RTCPeerConnection({ iceServers: [] }); const dc = a.createDataChannel('x'); await a.setLocalDescription(await a.createOffer());
        await new Promise(ok => { if (a.iceGatheringState === 'complete') ok(); else a.onicegatheringstatechange = () => a.iceGatheringState === 'complete' && ok(); }); window.__keep.push(a, dc); } return performance.now() - t; }`;
  const createMs = await page.evaluate(`(${mk})(${n})`);
  await new Promise(ok => setTimeout(ok, 3000));
  const procs1 = await procInfo(); const mid = rss(procs1.map(p => p.id)), cpuMid = procs1.reduce((a, p) => a + p.cpuTime, 0), tMid = Date.now();
  await new Promise(ok => setTimeout(ok, 15000));
  const procs2 = await procInfo(); const cpu2 = procs2.reduce((a, p) => a + p.cpuTime, 0), t2 = Date.now();
  const nPC = kind === 'pairs' ? 2 * n : n;
  const row = { kind, n, peerConnections: nPC, createMsTotal: +createMs.toFixed(0), createMsPerPC: +(createMs / nPC).toFixed(1), rssDeltaMB: +(mid - base).toFixed(1), rssPerPC_MB: +((mid - base) / nPC).toFixed(2), idleCpuPct: +(100 * (cpu2 - cpuMid) / ((t2 - tMid) / 1000)).toFixed(2), idleCpuPctPerPC: +(100 * (cpu2 - cpuMid) / ((t2 - tMid) / 1000) / nPC).toFixed(3) };
  out.runs.push(row); console.log(JSON.stringify(row));
  await ctx.close();
}
for (const n of [0, 5, 15, 30]) if (n) await run('pairs', n);
for (const n of [5, 15, 30]) await run('offers', n);
fs.writeFileSync(path.join(here, 'out/pc-cost.json'), JSON.stringify(out, null, 1));
await browser.close(); close();
