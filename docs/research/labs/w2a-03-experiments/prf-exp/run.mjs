import { chromium } from '$HOME/Documents/Projects/magnet-web/node_modules/playwright/index.mjs';
import { spawn } from 'node:child_process';
const server = spawn(process.execPath, [new URL('./server.mjs', import.meta.url).pathname], { stdio: ['ignore', 'pipe', 'inherit'] });
const port = await new Promise((res) => server.stdout.on('data', (d) => { const m = /PORT (\d+)/.exec(String(d)); if (m) res(m[1]); }));
const base = `http://localhost:${port}`;
const browser = await chromium.launch({ headless: true });
console.log('browser', browser.version());
async function run(label, url, { iframeSel } = {}) {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  const cdp = await ctx.newCDPSession(page);
  await cdp.send('WebAuthn.enable');
  const { authenticatorId } = await cdp.send('WebAuthn.addVirtualAuthenticator', { options: { protocol: 'ctap2', ctap2Version: 'ctap2_1', transport: 'internal', hasResidentKey: true, hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true, hasPrf: true } });
  page.on('pageerror', (e) => console.log('pageerror', e.message));
  await page.goto(url);
  let frame = page;
  if (iframeSel) { await page.waitForSelector(iframeSel); const el = await page.$(iframeSel); frame = await el.contentFrame(); }
  let result;
  try {
    await frame.waitForFunction(() => window.__result, null, { timeout: 15000 });
    result = await frame.evaluate(() => window.__result);
  } catch (e) { result = { harnessError: String(e).slice(0, 300) }; }
  console.log('=== ' + label + '\n' + JSON.stringify(result, null, 1));
  await ctx.close();
}
await run('top-level page (baseline)', base + '/top');
await run('SW-served iframe, sandbox="allow-scripts allow-same-origin ..." (magnet-web design)', base + '/?mode=same', { iframeSel: '#site' });
await run('SW-served iframe, sandbox without allow-same-origin (opaque origin)', base + '/?mode=opaque', { iframeSel: '#site' });
await browser.close();
server.kill();
