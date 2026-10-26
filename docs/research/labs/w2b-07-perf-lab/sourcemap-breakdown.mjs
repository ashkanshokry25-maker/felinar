// Lab 1a': attribute the bytes of the vendored dist/webtorrent.min.js to npm packages using its own source map.
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';
const here = path.dirname(fileURLToPath(import.meta.url));
const dist = path.resolve(here, '../../../../node_modules/webtorrent/dist');
const js = fs.readFileSync(path.join(dist, 'webtorrent.min.js'), 'utf8');
const map = JSON.parse(fs.readFileSync(path.join(dist, 'webtorrent.min.js.map'), 'utf8'));
const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
const vlq = (s) => { const out = []; let shift = 0, val = 0; for (const ch of s) { const d = B64.indexOf(ch); val += (d & 31) << shift; if (d & 32) shift += 5; else { out.push(val & 1 ? -(val >> 1) : val >> 1); val = 0; shift = 0; } } return out; };
const lines = js.split('\n');
const mapLines = map.mappings.split(';');
// generated column -> source index
const bySrc = new Map();
let srcIdx = 0;
for (let li = 0; li < mapLines.length; li++) {
  const segs = mapLines[li] ? mapLines[li].split(',') : [];
  let col = 0; const pts = [];
  for (const sg of segs) { const f = vlq(sg); col += f[0]; if (f.length >= 4) { srcIdx += f[1]; pts.push([col, srcIdx]); } else pts.push([col, -1]); }
  const lineLen = Buffer.byteLength(lines[li] || '');
  for (let i = 0; i < pts.length; i++) {
    const end = i + 1 < pts.length ? pts[i + 1][0] : (lines[li] || '').length;
    const len = Math.max(0, end - pts[i][0]);
    const name = pts[i][1] >= 0 ? map.sources[pts[i][1]] : '(unmapped)';
    bySrc.set(name, (bySrc.get(name) || 0) + len);
  }
}
// group by npm package
const pkg = (s) => { const m = s.match(/node_modules\/((?:@[^/]+\/)?[^/]+)/g); if (m) return m[m.length - 1].replace('node_modules/', ''); return s.replace(/^webpack:\/\/[^/]*\//, '').split('/').slice(0, 2).join('/'); };
const byPkg = new Map();
for (const [s, n] of bySrc) byPkg.set(pkg(s), (byPkg.get(pkg(s)) || 0) + n);
const total = [...byPkg.values()].reduce((a, b) => a + b, 0);
const rows = [...byPkg.entries()].sort((a, b) => b[1] - a[1]);
console.log('total attributed chars', total, 'file bytes', Buffer.byteLength(js), 'sources', map.sources.length);
for (const [k, v] of rows.slice(0, 45)) console.log(String(v).padStart(8), (100 * v / total).toFixed(1).padStart(5) + '%', k);
fs.writeFileSync(path.join(here, 'out/sourcemap-breakdown.json'), JSON.stringify(rows, null, 1));
