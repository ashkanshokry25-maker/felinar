import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { launchEngine, ENGINE } from './lab-browsers.mjs';
import { Server as TrackerServer } from '../../../../node_modules/bittorrent-tracker/index.js';
import createTorrent from '../../../../node_modules/create-torrent/index.js';
import parseTorrent from '../../../../node_modules/parse-torrent/index.js';
const here = path.dirname(fileURLToPath(import.meta.url));
const WTJS = path.resolve(here, '../../../../node_modules/webtorrent/dist/webtorrent.min.js');
const poly = fs.readFileSync(path.join(here, 'u8-polyfill.js'), 'utf8');
const strip = "for (const k of ['toHex','toBase64','setFromHex','setFromBase64']) delete Uint8Array.prototype[k]; for (const k of ['fromHex','fromBase64']) delete Uint8Array[k];";
const STORE_Q = process.env.WT_STORE === 'mem' ? 'store=mem' : '';
const page_ = (n) => fs.readFileSync(path.join(here, 'www', n));
const srv = http.createServer((req, res) => {
  const u = req.url.split('?')[0];
  if (u === '/webtorrent.min.js') { res.writeHead(200, { 'content-type': 'text/javascript' }); return res.end(fs.readFileSync(WTJS)); }
  if (u === '/wt.html' || u === '/wt2.html') { res.writeHead(200, { 'content-type': 'text/html' }); return res.end(page_(u.slice(1))); }
  res.writeHead(404); res.end('nf');
}).listen(0, '127.0.0.1');
await new Promise(r => srv.once('listening', r));
const port = srv.address().port;
const bytes = new Uint8Array(600000); for (let i = 0; i < bytes.length; i++) bytes[i] = (i * 7 + (i >> 8)) & 255;
const tb = await new Promise((res, rej) => createTorrent(Buffer.from(bytes), { name: 'a.bin', announce: [] }, (e, t) => e ? rej(e) : res(t)));
const expected = (await parseTorrent(tb)).infoHash;
const browser = await launchEngine();
console.log('engine:', ENGINE, browser.version());
const variants = [
  { name: 'A native (Chromium 156 as shipped)', init: '' },
  { name: 'B natives stripped, NO polyfill (simulates Safari/iOS <=18.1, Chromium <140, Firefox <133)', init: strip },
  { name: 'C natives stripped + polyfill', init: strip + '\n' + poly }
];
console.log('expected infoHash (Node create-torrent + parse-torrent):', expected);
for (const v of variants) {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  if (v.init) await page.addInitScript(v.init);
  await page.goto('http://127.0.0.1:' + port + '/wt.html?' + STORE_Q);
  await page.waitForFunction(() => window.__result, null, { timeout: 60000 });
  const r = await page.evaluate(() => window.__result);
  const nat = Object.entries(r.natives).map(([k, t]) => k + ':' + (t === 'function' ? 'y' : 'n')).join(' ');
  console.log('\n== ' + v.name + '\n   natives present -> ' + nat);
  console.log('   ' + JSON.stringify({ imported: r.imported, clientCreated: r.clientCreated, seed: r.seed, thrown: r.thrown, errors: r.errors }));
  console.log('   seed infoHash equals Node value:', r.seed ? r.seed.infoHash === expected : 'n/a (no seed)');
  await ctx.close();
}
const tracker = new TrackerServer({ udp: false, http: false, ws: true, stats: false });
await new Promise((res, rej) => { tracker.on('error', rej); tracker.listen(0, '127.0.0.1', res); });
const tport = tracker.ws.address().port;
for (const v of [variants[0], variants[2]]) {
  const ctx = await browser.newContext(); const page = await ctx.newPage();
  if (v.init) await page.addInitScript(v.init);
  await page.goto('http://127.0.0.1:' + port + '/wt2.html?' + STORE_Q + '&tr=' + encodeURIComponent('ws://127.0.0.1:' + tport));
  await page.waitForFunction(() => window.__result, null, { timeout: 90000 });
  const r = await page.evaluate(() => window.__result);
  console.log('\n== TRANSFER 3 MiB, two clients over WebRTC via local ws tracker: ' + v.name + '\n   ' + JSON.stringify(r));
  await ctx.close();
}
tracker.close();
await browser.close(); srv.close();
