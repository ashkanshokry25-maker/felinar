// Usage: node link-sizes.mjs. Byte size of a signed hub-form light link with owner doors (org=) and guest doors (dr=), and the QR version it needs.
// QR capacities: https://www.thonky.com/qr-code-tutorial/character-capacities (fetched 2026-10-20). Behind S4-doors.md finding F1.
// S4 lab: byte size of a signed hub-form light link as doors are added. Uses the project's own pointer.js and crypto.js.
import { resolve as __resolve, dirname as __dirname } from 'node:path';
import { fileURLToPath as __fu } from 'node:url';
const ROOT = __resolve(__dirname(__fu(import.meta.url)), '../../../..');
const P = await import(ROOT + '/src/common/pointer.js');
const C = await import(ROOT + '/src/chain/crypto.js');
const { privateKey, publicKey } = await C.generateKeyPair({ extractable: true });
const owner = await C.exportPublicKey(publicKey);
const btih = 'a'.repeat(40);
const now = Math.floor(Date.now() / 1000);
const base = {
  v: 'mw1', btih, dn: 'my-site', owner, chain: 'my-site', seq: now, exp: now + 90 * 86400,
  tr: ['wss://tracker.example.org/announce', 'wss://t2.example.net/announce'],
  ws: ['https://seed.example.org/ws/'], xs: ['https://seed.example.org/ws/my-site.torrent'],
};
const hosts = ['door-one.example.org', 'door-two.example.net', 'mirror.example.com', 'cdn3.example.io', 'alt.example.dev', 'edge.example.app', 'w.example.page', 'x.example.site'];
async function sizeWith(extraDoors, orgs) {
  const rec = Object.assign({}, base);
  if (orgs) rec.org = orgs.map((h) => 'https://' + h);
  if (extraDoors && extraDoors.length) rec.extra = { dr: extraDoors.join(',') };
  const signed = await P.signPointer(rec, 'btih:' + btih, privateKey);
  const text = P.formatPointer(signed);
  return { text, bytes: new TextEncoder().encode(text).length };
}
const rows = [];
for (const [label, extra, orgs] of [
  ['hub record, no doors', null, null],
  ['+ org= 2 owner doors', null, hosts.slice(0, 2)],
  ['+ org= 4 owner doors (the ORG_MAX cap)', null, hosts.slice(0, 4)],
  ['+ dr= 4 guest doors (comma list, one key)', hosts.slice(0, 4), null],
  ['+ dr= 8 guest doors', hosts.slice(0, 8), null],
  ['org= 4 + dr= 8', hosts.slice(0, 8), hosts.slice(0, 4)],
]) {
  try { const r = await sizeWith(extra, orgs); rows.push({ label, bytes: r.bytes }); }
  catch (e) { rows.push({ label, error: String(e.message || e).slice(0, 100) }); }
}
const door = 'https://door-one.example.org/#';
console.log(JSON.stringify({ privateKeyUnused: true, rows, urlPrefixBytes: door.length }, null, 1));
// QR byte-mode capacities (Thonky table, fetched 2026-10-20): [version, L, M, Q, H]
const cap = [[8,192,152,108,84],[9,230,180,130,98],[10,271,213,151,119],[11,321,251,177,137],[12,367,287,203,155],[13,425,331,241,177],[14,458,362,258,194],[15,520,412,292,220],[16,586,450,322,250],[17,644,504,364,280],[18,718,560,394,310],[19,792,624,442,338],[20,858,666,482,382],[21,929,711,509,403],[22,1003,779,565,439],[23,1091,857,611,461],[24,1171,911,661,511],[25,1273,997,715,535]];
const lvl = { L: 1, M: 2, Q: 3, H: 4 };
const qr = (n, l) => { const r = cap.find((c) => c[lvl[l]] >= n); return r ? 'v' + r[0] + ' (' + (17 + 4 * r[0]) + 'x' + (17 + 4 * r[0]) + ')' : '>v25'; };
console.log('QR version for URL (door prefix + fragment) at L / M / Q:');
for (const r of rows) if (r.bytes) { const n = r.bytes + door.length; console.log(String(n).padStart(5), 'bytes', qr(n, 'L'), qr(n, 'M'), qr(n, 'Q'), '|', r.label); }
process.exit(0);
