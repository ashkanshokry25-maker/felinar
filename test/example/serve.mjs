// A small static server that plays the loader's part for the example sites in a test: it serves the site at the origin root,
// answers Range requests with 206 like the Service Worker does, serves test/example/mock-sdk.js as /_mw/sdk.js, serves stand-in
// private media at /_mw/media/<sid> (a PNG, or the guestbook clip for video, with Range), and, when spa is on, answers every unknown
// path that is not a file with index.html and status 200, as the worker does in shell and hub modes (ARCHITECTURE 3.1). Loopback only.
import http from 'node:http';
import { readFileSync, existsSync, statSync } from 'node:fs';
import { resolve, dirname, join, extname, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
export const MOCK_SDK = join(HERE, 'mock-sdk.js');
const CLIP = resolve(HERE, '../../examples/peer-guestbook/media/clip.mp4');
const MIME = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.json': 'application/json', '.png': 'image/png', '.svg': 'image/svg+xml', '.mp4': 'video/mp4' };
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');

export function parseRange(header, size) {
  const m = /^bytes=(\d*)-(\d*)$/.exec(header || '');
  if (!m || (m[1] === '' && m[2] === '')) return null;
  let start, end;
  if (m[1] === '') { start = Math.max(0, size - Number(m[2])); end = size - 1; } else { start = Number(m[1]); end = m[2] === '' ? size - 1 : Math.min(Number(m[2]), size - 1); }
  return start >= size || start > end ? 416 : { start, end };
}

export function startSiteServer({ site, spa = false }) {
  const hits = [];
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost');
    const path = decodeURIComponent(url.pathname);
    const hit = { path, search: url.search, range: req.headers.range || null, status: 0, headers: req.headers };
    hits.push(hit);
    let body, type, status = 200;
    if (path.startsWith('/_mw/media/')) {
      const sid = path.slice('/_mw/media/'.length);
      body = sid.startsWith('v-') && !url.searchParams.has('part') ? readFileSync(CLIP) : PNG;
      type = sid.startsWith('v-') && !url.searchParams.has('part') ? 'video/mp4' : 'image/png';
    } else {
      let file = path === '/_mw/sdk.js' ? MOCK_SDK : path.split('/').some((seg) => seg.startsWith('.')) ? null : join(site, path.endsWith('/') ? path + 'index.html' : path);
      const inSite = file && (file === MOCK_SDK || file.startsWith(site + sep));
      if (!inSite || !existsSync(file) || statSync(file).isDirectory()) {
        if (spa && !extname(path)) { file = join(site, 'index.html'); } else { file = join(site, '404.html'); status = 404; }
      }
      body = readFileSync(file); type = MIME[extname(file)] || 'application/octet-stream';
    }
    const headers = { 'content-type': type, 'cache-control': 'no-store', 'accept-ranges': 'bytes' };
    const range = status === 200 && req.headers.range ? parseRange(req.headers.range, body.length) : null;
    if (range === 416) { hit.status = 416; res.writeHead(416, { 'content-range': 'bytes */' + body.length }); res.end(); return; }
    if (range) {
      hit.status = 206;
      res.writeHead(206, { ...headers, 'content-range': 'bytes ' + range.start + '-' + range.end + '/' + body.length, 'content-length': range.end - range.start + 1 });
      res.end(body.subarray(range.start, range.end + 1));
      return;
    }
    hit.status = status;
    res.writeHead(status, { ...headers, 'content-length': body.length });
    res.end(body);
  });
  return new Promise((ok) => server.listen(0, '127.0.0.1', () => ok({ server, hits, base: 'http://127.0.0.1:' + server.address().port })));
}
