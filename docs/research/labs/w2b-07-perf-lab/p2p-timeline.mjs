setTimeout(() => { console.log("HARD TIMEOUT"); process.exit(2); }, 1500000).unref(); console.log("boot");
// Lab 4a: anatomy of a cold peer-to-peer site load with the project's pinned stack (webtorrent 3.0.21 / bittorrent-tracker 11.2.3 / simple-peer 10.1.2),
// Chromium 156, one seeder page + one leecher page + a local WebSocket tracker, 15-file 1.43 MiB site.
// Link emulation: RTCDataChannel.send is delayed by one-way delay D and a serialization delay bytes/BW on both pages (RTT = 2D). Loopback otherwise.
// Usage: node p2p-timeline.mjs [quick]
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '../../../../node_modules/playwright/index.mjs';
import { Server as TrackerServer } from '../../../../node_modules/bittorrent-tracker/index.js';
import { WebSocket as NodeWS } from '../../../../node_modules/ws/wrapper.mjs';
import { startServer } from './lab-server.mjs';
import { makeSite, CRITICAL } from './site-fixture.mjs';
const here = path.dirname(fileURLToPath(import.meta.url));
const quick = process.argv.includes('quick');
const trackerOneWayMs = { v: 0 };
{ const so = NodeWS.prototype.send, se = NodeWS.prototype.emit;
  NodeWS.prototype.send = function (...a) { if (!trackerOneWayMs.v) return so.apply(this, a); setTimeout(() => { try { so.apply(this, a); } catch {} }, trackerOneWayMs.v); };
  NodeWS.prototype.emit = function (ev, ...a) { if (ev !== 'message' || !trackerOneWayMs.v) return se.call(this, ev, ...a); setTimeout(() => { try { se.call(this, ev, ...a); } catch {} }, trackerOneWayMs.v); return true; }; }
