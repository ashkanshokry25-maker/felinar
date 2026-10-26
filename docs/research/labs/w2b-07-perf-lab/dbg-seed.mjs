setTimeout(() => { console.log("HARD TIMEOUT"); process.exit(2); }, 80000).unref();
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '../../../../node_modules/playwright/index.mjs';
import { Server as TrackerServer } from '../../../../node_modules/bittorrent-tracker/index.js';
import { startServer } from './lab-server.mjs';
import { makeSite } from './site-fixture.mjs';
const here = path.dirname(fileURLToPath(import.meta.url));
console.log('start');
const site = makeSite();
const routes = {
  '/wt.js': { file: path.join(here, 'out/wt-esm.js'), type: 'text/javascript' },
  '/seed.html': { file: path.join(here, 'www/seed.html'), type: 'text/html' },
  '/site/manifest.json': { body: Buffer.from(JSON.stringify(site.map(f => ({ path: f.path, size: f.bytes.length })))), type: 'application/json' },
};
for (const f of site) routes['/site/' + f.path] = { body: Buffer.from(f.bytes), type: 'application/octet-stream' };
const web = await startServer(routes); console.log('web', web.port);
const tracker = new TrackerServer({ udp: false, http: false, ws: true, stats: false });
await new Promise((res, rej) => { tracker.on('error', rej); tracker.listen(0, '127.0.0.1', res); });
const TR = 'ws://127.0.0.1:' + tracker.ws.address().port; console.log('tracker', TR);
const browser = await chromium.launch({ headless: true, args: ['--disable-features=WebRtcHideLocalIpsWithMdns'] });
const ctx = await browser.newContext(); const page = await ctx.newPage();
page.on('console', m => console.log('console:', m.text().slice(0, 300))); page.on('pageerror', e => console.log('pageerror:', String(e).slice(0, 300)));
page.on('requestfailed', r => console.log('reqfailed', r.url()));
await page.goto(`http://127.0.0.1:${web.port}/seed.html?pl=16384&tr=${encodeURIComponent(TR)}`);
try { await page.waitForFunction(() => window.__result, null, { timeout: 20000 }); console.log('result', JSON.stringify(await page.evaluate(() => { const r = window.__result; return { ...r, torrentFileB64: undefined }; }))); } catch (e) { console.log('timeout waiting result'); }
await browser.close(); tracker.close(); web.close();
