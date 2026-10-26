import http from 'node:http'; import { readFile } from 'node:fs/promises';
import { chromium, webkit } from '$HOME/Documents/Projects/magnet-web/node_modules/playwright/index.mjs';
const dir = process.argv[2];
const srv = http.createServer(async (req, res) => { const f = req.url.startsWith('/bundle.js') ? 'bundle.js' : 'page.html'; res.writeHead(200, { 'content-type': f.endsWith('.js') ? 'text/javascript' : 'text/html' }).end(await readFile(dir + '/' + f)); }).listen(18795, '127.0.0.1');
for (const [name, bt] of [['chromium', chromium], ['webkit', webkit]]) {
  const b = await bt.launch({ headless: true }); const pg = await b.newPage();
  pg.on('pageerror', e => console.error(name, 'pageerror', e.message));
  await pg.goto('http://127.0.0.1:18795/'); await pg.waitForFunction(() => window.__RESULT, null, { timeout: 60000 });
  const r = await pg.evaluate(() => window.__RESULT); console.log(name, b.version(), JSON.stringify(r)); await b.close();
}
srv.close();
