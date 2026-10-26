// static server for the w2c-02 bench. args: <port> <benchDir> <sqliteDistDir> <outDir>
import http from 'node:http'; import { readFile } from 'node:fs/promises'; import { extname, join, normalize } from 'node:path';
const [,, port, benchDir, sqliteDir, outDir] = process.argv;
const types = { '.html': 'text/html', '.mjs': 'text/javascript', '.js': 'text/javascript', '.wasm': 'application/wasm', '.json': 'application/json' };
http.createServer(async (req, res) => {
  const u = new URL(req.url, 'http://x'); let base, rel;
  if (u.pathname.startsWith('/sqlite/')) { base = sqliteDir; rel = u.pathname.slice(8); }
  else if (u.pathname.startsWith('/out/')) { base = outDir; rel = u.pathname.slice(5); }
  else { base = benchDir; rel = u.pathname === '/' ? 'index.html' : u.pathname.slice(1); }
  const p = normalize(join(base, rel)); if (!p.startsWith(base)) { res.writeHead(403).end(); return; }
  try { const b = await readFile(p); res.writeHead(200, { 'content-type': types[extname(p)] || 'application/octet-stream' }).end(b); } catch { res.writeHead(404).end('nf'); }
}).listen(Number(port), '127.0.0.1', () => console.log('listening', port));
