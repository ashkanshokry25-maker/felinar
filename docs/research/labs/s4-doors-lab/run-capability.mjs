// Usage: node run-capability.mjs [chromium,webkit,firefox]   (default: all three; Firefox does not launch under Playwright on this Mac)
// Writes JSON to stdout. Behind docs/research/v03/S4-doors.md finding F9 and the sandboxed-frame rows of F2.
// S4 lab: what a page can do at file://, data:, a sandboxed (opaque) frame and a localhost baseline.
// LOCAL ONLY: every URL is http://127.0.0.1:<port>/, file:// or data:. Playwright Chromium uses the project's local-only args.
import http from 'node:http';
import { readFileSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
const { chromium, webkit, firefox } = await import(ROOT + '/node_modules/playwright/index.mjs');
const { CHROMIUM_LOCAL_ONLY_ARGS } = await import(ROOT + '/test/e2e/browser-args.mjs');
const { WebSocketServer } = await import(ROOT + '/node_modules/ws/wrapper.mjs');
const HERE = dirname(fileURLToPath(import.meta.url));
const probeSrc = readFileSync(join(HERE, 'probe.js'), 'utf8');
const TMP = mkdtempSync(join(tmpdir(), 's4-doors-'));
const only = process.argv[2] ? process.argv[2].split(',') : ['chromium', 'webkit', 'firefox'];

const wsSeen = [];
const reqLog = [];
const server = http.createServer((req, res) => {
  reqLog.push({ url: req.url, origin: req.headers.origin || '-', site: req.headers['sec-fetch-site'] || '-' });
  const u = new URL(req.url, 'http://x');
  if (u.pathname === '/sw.js') { res.writeHead(200, { 'content-type': 'text/javascript' }); return res.end("self.addEventListener('fetch',()=>{})"); }
  if (u.pathname === '/cors.json') { res.writeHead(200, { 'content-type': 'application/json', 'access-control-allow-origin': '*' }); return res.end('{"ok":true}'); }
  if (u.pathname === '/base.html') { res.writeHead(200, { 'content-type': 'text/html' }); return res.end(page(cfgFor('http'))); }
  if (u.pathname === '/sandbox.html') { res.writeHead(200, { 'content-type': 'text/html' }); return res.end(sandboxParent()); }
  if (u.pathname === '/nav.html') { res.writeHead(200, { 'content-type': 'text/html' }); return res.end('<!doctype html><title>nav</title><a id="a" href="data:text/html,%3Ch1%3Ehi%3C/h1%3E" target="_blank">x</a>'); }
  res.writeHead(404); res.end('no');
});
const wss = new WebSocketServer({ noServer: true });
server.on('upgrade', (req, sock, head) => { wsSeen.push({ origin: req.headers.origin === undefined ? '(none)' : req.headers.origin, path: req.url }); wss.handleUpgrade(req, sock, head, (ws) => ws.close()); });
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const PORT = server.address().port;
const BASE = 'http://127.0.0.1:' + PORT;

function cfgFor(kind) {
  const c = { wsUrl: 'ws://127.0.0.1:' + PORT + '/ws', corsUrl: BASE + '/cors.json' };
  if (kind === 'http') { c.swUrl = '/sw.js'; c.swScope = '/'; }
  else if (kind === 'file') { c.swUrl = pathToFileURL(join(TMP, 'sw.js')).href; c.swScope = pathToFileURL(TMP + '/').href; }
  else { c.swUrl = 'data:text/javascript,1'; c.swScope = undefined; }
  return c;
}
function page(cfg) {
  return '<!doctype html><meta charset="utf-8"><title>probe</title><script>' + probeSrc + '\nrunProbe(' + JSON.stringify(cfg) + ').then(function(r){window.__result=r;},function(e){window.__result={fatal:String(e)};});</script>';
}
function sandboxParent() {
  const inner = page(cfgFor('data')).replace('window.__result=r;', "parent.postMessage({s4:r},'*');").replace('window.__result={fatal:String(e)};', "parent.postMessage({s4:{fatal:String(e)}},'*');");
  const esc = inner.replace(/&/g, '&amp;').replace(/"/g, '&quot;');
  return '<!doctype html><title>sbx</title><script>addEventListener("message",function(e){if(e.data&&e.data.s4)window.__result=e.data.s4;});</script><iframe sandbox="allow-scripts" srcdoc="' + esc + '"></iframe>';
}
writeFileSync(join(TMP, 'sw.js'), "self.addEventListener('fetch',()=>{})");
writeFileSync(join(TMP, 'file.html'), page(cfgFor('file')));

const launchers = {
  chromium: () => chromium.launch({ headless: true, args: CHROMIUM_LOCAL_ONLY_ARGS }),
  webkit: () => webkit.launch({ headless: true }),
  firefox: () => firefox.launch({ headless: true }), // fails on this Mac: "Could not find profile folder" (same as docs/research/labs/w1-09-lab)
};
const results = {};
for (const name of only) {
  const entry = results[name] = {};
  let browser;
  try { browser = await launchers[name](); } catch (e) { entry.launchError = String(e.message || e).split('\n').slice(0, 3).join(' | '); continue; }
  entry.version = browser.version();
  const grab = async (label, nav) => {
    const ctx = await browser.newContext();
    const pg = await ctx.newPage();
    try {
      await nav(pg);
      await pg.waitForFunction(() => window.__result, null, { timeout: 45000 });
      entry[label] = await pg.evaluate(() => window.__result);
    } catch (e) { entry[label] = { navError: String(e.message || e).split('\n')[0].slice(0, 140) }; }
    await ctx.close();
  };
  await grab('http_localhost', (pg) => pg.goto(BASE + '/base.html'));
  await grab('file_url', (pg) => pg.goto(pathToFileURL(join(TMP, 'file.html')).href));
  await grab('data_url_goto', (pg) => pg.goto('data:text/html;base64,' + Buffer.from(page(cfgFor('data'))).toString('base64')));
  await grab('sandbox_allow_scripts_iframe', (pg) => pg.goto(BASE + '/sandbox.html'));
  // top-level navigation to data: started by page script (not by the browser UI)
  {
    const ctx = await browser.newContext();
    const pg = await ctx.newPage();
    const r = {};
    try {
      await pg.goto(BASE + '/nav.html');
      await pg.evaluate(() => { try { location.href = 'data:text/html,%3Ch1%3Ehi%3C/h1%3E'; } catch (e) {} });
      await pg.waitForTimeout(900);
      r.script_location_href_to_data = pg.url().startsWith('data:') ? 'NAVIGATED' : 'blocked (url stays ' + pg.url().slice(0, 30) + ')';
      await pg.goto(BASE + '/nav.html');
      const popupP = ctx.waitForEvent('page', { timeout: 1500 }).catch(() => null);
      await pg.click('#a');
      const pop = await popupP;
      if (pop) { await pop.waitForTimeout(500); r.anchor_target_blank_to_data = pop.url().startsWith('data:') ? 'NAVIGATED' : 'blocked (popup url ' + pop.url().slice(0, 20) + ')'; }
      else r.anchor_target_blank_to_data = 'no popup';
    } catch (e) { r.error = String(e.message || e).split('\n')[0]; }
    entry.data_nav_from_page_script = r;
    await ctx.close();
  }
  await browser.close();
}
results.wsServerSawOrigins = wsSeen;
console.log(JSON.stringify(results, null, 1));
server.close();
process.exit(0);
