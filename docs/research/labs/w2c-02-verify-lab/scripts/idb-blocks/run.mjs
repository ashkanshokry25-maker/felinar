import http from 'node:http'; import { readFile } from 'node:fs/promises'; import { mkdtemp } from 'node:fs/promises'; import { tmpdir } from 'node:os'; import { join } from 'node:path';
import { chromium, webkit } from '$HOME/Documents/Projects/magnet-web/node_modules/playwright/index.mjs';
const [,, pageDir, dataDir, file] = process.argv;
const srv = http.createServer(async (req, res) => { try { if (req.url.startsWith('/data/')) res.writeHead(200, { 'content-type': 'application/json' }).end(await readFile(dataDir + '/' + req.url.slice(6).split('?')[0])); else res.writeHead(200, { 'content-type': 'text/html' }).end(await readFile(pageDir + '/page.html')); } catch { res.writeHead(404).end(); } }).listen(18796, '127.0.0.1');
const base = 'http://127.0.0.1:18796/';
async function ev(page, url) { await page.goto(url); await page.waitForFunction(() => window.__RESULT, null, { timeout: 300000 }); return page.evaluate(() => window.__RESULT); }
const all = {};
for (const [name, bt] of [['chromium', chromium], ['webkit', webkit]]) {
  const r = {};
  { const b = await bt.launch({ headless: true }); const pg = await b.newPage(); r.ephemeralWrite = await ev(pg, `${base}?phase=write&file=${file}`); r.version = b.version(); await b.close(); }
  const dir = await mkdtemp(join(tmpdir(), 'pw-blk-'));
  { const c = await bt.launchPersistentContext(dir, { headless: true }); const pg = c.pages()[0] || await c.newPage(); r.persistentWrite = await ev(pg, `${base}?phase=write&file=${file}`); await c.close(); }
  { const c = await bt.launchPersistentContext(dir, { headless: true }); const pg = c.pages()[0] || await c.newPage(); r.persistentColdRead = await ev(pg, `${base}?phase=read&file=${file}`); await c.close(); }
  all[name] = r;
}
srv.close(); console.log(JSON.stringify(all));
