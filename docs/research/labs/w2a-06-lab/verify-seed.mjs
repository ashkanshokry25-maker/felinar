// verify-seed.mjs - CI gate: does the PUBLIC web-seed URL really serve the torrent's bytes to a browser-style client?
// usage: node verify-seed.mjs <site.torrent> <ws-base-url> [--origin https://example.com] [--accept-encoding identity|"gzip, br"] [--concurrency 8]
// Checks (all must pass): (1) CORS preflight as WebTorrent triggers it, (2) every piece: 206 + exact Content-Range, byte length, sha1 == torrent.
import fs from 'node:fs';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';

const MODS = '$HOME/Documents/Projects/magnet-web/node_modules';
const { default: parseTorrent } = await import(pathToFileURL(`${MODS}/parse-torrent/index.js`).href);

export async function verifySeed({ torrentPath, ws, origin = 'https://example.com', acceptEncoding = 'identity', concurrency = 8, log = () => {} }) {
  const t = await parseTorrent(fs.readFileSync(torrentPath));
  const base = ws.endsWith('/') ? ws : ws + '/';
  const problems = [];
  const urlFor = f => base + f.path.split('/').map(encodeURIComponent).join('/');   // f.path already starts with torrent name (BEP 19)
  // (1) preflight exactly as a cross-origin browser fetch with {Cache-Control, Range, User-Agent} would send it
  const probe = urlFor(t.files[0]);
  const pf = await fetch(probe, { method: 'OPTIONS', headers: { Origin: origin, 'Access-Control-Request-Method': 'GET', 'Access-Control-Request-Headers': 'cache-control,range,user-agent' } });
  const acao = pf.headers.get('access-control-allow-origin'), acah = (pf.headers.get('access-control-allow-headers') || '').toLowerCase(), acam = (pf.headers.get('access-control-allow-methods') || '').toUpperCase();
  const sameOrigin = new URL(base).origin === origin;
  if (!sameOrigin) {
    if (!pf.ok) problems.push(`preflight: HTTP ${pf.status} (cross-origin seed needs a 2xx OPTIONS answer)`);
    if (acao !== '*' && acao !== origin) problems.push(`preflight: Access-Control-Allow-Origin=${acao} (need * or ${origin})`);
    const okH = acah.split(',').map(s => s.trim()).includes('*') || ['cache-control', 'range'].every(h => acah.includes(h));
    if (!okH) problems.push(`preflight: Access-Control-Allow-Headers="${acah}" lacks cache-control/range (and user-agent for Firefox/Safari)`);
    if (acam && !acam.includes('GET') && acam !== '*') problems.push(`preflight: Access-Control-Allow-Methods=${acam}`);
  }
  // (2) every piece, fetched the way webconn.js does it: one Range request per file span
  const sizes = new Map(t.files.map(f => [f.path, f.length]));
  const starts = []; let off = 0; for (const f of t.files) { starts.push(off); off += f.length; }
  const pieceLen = t.pieceLength, total = off, nPieces = t.pieces.length;
  async function fetchPiece(i) {
    const a = i * pieceLen, b = Math.min(a + pieceLen, total) - 1; const parts = [];
    for (let k = 0; k < t.files.length; k++) {
      const f = t.files[k], fs0 = starts[k], fe = fs0 + f.length - 1;
      if (f.length === 0 || fe < a || fs0 > b) continue;
      const ra = Math.max(a, fs0) - fs0, rb = Math.min(b, fe) - fs0;
      const res = await fetch(urlFor(f), { headers: { Range: `bytes=${ra}-${rb}`, 'Accept-Encoding': acceptEncoding, 'Cache-Control': 'no-store', Origin: origin }, cache: 'no-store' });
      if (res.status !== 206) throw new Error(`piece ${i} ${f.path}: HTTP ${res.status} (need 206; 200 means Range ignored)`);
      const cr = res.headers.get('content-range') || '';
      if (cr !== `bytes ${ra}-${rb}/${f.length}`) throw new Error(`piece ${i} ${f.path}: Content-Range "${cr}" != "bytes ${ra}-${rb}/${f.length}" (compressed representation or wrong size?)`);
      if (!sameOrigin && acao !== '*' && res.headers.get('access-control-allow-origin') == null) throw new Error(`piece ${i}: GET response lacks Access-Control-Allow-Origin`);
      parts.push(Buffer.from(await res.arrayBuffer()));
    }
    const data = Buffer.concat(parts);
    if (data.length !== b - a + 1) throw new Error(`piece ${i}: got ${data.length} bytes, expected ${b - a + 1}`);
    if (createHash('sha1').update(data).digest('hex') !== t.pieces[i]) throw new Error(`piece ${i}: SHA-1 mismatch (bytes served differ from the torrent payload)`);
  }
  let next = 0, bad = 0;
  await Promise.all(Array.from({ length: Math.min(concurrency, nPieces) }, async () => {
    while (true) { const i = next++; if (i >= nPieces) return; try { await fetchPiece(i); } catch (e) { bad++; if (problems.length < 6) problems.push(e.message); } }
  }));
  log(`pieces=${nPieces} bad=${bad}`);
  return { ok: problems.length === 0, infoHash: t.infoHash, pieces: nPieces, bad, problems };
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [torrentPath, ws, ...rest] = process.argv.slice(2); const opt = k => { const i = rest.indexOf(k); return i >= 0 ? rest[i + 1] : undefined; };
  const r = await verifySeed({ torrentPath, ws, origin: opt('--origin'), acceptEncoding: opt('--accept-encoding'), concurrency: Number(opt('--concurrency')) || 8 });
  console.log(JSON.stringify(r, null, 2)); process.exit(r.ok ? 0 : 1);
}
