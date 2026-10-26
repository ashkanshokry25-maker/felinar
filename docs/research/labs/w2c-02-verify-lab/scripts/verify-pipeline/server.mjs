// static server for the verification bench. args: <port> <pageDir> <chainSrcDir> <dataDir>
import http from 'node:http'; import { readFile } from 'node:fs/promises'; import { extname, join, normalize } from 'node:path';
const [,, port, pageDir, chainDir, dataDir] = process.argv;
const types = { '.html': 'text/html', '.mjs': 'text/javascript', '.js': 'text/javascript', '.json': 'application/json' };
http.createServer(async (req, res) => {
  const u = new URL(req.url, 'http://x'); let base, rel;
  if (u.pathname.startsWith('/chain/')) { base = chainDir; rel = u.pathname.slice(7); }
  else if (u.pathname.startsWith('/data/')) { base = dataDir; rel = u.pathname.slice(6); }
  else { base = pageDir; rel = u.pathname === '/' ? 'bench.html' : u.pathname.slice(1); }
  const p = normalize(join(base, rel)); if (!p.startsWith(base)) { res.writeHead(403).end(); return; }
  try { const b = await readFile(p); res.writeHead(200, { 'content-type': types[extname(p)] || 'application/octet-stream', 'cache-control': 'no-store' }).end(b); } catch { res.writeHead(404).end('nf'); }
}).listen(Number(port), '127.0.0.1', () => console.log('listening', port));
