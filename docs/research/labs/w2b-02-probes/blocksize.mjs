// Size model: how big is a magnet-web chain block when carried as a Nostr event (3 encodings)? Uses the project's real canonicalize().
const { canonicalize, b64url, hex, utf8 } = await import(new URL('../../../../src/chain/canonical.js', import.meta.url).href);
import { webcrypto as crypto, createHash } from 'node:crypto';
const sha = (u8) => createHash('sha256').update(u8).digest();
const kp = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
const pub = b64url.encode(new Uint8Array(await crypto.subtle.exportKey('raw', kp.publicKey)));
const rnd = (n) => hex.encode(crypto.getRandomValues(new Uint8Array(n)));
function mkBlock(valueBytes, nprev) {
  const e = { v: 1, site: 'host:example.com', author: pub, seq: 1234, prev: Array.from({ length: nprev }, () => rnd(32)), ts: Date.now(), op: { t: 'append', l: 'guestbook', v: { name: 'Ash', text: 'x'.repeat(valueBytes) } }, nonce: 'k3j2h' };
  const h = hex.encode(sha(utf8.encode(canonicalize(e))));
  const s = b64url.encode(crypto.getRandomValues(new Uint8Array(64)));
  return { e, h, s };
}
const out = [];
for (const [label, vb, np] of [['typical guestbook post (140 B text, 2 heads)', 140, 2], ['medium (2 KiB value, 3 heads)', 2048, 3], ['max policy value (8 KiB, 8 heads)', 8192, 8]]) {
  const blk = mkBlock(vb, np);
  const canon = canonicalize(blk); const canonBytes = utf8.encode(canon).length;
  // W1: wrapper, content = canonical block JSON as a string
  const w1content = canon;
  const w2content = b64url.encode(utf8.encode(canon));
  const tags = [['d', blk.h], ['t', rnd(8)], ['x', blk.h]];                       // d = block hash (addressable), t = chain tag, x = block hash for exact lookups
  const mk = (kind, content, tg) => { const ev = { id: rnd(32), pubkey: rnd(32), created_at: Math.floor(Date.now() / 1000), kind, tags: tg, content, sig: rnd(64) }; return utf8.encode(JSON.stringify(ev)).length; };
  const w1 = mk(30311, w1content, tags), w2 = mk(30311, w2content, tags);
  // N: native — the block IS the event: tags carry parents; content = op JSON; PoW in nonce tag; (P-256 data replaced by Schnorr: no author field)
  const nativeTags = [['t', rnd(8)], ...blk.e.prev.map((p) => ['e', p, '', 'prev']), ['nonce', '12345', '14']];
  const n = mk(1311, JSON.stringify(blk.e.op), nativeTags);
  out.push({ label, canon_block_bytes: canonBytes, wrapper_escaped_json_event_bytes: w1, wrapper_base64url_event_bytes: w2, native_event_bytes: n,
    overhead_wrapper_b64_pct: Math.round((w2 / canonBytes - 1) * 100), strfry_maxEventSize_ok: [w1 <= 65536, w2 <= 65536, n <= 65536], relay_128KB_ws_ok: w2 + 10 <= 131072 });
}
for (const o of out) console.log(JSON.stringify(o));
// NIP-13 PoW on an event id: how long does 14 bits (and 16, 20) take with node:crypto sha256 (stand-in for noble/WebCrypto)?
function mine(bits) {
  let n = 0; const t0 = performance.now();
  for (;;) {
    const s = '[0,"' + 'a'.repeat(64) + '",1790000000,30311,[["d","' + 'b'.repeat(64) + '"],["nonce","' + n + '","' + bits + '"]],"' + 'z'.repeat(600) + '"]';
    const id = createHash('sha256').update(s).digest();
    let z = 0; for (const byte of id) { if (byte === 0) { z += 8; continue; } z += Math.clz32(byte) - 24; break; }
    if (z >= bits) return { bits, hashes: n + 1, ms: Math.round(performance.now() - t0) };
    n++;
  }
}
const rep = (bits) => { const r = []; for (let i = 0; i < 5; i++) r.push(mine(bits)); r.sort((a, b) => a.hashes - b.hashes); return { bits, median_hashes: r[2].hashes, median_ms: r[2].ms, all_hashes: r.map(x => x.hashes) }; };
for (const b of [14, 16, 20]) console.log(JSON.stringify(rep(b)));
