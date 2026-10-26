// EXP-B: piece reuse between two consecutive exports of a WordPress-like site, by file ordering and padding.
// Question: if a visitor already holds export v1 (in a store) and the owner publishes v2 (one new post + regenerated
// home/archives/feed/sitemap + regenerated Pagefind index), how many v2 pieces are byte-identical, at the same piece
// index, to a v1 piece (these would verify against a pre-filled store and need no download)?
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
const P = '$HOME/Documents/Projects/magnet-web/node_modules/';
const createTorrent = (await import(pathToFileURL(P + 'create-torrent/index.js').href)).default;
const bencode = (await import(pathToFileURL(P + 'bencode/index.js').href)).default;

// ---- deterministic pseudo-random bytes
const POOL = new Uint8Array(180 << 20);
{ const u32 = new Uint32Array(POOL.buffer); let s = 0x9e3779b9; for (let i = 0; i < u32.length; i++) { s ^= s << 13; s >>>= 0; s ^= s >>> 17; s ^= s << 5; s >>>= 0; u32[i] = s; } }
let cursor = 0;
const alloc = (len) => { if (cursor + len > POOL.length) throw new Error("pool exhausted"); const v = POOL.slice(cursor, cursor + len); cursor += len; return v; }; // fresh copy => unique content
function rng(seed) { let s = seed >>> 0; return () => (s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 2 ** 32; }
const r = rng(7);
const KiB = 1024;

// ---- build v1 site: Map path -> {bytes, cls}
const v1 = new Map();
const add = (m, path, len, cls) => m.set(path, { bytes: alloc(len), cls });
const pad2 = (n) => String(n).padStart(2, '0');
for (let i = 0; i < 400; i++) add(v1, `blog/${2022 + (i % 4)}/${pad2(1 + (i % 12))}/post-${i}/index.html`, Math.floor((10 + r() * 110) * KiB), 'html');
for (const [p, k] of [['index.html', 60], ['blog/index.html', 80], ['feed.xml', 50], ['sitemap.xml', 40]]) add(v1, p, k * KiB, 'volatile');
for (let i = 0; i < 10; i++) add(v1, `category/c${i}/index.html`, 50 * KiB, 'volatile');
for (let i = 0; i < 60; i++) add(v1, `wp-content/themes/t/assets/${i % 3 ? 'js' : 'css'}/bundle-${i}.${i % 3 ? 'js' : 'css'}`, Math.floor((5 + r() * 295) * KiB), 'code');
for (let i = 0; i < 1500; i++) add(v1, `wp-content/uploads/${2022 + (i % 4)}/${pad2(1 + (i % 12))}/IMG_${1000 + i}-${[300, 768, 1024, 1536][i % 4]}.webp`, Math.floor((8 + r() * r() * r() * 500) * KiB), 'media');
for (let i = 0; i < 20; i++) add(v1, `wp-content/themes/t/fonts/font-${i}.woff2`, 40 * KiB, 'media');
add(v1, 'pagefind/pagefind.js', 40 * KiB, 'code'); add(v1, 'pagefind/wasm.en.pagefind', 120 * KiB, 'code');
add(v1, 'pagefind/pagefind-entry.json', 2 * KiB, 'pf'); add(v1, 'pagefind/pagefind.en_aaaa.pf_meta', 30 * KiB, 'pf');
for (let i = 0; i < 30; i++) add(v1, `pagefind/index/h${i}_a.pf_index`, 20 * KiB, 'pf');
for (let i = 0; i < 400; i++) add(v1, `pagefind/fragment/f${i}_a.pf_fragment`, 3 * KiB, 'pf');

// ---- v2 = "publish one new post": edit/regenerate volatile files, new post + 3 images, regenerated search index
const v2 = new Map(v1);
const edit = (path, deltaBytes) => { const old = v2.get(path); const nb = new Uint8Array(old.bytes.length + deltaBytes); nb.set(old.bytes.subarray(0, Math.min(old.bytes.length, nb.length))); nb.set(alloc(Math.max(0, deltaBytes)), old.bytes.length); v2.set(path, { bytes: nb, cls: old.cls }); };
for (const p of ['index.html', 'blog/index.html', 'feed.xml', 'sitemap.xml', 'category/c3/index.html']) edit(p, 600 + Math.floor(r() * 400));
edit('blog/2023/06/post-5/index.html', 37); // an old post edited (typo fix; size shifts by +37 B)
add(v2, 'blog/2026/10/new-post/index.html', 45 * KiB, 'html');
for (const [n, kb] of [['a', 120], ['b', 80], ['c', 60]]) add(v2, `wp-content/uploads/2026/10/IMG_new-${n}.webp`, kb * KiB, 'media');
v2.delete('pagefind/pagefind.en_aaaa.pf_meta'); add(v2, 'pagefind/pagefind.en_bbbb.pf_meta', 31 * KiB, 'pf');
edit('pagefind/pagefind-entry.json', 20);
for (let i = 0; i < 30; i += 5) { v2.delete(`pagefind/index/h${i}_a.pf_index`); add(v2, `pagefind/index/h${i}_b.pf_index`, 21 * KiB, 'pf'); } // ~17 % of chunks rewritten
v2.delete('pagefind/fragment/f5_a.pf_fragment'); add(v2, 'pagefind/fragment/f5_b.pf_fragment', 3 * KiB, 'pf'); add(v2, 'pagefind/fragment/fnew_a.pf_fragment', 3 * KiB, 'pf');

// ---- orderings
const byPath = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
const CLS_ORDER = ['media', 'code', 'pf', 'html', 'volatile'];
function orderLex(m) { return [...m.keys()].sort(byPath); }
function orderClass(m) { return CLS_ORDER.flatMap(c => [...m.keys()].filter(p => m.get(p).cls === c).sort(byPath)); }
function orderClassStable(m, prevOrder) { // keep previous relative order, append new files at the end of their class
  const prevIdx = new Map(prevOrder.map((p, i) => [p, i]));
  return CLS_ORDER.flatMap(c => {
    const ps = [...m.keys()].filter(p => m.get(p).cls === c);
    const old = ps.filter(p => prevIdx.has(p)).sort((a, b) => prevIdx.get(a) - prevIdx.get(b));
    const fresh = ps.filter(p => !prevIdx.has(p)).sort(byPath);
    return [...old, ...fresh];
  });
}
function withPadding(m, order, pieceLength) { // BEP 47 style zero files so every real file starts at a piece boundary
  const out = []; let off = 0; const zero = new Uint8Array(pieceLength);
  for (const p of order) {
    const rem = off % pieceLength;
    if (rem !== 0 && out.length) { const padLen = pieceLength - rem; out.push({ path: `.pad/${padLen}`, bytes: zero.subarray(0, padLen), pad: true }); off += padLen; }
    const b = m.get(p).bytes; out.push({ path: p, bytes: b }); off += b.length;
  }
  return out;
}
function toInputs(list) { return list.map(({ path, bytes }) => { const v = bytes.subarray(0); v.fullPath = 'site/' + path; return v; }); }
async function pieces(inputs, pieceLength) {
  const buf = await new Promise((res, rej) => createTorrent(inputs, { name: 'site', pieceLength, announce: [], creationDate: new Date(0) }, (e, t) => e ? rej(e) : res(t)));
  const d = bencode.decode(buf); const p = d.info.pieces; const out = [];
  for (let i = 0; i < p.length; i += 20) out.push(Buffer.from(p.subarray(i, i + 20)).toString('hex'));
  return { pieces: out, torrentBytes: buf.length, totalBytes: (d.info.files || []).reduce((s, f) => s + f.length, 0) };
}

const sum = (m) => [...m.values()].reduce((s, f) => s + f.bytes.length, 0);
// theoretical minimum = bytes of files in v2 that are new or whose content differs from v1
let minDelta = 0; for (const [p, f] of v2) { const o = v1.get(p); if (!o || o.bytes.length !== f.bytes.length || Buffer.compare(Buffer.from(o.bytes), Buffer.from(f.bytes)) !== 0) minDelta += f.bytes.length; }
console.log(`v1 files=${v1.size} bytes=${(sum(v1) / 1048576).toFixed(1)} MiB | v2 files=${v2.size} bytes=${(sum(v2) / 1048576).toFixed(1)} MiB | theoretical file-level delta (new+changed files) = ${(minDelta / 1024).toFixed(0)} KiB`);



const same = (a, b) => a && b && a.bytes.length === b.bytes.length && Buffer.compare(Buffer.from(a.bytes), Buffer.from(b.bytes)) === 0;
function orderGen(m, prevMap, prevOrder) {
  const unchanged = prevOrder.filter(p => m.has(p) && same(prevMap.get(p), m.get(p)));
  const us = new Set(unchanged);
  const changed = [...m.keys()].filter(p => !us.has(p));
  const cls = (p) => CLS_ORDER.indexOf(m.get(p).cls);
  changed.sort((a, b) => cls(a) - cls(b) || byPath(a, b));
  return [...unchanged, ...changed];
}
const mk = (m, order) => order.map(p => ({ path: p, bytes: m.get(p).bytes }));
// "File-granular prefill": the loader keeps v1 files in IndexedDB. For v2 it builds a store buffer of v2's size, copies every
// UNCHANGED file (same path, same bytes) to its v2 offset, leaves the rest zero, and lets WebTorrent hash-verify. A v2 piece is
// reusable iff its SHA-1 over that prefilled buffer equals the real v2 piece hash.
async function prefillReuse(L2, v1map, pl, v2hashes) {
  const total = L2.reduce((s, f) => s + f.bytes.length, 0);
  const buf = new Uint8Array(total); let off = 0;
  for (const f of L2) {
    if (f.pad) { off += f.bytes.length; continue; } // zeros are reproducible
    const o = v1map.get(f.path);
    if (o && o.bytes.length === f.bytes.length && Buffer.compare(Buffer.from(o.bytes), Buffer.from(f.bytes)) === 0) buf.set(f.bytes, off);
    off += f.bytes.length;
  }
  let ok = 0; const n = v2hashes.length;
  for (let i = 0; i < n; i++) {
    const h = createHash('sha1').update(buf.subarray(i * pl, Math.min(total, (i + 1) * pl))).digest('hex');
    if (h === v2hashes[i]) ok++;
  }
  return { ok, n };
}
const rows = [];
async function run(label, pl, L1, L2, v1m) {
  const a = await pieces(toInputs(L1), pl); const b = await pieces(toInputs(L2), pl);
  let idx = 0; for (let i = 0; i < b.pieces.length; i++) if (a.pieces[i] === b.pieces[i]) idx++;
  const f = await prefillReuse(L2, v1m, pl, b.pieces);
  const pad = L2.filter(x => x.pad).reduce((s, x) => s + x.bytes.length, 0);
  rows.push({ pieceKiB: pl >> 10, layout: label, v2Pieces: b.pieces.length, 'reuse@same-index %': +(100 * idx / b.pieces.length).toFixed(1), 'reuse via file-prefill %': +(100 * f.ok / f.n).toFixed(1), 'download MiB (file-prefill)': +(((f.n - f.ok) * pl) / 1048576).toFixed(2), paddingMiB: +(pad / 1048576).toFixed(1), torrentKB: +(b.torrentBytes / 1024).toFixed(0) });
}
for (const order of [['media', 'code', 'pf', 'html', 'volatile'], ['media', 'code', 'html', 'pf', 'volatile']]) {
  CLS_ORDER.splice(0, CLS_ORDER.length, ...order);
  const tag = order.join('>');
  for (const pl of [256 << 10, 64 << 10, 16 << 10]) {
    const o1cls = orderClass(v1);
    if (order[2] === 'pf') { // path-sorted baselines only once (they do not depend on class order)
      await run('A path-sorted', pl, mk(v1, orderLex(v1)), mk(v2, orderLex(v2)), v1);
      await run('F path-sorted + piece padding', pl, withPadding(v1, orderLex(v1), pl), withPadding(v2, orderLex(v2), pl), v1);
    }
    await run('B class[' + tag + ']', pl, mk(v1, o1cls), mk(v2, orderClass(v2)), v1);
    await run('C generational[' + tag + ']', pl, mk(v1, o1cls), mk(v2, orderGen(v2, v1, o1cls)), v1);
  }
}
console.table(rows);
