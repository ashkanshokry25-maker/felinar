// Tiny static server for the lab: serves files from a route table, supports Range, configurable delay/bandwidth per route.
import http from 'node:http';
import fs from 'node:fs';
export function startServer(routes, { host = '127.0.0.1' } = {}) {
  // routes: { '/path': { file|body, type, cache, delayMs, bytesPerSec, headers } }
  const srv = http.createServer(async (req, res) => {
    const u = new URL(req.url, 'http://x');
    const r = routes[u.pathname];
    if (!r) { res.writeHead(404); return res.end('nf'); }
    const body = r.body ?? fs.readFileSync(r.file);
    const h = { 'content-type': r.type || 'application/octet-stream', 'cache-control': r.cache || 'no-store', 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'accept-ranges': 'bytes', ...(r.headers || {}) };
    if (req.method === 'OPTIONS') { res.writeHead(204, { ...h, 'access-control-allow-methods': 'GET, HEAD, OPTIONS', 'access-control-max-age': '600' }); return res.end(); }
    if (r.delayMs) await new Promise(ok => setTimeout(ok, r.delayMs));
    let start = 0, end = body.length - 1, status = 200;
    const m = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range || '');
    if (m) { if (m[1] !== '') { start = +m[1]; end = m[2] !== '' ? Math.min(+m[2], body.length - 1) : body.length - 1; } else { start = Math.max(0, body.length - +m[2]); } status = 206; h['content-range'] = `bytes ${start}-${end}/${body.length}`; }
    h['content-length'] = end - start + 1;
    res.writeHead(status, h);
    const slice = body.subarray(start, end + 1);
    if (!r.bytesPerSec) return res.end(slice);
    // crude token-bucket: 10 ms slices
    const per = Math.max(1, Math.floor(r.bytesPerSec / 100)); let off = 0;
    const tick = () => { if (off >= slice.length) return res.end(); res.write(slice.subarray(off, off + per)); off += per; setTimeout(tick, 10); };
    tick();
  });
  return new Promise(ok => srv.listen(0, host, () => ok({ srv, port: srv.address().port, close: () => srv.close() })));
}
