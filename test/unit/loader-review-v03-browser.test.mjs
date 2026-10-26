// Code review v0.3 (browser, loader-sw fixer): on a phone the signed-in header is shown once and then folds into a
// 44 px corner chip, so the site's own controls at the bottom of the screen get the person's taps again; a tap on the
// chip opens the header. Real engines at 390 x 844 with touch (opt-in like the other *-browser tests):
//   MW_BROWSER=1 node --test test/unit/loader-review-v03-browser.test.mjs
// Network policy (docs/DEV-NETWORK.md): the server binds 127.0.0.1 and every page is http://127.0.0.1:<port>; Chromium
// runs with chromiumArgs().
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join, normalize, extname, sep } from 'node:path';
import { chromiumArgs } from '../e2e/browser-args.mjs';

const ENABLED = process.env.MW_BROWSER === '1';
const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const SRC = join(ROOT, 'src') + sep;

const PAGE = `
import { createCards } from '/src/loader/ui.js';
const site = document.getElementById('site');
window.__siteTaps = 0;
site.addEventListener('click', () => { window.__siteTaps++; });
const cards = createCards({ win: window, doc: document, lang: 'en', headerFoldMs: 400 });
cards.setIdentityHeader({ name: 'Ana', short: 'k3f9-2xq1', pub: 'p256:abc', unlock: 'passkey', backup: false }, {});
window.__cards = cards;
const host = () => document.querySelector('[data-mw-ui-cards]');
window.__at = (x, y) => { const el = document.elementFromPoint(x, y); return el === site ? 'site' : el === host() ? 'loader' : (el ? el.tagName : null); };
// The chip is the only part of the loader that takes taps once the header folded: find it from outside its closed root.
window.__chip = () => {
  for (let y = innerHeight - 1; y > innerHeight - 160; y -= 2) for (let x = innerWidth - 1; x > innerWidth - 160; x -= 2) if (document.elementFromPoint(x, y) === host()) return { x, y };
  return null;
};
window.__ready = true;
`;

function startServer() {
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    if (url.pathname === '/') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
      res.end('<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>header</title>' +
        '<body style="margin:0"><button id="site" style="position:fixed;left:0;right:0;bottom:0;height:120px;width:100%">Post</button>' +
        '<script type="module" src="/page.js"></script></body>');
      return;
    }
    if (url.pathname === '/page.js') {
      res.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8', 'cache-control': 'no-store' });
      res.end(PAGE);
      return;
    }
    const file = normalize(join(ROOT, decodeURIComponent(url.pathname)));
    if (!file.startsWith(SRC) || extname(file) !== '.js') {
      res.writeHead(404);
      res.end();
      return;
    }
    try {
      const body = await readFile(file);
      res.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8', 'cache-control': 'no-store' });
      res.end(body);
    } catch (_) {
      res.writeHead(404);
      res.end();
    }
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port })));
}

test('a phone at 390 x 844: the signed-in header folds into a 44 px chip and the site\'s bottom controls take taps again (Chromium, WebKit)', {
  skip: ENABLED ? false : 'set MW_BROWSER=1 to run (needs Playwright browsers)',
  timeout: 180000,
}, async (t) => {
  const playwright = await import('playwright');
  const { server, port } = await startServer();
  t.after(() => { server.close(); server.closeAllConnections(); });
  let engines = 0;
  for (const name of ['chromium', 'webkit']) {
    let browser;
    try {
      browser = await playwright[name].launch(name === 'chromium' ? { args: chromiumArgs() } : {});
    } catch (err) {
      t.diagnostic(name + ': not available (' + String(err.message).split('\n')[0] + ')');
      continue;
    }
    engines++;
    try {
      const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true });
      const page = await ctx.newPage();
      const errors = [];
      page.on('pageerror', (e) => errors.push(String(e)));
      await page.goto('http://127.0.0.1:' + port + '/');
      await page.waitForFunction(() => window.__ready === true, null, { timeout: 30000 });
      const x = 195;
      const y = 844 - 40;
      assert.equal(await page.evaluate(() => window.__cards.headerState), 'full', name + ': shown once after sign-in');
      assert.equal(await page.evaluate(([a, b]) => window.__at(a, b), [x, y]), 'loader', name + ': while shown, the header covers the bottom');
      await page.waitForFunction(() => window.__cards.headerState === 'folded', null, { timeout: 10000 });
      assert.equal(await page.evaluate(([a, b]) => window.__at(a, b), [x, y]), 'site', name + ': folded, the site is under the finger again');
      await page.touchscreen.tap(x, y);
      await page.waitForFunction(() => window.__siteTaps === 1, null, { timeout: 5000 });
      const chip = await page.evaluate(() => window.__chip());
      assert.ok(chip, name + ': the chip is on screen');
      assert.ok(chip.x > 390 - 80 && chip.y > 844 - 120, name + ': in the bottom corner (' + chip.x + ', ' + chip.y + ')');
      await page.touchscreen.tap(chip.x, chip.y);
      await page.waitForFunction(() => window.__cards.headerState === 'full', null, { timeout: 5000 });
      assert.equal(await page.evaluate(() => window.__siteTaps), 1, name + ': the chip tap did not reach the site');
      await page.waitForFunction(() => window.__cards.headerState === 'folded', null, { timeout: 10000 });
      assert.deepEqual(errors, [], name);
      t.diagnostic(name + ' ' + browser.version() + ': header folded, site tap at (' + x + ', ' + y + ') delivered, chip at (' + chip.x + ', ' + chip.y + ') opens the header');
      await ctx.close();
    } finally {
      await browser.close();
    }
  }
  assert.ok(engines > 0, 'at least one browser engine ran');
});
