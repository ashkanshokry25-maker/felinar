// The door view of the doors lane in real browsers (v0.3 C2, docs/research/v03/S4-doors.md D4), moved here from
// loader-doors.test.mjs by the C2 integrator so that `npm run test:browser` (tools/run-unit.mjs --browser) runs it. Opt-in like
// the other *-browser tests: MW_BROWSER=1 node --test test/unit/loader-doors-browser.test.mjs. Chromium runs with chromiumArgs()
// (local-only), WebKit loads only http://127.0.0.1 pages (docs/DEV-NETWORK.md).
import { test } from 'node:test';
import assert from 'node:assert/strict';

const BROWSER = process.env.MW_BROWSER === '1';

test('door view in Chromium and WebKit: the site renders in an opaque origin, CSS, images, scripts and a module cycle work, storage does not', { skip: !BROWSER ? 'set MW_BROWSER=1 (Chromium with the local-only flags and WebKit, on 127.0.0.1)' : false, timeout: 180000 }, async () => {
  const http = await import('node:http');
  const { chromium, webkit } = await import('playwright');
  const { chromiumArgs } = await import('../e2e/browser-args.mjs');
  const esbuild = await import('esbuild');
  const { cspString } = await import('../../src/loader/render.js');
  const ROOT = new URL('../../', import.meta.url).pathname;
  const bundle = async (contents, format) => (await esbuild.build({ stdin: { contents, resolveDir: ROOT, loader: 'js' }, bundle: true, write: false, format, platform: 'browser', target: ['es2020'] })).outputFiles[0].text;
  const harness = await bundle("import { mountDoorView } from './src/loader/doors.js'; window.__mountDoorView = mountDoorView;", 'iife');
  const frame = await bundle("import { frameMain } from './src/loader/doors.js'; frameMain(self);", 'iife');
  const site = {
    'index.html': '<!doctype html><html><head><title>Door Home</title><link rel="stylesheet" href="css/app.css"><script src="js/classic.js"></script></head><body><h1 id="h">Home</h1><img id="img" src="img/a.svg"><a id="next" href="page2.html">next</a><script type="module" src="js/mod.js"></script></body></html>',
    'page2.html': '<!doctype html><title>Page Two</title><h1 id="h">Two</h1>',
    'css/app.css': '@import "base.css"; h1 { color: rgb(1, 2, 3) }',
    'css/base.css': 'body { background-color: rgb(4, 5, 6) }',
    'img/a.svg': '<svg xmlns="http://www.w3.org/2000/svg" width="7" height="5"></svg>',
    'js/classic.js': 'window.__classic = 1',
    'js/mod.js': 'import { dep } from "./dep.js"; export const mod = 1; window.__module = dep() + 1;',
    'js/dep.js': 'import { mod } from "./mod.js"; export function dep () { return 41 }',
  };
  const run = 'window.__mountDoorView({ container: document.body, files: new Map(Object.entries(' + JSON.stringify(site) + ').map(([p, t]) => [p, new Blob([t])])), frameScript: ' + JSON.stringify(frame) + ', base: location.origin + "/" }).then((m) => { window.__m = m; window.__ready = m.rendered })';
  const server = http.createServer((req, res) => {
    if (req.url === '/door.html') { res.writeHead(200, { 'content-type': 'text/html' }); return res.end('<!doctype html><meta charset=utf-8><meta http-equiv="Content-Security-Policy" content="' + cspString('degraded', { dev: true }) + '"><body></body><script src="/h.js"></script><script src="/run.js"></script>') }
    if (req.url === '/h.js') { res.writeHead(200, { 'content-type': 'text/javascript' }); return res.end(harness) }
    if (req.url === '/run.js') { res.writeHead(200, { 'content-type': 'text/javascript' }); return res.end(run) }
    res.writeHead(404); res.end();
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = 'http://127.0.0.1:' + server.address().port;
  try {
    for (const [name, launch] of [['chromium', () => chromium.launch({ headless: true, args: chromiumArgs() })], ['webkit', () => webkit.launch({ headless: true })]]) {
      const browser = await launch();
      try {
        const page = await (await browser.newContext()).newPage();
        await page.goto(base + '/door.html');
        await page.waitForFunction(() => window.__ready === true, null, { timeout: 15000 });
        const fr = page.frames().find((f) => f !== page.mainFrame());
        const inside = await fr.evaluate(() => {
          const s = (fn) => { try { return fn() } catch (e) { return 'THROWS ' + e.name } };
          return { origin: String(window.origin), h1: getComputedStyle(document.getElementById('h')).color, bg: getComputedStyle(document.body).backgroundColor, img: document.getElementById('img').naturalWidth, classic: window.__classic, module: window.__module, door: window.__mwDoor, ls: s(() => localStorage.length), sw: s(() => typeof navigator.serviceWorker) };
        });
        assert.deepEqual(inside, { origin: 'null', h1: 'rgb(1, 2, 3)', bg: 'rgb(4, 5, 6)', img: 7, classic: 1, module: 42, door: true, ls: 'THROWS SecurityError', sw: 'THROWS SecurityError' }, name);
        await fr.click('#next');
        await page.waitForFunction(() => window.__m.currentPath() === '/page2.html', null, { timeout: 10000 });
        await page.waitForTimeout(300);
        const fr2 = page.frames().find((f) => f !== page.mainFrame());
        assert.equal(await fr2.evaluate(() => document.title), 'Page Two', name);
      } finally {
        await browser.close();
      }
    }
  } finally {
    server.close();
  }
});
