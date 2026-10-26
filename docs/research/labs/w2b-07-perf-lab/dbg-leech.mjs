setTimeout(() => { console.log("HARD TIMEOUT"); process.exit(2); }, 100000).unref();
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '../../../../node_modules/playwright/index.mjs';
import { Server as TrackerServer } from '../../../../node_modules/bittorrent-tracker/index.js';
import { startServer } from './lab-server.mjs';
import { makeSite, CRITICAL } from './site-fixture.mjs';
const here = path.dirname(fileURLToPath(import.meta.url));
const site = makeSite();
const routes = {
  '/wt.js': { file: path.join(here, 'out/wt-esm.js'), type: 'text/javascript' },
  '/seed.html': { file: path.join(here, 'www/seed.html'), type: 'text/html' }, '/leech.html': { file: path.join(here, 'www/leech.html'), type: 'text/html' },
  '/site/manifest.json': { body: Buffer.from(JSON.stringify(site.map(f => ({ path: f.path, size: f.bytes.length })))), type: 'application/json' },
};
for (const f of site) routes['/site/' + f.path] = { body: Buffer.from(f.bytes), type: 'application/octet-stream' };
const web = await startServer(routes);
const tracker = new TrackerServer({ udp: false, http: false, ws: true, stats: false });
tracker.on('start', (addr, params) => console.log('tracker start from', addr, 'event', params.event, 'numwant', params.numwant, 'offers', (params.offers||[]).length));
await new Promise((res, rej) => { tracker.on('error', rej); tracker.listen(0, '127.0.0.1', res); });
const TR = 'ws://127.0.0.1:' + tracker.ws.address().port;
const browser = await chromium.launch({ headless: true, args: ['--disable-features=WebRtcHideLocalIpsWithMdns'] });
const ctx = await browser.newContext(); const page = await ctx.newPage();
await page.goto(`http://127.0.0.1:${web.port}/seed.html?pl=16384&tr=${encodeURIComponent(TR)}`);
await page.waitForFunction(() => window.__result, null, { timeout: 20000 });
const info = await page.evaluate(() => { const r = window.__result; return { infoHash: r.infoHash, torrentFileB64: r.torrentFileB64 }; });
await new Promise(ok => setTimeout(ok, 800));
const ctx2 = await browser.newContext(); const page2 = await ctx2.newPage();
page2.on('console', m => console.log('console:', m.text().slice(0, 300))); page2.on('pageerror', e => console.log('pageerror:', String(e).slice(0, 300)));
const url = `http://127.0.0.1:${web.port}/leech.html?mode=file&prio=none&tr=${encodeURIComponent(TR)}&crit=${encodeURIComponent(CRITICAL.join(','))}&info=${encodeURIComponent(JSON.stringify(info))}`;
await page2.goto(url);
await new Promise(ok => setTimeout(ok, 8000));
console.log(JSON.stringify(await page2.evaluate(() => ({ marks: window.__marks, out: window.__out, done: window.__done, nwires: window.__t && window.__t.wires.length, ready: window.__t && window.__t.ready, np: window.__t && window.__t.numPeers }))));
await browser.close(); tracker.close(); web.close();
