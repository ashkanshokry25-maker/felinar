// Lab 2: SHA-1 piece verification cost: WebCrypto (what webtorrent 3.0.21 uses via uint8-util hash()) vs pure-JS noble sha1,
// across Chromium / WebKit / Firefox on this Mac (desktop proxy), sequential vs parallel, piece sizes 16 KiB..16 MiB.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, webkit, firefox } from '../../../../node_modules/playwright/index.mjs';
import { startServer } from './lab-server.mjs';
const here = path.dirname(fileURLToPath(import.meta.url));
const { port, close } = await startServer({
  '/b.html': { body: Buffer.from('<!doctype html><meta charset=utf-8><title>b</title><script src="/noble.js"></script><body>b'), type: 'text/html' },
  '/noble.js': { file: path.join(here, 'out/noble-sha1.iife.js'), type: 'text/javascript' },
});
const base = 'http://127.0.0.1:' + port;
const fnSrc = `async () => {
  const sizes = [[16384, 2000], [65536, 800], [262144, 300], [1048576, 80], [4194304, 24], [16777216, 6]];
  const rows = [];
  for (const [size, iters] of sizes) {
    const buf = new Uint8Array(size); for (let i = 0; i < size; i += 4096) crypto.getRandomValues(buf.subarray(i, Math.min(size, i + 4096)));
    // warm up
    await crypto.subtle.digest('SHA-1', buf); self.nobleSha1(buf);
    let t = performance.now();
    for (let i = 0; i < iters; i++) await crypto.subtle.digest('SHA-1', buf);
    const seq = performance.now() - t;
    t = performance.now();
    for (let i = 0; i < iters; i += 16) { const b = []; for (let j = 0; j < 16 && i + j < iters; j++) b.push(crypto.subtle.digest('SHA-1', buf)); await Promise.all(b); }
    const par = performance.now() - t;
    const jsIters = Math.max(4, Math.floor(iters / 4));
    t = performance.now();
    for (let i = 0; i < jsIters; i++) self.nobleSha1(buf);
    const js = performance.now() - t;
    const mbps = (n, ms) => +((n * size) / 1048576 / (ms / 1000)).toFixed(0);
    rows.push({ size, wcSeqMBps: mbps(iters, seq), wcSeqUsPerCall: +(seq / iters * 1000).toFixed(1), wcPar16MBps: mbps(iters, par), jsMBps: mbps(jsIters, js), jsMsPerPiece: +(js / jsIters).toFixed(3) });
  }
  return rows;
}`;
const out = { date: new Date().toISOString(), engines: {} };
for (const [name, type, rates] of [['chromium', chromium, [1, 4, 6]], ['webkit', webkit, [1]], ['firefox', firefox, [1]]]) {
  let browser;
  try { browser = await type.launch({ headless: true }); } catch (e) { console.log(name, 'launch failed', e.message.split('\n')[0]); continue; }
  const ver = browser.version();
  for (const rate of rates) {
    const ctx = await browser.newContext(); const page = await ctx.newPage();
    if (rate !== 1) { const cdp = await ctx.newCDPSession(page); await cdp.send('Emulation.setCPUThrottlingRate', { rate }); }
    await page.goto(base + '/b.html');
    const rows = await page.evaluate(`(${fnSrc})()`);
    out.engines[`${name} ${ver} cpu x${rate}`] = rows;
    console.log(`\n${name} ${ver}  CPU x${rate}`);
    console.log('piece      WebCrypto-seq   us/call   WebCrypto-par16   noble-JS     JS ms/piece');
    for (const r of rows) console.log(String(r.size / 1024 + ' KiB').padEnd(10), String(r.wcSeqMBps + ' MB/s').padStart(14), String(r.wcSeqUsPerCall).padStart(9), String(r.wcPar16MBps + ' MB/s').padStart(17), String(r.jsMBps + ' MB/s').padStart(12), String(r.jsMsPerPiece).padStart(12));
    await ctx.close();
  }
  await browser.close();
}
fs.writeFileSync(path.join(here, 'out/sha1-bench.json'), JSON.stringify(out, null, 1));
close();
