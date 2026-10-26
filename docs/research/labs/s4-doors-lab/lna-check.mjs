// Usage: node lna-check.mjs. Shows that Chromium's failure to reach 127.0.0.1 from a data: page is its local-network check, not the page type.
import http from 'node:http';
import { readFileSync } from 'node:fs';
import { resolve as __resolve, dirname as __dirname } from 'node:path';
import { fileURLToPath as __fu } from 'node:url';
const ROOT = __resolve(__dirname(__fu(import.meta.url)), '../../../..');
const { chromium } = await import(ROOT + '/node_modules/playwright/index.mjs');
const { CHROMIUM_LOCAL_ONLY_ARGS } = await import(ROOT + '/test/e2e/browser-args.mjs');
const { WebSocketServer } = await import(ROOT + '/node_modules/ws/wrapper.mjs');
const seen = [];
const server = http.createServer((req, res) => { res.writeHead(200, { 'content-type': 'application/json', 'access-control-allow-origin': '*' }); res.end('{"ok":true}'); });
const wss = new WebSocketServer({ noServer: true });
server.on('upgrade', (req, s, h) => { seen.push(req.headers.origin); wss.handleUpgrade(req, s, h, (ws) => ws.close()); });
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const port = server.address().port;
const html = (p) => 'data:text/html;base64,' + Buffer.from(`<script>
const out={};
Promise.all([
 fetch('http://127.0.0.1:${p}/x').then(r=>r.json()).then(()=>out.fetch='ok',e=>out.fetch='ERR '+e.message),
 new Promise(res=>{const w=new WebSocket('ws://127.0.0.1:${p}/ws');w.onopen=()=>{out.ws='open';w.close();res()};w.onerror=()=>{out.ws='error';res()}})
]).then(()=>window.__r=out);</script>`).toString('base64');
async function run(label, args) {
  const b = await chromium.launch({ headless: true, args });
  const pg = await b.newPage();
  await pg.goto(html(port));
  await pg.waitForFunction(() => window.__r, null, { timeout: 15000 });
  console.log(label, JSON.stringify(await pg.evaluate(() => window.__r)));
  await b.close();
}
await run('default local-only args    ', CHROMIUM_LOCAL_ONLY_ARGS);
const merged = CHROMIUM_LOCAL_ONLY_ARGS.map(a => a.startsWith('--disable-features=') ? a + ',LocalNetworkAccessChecks,PrivateNetworkAccessSendPreflights,BlockInsecurePrivateNetworkRequests,PrivateNetworkAccessForNavigations,PrivateNetworkAccessForWorkers,PrivateNetworkAccessRespectPreflightResults' : a);
await run('LNA/PNA features disabled   ', merged);
console.log('server saw ws origins:', JSON.stringify(seen));
server.close(); process.exit(0);
