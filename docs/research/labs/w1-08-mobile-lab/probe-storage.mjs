// usage: [ENGINE=webkit PW_WEBKIT_EXE=...] node probe-storage.mjs [persistent]
// Runs www/probe-storage.html from 127.0.0.1 in an ephemeral context (default) or a persistent context (arg "persistent").
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, webkit, firefox } from '../../../../node_modules/playwright/index.mjs';
import { ENGINE } from './lab-browsers.mjs';
const here = path.dirname(fileURLToPath(import.meta.url));
const srv = http.createServer((req, res) => { const u = req.url.split('?')[0]; if (u === '/probe.html') { res.writeHead(200, { 'content-type': 'text/html' }); return res.end(fs.readFileSync(path.join(here, 'www/probe-storage.html'))); } res.writeHead(404); res.end(); }).listen(0, '127.0.0.1');
await new Promise(r => srv.once('listening', r));
const url = 'http://127.0.0.1:' + srv.address().port + '/probe.html';
const type = { chromium, webkit, firefox }[ENGINE];
const exe = ENGINE === 'webkit' ? process.env.PW_WEBKIT_EXE : ENGINE === 'firefox' ? process.env.PW_FIREFOX_EXE : undefined;
const persistent = process.argv[2] === 'persistent';
let ctx, browser;
if (persistent) { const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'probe-profile-')); ctx = await type.launchPersistentContext(dir, { headless: true, executablePath: exe || undefined }); }
else { browser = await type.launch({ headless: true, executablePath: exe || undefined }); ctx = await browser.newContext(); }
const page = ctx.pages()[0] || await ctx.newPage();
await page.goto(url);
await page.waitForFunction(() => window.__result, null, { timeout: 60000 });
const r = await page.evaluate(() => window.__result);
console.log('# engine:', ENGINE, (browser ? browser.version() : ''), persistent ? '(persistent context)' : '(ephemeral context)');
console.log('# ua:', r.env.ua, '| isSecureContext:', r.env.secure);
for (const [k, v] of Object.entries(r.tests)) console.log((v.ok ? 'OK   ' : 'FAIL ') + k.padEnd(58) + ' ' + JSON.stringify(v.ok ? v.v : v.err));
await ctx.close(); if (browser) await browser.close(); srv.close();
