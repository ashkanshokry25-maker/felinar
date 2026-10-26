// v0.2-shaped block (ARCHITECTURE s6.1): e={v,site,author,seq,prev[],ts,bits,op:{t,l,vh},nonce}; Block={e,h,s,v?}. Size of the Nostr wrapper event (kind-agnostic) and compression.
const { canonicalize, b64url, hex, utf8 } = await import(new URL('../../../../src/chain/canonical.js', import.meta.url).href);
import { webcrypto as crypto, createHash } from 'node:crypto';
import zlib from 'node:zlib';
const sha = (u8) => createHash('sha256').update(u8).digest();
const rnd = (n) => hex.encode(crypto.getRandomValues(new Uint8Array(n)));
const authors = []; for (let i = 0; i < 20; i++) { const kp = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign']); authors.push(b64url.encode(new Uint8Array(await crypto.subtle.exportKey('raw', kp.publicKey)))); }
const ledgerId = 'mw1:' + b64url.encode(sha(utf8.encode('owner|example.com'))).slice(0, 27);
const words = 'the quick brown fox jumps over a lazy dog while peers gossip about ledgers and guestbook entries across browsers every day'.split(' ');
const text = (n) => { let s = ''; while (s.length < n) s += words[Math.floor(Math.random() * words.length)] + ' '; return s.slice(0, n); };
function mkBlock(vbytes, nprev, withV = true) {
  const v = { name: 'Visitor' + Math.floor(Math.random() * 50), text: text(vbytes) };
  const e = { v: 1, site: ledgerId, author: authors[Math.floor(Math.random() * 20)], seq: Math.floor(Math.random() * 500), prev: Array.from({ length: nprev }, () => rnd(32)).sort(), ts: Math.floor(Date.now() / 60000) * 60000, bits: 16, op: { t: 'append', l: 'guestbook', vh: hex.encode(sha(utf8.encode(canonicalize(v)))) }, nonce: rnd(4) };
  const h = hex.encode(sha(utf8.encode(canonicalize(e)))); const s = b64url.encode(crypto.getRandomValues(new Uint8Array(64)));
  return withV ? { e, h, s, v } : { e, h, s };
}
const wrapper = (blk, kind = 7777) => { const content = b64url.encode(utf8.encode(canonicalize(blk))); const ev = { id: rnd(32), pubkey: rnd(32), created_at: Math.floor(Date.now() / 1000), kind, tags: [['t', ledgerId], ['x', blk.h]], content, sig: rnd(64) }; return JSON.stringify(ev); };
const row = (label, blk) => { const canon = canonicalize(blk); const cb = utf8.encode(canon).length; const w = wrapper(blk); const wb = utf8.encode(w).length; const defl = zlib.deflateRawSync(w, { level: 6 }).length; return { label, canonical_block_bytes: cb, wrapper_event_bytes: wb, deflated_event_bytes: defl, overhead_vs_block: +(wb / cb).toFixed(2) }; };
console.log(JSON.stringify(row('typical post (140 B text, 2 heads)', mkBlock(140, 2))));
console.log(JSON.stringify(row('guestbook max-ish (1 KiB text, 3 heads)', mkBlock(1024, 3))));
console.log(JSON.stringify(row('value at default maxValueBytes (~2 KiB text, 8 heads)', mkBlock(1990, 8))));
console.log(JSON.stringify(row('v-less skeleton (tombstoned, 2 heads)', mkBlock(140, 2, false))));
// compression over 2000 typical events: per-message deflate vs one stream (context takeover)
const evs = Array.from({ length: 2000 }, () => wrapper(mkBlock(60 + Math.floor(Math.random() * 200), 1 + Math.floor(Math.random() * 3))));
const raw = evs.reduce((a, s) => a + utf8.encode(s).length, 0);
const per = evs.reduce((a, s) => a + zlib.deflateRawSync(s, { level: 6 }).length, 0);
const stream = zlib.deflateRawSync(evs.join('\n'), { level: 6 }).length;
console.log(JSON.stringify({ events: 2000, raw_bytes: raw, avg_raw: Math.round(raw / 2000), per_message_deflate_bytes: per, avg_per_message: Math.round(per / 2000), ratio_per_message: +(per / raw).toFixed(2), one_stream_bytes: stream, ratio_one_stream: +(stream / raw).toFixed(2) }));
// worst case under maxBlockBytes=4096
const big = mkBlock(1990, 8); console.log(JSON.stringify({ worst_case_note: 'v0.2 maxBlockBytes 4096 (canonical(e)+canonical(v))', canon_e_plus_v: utf8.encode(canonicalize(big.e)).length + utf8.encode(canonicalize(big.v)).length, wrapper_bytes: utf8.encode(wrapper(big)).length }));
// snapshot (gzip JSON array of blocks, as `snapshot.mjs` would write) compression for the same 2000 typical blocks
const blocks = Array.from({ length: 2000 }, () => mkBlock(60 + Math.floor(Math.random() * 200), 1 + Math.floor(Math.random() * 3)));
const json = JSON.stringify(blocks); const gz = zlib.gzipSync(json, { level: 9 }).length; const br = zlib.brotliCompressSync(json).length;
console.log(JSON.stringify({ snapshot_blocks: 2000, json_bytes: json.length, avg_block_bytes: Math.round(json.length / 2000), gzip9_bytes: gz, gzip_ratio: +(gz / json.length).toFixed(2), brotli_bytes: br, brotli_ratio: +(br / json.length).toFixed(2), extrapolated_13_6k_blocks_gz_MiB: +(13600 * gz / 2000 / 1048576).toFixed(1) }));
