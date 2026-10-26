// What does <base href="/base/"> change? Page lives at /app/page.html ; module lives at /elsewhere/mod.mjs
import http from 'node:http';
import { pathToFileURL } from 'node:url';
const _pw = await import(new URL('../../../../../node_modules/playwright/index.mjs', import.meta.url).href);
const chromium = _pw[process.env.ENGINE || 'chromium'];
const seen = [];
const T = { js: 'text/javascript', mjs: 'text/javascript', css: 'text/css', json: 'application/json', png: 'image/png', html: 'text/html; charset=utf-8', txt: 'text/plain' };
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');
const page = `<!doctype html><meta charset=utf-8><title>t</title>
<base href="/base/">
<link rel="stylesheet" href="rel.css">
<link rel="modulepreload" href="pre.mjs">
<style>body{background:url(inline-bg.png)} @font-face{font-family:Q;src:url(inline-font.woff2)}</style>
<script type="importmap">{"imports":{"mapped":"./mapped.mjs"}}</script>
<body>
<img id=img src="rel.png"><img id=img2 srcset="rel2.png 1x">
<a id=frag href="#frag">frag</a> <a id=relA href="rel-page.html">rel</a>
<form id=form action="submit" method=get><button id=go>go</button></form>
<svg width=20 height=20><defs><symbol id=sym viewBox="0 0 10 10"><rect width=10 height=10 fill=blue /></symbol><linearGradient id=grad><stop offset=0 stop-color=red /></linearGradient></defs><use id=use href="#sym" /></svg>
<svg width=20 height=20><rect id=fillrect width=20 height=20 fill="url(#grad)" /></svg>
<iframe id=ifr src="rel-frame.html" width=10 height=10></iframe>
<script type="module" src="/elsewhere/mod.mjs"></script>
</body>`;
const mod = `import { dep } from './dep.mjs';
import mapped from 'mapped';
const out = { baseURI: document.baseURI, docURL: location.pathname, importMetaUrl: import.meta.url.replace(location.origin, '') };
const rec = async (k, f) => { try { out[k] = await f(); } catch (e) { out[k] = 'ERR ' + e.message; } };
out.staticImportDep = dep; out.importMap = mapped;
await rec('dynamicImport', async () => (await import('./dyn.mjs')).where);
await rec('fetchRel', async () => (await (await fetch('f.json')).json()).where);
await rec('newURLimportMeta', async () => new URL('./u.txt', import.meta.url).pathname);
await rec('newURLbaseURI', async () => new URL('u.txt', document.baseURI).pathname);
await rec('newURLlocation', async () => new URL('u.txt', location.href).pathname);
await rec('workerRel', () => new Promise((res, rej) => { const w = new Worker('w.js'); w.onmessage = (e) => { res(e.data); w.terminate(); }; w.onerror = () => rej(new Error('load failed')); }));
await rec('workerImportMetaUrl', () => new Promise((res, rej) => { const w = new Worker(new URL('w2.js', import.meta.url)); w.onmessage = (e) => { res(e.data); w.terminate(); }; w.onerror = () => rej(new Error('load failed')); }));
history.pushState({}, '', 'pushed'); out.pushStateRel = location.pathname; history.replaceState({}, '', location.pathname.replace('pushed', 'page.html'));
out.fragAnchorHref = document.getElementById('frag').href.replace(location.origin, '');
out.imgSrc = document.getElementById('img').src.replace(location.origin, '');
out.formAction = document.getElementById('form').action.replace(location.origin, '');
out.sheets = [...document.styleSheets].map((s) => (s.href || 'inline').replace(location.origin, ''));
window.__out = out;
`;
const srv = http.createServer((q, r) => {
  const p = new URL(q.url, 'http://x').pathname; seen.push({ p, dest: q.headers['sec-fetch-dest'] || '' });
  const send = (c, t, b) => { r.writeHead(c, { 'content-type': t }); r.end(b); };
  if (p === '/app/page.html') return send(200, T.html, page);
  if (p === '/elsewhere/mod.mjs') return send(200, T.mjs, mod);
  if (p.endsWith('dep.mjs')) return send(200, T.mjs, 'export const dep = ' + JSON.stringify(p) + ';');
  if (p.endsWith('mapped.mjs')) return send(200, T.mjs, 'export default ' + JSON.stringify(p) + ';');
  if (p.endsWith('dyn.mjs')) return send(200, T.mjs, 'export const where = ' + JSON.stringify(p) + ';');
  if (p.endsWith('pre.mjs')) return send(200, T.mjs, 'export const x = 1;');
  if (p.endsWith('f.json')) return send(200, T.json, JSON.stringify({ where: p }));
  if (p.endsWith('/w.js')) return send(200, T.js, 'importScripts("imp.js"); postMessage({ where: self.location.pathname, imp: self.__imp });');
  if (p.endsWith('/w2.js')) return send(200, T.js, 'importScripts("imp.js"); postMessage({ where: self.location.pathname, imp: self.__imp });');
  if (p.endsWith('imp.js')) return send(200, T.js, 'self.__imp = ' + JSON.stringify(p) + ';');
  if (p.endsWith('.css')) return send(200, T.css, 'body{margin:0}');
  if (p.endsWith('.png')) return send(200, T.png, PNG);
  if (p.endsWith('.html')) return send(200, T.html, '<!doctype html><title>' + p + '</title>');
  send(404, T.txt, 'nf ' + p);
});
await new Promise((r) => srv.listen(0, '127.0.0.1', r));
const url = 'http://127.0.0.1:' + srv.address().port;
const browser = await chromium.launch(); const ctx = await browser.newContext(); const pg = await ctx.newPage();
for (let i = 0; i < 6; i++) { try { await pg.goto(url + '/app/page.html'); break; } catch (e) { await new Promise((r) => setTimeout(r, 2000)); } }
await pg.waitForFunction(() => window.__out, null, { timeout: 15000 });
await new Promise((r) => setTimeout(r, 1500));
const out = await pg.evaluate(() => window.__out);
console.log(JSON.stringify(out, null, 1));
console.log('\n== requests observed (path, sec-fetch-dest), excluding the page itself');
const interesting = seen.filter((s) => s.p !== '/app/page.html'); console.log(interesting.map((s) => (s.dest || '-').padEnd(12) + s.p).join('\n'));
// fragment link click and form submit behaviour
await pg.click('#frag').catch(() => {}); await new Promise((r) => setTimeout(r, 800));
console.log('\nafter clicking <a href="#frag">: location =', await pg.evaluate(() => location.pathname + location.hash), '| title =', await pg.title());
await browser.close(); srv.close();
