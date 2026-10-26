// Shared setup for the social example's browser tests: one loopback server, Chromium with the repository's local-only flags
// (test/e2e/browser-args.mjs) and, where installed, WebKit against http://127.0.0.1 only (docs/DEV-NETWORK.md). ASCII only; not a test file.
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import assert from 'node:assert/strict';
import { startSiteServer } from './serve.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
export const SITE = process.env.MW_SOCIAL_DIR ? resolve(process.env.MW_SOCIAL_DIR) : resolve(HERE, '../../examples/social');
const { chromiumArgs } = await import(pathToFileURL(resolve(HERE, '../e2e/browser-args.mjs')).href);
export let pw = null;
try { pw = await import('playwright'); } catch (err) { pw = null; }

export async function setup() {
  const srv = await startSiteServer({ site: SITE, spa: true });
  const chromium = await pw.chromium.launch({ args: chromiumArgs({ allowRemote: false }) });
  let webkit = null;
  try { webkit = await pw.webkit.launch(); } catch (err) { webkit = null; }
  return {
    srv, chromium, webkit,
    async close() { await chromium.close(); if (webkit) await webkit.close(); srv.server.close(); },
  };
}

/**
 * open(env, browser, path, scenario, opts) -> { context, page, problems }; waits until the app has drawn its first route.
 * opts.config: an object served as /config.json instead of the template's own (the operator settings, such as moderationContact).
 */
export async function open(env, browser, path, scenario, opts = {}) {
  const context = await browser.newContext(Object.assign({}, opts.device || { viewport: { width: opts.width || 1024, height: opts.height || 900 } }, opts.context || {}));
  const page = await context.newPage();
  const problems = [];
  page.on('pageerror', (e) => problems.push('pageerror: ' + e.message));
  page.on('console', (m) => { if (m.type() === 'error' && !/Failed to load resource|Importing a module script failed|the server responded with a status of 404/.test(m.text())) problems.push('console: ' + m.text()); });
  if (scenario) await page.addInitScript((s) => { globalThis.__mwScenario = s; }, scenario);
  if (opts.init) await page.addInitScript(opts.init);
  if (opts.blockSdk) await page.route('**/_mw/sdk.js', (route) => route.fulfill({ status: 404, contentType: 'text/plain', body: 'no loader here' }));
  if (opts.config) await page.route('**/config.json', (route) => route.fulfill({ contentType: 'application/json', body: JSON.stringify(opts.config) }));
  const response = await page.goto(env.srv.base + path);
  if (!opts.noWait) await page.waitForFunction(() => window.__social && window.__social.ctx && window.__social.ctx.route && document.querySelector('#view').children.length > 0, null, { timeout: 15000 });
  return { context, page, problems, response };
}
export const text = (page, sel) => page.locator(sel).first().textContent();
export const count = (page, sel) => page.locator(sel).count();
export const visible = (page, sel) => page.$eval(sel, (n) => !n.closest('[hidden]'));
export async function waitText(page, sel, expected, timeout = 6000) {
  try {
    await page.waitForFunction(([s, e]) => { const n = document.querySelector(s); return !!n && n.textContent === e; }, [sel, expected], { timeout });
  } catch (err) {
    assert.equal(await page.$eval(sel, (n) => n.textContent).catch(() => '(no ' + sel + ')'), expected, 'waiting for ' + sel);
  }
}
// waitForFunction rejects at once when its predicate throws, and a predicate that reads a node that is not there yet throws: the page is
// still being drawn. The predicate is run inside a guard, so "not yet" is false and the wait goes on.
export async function waitFor(page, fn, arg, timeout = 6000) {
  return page.waitForFunction(([src, a]) => {
    try {
      const r = (0, eval)('(' + src + ')')(a); // eslint-disable-line no-eval
      return r && typeof r.then === 'function' ? r.catch(() => false) : r;
    } catch (err) { return false; }
  }, [fn.toString(), arg], { timeout });
}
export const calls = (page, name) => page.evaluate((n) => __mwMock.calls.filter((c) => c[0] === n), name);
/** quiet(page, ms): resolves once the app's data has not changed for ms (a redraw in the middle of a two-tap button would unarm it). */
export async function quiet(page, ms = 450) {
  let v = await page.evaluate(() => window.__social.ctx.data.version);
  for (let i = 0; i < 40; i++) {
    await page.waitForTimeout(ms);
    const n = await page.evaluate(() => window.__social.ctx.data.version);
    if (n === v) return;
    v = n;
  }
}
export const body = (page, sel) => page.locator(sel || '#view').first().innerText();
/** goto(page, href): follow an in-app link or path the way a person does, and wait for the route to be drawn. */
export async function go(page, href) {
  await page.evaluate((h) => window.__social.ctx.go(h), href);
  await page.waitForFunction((h) => window.__social.ctx.route && location.pathname + location.search + location.hash === h, href, { timeout: 8000 });
  await page.waitForTimeout(120);
}
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
export const pngFile = (name = 'door.png') => ({ name, mimeType: 'image/png', buffer: png });
