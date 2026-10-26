// Usage: node installable.mjs. Serves dist/ on 127.0.0.1 and asks Chromium (CDP Page.getInstallabilityErrors) whether the current manifest is installable. Needs a built dist/.
// S4 lab: does Chromium 156 consider the current loader manifest installable? Serves dist/ on 127.0.0.1 only.
import http from 'node:http';
import { readFileSync, existsSync, statSync } from 'node:fs';
import { join, extname } from 'node:path';
import { resolve as __resolve, dirname as __dirname } from 'node:path';
import { fileURLToPath as __fu } from 'node:url';
const ROOT = __resolve(__dirname(__fu(import.meta.url)), '../../../..');
const { chromium } = await import(ROOT + '/node_modules/playwright/index.mjs');
const { CHROMIUM_LOCAL_ONLY_ARGS } = await import(ROOT + '/test/e2e/browser-args.mjs');
const DIST = join(ROOT, 'dist');
const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.webmanifest': 'application/manifest+json', '.svg': 'image/svg+xml' };
const server = http.createServer((req, res) => {
  let p = new URL(req.url, 'http://x').pathname; if (p === '/') p = '/index.html';
  const f = join(DIST, p);
  if (!f.startsWith(DIST) || !existsSync(f) || !statSync(f).isFile()) { res.writeHead(200, { 'content-type': 'text/html' }); return res.end(readFileSync(join(DIST, 'index.html'))); }
  res.writeHead(200, { 'content-type': types[extname(f)] || 'application/octet-stream', 'cache-control': 'no-cache' }); res.end(readFileSync(f));
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base = 'http://127.0.0.1:' + server.address().port + '/';
const b = await chromium.launch({ headless: true, args: CHROMIUM_LOCAL_ONLY_ARGS });
const ctx = await b.newContext(); const pg = await ctx.newPage();
const cdp = await ctx.newCDPSession(pg);
await pg.goto(base); await pg.waitForTimeout(1500);
const errs = await cdp.send('Page.getInstallabilityErrors');
const man = await cdp.send('Page.getAppManifest');
console.log('chromium', b.version());
console.log('installabilityErrors:', JSON.stringify(errs.installabilityErrors));
console.log('manifest errors:', JSON.stringify(man.errors));
console.log('manifest url:', man.url);
await b.close(); server.close(); process.exit(0);
