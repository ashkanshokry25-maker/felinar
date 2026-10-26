// Real-browser check of src/sw/sw.js + src/sdk/sdk.js in Playwright Chromium.
// Opt-in (MW_BROWSER=1) so `npm test` stays fast and never needs a browser:
//   MW_BROWSER=1 node --test test/unit/sw-browser.test.mjs
// It bundles sw.js with esbuild exactly like build.mjs (define placeholders), serves a throw-away
// shell from a temp dir WITHOUT SPA fallback, seeds IndexedDB the way cache.js does, and asserts
// routing, headers, ranges, redirects, 404s, hub mode, the SDK dual-serving, offline and deploys.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { CHROMIUM_LOCAL_ONLY_ARGS } from '../e2e/browser-args.mjs';

// integration-1 (2026-10-19): this file targets the v0.1 worker (/sw.js, /_mw/s/<btih>/ mounts, the export-free
// SDK form) and 12 of its 14 checks fail against the v0.2 worker. The v0.2 worker is exercised in Chromium by
// test/e2e/run.mjs (scenarios 1 to 7) and in Node by test/unit/sw-core.test.mjs. Kept, skipped, for the review
// phase to port or delete; MW_SW_BROWSER_V01=1 still runs it.
const ENABLED = process.env.MW_SW_BROWSER_V01 === '1';
const ROOT = new URL('../../', import.meta.url);
const BTIH = '0123456789abcdef0123456789abcdef01234567';
const PNG_1x1 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
const SHELL_V1 = '<!doctype html><meta charset="utf-8"><title>shell v1</title>' +
  '<script>navigator.serviceWorker.register("/sw.js")</script><p id="shell">shell v1</p>';
