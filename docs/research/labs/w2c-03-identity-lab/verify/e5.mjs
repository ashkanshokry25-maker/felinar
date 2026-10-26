// E5: which "modern" WebCrypto algorithms does the installed engine actually support?  (Argon2 vs the Chrome 155/154 set)
import * as pw from '$HOME/Documents/Projects/magnet-web/node_modules/playwright/index.mjs';
import http from 'node:http';
const engine = process.argv[2];
const srv = http.createServer((req, res) => { res.writeHead(200, { 'content-type': 'text/html' }).end('<!doctype html><title>e5</title>e5'); });
await new Promise((r) => srv.listen(0, '127.0.0.1', r));
const browser = await pw[engine].launch({ headless: true }); const page = await (await browser.newContext()).newPage();
await page.goto(`http://localhost:${srv.address().port}/`);
const out = await page.evaluate(async () => {
  const o = { ua: navigator.userAgent.slice(-60), hasSupportsStatic: typeof SubtleCrypto !== 'undefined' && typeof SubtleCrypto.supports };
  const probes = {
    'ML-KEM-768 generateKey': () => crypto.subtle.generateKey({ name: 'ML-KEM-768' }, false, ['encapsulateKey', 'decapsulateKey']),
    'ML-KEM-1024 generateKey': () => crypto.subtle.generateKey({ name: 'ML-KEM-1024' }, false, ['encapsulateKey', 'decapsulateKey']),
    'ML-DSA-65 generateKey': () => crypto.subtle.generateKey({ name: 'ML-DSA-65' }, false, ['sign', 'verify']),
    'ChaCha20-Poly1305 generateKey': () => crypto.subtle.generateKey({ name: 'ChaCha20-Poly1305' }, true, ['encrypt', 'decrypt']),
    'X-Wing (MLKEM768-X25519) generateKey': () => crypto.subtle.generateKey({ name: 'MLKEM768-X25519' }, false, ['encapsulateKey', 'decapsulateKey']),
    'Ed25519 generateKey': () => crypto.subtle.generateKey({ name: 'Ed25519' }, false, ['sign', 'verify']),
    'Argon2id importKey+deriveBits': async () => { const k = await crypto.subtle.importKey('raw-secret', new TextEncoder().encode('pw'), 'Argon2id', false, ['deriveBits']); return crypto.subtle.deriveBits({ name: 'Argon2id', nonce: new Uint8Array(16), parallelism: 1, memory: 19456, passes: 2 }, k, 256); },
    'Argon2id importKey (raw)': () => crypto.subtle.importKey('raw', new TextEncoder().encode('pw'), 'Argon2id', false, ['deriveBits']),
    'scrypt importKey': () => crypto.subtle.importKey('raw', new TextEncoder().encode('pw'), 'scrypt', false, ['deriveBits']),
    'SHA3-256 digest': () => crypto.subtle.digest('SHA3-256', new Uint8Array(1)),
  };
  o.results = {};
  for (const [k, f] of Object.entries(probes)) { try { await f(); o.results[k] = 'supported'; } catch (e) { o.results[k] = e.name + ': ' + String(e.message).slice(0, 60); } }
  if (typeof SubtleCrypto.supports === 'function') {
    o.supports = {};
    for (const [op, alg] of [['importKey', 'Argon2id'], ['deriveBits', 'Argon2id'], ['generateKey', 'ML-KEM-768'], ['generateKey', 'ChaCha20-Poly1305'], ['generateKey', 'Ed25519']]) {
      try { o.supports[`${op}:${alg}`] = SubtleCrypto.supports(op, alg); } catch (e) { o.supports[`${op}:${alg}`] = 'throws ' + e.name; }
    }
  }
  return o;
});
console.log(engine, browser.version(), JSON.stringify(out, null, 1));
await browser.close(); srv.close();
