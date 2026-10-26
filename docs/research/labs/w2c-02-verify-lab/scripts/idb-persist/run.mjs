// args: <browser> <port> <label>   -> runs ephemeral, then persistent write + (fresh process) persistent read
import { chromium, webkit } from '$HOME/Documents/Projects/magnet-web/node_modules/playwright/index.mjs';
import { mkdtemp } from 'node:fs/promises'; import { tmpdir } from 'node:os'; import { join } from 'node:path';
const [,, which, port, dur = 'default'] = process.argv; const bt = { chromium, webkit }[which];
const base = `http://127.0.0.1:${port}/`; const res = { browser: which };
async function evalPage(page, url) { await page.goto(url); await page.waitForFunction(() => window.__RESULT, null, { timeout: 300000 }); return page.evaluate(() => window.__RESULT); }
// 1) ephemeral (what the original bench did: browser.newPage())
{ const b = await bt.launch({ headless: true }); const pg = await b.newPage(); res.ephemeralWrite = await evalPage(pg, `${base}?phase=write&dur=${dur}`); res.ephemeralReadSameCtx = await evalPage(pg, `${base}?phase=read`); res.version = b.version(); await b.close(); }
// 2) persistent on-disk profile, write, close, relaunch in a fresh browser process, read
const dir = await mkdtemp(join(tmpdir(), 'pw-persist-'));
{ const c = await bt.launchPersistentContext(dir, { headless: true }); const pg = c.pages()[0] || await c.newPage(); res.persistentWrite = await evalPage(pg, `${base}?phase=write&dur=${dur}`); await c.close(); }
{ const c = await bt.launchPersistentContext(dir, { headless: true }); const pg = c.pages()[0] || await c.newPage(); res.persistentColdRead = await evalPage(pg, `${base}?phase=read`); await c.close(); }
console.log(JSON.stringify(res));