const SHELL = {
  'index.html': SHELL_V1,
  'boot.js': 'window.__boot = 1;',
  'loader.js': 'window.__loader = 1;',
  'pow-worker.js': '// worker v1',
  'webtorrent.min.js': '// wt v1',
  'ui.css': 'body{margin:0}',
  'manifest.webmanifest': '{"name":"mw"}',
};
const TYPES = { html: 'text/html; charset=utf-8', js: 'text/javascript', css: 'text/css', webmanifest: 'application/manifest+json' };

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test('service worker + SDK in Chromium', {
  skip: ENABLED ? false : 'targets the v0.1 worker; v0.2 is covered by test/e2e/run.mjs and sw-core.test.mjs (MW_SW_BROWSER_V01=1 runs it)',
  timeout: 180000,
}, async (t) => {
  const esbuild = await import('esbuild');
  const { chromium } = await import('playwright');
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'mw-sw-'));
  await esbuild.build({
    entryPoints: [path.join(ROOT.pathname, 'src/sw/sw.js')],
    bundle: true,
    format: 'iife',
    outfile: path.join(dir, 'sw.js'),
    define: { 'self.__BUILD_ID__': '"test1234"' },
    logLevel: 'silent',
  });
  await fs.copyFile(new URL('src/sdk/sdk.js', ROOT), path.join(dir, 'sdk.js'));
  for (const [name, body] of Object.entries(SHELL)) await fs.writeFile(path.join(dir, name), body);

  const server = http.createServer(async (req, res) => {
    const p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    const file = path.join(dir, p === '/' ? 'index.html' : p.slice(1));
    try {
      const data = await fs.readFile(file);
      res.writeHead(200, { 'Content-Type': TYPES[path.extname(file).slice(1)] || 'application/octet-stream', 'Cache-Control': 'no-store' });
      res.end(data);
    } catch (_) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('not found');
    }
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  const base = 'http://127.0.0.1:' + port;
  const browser = await chromium.launch({ args: CHROMIUM_LOCAL_ONLY_ARGS });
  t.after(async () => {
    await browser.close();
    server.close();
    server.closeAllConnections();
    await fs.rm(dir, { recursive: true, force: true });
  });
  const context = await browser.newContext();
  const page = await context.newPage();
  const pageErrors = [];
  page.on('pageerror', (e) => pageErrors.push(String(e)));

  await page.goto(base + '/');
  await page.evaluate(() => navigator.serviceWorker.ready.then(() => navigator.serviceWorker.controller
    ? null
    : new Promise((r) => navigator.serviceWorker.addEventListener('controllerchange', () => r()))));

  const get = (p, init) => page.evaluate(async ({ p, init }) => {
    const r = await fetch(p, init);
    const buf = new Uint8Array(await r.arrayBuffer());
    const headers = {};
    r.headers.forEach((v, k) => { headers[k] = v; });
    return { status: r.status, url: r.url, redirected: r.redirected, headers, text: new TextDecoder().decode(buf),
      length: buf.length, bytes: Array.from(buf.slice(0, 16)) };
  }, { p, init: init || {} });

  await t.test('install: shell precached under mw-shell-<BUILD_ID>', async () => {
    const info = await page.evaluate(async () => {
      const names = await caches.keys();
      const keys = await (await caches.open('mw-shell-test1234')).keys();
      return { names, paths: keys.map((r) => new URL(r.url).pathname).sort() };
    });
    assert.deepEqual(info.names, ['mw-shell-test1234']);
    assert.deepEqual(info.paths, ['/', '/boot.js', '/index.html', '/loader.js', '/manifest.webmanifest',
      '/pow-worker.js', '/sdk.js', '/ui.css', '/webtorrent.min.js']);
  });

  await t.test('first site request creates the shared DB schema and answers JSON 404', async () => {
    const r = await get('/_mw/s/' + BTIH + '/');
    assert.equal(r.status, 404);
    assert.match(r.headers['content-type'], /application\/json/);
    assert.deepEqual(JSON.parse(r.text), { error: 'not found', btih: BTIH, path: 'index.html' });
    const stores = await page.evaluate(() => new Promise((res, rej) => {
      const q = indexedDB.open('mw-sites');
      q.onsuccess = () => { const db = q.result; const n = Array.from(db.objectStoreNames).sort(); const v = db.version; db.close(); res({ n, v }); };
      q.onerror = () => rej(q.error);
    }));
    assert.deepEqual(stores, { n: ['files', 'identity', 'pins', 'pointers', 'prefs', 'sites'], v: 1 });
  });

  // Seed files the way cache.js does: key `${btih}/${site-relative path}` → Blob.
  await page.evaluate(async ({ btih, png }) => {
    const db = await new Promise((res, rej) => {
      const q = indexedDB.open('mw-sites', 1);
      q.onupgradeneeded = () => {
        for (const n of ['sites', 'files', 'pointers', 'pins', 'prefs', 'identity']) {
          if (!q.result.objectStoreNames.contains(n)) q.result.createObjectStore(n);
        }
      };
      q.onsuccess = () => res(q.result);
      q.onerror = () => rej(q.error);
    });
    const bin = new Uint8Array(1000);
    for (let i = 0; i < bin.length; i++) bin[i] = i % 256;
    const pngBytes = Uint8Array.from(atob(png), (c) => c.charCodeAt(0));
    const files = {
      'index.html': new Blob(['<!doctype html><html><head><meta charset="utf-8"><title>Peer Site</title>' +
        '<link rel="stylesheet" href="style.css"><script src="/_mw/sdk.js"></script>' +
        '<script type="module">import mw from "/_mw/sdk.js"; window.__modmw = mw;</script>' +
        '<script type="module" src="app.js"></script></head><body><h1 id="h">Hello</h1>' +
        '<img id="i" src="img.png"></body></html>'], { type: 'text/html' }),
      'style.css': new Blob(['h1{color:rgb(255, 0, 0)}'], { type: 'text/css' }),
      'app.js': new Blob(['window.__ran = true; fetch("data.json").then((r) => r.json()).then((j) => { window.__json = j; });']),
      'data.json': new Blob(['{"ok":true}'], { type: 'application/json' }),
      'img.png': new Blob([pngBytes], { type: 'image/png' }),
      'docs/index.html': new Blob(['DOCS']),
      'legal/index.html': new Blob(['LEGAL']),
      'about.html': new Blob(['ABOUT']),
      'media.bin': new Blob([bin]),
      '404.html': new Blob(['NOTFOUND']),
      'café.html': new Blob(['CAFE']),
      'LICENSE': new Blob(['MIT']),
      'typed.custom': new Blob(['X'], { type: 'application/x-custom' }),
    };
    await new Promise((res, rej) => {
      const tx = db.transaction('files', 'readwrite');
      const st = tx.objectStore('files');
      for (const [k, v] of Object.entries(files)) st.put(v, btih + '/' + k);
      tx.oncomplete = () => res();
      tx.onerror = () => rej(tx.error);
    });
    db.close();
  }, { btih: BTIH, png: PNG_1x1 });

  await t.test('site files: headers, directory rules, redirects, decoding, 404.html', async () => {
    const S = '/_mw/s/' + BTIH;
    let r = await get(S + '/');
    assert.equal(r.status, 200);
    assert.equal(r.headers['content-type'], 'text/html; charset=utf-8');
    assert.equal(r.headers['x-content-type-options'], 'nosniff');
    assert.equal(r.headers['accept-ranges'], 'bytes');
    assert.equal(r.headers['cache-control'], 'no-store');
    assert.equal(r.headers['content-length'], String(r.length));
    assert.equal(r.headers['content-security-policy'], undefined, 'no CSP sandbox outside hub mode');
    assert.match(r.text, /Peer Site/);

    r = await get(S);
    assert.equal(r.redirected, true, 'bare /_mw/s/<btih> redirects to the trailing slash');
    assert.ok(r.url.endsWith(S + '/'));
    assert.match(r.text, /Peer Site/);

    r = await get(S + '/docs');
    assert.equal(r.redirected, true);
    assert.ok(r.url.endsWith(S + '/docs/'), r.url);
    assert.equal(r.text, 'DOCS');
    r = await get(S + '/legal?x=1');
    assert.ok(r.url.endsWith(S + '/legal/?x=1'), 'query preserved on redirect: ' + r.url);
    assert.equal(r.text, 'LEGAL');
    r = await get(S + '/docs/');
    assert.equal(r.redirected, false);
    assert.equal(r.text, 'DOCS');

    r = await get(S + '/about');
    assert.equal(r.redirected, false);
    assert.equal(r.text, 'ABOUT');
    assert.equal(r.headers['content-type'], 'text/html; charset=utf-8');
    r = await get(S + '/LICENSE');
    assert.equal(r.text, 'MIT');
    assert.equal(r.headers['content-type'], 'application/octet-stream');
    r = await get(S + '/typed.custom');
    assert.equal(r.headers['content-type'], 'application/x-custom', 'Blob.type used when the extension is unknown');
    r = await get(S + '/caf%C3%A9.html');
    assert.equal(r.text, 'CAFE');
    r = await get(S + '/style.css');
    assert.equal(r.headers['content-type'], 'text/css; charset=utf-8');
    r = await get(S + '/img.png');
    assert.equal(r.headers['content-type'], 'image/png');
    assert.deepEqual(r.bytes.slice(0, 4), [0x89, 0x50, 0x4e, 0x47]);

    r = await get(S + '/missing.txt');
    assert.equal(r.status, 404);
    assert.equal(r.text, 'NOTFOUND');
    assert.equal(r.headers['content-type'], 'text/html; charset=utf-8');
    r = await get(S + '/nodir/');
    assert.equal(r.status, 404);
    assert.equal(r.text, 'NOTFOUND');
    r = await get('/_mw/s/' + BTIH.replace(/0/g, 'e') + '/index.html');
    assert.equal(r.status, 404);
    assert.deepEqual(JSON.parse(r.text).error, 'not found', 'unknown site → JSON 404 (no 404.html there)');
    r = await get('/_mw/reserved/thing');
    assert.equal(r.status, 404);
    assert.equal(JSON.parse(r.text).error, 'reserved path');
  });

  await t.test('Range requests by Blob slicing, HEAD', async () => {
    const M = '/_mw/s/' + BTIH + '/media.bin';
    let r = await get(M, { headers: { Range: 'bytes=10-19' } });
    assert.equal(r.status, 206);
    assert.equal(r.headers['content-range'], 'bytes 10-19/1000');
    assert.equal(r.headers['content-length'], '10');
    assert.equal(r.length, 10);
    assert.deepEqual(r.bytes.slice(0, 10), [10, 11, 12, 13, 14, 15, 16, 17, 18, 19]);
    r = await get(M, { headers: { Range: 'bytes=-5' } });
    assert.equal(r.status, 206);
    assert.equal(r.headers['content-range'], 'bytes 995-999/1000');
    assert.deepEqual(r.bytes.slice(0, 5), [995 % 256, 996 % 256, 997 % 256, 998 % 256, 999 % 256]);
    r = await get(M, { headers: { Range: 'bytes=990-' } });
    assert.equal(r.status, 206);
    assert.equal(r.headers['content-range'], 'bytes 990-999/1000');
    assert.equal(r.length, 10);
    r = await get(M, { headers: { Range: 'bytes=2000-' } });
    assert.equal(r.status, 416);
    assert.equal(r.headers['content-range'], 'bytes */1000');
    assert.equal(r.length, 0);
    r = await get(M, { headers: { Range: 'bytes=0-5,7-9' } });
    assert.equal(r.status, 200, 'multi-range → full body');
    assert.equal(r.length, 1000);
    r = await get(M, { method: 'HEAD' });
    assert.equal(r.status, 200);
    assert.equal(r.length, 0);
    assert.equal(r.headers['content-length'], '1000');
    assert.equal(r.headers['accept-ranges'], 'bytes');
  });

  await t.test('hub mode flag in prefs adds CSP sandbox + Referrer-Policy', async () => {
    const setPref = (value) => page.evaluate(({ btih, value }) => new Promise((res, rej) => {
      const q = indexedDB.open('mw-sites', 1);
      q.onsuccess = () => {
        const db = q.result;
        const tx = db.transaction('prefs', 'readwrite');
        if (value === null) tx.objectStore('prefs').delete('hubMode:' + btih);
        else tx.objectStore('prefs').put(value, 'hubMode:' + btih);
        tx.oncomplete = () => { db.close(); res(); };
        tx.onerror = () => rej(tx.error);
      };
      q.onerror = () => rej(q.error);
    }), { btih: BTIH, value });
    await setPref(true);
    let r = await get('/_mw/s/' + BTIH + '/about.html');
    assert.equal(r.headers['content-security-policy'],
      'sandbox allow-scripts allow-forms allow-same-origin allow-popups allow-modals');
    assert.equal(r.headers['referrer-policy'], 'no-referrer');
    await setPref(false);
    r = await get('/_mw/s/' + BTIH + '/about.html');
    assert.equal(r.headers['content-security-policy'], undefined);
    await setPref(null);
  });

  await t.test('/_mw/sdk.js: module form for cors fetches, export-free form for classic scripts', async () => {
    let r = await get('/_mw/sdk.js');
    assert.equal(r.status, 200);
    assert.equal(r.headers['content-type'], 'text/javascript; charset=utf-8');
    assert.equal(r.headers['x-content-type-options'], 'nosniff');
    assert.match(r.text, /export default mw;/);
    const moduleText = r.text;
    r = await get('/_mw/sdk.js', { mode: 'no-cors' });
    assert.equal(r.status, 200);
    assert.doesNotMatch(r.text, /^\s*export\b/m, 'no export statements left');
    assert.match(r.text, /globalThis\.mw = mw/);
    const parses = await page.evaluate((t) => { try { new Function(t); return true; } catch (e) { return String(e); } }, r.text);
    assert.equal(parses, true, 'the classic variant parses as a classic script');
    const moduleParses = await page.evaluate((t) => { try { new Function(t); return 'parsed'; } catch (e) { return e.name; } }, moduleText);
    assert.equal(moduleParses, 'SyntaxError', 'sanity: the module variant is NOT a classic script');
  });

  await t.test('a site rendered in an iframe: CSS, image, module JS, fetch(), SDK both ways', async () => {
    const out = await page.evaluate((btih) => new Promise((resolve, reject) => {
      const f = document.createElement('iframe');
      f.src = '/_mw/s/' + btih + '/';
      f.onload = async () => {
        try {
          const w = f.contentWindow;
          const d = f.contentDocument;
          for (let i = 0; i < 100 && !(w.__json && d.getElementById('i').complete); i++) await new Promise((r) => setTimeout(r, 50));
          resolve({
            title: d.title,
            color: w.getComputedStyle(d.getElementById('h')).color,
            imgWidth: d.getElementById('i').naturalWidth,
            ran: w.__ran === true,
            json: w.__json,
            classic: typeof w.mw,
            module: typeof w.__modmw,
            embedded: w.mw && w.mw.embedded,
          });
        } catch (e) { reject(e); }
      };
      document.body.appendChild(f);
    }), BTIH);
    assert.deepEqual(out, { title: 'Peer Site', color: 'rgb(255, 0, 0)', imgWidth: 1, ran: true, json: { ok: true },
      classic: 'object', module: 'object', embedded: true });
  });

  await t.test('message: mw-ping → mw-pong with the build id (port and client replies)', async () => {
    const viaPort = await page.evaluate(() => new Promise((res) => {
      const ch = new MessageChannel();
      ch.port1.onmessage = (e) => res(e.data);
      navigator.serviceWorker.controller.postMessage({ type: 'mw-ping' }, [ch.port2]);
    }));
    assert.deepEqual(viaPort, { type: 'mw-pong', buildId: 'test1234' });
    const viaClient = await page.evaluate(() => new Promise((res) => {
      navigator.serviceWorker.addEventListener('message', (e) => res(e.data), { once: true });
      navigator.serviceWorker.controller.postMessage({ type: 'mw-ping' });
    }));
    assert.deepEqual(viaClient, { type: 'mw-pong', buildId: 'test1234' });
  });

  await t.test('shell assets: cache-first; a deploy flips the shell to network-first', async () => {
    let r = await get('/boot.js');
    assert.equal(r.text, 'window.__boot = 1;');
    await fs.writeFile(path.join(dir, 'boot.js'), 'window.__boot = 2;');
    r = await get('/boot.js');
    assert.equal(r.text, 'window.__boot = 1;', 'still the cached copy (consistent with cached index.html)');
    // New deploy: index.html changes → navigation (network-first) notices → assets go network-first.
    await fs.writeFile(path.join(dir, 'index.html'), SHELL_V1.replace(/v1/g, 'v2'));
    await page.goto(base + '/');
    assert.equal(await page.textContent('#shell'), 'shell v2', 'navigation is network-first');
    let text = '';
    for (let i = 0; i < 40 && text !== 'window.__boot = 2;'; i++) {
      await sleep(100);
      text = (await get('/boot.js')).text;
    }
    assert.equal(text, 'window.__boot = 2;', 'after the deploy was detected, assets come from the network');
    const marker = await page.evaluate(async () => !!(await (await caches.open('mw-shell-test1234')).match('/_mw/__stale')));
    assert.equal(marker, true);
  });

  await t.test('navigation: deep links on a host without SPA fallback get the cached shell', async () => {
    const res = await page.goto(base + '/some/deep/link');
    assert.equal(res.status(), 200);
    assert.equal(await page.textContent('#shell'), 'shell v1', 'the cached shell (the old, internally consistent build)');
  });

  await t.test('offline: shell and site still render', async () => {
    server.close();
    server.closeAllConnections();
    try {
      let res = await page.goto(base + '/');
      assert.equal(res.status(), 200);
      assert.equal(await page.textContent('#shell'), 'shell v1');
      res = await page.goto(base + '/another/deep/link');
      assert.equal(res.status(), 200);
      assert.equal(await page.textContent('#shell'), 'shell v1');
      let r = await get('/_mw/s/' + BTIH + '/about');
      assert.equal(r.text, 'ABOUT');
      r = await get('/boot.js');
      assert.equal(r.text, 'window.__boot = 1;', 'network-first falls back to the cache offline');
      r = await get('/_mw/sdk.js');
      assert.equal(r.status, 200);
    } finally {
      await new Promise((r) => server.listen(port, '127.0.0.1', r));
    }
  });

  await t.test('offline with no cache at all: a 503 offline page, never a network error', async () => {
    const ctx2 = await browser.newContext();
    const p2 = await ctx2.newPage();
    await p2.goto(base + '/');
    await p2.evaluate(() => navigator.serviceWorker.ready.then(() => navigator.serviceWorker.controller
      ? null : new Promise((r) => navigator.serviceWorker.addEventListener('controllerchange', () => r()))));
    await p2.evaluate(async () => { for (const k of await caches.keys()) await caches.delete(k); });
    server.close();
    server.closeAllConnections();
    try {
      const res = await p2.goto(base + '/x');
      assert.equal(res.status(), 503);
      assert.match(await p2.textContent('h1'), /offline/i);
    } finally {
      await new Promise((r) => server.listen(port, '127.0.0.1', r));
      await ctx2.close();
    }
  });

  assert.deepEqual(pageErrors, [], 'no uncaught page errors');
});
