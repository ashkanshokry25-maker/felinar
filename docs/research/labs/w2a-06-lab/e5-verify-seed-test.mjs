// E5: run verify-seed against local servers that imitate the host behaviours measured in the probe table.
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { pathToFileURL } from 'node:url';
import { verifySeed } from './verify-seed.mjs';
const MODS = '$HOME/Documents/Projects/magnet-web/node_modules';
const { default: createTorrent } = await import(pathToFileURL(`${MODS}/create-torrent/index.js`).href);

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mwe5-')); const tree = path.join(root, 'r', 'rel1', 'site');
const files = { 'index.html': '<!doctype html><title>x</title>' + '<p>hello world</p>\n'.repeat(400), 'css/app.css': 'body{margin:0}\n'.repeat(900), 'js/app.js': 'console.log("x")\n'.repeat(700), 'img/peer.png': Buffer.alloc(40000, 7), '.well-known/security.txt': 'Contact: x\n' };
for (const [rel, body] of Object.entries(files)) { const p = path.join(tree, rel); fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, body); }
const walk = (d, r = '') => fs.readdirSync(d, { withFileTypes: true }).flatMap(e => e.isDirectory() ? walk(path.join(d, e.name), r ? `${r}/${e.name}` : e.name) : [r ? `${r}/${e.name}` : e.name]);
const blobs = []; for (const r of walk(tree).sort()) { const b = await fs.openAsBlob(path.join(tree, r)); b.fullPath = `site/${r}`; blobs.push(b); }
const torrentBuf = await new Promise((res, rej) => createTorrent(blobs, { name: 'site', pieceLength: 16384, announce: [], creationDate: new Date('2026-10-17T00:00:00Z') }, (e, b) => e ? rej(e) : res(b)));
const tfile = path.join(root, 'site.torrent'); fs.writeFileSync(tfile, torrentBuf);

function serve(mode) {
  return new Promise(resolve => { const s = http.createServer((req, res) => {
    const cors = { 'access-control-allow-origin': '*' };
    if (req.method === 'OPTIONS') {
      if (mode === 'no-preflight') { res.writeHead(405, { allow: 'GET, HEAD' }); return res.end(); }                 // GitHub Pages / Cloudflare sample
      if (mode === 'acao-only') { res.writeHead(200, cors); return res.end(); }                                      // jsDelivr sample: ACAO but no Allow-Headers
      res.writeHead(204, { ...cors, 'access-control-allow-headers': req.headers['access-control-request-headers'] || '*', 'access-control-allow-methods': 'GET, HEAD, OPTIONS', 'access-control-max-age': '86400' }); return res.end();
    }
    const p = path.join(root, decodeURIComponent(req.url.split('?')[0])); if (!p.startsWith(root) || !fs.existsSync(p) || fs.statSync(p).isDirectory()) { res.writeHead(404, cors); return res.end(); }
    let body = fs.readFileSync(p); const m = /bytes=(\d+)-(\d+)/.exec(req.headers.range || ''); const ae = req.headers['accept-encoding'] || '';
    const headers = { ...cors, 'accept-ranges': 'bytes' };
    if (mode === 'gzip-range' && /gzip/.test(ae)) { body = zlib.gzipSync(body); headers['content-encoding'] = 'gzip'; }   // GitHub Pages sample: Range applies to the compressed representation
    if (m && mode !== 'range-ignored') { const a = +m[1], b = Math.min(+m[2], body.length - 1); res.writeHead(206, { ...headers, 'content-range': `bytes ${a}-${b}/${body.length}`, 'content-length': b - a + 1 }); return res.end(body.subarray(a, b + 1)); }
    res.writeHead(200, { ...headers, 'content-length': body.length }); res.end(body);                                   // Cloudflare sample: Range ignored
  }); s.listen(0, '127.0.0.1', () => resolve(s)); });
}
const cases = [['good', 'identity'], ['no-preflight', 'identity'], ['acao-only', 'identity'], ['range-ignored', 'identity'], ['gzip-range', 'identity'], ['gzip-range', 'gzip, br']];
for (const [mode, ae] of cases) {
  const s = await serve(mode); const ws = `http://127.0.0.1:${s.address().port}/r/rel1/`;
  const r = await verifySeed({ torrentPath: tfile, ws, origin: 'https://example.com', acceptEncoding: ae });
  console.log(`${mode.padEnd(14)} accept-encoding=${ae.padEnd(10)} -> ${r.ok ? 'PASS' : 'FAIL'}  pieces=${r.pieces} bad=${r.bad}  ${r.problems.slice(0, 2).join(' | ')}`);
  s.close();
}
// same-origin drop-in case: no preflight required even though the server would 405 it
{ const s = await serve('no-preflight'); const port = s.address().port; const r = await verifySeed({ torrentPath: tfile, ws: `http://127.0.0.1:${port}/r/rel1/`, origin: `http://127.0.0.1:${port}` });
  console.log(`${'same-origin'.padEnd(14)} (405 preflight ignored)           -> ${r.ok ? 'PASS' : 'FAIL'}  ${r.problems.join(' | ')}`); s.close(); }
fs.rmSync(root, { recursive: true, force: true });
