// Bench: signature verify/sign throughput (single thread, Node 24, this machine). Bundled by esbuild; no network.
import * as secp from '@noble/secp256k1';
import { hmac } from '@noble/hashes/hmac.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { schnorr as curvesSchnorr } from '@noble/curves/secp256k1.js';
import { finalizeEvent, verifyEvent, generateSecretKey, getPublicKey } from 'nostr-tools/pure';
import * as wasmMod from 'nostr-tools/wasm';
import { initNostrWasm } from 'nostr-wasm';
secp.hashes.hmacSha256 = (key, msg) => hmac(sha256, key, msg);
secp.hashes.sha256 = sha256;
const subtle = globalThis.crypto.subtle;
function bench(name, fn, ms = 1500) {
  for (let i = 0; i < 20; i++) fn();               // warm-up
  let n = 0; const t0 = performance.now();
  while (performance.now() - t0 < ms) { fn(); n++; }
  const dt = performance.now() - t0; return { name, ops_s: Math.round(n / dt * 1000), us_op: Math.round(dt / n * 1000) };
}
async function abench(name, fn, ms = 1500) {
  for (let i = 0; i < 20; i++) await fn();
  let n = 0; const t0 = performance.now();
  while (performance.now() - t0 < ms) { await fn(); n++; }
  const dt = performance.now() - t0; return { name, ops_s: Math.round(n / dt * 1000), us_op: Math.round(dt / n * 1000) };
}
const out = [];
const msg32 = sha256(new TextEncoder().encode('magnet-web block hash'));
// 1) @noble/secp256k1 3.2.0 schnorr
{ const { secretKey, publicKey } = secp.schnorr.keygen(); const sig = secp.schnorr.sign(msg32, secretKey);
  out.push(bench('noble-secp256k1 3.2.0 schnorr.sign (sync)', () => secp.schnorr.sign(msg32, secretKey)));
  out.push(bench('noble-secp256k1 3.2.0 schnorr.verify (sync)', () => { if (!secp.schnorr.verify(sig, msg32, publicKey)) throw 1; })); }
// 2) @noble/curves 2.4.0 schnorr
{ const sk = curvesSchnorr.utils.randomSecretKey(); const pk = curvesSchnorr.getPublicKey(sk); const sig = curvesSchnorr.sign(msg32, sk);
  out.push(bench('noble-curves 2.4.0 schnorr.sign', () => curvesSchnorr.sign(msg32, sk)));
  out.push(bench('noble-curves 2.4.0 schnorr.verify', () => { if (!curvesSchnorr.verify(sig, msg32, pk)) throw 1; })); }
// 3) nostr-tools 2.25.2 event sign/verify (id hash + schnorr) on a ~1 KB event
function mkEvent() { const sk = generateSecretKey(); return finalizeEvent({ kind: 30078, created_at: Math.floor(Date.now() / 1000), tags: [['d', 'x'.repeat(64)], ['t', 'y'.repeat(64)]], content: 'z'.repeat(900) }, sk); }
{ const sk = generateSecretKey(); const tmpl = () => ({ kind: 30078, created_at: Math.floor(Date.now() / 1000), tags: [['d', 'x'.repeat(64)], ['t', 'y'.repeat(64)]], content: 'z'.repeat(900) });
  out.push(bench('nostr-tools 2.25.2 finalizeEvent (hash+sign, ~1 KB event)', () => finalizeEvent(tmpl(), sk)));
  const ev = mkEvent();
  out.push(bench('nostr-tools 2.25.2 verifyEvent (hash+verify, JS, ~1 KB event)', () => { if (!verifyEvent({ ...ev })) throw 1; })); // spread to bypass verifiedSymbol cache
  wasmMod.setNostrWasm(await initNostrWasm());
  out.push(bench('nostr-tools verifyEvent via nostr-wasm 0.1.0 (~1 KB event)', () => { if (!wasmMod.verifyEvent({ ...ev })) throw 1; })); }
// 4) WebCrypto references
{ const kp = await subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign', 'verify']);
  const sig = new Uint8Array(await subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, kp.privateKey, msg32));
  out.push(await abench('WebCrypto ECDSA P-256 verify (Node 24 async)', async () => { if (!(await subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, kp.publicKey, sig, msg32))) throw 1; }));
  out.push(await abench('WebCrypto ECDSA P-256 sign (Node 24 async)', async () => { await subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, kp.privateKey, msg32); }));
  try { const ek = await subtle.generateKey({ name: 'Ed25519' }, false, ['sign', 'verify']);
    const es = new Uint8Array(await subtle.sign({ name: 'Ed25519' }, ek.privateKey, msg32));
    out.push(await abench('WebCrypto Ed25519 verify (Node 24 async)', async () => { if (!(await subtle.verify({ name: 'Ed25519' }, ek.publicKey, es, msg32))) throw 1; }));
  } catch (e) { out.push({ name: 'WebCrypto Ed25519', error: String(e) }); } }
// 5) SHA-256 id hashing of a 1 KB event (noble JS) for context
out.push(bench('noble-hashes 2.4.0 sha256 over 1 KB', () => sha256(new Uint8Array(1024))));
for (const r of out) console.log(JSON.stringify(r));
console.log(JSON.stringify({ node: process.version, platform: process.platform + '/' + process.arch, cpu: (await import('node:os')).cpus()[0].model }));
