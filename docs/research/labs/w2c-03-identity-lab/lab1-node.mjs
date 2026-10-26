// Lab 1 (Node 24): deterministic P-256 identity from a 32-byte seed using only WebCrypto + noble,
// PKCS8-without-public-key import behaviour, keygen throughput, fingerprint-forgery rate.
import { webcrypto as wc, generateKeyPairSync, createECDH, createHash } from 'node:crypto';
import { p256 } from '@noble/curves/nist.js';
import { sha256 } from '@noble/hashes/sha2.js';
import os from 'node:os';

const b64u = (u8) => Buffer.from(u8).toString('base64url');
const hex = (u8) => Buffer.from(u8).toString('hex');
const enc = new TextEncoder();
const out = {};
out.env = { node: process.version, cpu: os.cpus()[0].model, cores: os.cpus().length, platform: process.platform + '/' + process.arch };

// ---- 1. HKDF(seed) -> P-256 scalar (FIPS 186-5 B.4.1 style: 48 bytes mod (n-1), +1) ----
const n = p256.Point.CURVE().n;
async function deriveScalar(seed, info) {
  const k = await wc.subtle.importKey('raw', seed, 'HKDF', false, ['deriveBits']);
  const bits = await wc.subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt: enc.encode('mw/id/v1'), info: enc.encode(info) }, k, 384);
  let v = 0n; for (const b of new Uint8Array(bits)) v = (v << 8n) | BigInt(b);
  const d = (v % (n - 1n)) + 1n;
  const bytes = new Uint8Array(32); let t = d; for (let i = 31; i >= 0; i--) { bytes[i] = Number(t & 0xffn); t >>= 8n; }
  return bytes;
}
const seed = wc.getRandomValues(new Uint8Array(32));
const dA = await deriveScalar(seed, 'p256|chain:host:example.com');
const dA2 = await deriveScalar(seed, 'p256|chain:host:example.com');
const dB = await deriveScalar(seed, 'p256|chain:host:other.example');
out.deterministic = hex(dA) === hex(dA2);
out.perChainDiffers = hex(dA) !== hex(dB);

const pub = p256.getPublicKey(dA, false); // 65 bytes
const ecdh = createECDH('prime256v1'); ecdh.setPrivateKey(Buffer.from(dA));
out.nobleMatchesOpenSSL = hex(pub) === hex(ecdh.getPublicKey());
out.pubLen = pub.length;

// ---- 2. import as NON-extractable key via JWK (works everywhere WebCrypto P-256 JWK import works) ----
const jwk = { kty: 'EC', crv: 'P-256', d: b64u(dA), x: b64u(pub.slice(1, 33)), y: b64u(pub.slice(33, 65)) };
const priv = await wc.subtle.importKey('jwk', jwk, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);
const pubKey = await wc.subtle.importKey('raw', pub, { name: 'ECDSA', namedCurve: 'P-256' }, true, ['verify']);
const msg = enc.encode('hello block hash');
const sig = await wc.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, priv, msg);
out.jwkImport = { extractable: priv.extractable, sigLen: sig.byteLength, verifies: await wc.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, pubKey, sig, msg) };
try { await wc.subtle.exportKey('jwk', priv); out.jwkImport.exportBlocked = false; } catch (e) { out.jwkImport.exportBlocked = e.name; }

// ---- 3. PKCS8 import WITHOUT embedded public key (no scalar-mult needed in the browser?) ----
function der(tag, ...parts) { const body = Buffer.concat(parts); const len = body.length < 128 ? Buffer.from([body.length]) : Buffer.from([0x81, body.length]); return Buffer.concat([Buffer.from([tag]), len, body]); }
const oidEcPub = Buffer.from('06072a8648ce3d0201', 'hex'), oidP256 = Buffer.from('06082a8648ce3d030107', 'hex');
const ecPriv = der(0x30, Buffer.from('020101', 'hex'), der(0x04, Buffer.from(dA)));
const pkcs8 = der(0x30, Buffer.from('020100', 'hex'), der(0x30, oidEcPub, oidP256), der(0x04, ecPriv));
try {
  const k2 = await wc.subtle.importKey('pkcs8', pkcs8, { name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign']);
  const j = await wc.subtle.exportKey('jwk', k2);
  out.pkcs8NoPub = { node_ok: true, xyMatches: j.x === jwk.x && j.y === jwk.y };
} catch (e) { out.pkcs8NoPub = { node_ok: false, err: e.message }; }

// ---- 4. throughput: OpenSSL keygen (fingerprint-forgery by brute keygen) ----
{
  const t0 = performance.now(); let c = 0;
  while (performance.now() - t0 < 2500) { generateKeyPairSync('ec', { namedCurve: 'prime256v1' }); c++; }
  out.opensslKeygenPerSec = Math.round(c / ((performance.now() - t0) / 1000));
}
// ---- 5. incremental attack in pure JS (point += G, SHA-256 of pub): LOWER BOUND for an attacker ----
{
  let P = p256.Point.BASE; const G = p256.Point.BASE; const t0 = performance.now(); let c = 0;
  while (performance.now() - t0 < 2500) { P = P.add(G); sha256(P.toBytes(false)); c++; }
  out.nobleIncrementalPerSec = Math.round(c / ((performance.now() - t0) / 1000));
}
// ---- 6. fingerprint-forgery arithmetic from measured rates ----
const rates = { opensslKeygen: out.opensslKeygenPerSec, nobleIncremental: out.nobleIncrementalPerSec };
out.forgeryHours = {};
for (const bits of [32, 48, 64]) {
  out.forgeryHours[bits] = {
    singleCoreOpenSSLKeygen_hours: +((2 ** bits) / rates.opensslKeygen / 3600).toPrecision(3),
    singleCoreNobleIncremental_hours: +((2 ** bits) / rates.nobleIncremental / 3600).toPrecision(3),
    at_1e9_per_sec_hours: +((2 ** bits) / 1e9 / 3600).toPrecision(3),
  };
}
// birthday collisions: number of identities for 50% chance of ANY two sharing a short id
out.birthday50pct = { 32: Math.round(1.1774 * 2 ** 16), 48: Math.round(1.1774 * 2 ** 24), 64: Math.round(1.1774 * 2 ** 32) };
console.log(JSON.stringify(out, null, 2));
