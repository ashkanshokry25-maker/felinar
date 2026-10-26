// Property-based / differential tests of EXISTING project parsers with fast-check 4.10.2 (read-only on the project).
import fc from 'fast-check';
import { parseRange, splitSitePath, entryFor, mimeFor } from '../../../../src/sw/lib.js';
import { normalizeBtih, parseMagnet, formatMagnet } from '../../../../src/common/magnet.js';
import { canonicalize } from '../../../../src/chain/canonical.js';

const SEED = 20261017; const NUM = 30000;
const results = [];
function run(name, prop, arb) {
  const t0 = Date.now();
  try { fc.assert(fc.property(arb, prop), { seed: SEED, numRuns: NUM, verbose: 0 }); results.push([name, 'PASS', Date.now() - t0 + ' ms']); }
  catch (e) { const m = String(e.message); results.push([name, 'FAIL', m.split('\n').slice(0, 6).join(' | ').slice(0, 420)]); }
}
// ---- parseRange
const sizeArb = fc.oneof(fc.nat(2000), fc.constant(0), fc.integer({ min: 0, max: Number.MAX_SAFE_INTEGER }));
const headerArb = fc.oneof(fc.string({ maxLength: 40 }), fc.tuple(fc.string({ maxLength: 8 }), fc.string({ maxLength: 8 })).map(([a, b]) => `bytes=${a}-${b}`), fc.tuple(fc.nat(5000), fc.nat(5000)).map(([a, b]) => `bytes=${a}-${b}`), fc.nat(5000).map((a) => `bytes=-${a}`), fc.nat(5000).map((a) => `bytes=${a}-`), fc.constantFrom('bytes=0-0', 'bytes=0-', 'bytes=-1', ' BYTES = 1 - 2 ', 'bytes=0-1,5-6', 'bytes=', 'bytes=-', 'items=0-1', 'bytes=1e3-2e3', 'bytes=0x10-0x20', 'bytes=١-٢', 'bytes=00-0', 'bytes=99999999999999999999-', 'bytes=0-99999999999999999999'));
run('parseRange never throws; result is null|416|{start<=end<size}', ([h, size]) => {
  const r = parseRange(h, size);
  if (r === null || r === 416) return true;
  return Number.isSafeInteger(r.start) && Number.isSafeInteger(r.end) && r.start >= 0 && r.start <= r.end && r.end <= size - 1;
}, fc.tuple(headerArb, sizeArb));
run('parseRange("bytes=a-b") = {a, min(b,size-1)} for 0<=a<=b, a<size', ([a, b, size]) => {
  fc.pre(a <= b && a < size);
  const r = parseRange(`bytes=${a}-${b}`, size); return r && r.start === a && r.end === Math.min(b, size - 1);
}, fc.tuple(fc.nat(100000), fc.nat(100000), fc.integer({ min: 1, max: 200000 })));
run('parseRange suffix "bytes=-n" = last n bytes (clamped)', ([n, size]) => {
  fc.pre(n >= 1 && size >= 1); const r = parseRange(`bytes=-${n}`, size); return r && r.end === size - 1 && r.start === Math.max(0, size - n);
}, fc.tuple(fc.nat(100000), fc.nat(100000)));
// ---- magnet
const hexArb = fc.uint8Array({ minLength: 20, maxLength: 20 }).map((u) => Array.from(u, (x) => x.toString(16).padStart(2, '0')).join(''));
const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
const toBase32 = (hex) => { const bytes = hex.match(/../g).map((x) => parseInt(x, 16)); let bits = '', out = ''; for (const b of bytes) bits += b.toString(2).padStart(8, '0'); for (let i = 0; i < bits.length; i += 5) out += B32[parseInt(bits.slice(i, i + 5), 2)]; return out; };
run('normalizeBtih(hex)=lowercase hex; normalizeBtih(base32(hex))=hex (both cases)', (hex) => normalizeBtih(hex.toUpperCase()) === hex && normalizeBtih(toBase32(hex)) === hex && normalizeBtih(toBase32(hex).toLowerCase()) === hex && normalizeBtih('urn:btih:' + hex) === hex, hexArb);
const urlish = fc.string({ maxLength: 30 });
run('formatMagnet -> parseMagnet round-trips btih/dn/tr/ws/xs (after trim+dedupe)', ([hex, dn, tr, ws, xs]) => {
  const m = formatMagnet({ btih: hex, dn, tr, ws, xs }); const p = parseMagnet(m);
  const norm = (l) => { const o = []; const seen = new Set(); for (const s of l) { const t = s.trim(); if (t && !seen.has(t)) { seen.add(t); o.push(t); } } return o; };
  return p && p.btih === hex && (p.dn ?? null) === ((dn && dn.trim()) ? dn.trim() : null) && JSON.stringify(p.tr) === JSON.stringify(norm(tr)) && JSON.stringify(p.ws) === JSON.stringify(norm(ws)) && JSON.stringify(p.xs) === JSON.stringify(norm(xs));
}, fc.tuple(hexArb, urlish, fc.array(urlish, { maxLength: 4 }), fc.array(urlish, { maxLength: 3 }), fc.array(urlish, { maxLength: 3 })));
run('parseMagnet never throws on arbitrary strings', (s) => { parseMagnet(s); return true; }, fc.oneof(fc.string({ maxLength: 120 }), fc.string({ maxLength: 60 }).map((s) => 'magnet:?' + s), fc.string({ maxLength: 60 }).map((s) => 'magnet:?xt=urn:btih:' + s + '&dn=%' + s)));
// ---- splitSitePath / entryFor
run('splitSitePath never throws; btih is 40 lowercase hex; entryFor never throws', (s) => {
  const r = splitSitePath(s); if (r) { if (!/^[0-9a-f]{40}$/.test(r.btih)) return false; entryFor(r.path, () => false); }
  return true;
}, fc.oneof(fc.string({ maxLength: 80 }), fc.tuple(hexArb, fc.string({ maxLength: 40 })).map(([h, p]) => `/_mw/s/${h}/${p}`)));
// ---- canonicalize (JCS) differential vs JSON.stringify(sortKeysDeep)
const ser = (v) => Array.isArray(v) ? '[' + v.map(ser).join(',') + ']' : (v && typeof v === 'object') ? '{' + Object.keys(v).sort().map((k) => JSON.stringify(k) + ':' + ser(v[k])).join(',') + '}' : JSON.stringify(v);
const jsonArb = fc.jsonValue({ maxDepth: 4 });
run('canonicalize == manual sorted-key serializer (differential oracle; naive JSON.stringify(sorted object) is WRONG for integer-like keys)', (v) => canonicalize(v) === ser(JSON.parse(JSON.stringify(v))), jsonArb);
run('canonicalize idempotent: canonicalize(JSON.parse(canonicalize(v))) === canonicalize(v)', (v) => { const c = canonicalize(v); return canonicalize(JSON.parse(c)) === c; }, jsonArb);
const keyArb = fc.oneof(fc.string({ maxLength: 6 }), fc.constantFrom('__proto__', 'constructor', 'prototype', 'toString', 'é', 'é', '😀', '￿', '\u0000'));
run('canonicalize is independent of object key insertion order (incl. __proto__ keys)', (entries) => {
  const mk = (es) => { const o = {}; for (const [k, v] of es) Object.defineProperty(o, k, { value: v, enumerable: true, configurable: true, writable: true }); return o; };
  const dedup = [...new Map(entries).entries()];
  const a = mk(dedup), b = mk([...dedup].reverse());
  return canonicalize(a) === canonicalize(b);
}, fc.array(fc.tuple(keyArb, fc.integer()), { maxLength: 8 }));
run('canonicalize(lone surrogate strings) matches JSON.stringify (well-formed JSON.stringify)', (s) => canonicalize(s) === JSON.stringify(s), fc.string({ unit: 'binary', maxLength: 12 }));
for (const r of results) console.log(r[1].padEnd(5), r[0], '=>', r[2]);
