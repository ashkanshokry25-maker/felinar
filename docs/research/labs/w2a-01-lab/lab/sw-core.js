// Lab Service Worker: three serving strategies for a P2P-delivered site.
//   prefix : site lives ONLY under /_mw/s/<btih>/...   (current magnet-web design)
//   remap  : prefix + root-absolute requests from site clients are remapped into the prefix (patch of current design)
//   true   : same-URL dispatch (research 04 R2): navigation destination 'document' -> shell, 'iframe' -> site; subresources by client
const MODE = '__MODE__';
const SPA = __SPA__;
const SITE_BASE = '__BASE__';  // URL prefix the site was BUILT for (e.g. '/repo/'); stripped before file lookup (true mode)
const BTIH = 'a'.repeat(40);
const PREFIX = '/_mw/s/' + BTIH + '/';
const SHELL_ASSETS = new Set(['/', '/shell.js', '/sw.js']);
const SITE_CACHE = 'site-v1';
const ship = (entry) => fetch('/_lab/swlog', { method: 'POST', body: JSON.stringify(entry) }).catch(() => {});

self.addEventListener('install', (e) => e.waitUntil((async () => {
  const idx = await (await fetch('/_lab/siteindex.json', { cache: 'no-store' })).json();
  const c = await caches.open(SITE_CACHE);
  await Promise.all(idx.map(async (f) => { const r = await fetch('/_lab/site/' + f.path.split('/').map(encodeURIComponent).join('/'), { cache: 'no-store' }); await c.put('/_lab/site/' + f.path, r); }));
  await c.put('/_lab/shell.html', await fetch('/_lab/shell.html', { cache: 'no-store' }));
  await self.skipWaiting();
})()));
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));

const hasExt = (p) => /\.[^/]+$/.test(p);
async function siteFile(path) {
  const c = await caches.open(SITE_CACHE);
  const cand = [];
  if (path === '' || path.endsWith('/')) cand.push(path + 'index.html');
  else { cand.push(path); if (!hasExt(path)) cand.push(path + '/index.html', path + '.html'); }
  for (const k of cand) { const r = await c.match('/_lab/site/' + k); if (r) return { res: r, key: k, status: 200 }; }
  if (SPA && !hasExt(path)) { const r = await c.match('/_lab/site/index.html'); if (r) return { res: r, key: 'index.html(spa-fallback)', status: 200 }; }
  const nf = await c.match('/_lab/site/404.html'); if (nf) return { res: nf, key: '404.html', status: 404 };
  return null;
}
// Blob-backed response with clean headers, like the real SW (src/sw/sw.js): never forward hop-by-hop headers; explicit Content-Length.
const mk = async (f) => {
  if (!f) return new Response('not found', { status: 404 });
  const blob = await f.res.blob();
  return new Response(blob, { status: f.status, headers: { 'Content-Type': f.res.headers.get('content-type') || 'application/octet-stream', 'Content-Length': String(blob.size), 'X-Content-Type-Options': 'nosniff' } });
};

self.addEventListener('fetch', (event) => {
  const req = event.request; const url = new URL(req.url);
  if (url.origin !== location.origin) return;
  if (url.pathname.startsWith('/_lab/')) return;
  event.respondWith(handle(event, req, url));
});

async function handle(event, req, url) {
  const info = { clientId: event.clientId || '', resulting: event.resultingClientId || '' };
  if (event.clientId) {
    try { const c = await self.clients.get(event.clientId); if (c) { info.cUrl = new URL(c.url).pathname; info.cFrame = c.frameType; info.cType = c.type; } else info.cUrl = null; } catch (e) { info.cErr = String(e); }
  }
  const p = url.pathname;
  const entry = { mode: MODE, path: p + url.search, dest: req.destination, rmode: req.mode, ...info, by: '?' };
  try { return await route(event, req, url, p, info, entry); }
  catch (e) { entry.by = 'ERR ' + e.message; return new Response('sw error ' + e.message, { status: 500 }); }
  finally { event.waitUntil(ship(entry)); }
}

async function route(event, req, url, p, info, entry) {
  const dec = (s) => { try { return decodeURIComponent(s); } catch (_) { return s; } };
  if (MODE === 'prefix' || MODE === 'remap') {
    if (p.startsWith(PREFIX)) {
      const rel = dec(p.slice(PREFIX.length));
      // directory without trailing slash -> redirect so relative URLs resolve inside it
      const f = await siteFile(rel);
      entry.by = 'site:' + (f ? f.key : 'none');
      return mk(f);
    }
    if (MODE === 'remap' && !SHELL_ASSETS.has(p) && !p.startsWith('/_mw/') && info.cUrl && info.cUrl.startsWith(PREFIX)) {
      if (req.mode === 'navigate') {
        if (req.destination === 'iframe' || req.destination === 'frame') { entry.by = 'redirect->prefix'; return Response.redirect(url.origin + PREFIX + p.slice(1) + url.search, 302); }
        entry.by = 'network(top-level nav from site client)'; return fetch(req);
      }
      const f = await siteFile(dec(p.slice(1)));
      entry.by = 'remap:' + (f ? f.key : 'none');
      return mk(f);
    }
    entry.by = 'network'; return fetch(req);
  }
  // MODE === 'true'
  if (req.mode === 'navigate') {
    if (req.destination === 'document') {
      const c = await caches.open(SITE_CACHE); entry.by = 'shell(document)';
      return new Response((await c.match('/_lab/shell.html')).body, { status: 200, headers: { 'Content-Type': 'text/html; charset=utf-8' } });
    }
    if (req.destination === 'iframe' || req.destination === 'frame') {
      const r = stripBase(p);
      const f = r === null ? null : await siteFile(dec(r));
      entry.by = 'site(iframe):' + (f ? f.key : 'none' + (r === null ? '(outside base)' : '')); return mk(f);
    }
  }
  let who;
  if (info.cFrame === 'top-level') who = 'shell';
  else if (info.cFrame === 'nested') who = 'site';
  else who = SHELL_ASSETS.has(p) ? 'shell' : 'site'; // unknown client (dedicated worker): path heuristic
  if (who === 'shell') { entry.by = 'network(shell-client)'; return fetch(req); }
  const r2 = stripBase(p);
  const f = r2 === null ? null : await siteFile(dec(r2));
  if (f && f.status === 200) { entry.by = 'site:' + f.key; return mk(f); }
  entry.by = 'site-miss->network' + (r2 === null ? '(outside base)' : ''); return fetch(req);
}
function stripBase(p) { return p.startsWith(SITE_BASE) ? p.slice(SITE_BASE.length) : (p + '/' === SITE_BASE ? '' : null); }
