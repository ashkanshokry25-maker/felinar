import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
const TYPES = { html: 'text/html; charset=utf-8', htm: 'text/html; charset=utf-8', css: 'text/css; charset=utf-8', js: 'text/javascript; charset=utf-8', mjs: 'text/javascript; charset=utf-8', cjs: 'text/javascript; charset=utf-8', json: 'application/json; charset=utf-8', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', avif: 'image/avif', svg: 'image/svg+xml', ico: 'image/x-icon', woff2: 'font/woff2', woff: 'font/woff', ttf: 'font/ttf', otf: 'font/otf', txt: 'text/plain; charset=utf-8', xml: 'application/xml', map: 'application/json', webmanifest: 'application/manifest+json', wasm: 'application/wasm', mp4: 'video/mp4', pdf: 'application/pdf' };
const typeOf = (p) => TYPES[(p.split('.').pop() || '').toLowerCase()] || 'application/octet-stream';
function walk(dir, base = dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) walk(full, base, out); else if (e.isFile()) out.push({ path: path.relative(base, full).split(path.sep).join('/'), size: fs.statSync(full).size });
  }
  return out;
}
export async function startServer({ mode, siteDir, spa = false, base = '/', hostFallback = 'shell', extraHostFiles = {} }) {
  const here = path.dirname(new URL(import.meta.url).pathname);
  const swText = fs.readFileSync(path.join(here, 'sw-core.js'), 'utf8').replace('__MODE__', mode).replace('__SPA__', spa ? 'true' : 'false').replace('__BASE__', base);
  const shellJs = fs.readFileSync(path.join(here, 'shell.js'), 'utf8').replace('__MODE__', mode);
  const shellHtml = '<!doctype html><meta charset=utf-8><title>shell</title><style>html,body{margin:0;height:100%}iframe{border:0;width:100%;height:100%}</style><script src="/shell.js"></script>';
  const index = walk(siteDir);
  const netlog = []; const swlog = [];
  const srv = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://x'); const p = u.pathname;
    const send = (status, type, body, headers = {}) => { res.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'no-cache', ...headers }); res.end(body); };
    if (p === '/_lab/swlog') { let b = ''; req.on('data', (d) => (b += d)); req.on('end', () => { try { swlog.push(JSON.parse(b)); } catch (_) {} send(204, 'text/plain', ''); }); return; }
    if (p === '/_lab/siteindex.json') return send(200, 'application/json', JSON.stringify(index));
    if (p === '/_lab/shell.html') return send(200, 'text/html; charset=utf-8', shellHtml);
    if (p.startsWith('/_lab/site/')) { const rel = decodeURIComponent(p.slice('/_lab/site/'.length)); const f = path.join(siteDir, rel); if (!f.startsWith(siteDir) || !fs.existsSync(f)) return send(404, 'text/plain', 'nf'); return send(200, typeOf(rel), fs.readFileSync(f)); }
    const rec = { method: req.method, path: p + u.search, dest: req.headers['sec-fetch-dest'] || '', smode: req.headers['sec-fetch-mode'] || '', referer: req.headers['referer'] || '' };
    netlog.push(rec);
    if (p === '/sw.js') { rec.served = 'host:sw.js'; return send(200, 'text/javascript; charset=utf-8', swText); }
    if (p === '/shell.js') { rec.served = 'host:shell.js'; return send(200, 'text/javascript; charset=utf-8', shellJs); }
    if (extraHostFiles[p]) { rec.served = 'host:extra'; return send(200, extraHostFiles[p].type, extraHostFiles[p].body); }
    if (p === '/') { rec.served = 'host:shell'; return send(200, 'text/html; charset=utf-8', shellHtml); }
    const nav = rec.smode === 'navigate' || (req.headers.accept || '').includes('text/html');
    if (nav) { rec.served = 'host:SPA-fallback-shell(200)'; return send(200, 'text/html; charset=utf-8', shellHtml); } // S3/CloudFront/GitHub-Pages style: unknown path -> shell
    rec.served = 'host:404'; return send(404, 'text/plain', 'not found');
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const port = srv.address().port;
  return { port, url: 'http://127.0.0.1:' + port, netlog, swlog, close: () => new Promise((r) => srv.close(r)), index };
}
