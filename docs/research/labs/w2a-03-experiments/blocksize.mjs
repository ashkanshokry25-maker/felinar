import { canonicalize, hex, b64url, utf8 } from '$HOME/Documents/Projects/magnet-web/src/chain/canonical.js';
import { generateKeyPair, exportPublicKey, sign, verify, sha256, importPublicKey } from '$HOME/Documents/Projects/magnet-web/src/chain/crypto.js';

const kp = await generateKeyPair({ extractable: false });
const pub = await exportPublicKey(kp.publicKey);
const siteId = 'host:example.com';
const fakeHash = (i) => hex.encode(new Uint8Array(32).fill(i & 255));

async function mkBlock(op, seq = 7, prevN = 2) {
  const e = { v: 1, site: siteId, author: pub, seq, prev: Array.from({ length: prevN }, (_, i) => fakeHash(i + 1)), ts: 1792270000000, op, nonce: '48213' };
  const canon = canonicalize(e);
  const hBytes = await sha256(utf8.encode(canon));
  const h = hex.encode(hBytes);
  const s = b64url.encode(await sign(kp.privateKey, hBytes));
  const block = { e, h, s };
  return { block, bytes: utf8.encode(canonicalize(block)).length, entryBytes: utf8.encode(canon).length };
}
const text = (n) => 'x'.repeat(n);
const cases = [
  ['guestbook/comment, 200-char text', { t: 'append', l: 'comments', v: { text: text(200), parent: null, name: 'alice' } }],
  ['comment, 1000-char text', { t: 'append', l: 'comments', v: { text: text(1000), parent: fakeHash(9), name: 'alice' } }],
  ['reaction/like as put (key like/<target8>/<author8>, v=1)', { t: 'put', k: 'like/ab12cd34/9f3e7a1c', v: 1 }],
  ['reaction with emoji kind', { t: 'put', k: 'react/ab12cd34/9f3e7a1c', v: { e: '❤️' } }],
  ['profile name', { t: 'profile', name: 'alice' }],
];
for (const [label, op] of cases) {
  for (const prevN of [1, 8]) {
    const r = await mkBlock(op, 7, prevN);
    console.log(`${label} | prev=${prevN} | block JSON ${r.bytes} B (entry ${r.entryBytes} B)`);
  }
}

// Encrypted inbox message: ECDH P-256 ephemeral -> HKDF-SHA256 -> AES-256-GCM (HPKE-like base mode shape) to the owner's P-256 key
const owner = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
async function seal(plain) {
  const eph = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
  const secret = await crypto.subtle.deriveBits({ name: 'ECDH', public: owner.publicKey }, eph.privateKey, 256);
  const hk = await crypto.subtle.importKey('raw', secret, 'HKDF', false, ['deriveKey']);
  const aes = await crypto.subtle.deriveKey({ name: 'HKDF', hash: 'SHA-256', salt: new Uint8Array(0), info: utf8.encode('mw/inbox/v1') }, hk, { name: 'AES-GCM', length: 256 }, false, ['encrypt']);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, aes, utf8.encode(plain)));
  const ephRaw = new Uint8Array(await crypto.subtle.exportKey('raw', eph.publicKey));
  return b64url.encode(new Uint8Array([...ephRaw, ...iv, ...ct]));
}
for (const n of [300, 1000, 4000]) {
  const sealed = await seal(text(n));
  const r = await mkBlock({ t: 'append', l: 'inbox', v: { c: sealed } }, 7, 2);
  console.log(`encrypted inbox msg, plaintext ${n} B -> sealed b64url ${sealed.length} chars -> block ${r.bytes} B (limit 16384; value limit 8192)`);
}
// Max plaintext that fits value limit 8192 (canonical JSON of v)
let lo = 0, hi = 8192;
while (lo < hi) { const mid = (lo + hi + 1) >> 1; const s = await seal(text(mid)); const vlen = utf8.encode(canonicalize({ c: s })).length; if (vlen <= 8192) lo = mid; else hi = mid - 1; }
console.log('max inbox plaintext under 8192 B value limit:', lo, 'bytes');

// Verification throughput (project crypto.js verify with b64url pub)
const { block } = await mkBlock({ t: 'put', k: 'like/ab12cd34/9f3e7a1c', v: 1 }, 7, 2);
const hBytes = hex.decode(block.h);
const sig = b64url.decode(block.s);
const pk = await importPublicKey(pub);
let N = 3000, t0 = performance.now();
for (let i = 0; i < N; i++) { const ok = await crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, pk, sig, hBytes); if (!ok) throw new Error('bad'); }
let dt = performance.now() - t0;
console.log(`ECDSA P-256 verify, sequential (raw subtle.verify on 32-byte message): ${(N / (dt / 1000)).toFixed(0)} verifies/s (${(dt / N).toFixed(3)} ms each)`);
t0 = performance.now();
await Promise.all(Array.from({ length: N }, () => crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, pk, sig, hBytes)));
dt = performance.now() - t0;
console.log(`ECDSA P-256 verify, ${N} in flight: ${(N / (dt / 1000)).toFixed(0)} verifies/s`);
t0 = performance.now();
for (let i = 0; i < 1000; i++) await sign(kp.privateKey, hBytes);
dt = performance.now() - t0;
console.log(`ECDSA P-256 sign (project sign()): ${(1000 / (dt / 1000)).toFixed(0)} signs/s`);
// full ingest pipeline estimate: canonicalize + sha256 + verify
t0 = performance.now();
for (let i = 0; i < 2000; i++) { const c = utf8.encode(canonicalize(block.e)); const hh = await sha256(c); await verify(pub, hh, sig); }
dt = performance.now() - t0;
console.log(`full per-block ingest check (canonicalize+sha256+verify via project verify()): ${(2000 / (dt / 1000)).toFixed(0)} blocks/s -> 100k blocks = ${(100000 / (2000 / (dt / 1000))).toFixed(1)} s on this M3 (Node 24, single thread)`);
console.log('node', process.version);
