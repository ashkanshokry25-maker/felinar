// Lab 4: cross-engine behaviour of identity-key primitives (Playwright Chromium / Firefox / WebKit builds, macOS arm64)
import * as pw from '$HOME/Documents/Projects/magnet-web/node_modules/playwright/index.mjs';
import http from 'node:http'; import fs from 'node:fs'; import path from 'node:path';
import { p256 } from '@noble/curves/nist.js';
const engine = process.argv[2];
const root = process.cwd();
const types = { '.js': 'text/javascript', '.html': 'text/html; charset=utf-8' };
const srv = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://x'); let p = path.join(root, 'pages', decodeURIComponent(u.pathname));
  if (u.pathname.startsWith('/node_modules/')) p = path.join(root, decodeURIComponent(u.pathname));
  if (!fs.existsSync(p) || fs.statSync(p).isDirectory()) { res.writeHead(404).end('nf'); return; }
  res.writeHead(200, { 'content-type': types[path.extname(p)] || 'application/octet-stream', 'cache-control': 'no-store' }); fs.createReadStream(p).pipe(res);
});
await new Promise((r) => srv.listen(0, '127.0.0.1', r));
const origin = `http://localhost:${srv.address().port}`;
const browser = await pw[engine].launch({ headless: true });
const ctx = await browser.newContext(); const page = await ctx.newPage();
await page.goto(origin + '/index.html');
const d = p256.utils.randomSecretKey(); const pub = p256.getPublicKey(d, false);
const res = await page.evaluate(async ({ dArr, pubArr }) => {
  const d = Uint8Array.from(dArr), pub = Uint8Array.from(pubArr);
  const b64u = (x) => btoa(String.fromCharCode(...x)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  const out = { ua: navigator.userAgent.slice(0, 120) };
  const tryIt = async (name, fn) => { try { out[name] = await fn(); } catch (e) { out[name] = { error: e.name + ': ' + String(e.message).slice(0, 120) }; } };
  const ALG = { name: 'ECDSA', namedCurve: 'P-256' }, SIG = { name: 'ECDSA', hash: 'SHA-256' };
  await tryIt('jwkImportNonExtractable', async () => { const k = await crypto.subtle.importKey('jwk', { kty: 'EC', crv: 'P-256', d: b64u(d), x: b64u(pub.slice(1, 33)), y: b64u(pub.slice(33, 65)) }, ALG, false, ['sign']); const pk = await crypto.subtle.importKey('raw', pub, ALG, true, ['verify']); const m = new Uint8Array([1, 2, 3]); const s = await crypto.subtle.sign(SIG, k, m); return { extractable: k.extractable, verifies: await crypto.subtle.verify(SIG, pk, s, m) }; });
  await tryIt('pkcs8NoPublicKeyImport', async () => {
    const der = (tag, ...parts) => { const len = parts.reduce((s, p) => s + p.length, 0); const hdr = len < 128 ? [tag, len] : [tag, 0x81, len]; return Uint8Array.from([...hdr, ...parts.flatMap((p) => [...p])]); };
    const pkcs8 = der(0x30, [2, 1, 0], der(0x30, [6, 7, 0x2a, 0x86, 0x48, 0xce, 0x3d, 2, 1], [6, 8, 0x2a, 0x86, 0x48, 0xce, 0x3d, 3, 1, 7]), der(0x04, der(0x30, [2, 1, 1], der(0x04, d))));
    const k = await crypto.subtle.importKey('pkcs8', pkcs8, ALG, true, ['sign']); const j = await crypto.subtle.exportKey('jwk', k);
    return { ok: true, xyMatch: j.x === b64u(pub.slice(1, 33)) && j.y === b64u(pub.slice(33, 65)) };
  });
  const idbRoundTrip = async (label, genAlg, signAlg) => {
    const pair = await crypto.subtle.generateKey(genAlg, false, ['sign', 'verify']);
    const db = await new Promise((res, rej) => { const r = indexedDB.open('rt-' + label, 1); r.onupgradeneeded = () => { const s = r.result.createObjectStore('identity'); const s2 = r.result.createObjectStore('recs', { keyPath: 'id' }); s2.createIndex('byTag', 'tag'); }; r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
    const put = (store, val, key) => new Promise((res, rej) => { const tx = db.transaction(store, 'readwrite'); const rq = key === undefined ? tx.objectStore(store).put(val) : tx.objectStore(store).put(val, key); tx.oncomplete = res; tx.onerror = () => rej(tx.error); tx.onabort = () => rej(tx.error || new Error('abort')); });
    const get = (store, key) => new Promise((res, rej) => { const r = db.transaction(store).objectStore(store).get(key); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
    const r = {};
    try { await put('identity', { privateKey: pair.privateKey, publicKey: pair.publicKey }, 'me'); const back = await get('identity', 'me'); const m = new Uint8Array([9, 9]); const s = await crypto.subtle.sign(signAlg, back.privateKey, m); r.asValue = { restored: !!back, privExtractable: back.privateKey.extractable, signs: s.byteLength, verifies: await crypto.subtle.verify(signAlg, back.publicKey, s, m) }; } catch (e) { r.asValue = { error: e.name + ': ' + String(e.message).slice(0, 100) }; }
    try { await put('recs', { id: 1, tag: 'a', k: pair.privateKey }); const viaIndex = await new Promise((res, rej) => { const q = db.transaction('recs').objectStore('recs').index('byTag').get('a'); q.onsuccess = () => res(q.result); q.onerror = () => rej(q.error); }); r.asIndexedProperty = { found: !!viaIndex, keyType: viaIndex && viaIndex.k && viaIndex.k.type }; } catch (e) { r.asIndexedProperty = { error: e.name + ': ' + String(e.message).slice(0, 100) }; }
    db.close(); return r;
  };
  await tryIt('idb_ecdsa_p256_nonextractable', () => idbRoundTrip('p256', ALG, SIG));
  await tryIt('idb_ed25519_nonextractable', () => idbRoundTrip('ed', { name: 'Ed25519' }, { name: 'Ed25519' }));
  await tryIt('clientCapabilities', async () => { if (!PublicKeyCredential.getClientCapabilities) return 'getClientCapabilities missing'; const c = await PublicKeyCredential.getClientCapabilities(); return { prf: c['extension:prf'], relatedOrigins: c.relatedOrigins, hybridTransport: c.hybridTransport, conditionalCreate: c.conditionalCreate, passkeyPlatformAuthenticator: c.passkeyPlatformAuthenticator, keys: Object.keys(c).length }; });
  await tryIt('storage', async () => ({ persistApi: typeof navigator.storage?.persist, persisted: await navigator.storage.persisted?.(), persistGranted: await navigator.storage.persist?.() }));
  await tryIt('argon2idWasm_64MiB_t3', async () => { const hw = await import('/node_modules/hash-wasm/dist/index.esm.js'); const t0 = performance.now(); await hw.argon2id({ password: 'pw', salt: crypto.getRandomValues(new Uint8Array(16)), parallelism: 1, iterations: 3, memorySize: 65536, hashLength: 32, outputType: 'hex' }); return { ms: Math.round(performance.now() - t0) }; });
  await tryIt('argon2idWasm_256MiB_t1', async () => { const hw = await import('/node_modules/hash-wasm/dist/index.esm.js'); const t0 = performance.now(); await hw.argon2id({ password: 'pw', salt: crypto.getRandomValues(new Uint8Array(16)), parallelism: 1, iterations: 1, memorySize: 262144, hashLength: 32, outputType: 'hex' }); return { ms: Math.round(performance.now() - t0) }; });
  return out;
}, { dArr: Array.from(d), pubArr: Array.from(pub) });
console.log(JSON.stringify({ engine, version: browser.version(), res }, null, 1));
await browser.close(); srv.close();
