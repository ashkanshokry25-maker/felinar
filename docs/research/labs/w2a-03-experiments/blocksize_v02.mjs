// Block sizes under ARCHITECTURE v0.2 section 6.1 (payload outside the hash: op carries vh, value v is stored beside e).
import { canonicalize, hex, b64url, utf8 } from '$HOME/Documents/Projects/magnet-web/src/chain/canonical.js';
import { generateKeyPair, exportPublicKey, sign, sha256 } from '$HOME/Documents/Projects/magnet-web/src/chain/crypto.js';
const kp = await generateKeyPair({ extractable: false });
const pub = await exportPublicKey(kp.publicKey);
const ledgerId = 'mw1:' + 'A'.repeat(27);              // "mw1:" + b64url(sha256(...)).slice(0,27)
const fakeHash = (i) => hex.encode(new Uint8Array(32).fill(i & 255));
async function mk(opKind, v, prevN) {
  const vh = hex.encode(await sha256(utf8.encode(canonicalize(v))));
  const op = opKind.t === 'put' ? { t: 'put', k: opKind.k, vh } : opKind.t === 'append' ? { t: 'append', l: opKind.l, vh } : { t: 'profile', vh };
  const e = { v: 1, site: ledgerId, author: pub, seq: 7, prev: Array.from({ length: prevN }, (_, i) => fakeHash(i + 1)).sort(), ts: 1792270020000, bits: 16, op, nonce: '48213' };
  const h = hex.encode(await sha256(utf8.encode(canonicalize(e))));
  const s = b64url.encode(await sign(kp.privateKey, utf8.encode('mw-block-v1\n' + h)));
  const block = { e, h, s, v };
  const limitBytes = utf8.encode(canonicalize(e)).length + utf8.encode(canonicalize(v)).length;
  return { wire: utf8.encode(canonicalize(block)).length, limitBytes, entry: utf8.encode(canonicalize(e)).length, value: utf8.encode(canonicalize(v)).length };
}
const t = (n) => 'x'.repeat(n);
const cases = [
  ['comment 200 chars (append comments)', { t: 'append', l: 'comments' }, { text: t(200), parent: null, name: 'alice' }],
  ['comment 1000 chars', { t: 'append', l: 'comments' }, { text: t(1000), parent: fakeHash(9), name: 'alice' }],
  ['like (put like/<t8>/<a8>, v=1)', { t: 'put', k: 'like/ab12cd34/9f3e7a1c' }, 1],
  ['emoji reaction (put react/..., v={e})', { t: 'put', k: 'react/ab12cd34/9f3e7a1c' }, { e: '❤️' }],
  ['profile name', { t: 'profile' }, 'alice'],
];
for (const [label, opk, v] of cases) for (const prevN of [1, 8]) {
  const r = await mk(opk, v, prevN);
  console.log(`${label} | prev=${prevN} | wire JSON ${r.wire} B | counted toward maxBlockBytes (e+v) ${r.limitBytes} B (e ${r.entry} + v ${r.value})`);
}
// sealed inbox: ECDH P-256 eph + HKDF + AES-256-GCM => b64url(eph65 | iv12 | ct | tag16)
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
for (const maxV of [2048, 3000]) {
  let lo = 0, hi = 4096;
  while (lo < hi) { const mid = (lo + hi + 1) >> 1; const sv = await seal(t(mid)); const vlen = utf8.encode(canonicalize({ c: sv })).length; if (vlen <= maxV) lo = mid; else hi = mid - 1; }
  console.log(`max sealed plaintext when canonical(v) <= ${maxV} B (v = {"c": b64url}): ${lo} bytes`);
}
const r300 = await mk({ t: 'append', l: 'inbox' }, { c: await seal(t(300)) }, 2);
const r1000 = await mk({ t: 'append', l: 'inbox' }, { c: await seal(t(1000)) }, 2);
console.log(`sealed inbox 300 B plaintext: wire ${r300.wire} B, e+v ${r300.limitBytes} B; 1000 B plaintext: wire ${r1000.wire} B, e+v ${r1000.limitBytes} B`);
// how many blocks fit in 8 MiB / 64 MiB if each counts its wire size
for (const [label, bytes] of [['like prev=1', (await mk({ t: 'put', k: 'like/ab12cd34/9f3e7a1c' }, 1, 1)).wire], ['like prev=8', (await mk({ t: 'put', k: 'like/ab12cd34/9f3e7a1c' }, 1, 8)).wire], ['comment200 prev=2', (await mk({ t: 'append', l: 'comments' }, { text: t(200), parent: null, name: 'alice' }, 2)).wire]]) {
  console.log(`${label}: ${bytes} B each -> 8 MiB holds ${Math.floor(8 * 1048576 / bytes)} blocks; 64 MiB holds ${Math.floor(64 * 1048576 / bytes)} blocks`);
}