const site = makeSite();
const routes = {
  '/wt.js': { file: path.join(here, 'out/wt-esm.js'), type: 'text/javascript', cache: 'public, max-age=3600' },
  '/seed.html': { file: path.join(here, 'www/seed.html'), type: 'text/html' }, '/leech.html': { file: path.join(here, 'www/leech.html'), type: 'text/html' }, '/leech2.html': { file: path.join(here, 'www/leech2.html'), type: 'text/html' },
  '/site/manifest.json': { body: Buffer.from(JSON.stringify(site.map(f => ({ path: f.path, size: f.bytes.length })))), type: 'application/json' },
};
for (const f of site) routes['/site/' + f.path] = { body: Buffer.from(f.bytes), type: 'application/octet-stream' };
console.log("pre-web"); const web = await startServer(routes); console.log("web up"); const base = 'http://127.0.0.1:' + web.port;
const tracker = new TrackerServer({ udp: false, http: false, ws: true, stats: false });
await new Promise((res, rej) => { tracker.on('error', rej); tracker.listen(0, '127.0.0.1', res); });
const TR = 'ws://127.0.0.1:' + tracker.ws.address().port;
console.log("tracker up"); const browser = await chromium.launch({ headless: true, args: ['--disable-features=WebRtcHideLocalIpsWithMdns', '--disable-background-timer-throttling', '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows'] });
const linkInit = `(() => {
  // Link emulation on RTCDataChannel.send: FIFO per channel (setTimeout truncates fractional delays, which would reorder messages and corrupt the byte stream).
  window.__link = { d: 0, bw: Infinity };
  const orig = RTCDataChannel.prototype.send;
  function arm(ch) {
    const head = ch.__q[0]; if (!head) { ch.__timer = 0; return; }
    ch.__timer = setTimeout(() => { ch.__timer = 0; const now = performance.now();
      while (ch.__q.length && ch.__q[0].at <= now + 0.5) { const it = ch.__q.shift(); try { orig.call(ch, it.data); } catch (e) { console.error('linksend-error: ' + e.message); } }
      arm(ch); }, Math.max(0, Math.ceil(head.at - performance.now())));
  }
  RTCDataChannel.prototype.send = function (data) {
    const L = window.__link;
    if (!this.__q) this.__q = [];
    if (!L.d && !isFinite(L.bw) && !this.__q.length) return orig.call(this, data);
    const bytes = typeof data === 'string' ? data.length : (data.byteLength !== undefined ? data.byteLength : data.size);
    const copy = typeof data === 'string' ? data : (ArrayBuffer.isView(data) ? data.slice() : data);
    const now = performance.now(); const start = Math.max(now, this.__busy || 0); const tx = isFinite(L.bw) ? bytes / L.bw : 0;
    this.__busy = start + tx;
    this.__q.push({ at: start + tx + L.d, data: copy });
    if (!this.__timer) arm(this);
  };
})();`;
async function newSeeder(pl) {
  const ctx = await browser.newContext(); await ctx.addInitScript(linkInit);
  const page = await ctx.newPage();
  if (process.env.DEBUG) { page.on('console', m => console.log('  [seed console]', m.text().slice(0, 200))); page.on('pageerror', e => console.log('  [seed pageerror]', String(e).slice(0, 200))); }
  await page.goto(`${base}/seed.html?pl=${pl}&tr=${encodeURIComponent(TR)}`);
  await page.waitForFunction(() => window.__result, null, { timeout: 60000 });
  const info = await page.evaluate(() => window.__result);
  if (!info.infoHash) throw new Error('seeder failed ' + JSON.stringify(info));
  await new Promise(ok => setTimeout(ok, 800));
  return { ctx, page, info };
}
const rows = [];
async function leech(seeder, { pl, rttMs, mbps, prio, mode = 'file', trackerMs = 0 }) {
  const d = rttMs / 2, bw = mbps ? (mbps * 1e6 / 8) / 1000 : Infinity;   // bytes per ms
  trackerOneWayMs.v = trackerMs / 2;
  await seeder.page.evaluate(([d, bw]) => { window.__link.d = d; window.__link.bw = bw === null ? Infinity : bw; }, [d, isFinite(bw) ? bw : null]);
  const ctx = await browser.newContext(); await ctx.addInitScript(linkInit); const page = await ctx.newPage();
  if (process.env.DEBUG) { page.on('console', m => console.log('  [leech console]', m.text().slice(0, 200))); page.on('pageerror', e => console.log('  [leech pageerror]', String(e).slice(0, 200))); }
  await page.goto('about:blank');
  await page.evaluate(([d, bw]) => { }, [d, bw]);
  const info = { infoHash: seeder.info.infoHash, torrentFileB64: seeder.info.torrentFileB64 };
  const url = `${base}/${process.env.LEECH || 'leech.html'}?mode=${mode}&prio=${prio}&tr=${encodeURIComponent(TR)}&crit=${encodeURIComponent(CRITICAL.join(','))}&info=${encodeURIComponent(JSON.stringify(info))}&wait=1`;
  await page.addInitScript(([d, bw]) => { Object.defineProperty(window, '__linkInit', { value: { d, bw } }); }, [d, isFinite(bw) ? bw : null]);
  await page.goto(url);
  await page.waitForFunction(() => typeof window.__start === 'function', null, { timeout: 30000 });
  await page.evaluate(([d, bw]) => { window.__link.d = d; window.__link.bw = bw === null ? Infinity : bw; window.__start(); }, [d, isFinite(bw) ? bw : null]);
  let ok = true;
  let poll; if (process.env.DEBUG) poll = setInterval(async () => { try { console.log('  [poll]', JSON.stringify(await page.evaluate(() => window.__t && ({ dl: window.__t.downloaded, prog: +window.__t.progress.toFixed(3), w: window.__t.wires.map(w => ({ req: w.requests.length, choke: w.peerChoking, spd: Math.round(w.downloadSpeed()) })), link: window.__link, stat: window.__lstat })))); console.log('  [seeder]', JSON.stringify(await seeder.page.evaluate(() => ({ link: window.__link, stat: window.__lstat, up: window.__client.torrents[0].uploaded, wires: window.__client.torrents[0].wires.map(w => ({ amChoking: w.amChoking, peerInterested: w.peerInterested, preq: w.peerRequests.length })) })))); } catch (e) { console.log('poll err', e.message); } }, 2000);
  try { await page.waitForFunction(() => window.__done, null, { timeout: +(process.env.LEECH_TIMEOUT || 90000) }); } catch { ok = false; }
  if (poll) clearInterval(poll);
  const marks = await page.evaluate(() => ({ ...window.__marks, out: window.__out }));
  await ctx.close();
  trackerOneWayMs.v = 0;
  const r = { pl: pl / 1024, rttMs, mbps: mbps || 'inf', prio, mode, trackerRttMs: trackerMs, ok, pieces: seeder.info.pieces, torrentFileBytes: seeder.info.torrentFileBytes, ...marks };
  delete r.t0abs; rows.push(r);
  return r;
}
const fmt = (r) => [r.pl + 'K', 'rtt' + r.rttMs, (r.mbps === 'inf' ? 'inf' : r.mbps + 'M'), r.prio, r.mode, 'ws+' + r.ws_open, 'ann+' + r.announce_sent, 'ans+' + r.answer_received, 'wire+' + r.wire_first, 'meta+' + r.metadata, '1st+' + r.verified_first, 'idx+' + r.index_done, 'crit+' + r.critical_done, 'all+' + r.all_done, r.ok ? '' : 'TIMEOUT', (r.out && r.out.errors && r.out.errors.length) ? 'ERR ' + r.out.errors[0] : ''].join(' ');
if (process.env.ONLY) { const cfg = JSON.parse(process.env.ONLY); const seeder = await newSeeder(cfg.pl); const r = await leech(seeder, cfg); console.log(fmt(r)); console.log(JSON.stringify(r)); await browser.close(); tracker.close(); web.close(); process.exit(0); }
const PLS = quick ? [16384, 262144] : [16384, 65536, 262144];
const RTTS = quick ? [0, 150] : [0, 50, 150];
for (const pl of PLS) {
  const seeder = await newSeeder(pl);
  console.log(`\n== piece length ${pl / 1024} KiB: ${seeder.info.pieces} pieces, .torrent ${seeder.info.torrentFileBytes} B, infohash ${seeder.info.infoHash}`);
  for (const rttMs of RTTS) for (const mbps of (quick ? [20] : [20, 5])) for (const prio of ['none', 'prio']) {
    const r = await leech(seeder, { pl, rttMs, mbps, prio }); console.log(fmt(r));
  }
  await seeder.ctx.close();
}
// metadata via ut_metadata (magnet, no .torrent) vs .torrent in hand, and tracker RTT
{
  const pl = 262144; const seeder = await newSeeder(pl); console.log('\n== magnet-only (ut_metadata) vs .torrent known; tracker RTT 0/300 ms; wire RTT 100 ms; 20 Mbps');
  for (const trackerMs of [0, 300]) for (const mode of ['file', 'magnet']) { const r = await leech(seeder, { pl, rttMs: 100, mbps: 20, prio: 'prio', mode, trackerMs }); console.log(fmt(r)); }
  await seeder.ctx.close();
}
fs.writeFileSync(path.join(here, 'out/p2p-timeline.json'), JSON.stringify(rows, null, 1));
await browser.close(); tracker.close(); web.close();
