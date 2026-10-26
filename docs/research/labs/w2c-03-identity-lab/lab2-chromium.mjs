// Lab 2 (headless Chromium via the project's Playwright): CryptoKey-in-IDB misuse by same-origin site code,
// PKCS8-without-public-key import, KDF timings, WebAuthn PRF through a CDP virtual authenticator.
import { chromium } from '$HOME/Documents/Projects/magnet-web/node_modules/playwright/index.mjs';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { webcrypto as wc } from 'node:crypto';
import { p256 } from '@noble/curves/nist.js';

const root = process.cwd();
const types = { '.js': 'text/javascript', '.mjs': 'text/javascript', '.html': 'text/html; charset=utf-8', '.json': 'application/json', '.wasm': 'application/wasm' };
const srv = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://x'); let p = path.join(root, 'pages', decodeURIComponent(u.pathname));
  if (u.pathname.startsWith('/node_modules/')) p = path.join(root, decodeURIComponent(u.pathname));
  if (!fs.existsSync(p) || fs.statSync(p).isDirectory()) { res.writeHead(404).end('nf'); return; }
  res.writeHead(200, { 'content-type': types[path.extname(p)] || 'application/octet-stream', 'cache-control': 'no-store' });
  fs.createReadStream(p).pipe(res);
});
await new Promise((r) => srv.listen(0, '127.0.0.1', r));
const port = srv.address().port;
const origin = `http://localhost:${port}`;   // localhost = secure context, valid WebAuthn RP ID

const browser = await chromium.launch({ headless: true, args: ['--disable-features=WebRtcHideLocalIpsWithMdns'] });
const ctx = await browser.newContext();
const page = await ctx.newPage();
const results = { chromium: browser.version(), origin };
page.on('pageerror', (e) => (results.pageerror = (results.pageerror || []).concat(String(e))));
await page.goto(origin + '/index.html');

// ---------- A. deterministic key import paths in Chromium ----------
const seed = wc.getRandomValues(new Uint8Array(32));
const d = p256.utils.randomSecretKey();            // any valid scalar
const pubRaw = p256.getPublicKey(d, false);
results.A = await page.evaluate(async ({ d: dArr, pub: pubArr }) => {
  const u8 = (a) => Uint8Array.from(a);
  const d = u8(dArr), pub = u8(pubArr);
  const b64u = (x) => btoa(String.fromCharCode(...x)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  const out = {};
  // A1: PKCS8 without embedded public key
  const der = (tag, ...parts) => { const len = parts.reduce((s, p) => s + p.length, 0); const hdr = len < 128 ? [tag, len] : [tag, 0x81, len]; return Uint8Array.from([...hdr, ...parts.flatMap((p) => [...p])]); };
  const ecPriv = der(0x30, [2, 1, 1], der(0x04, d));
  const pkcs8 = der(0x30, [2, 1, 0], der(0x30, [6, 7, 0x2a, 0x86, 0x48, 0xce, 0x3d, 2, 1], [6, 8, 0x2a, 0x86, 0x48, 0xce, 0x3d, 3, 1, 7]), der(0x04, ecPriv));
  try {
    const k = await crypto.subtle.importKey('pkcs8', pkcs8, { name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign']);
    const j = await crypto.subtle.exportKey('jwk', k);
    out.pkcs8NoPub = { ok: true, x: j.x === b64u(pub.slice(1, 33)), y: j.y === b64u(pub.slice(33, 65)) };
  } catch (e) { out.pkcs8NoPub = { ok: false, err: e.name + ': ' + e.message }; }
  // A2: JWK with d,x,y (needs scalar mult done outside WebCrypto)
  const jwk = { kty: 'EC', crv: 'P-256', d: b64u(d), x: b64u(pub.slice(1, 33)), y: b64u(pub.slice(33, 65)) };
  const priv = await crypto.subtle.importKey('jwk', jwk, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);
  const pk = await crypto.subtle.importKey('raw', pub, { name: 'ECDSA', namedCurve: 'P-256' }, true, ['verify']);
  const m = new TextEncoder().encode('x'); const sig = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, priv, m);
  out.jwkImport = { extractable: priv.extractable, verifies: await crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, pk, sig, m) };
  // A3: store the non-extractable pair in IndexedDB exactly like cache.js `identity:'me'`
  const db = await new Promise((res, rej) => { const r = indexedDB.open('mw-lab', 1); r.onupgradeneeded = () => r.result.createObjectStore('identity'); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
  await new Promise((res, rej) => { const tx = db.transaction('identity', 'readwrite'); tx.objectStore('identity').put({ privateKey: priv, publicKey: pk, pub: b64u(pub) }, 'me'); tx.oncomplete = res; tx.onerror = () => rej(tx.error); });
  out.idbStored = true;
  return out;
}, { d: Array.from(d), pub: Array.from(pubRaw) });

// ---------- B. hostile same-origin site code vs the identity key ----------
results.B = await page.evaluate(async () => {
  const run = (sandbox) => new Promise((resolve) => {
    const f = document.createElement('iframe'); f.setAttribute('sandbox', sandbox); f.src = '/iframe-site.html';
    const t = setTimeout(() => resolve({ timeout: true }), 6000);
    const h = (e) => { if (e.data && e.data.lab === 'iframe-result') { clearTimeout(t); window.removeEventListener('message', h); resolve(e.data.out); } };
    window.addEventListener('message', h); document.body.appendChild(f);
  });
  return { sameOriginSandbox: await run('allow-scripts allow-same-origin'), opaqueSandbox: await run('allow-scripts') };
});

// ---------- C. KDF timings in the page (desktop M3, headless Chromium) ----------
results.C = await page.evaluate(async () => {
  const time = async (fn, reps = 3) => { const ts = []; for (let i = 0; i < reps; i++) { const t0 = performance.now(); await fn(); ts.push(performance.now() - t0); } ts.sort((a, b) => a - b); return { min_ms: Math.round(ts[0]), median_ms: Math.round(ts[Math.floor(ts.length / 2)]) }; };
  const out = {};
  const hw = await import('/node_modules/hash-wasm/dist/index.esm.js');
  const pw = new TextEncoder().encode('correct horse battery staple'); const salt = crypto.getRandomValues(new Uint8Array(16));
  for (const [m, t] of [[19456, 2], [47104, 1], [65536, 3], [131072, 1]]) {
    out[`argon2id_wasm m=${m / 1024}MiB t=${t} p=1`] = await time(() => hw.argon2id({ password: pw, salt, parallelism: 1, iterations: t, memorySize: m, hashLength: 32, outputType: 'binary' }));
  }
  try {
    const na = await import('/node_modules/@noble/hashes/argon2.js');
    out['argon2id_noble_js m=19MiB t=2 p=1'] = await time(() => na.argon2id(pw, salt, { t: 2, m: 19456, p: 1, dkLen: 32 }), 2);
  } catch (e) { out.nobleArgon2Err = String(e); }
  try {
    const ns = await import('/node_modules/@noble/hashes/scrypt.js');
    for (const lg of [15, 16, 17]) out[`scrypt_noble_js N=2^${lg} r=8 p=1 (${(128 * (2 ** lg) * 8) / 1048576}MiB)`] = await time(() => ns.scrypt(pw, salt, { N: 2 ** lg, r: 8, p: 1, dkLen: 32 }), 2);
  } catch (e) { out.nobleScryptErr = String(e); }
  const base = await crypto.subtle.importKey('raw', pw, 'PBKDF2', false, ['deriveBits']);
  out['pbkdf2_webcrypto sha256 600000'] = await time(() => crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations: 600000 }, base, 256));
  out['webcrypto_P256_generateKey'] = await (async () => { const t0 = performance.now(); let c = 0; while (performance.now() - t0 < 1500) { await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']); c++; } return { perSec: Math.round(c / ((performance.now() - t0) / 1000)) }; })();
  return out;
});

// ---------- D. WebAuthn PRF through a CDP virtual authenticator (software, CTAP2 hmac-secret) ----------
const cdp = await ctx.newCDPSession(page);
await cdp.send('WebAuthn.enable');
let vaOk = true; let va;
try {
  va = await cdp.send('WebAuthn.addVirtualAuthenticator', { options: { protocol: 'ctap2', ctap2Version: 'ctap2_1', transport: 'internal', hasResidentKey: true, hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true, hasPrf: true } });
} catch (e) { vaOk = false; results.D = { virtualAuthenticator: 'unavailable: ' + e.message }; }
if (vaOk) {
  results.D = await page.evaluate(async () => {
    const hex = (b) => Array.from(new Uint8Array(b)).map((x) => x.toString(16).padStart(2, '0')).join('');
    const out = {};
    out.clientCapabilities = PublicKeyCredential.getClientCapabilities ? await PublicKeyCredential.getClientCapabilities() : 'n/a';
    const challenge = crypto.getRandomValues(new Uint8Array(32));
    const cred = await navigator.credentials.create({ publicKey: { rp: { name: 'lab', id: 'localhost' }, user: { id: new Uint8Array([1, 2, 3, 4]), name: 'visitor', displayName: 'visitor' }, challenge, pubKeyCredParams: [{ type: 'public-key', alg: -7 }], authenticatorSelection: { residentKey: 'required', userVerification: 'required' }, extensions: { prf: {} } } });
    const ext = cred.getClientExtensionResults();
    out.createPrf = { enabled: ext.prf && ext.prf.enabled, hasResultsAtCreate: !!(ext.prf && ext.prf.results) };
    const salt1 = new TextEncoder().encode('mw/identity/v1'), salt2 = new TextEncoder().encode('mw/identity/v1|chain:host:example.com');
    const get = async (prf) => { const a = await navigator.credentials.get({ publicKey: { challenge: crypto.getRandomValues(new Uint8Array(32)), rpId: 'localhost', allowCredentials: [{ type: 'public-key', id: cred.rawId }], userVerification: 'required', extensions: { prf } } }); return a.getClientExtensionResults().prf; };
    const r1 = await get({ eval: { first: salt1 } });
    const r1b = await get({ eval: { first: salt1 } });
    const r2 = await get({ eval: { first: salt2, second: salt1 } });
    out.getPrf = { len: r1.results.first.byteLength, stable: hex(r1.results.first) === hex(r1b.results.first), differentSaltDiffers: hex(r1.results.first) !== hex(r2.results.first), secondEqualsFirstOfSalt1: hex(r2.results.second) === hex(r1.results.first), sample: hex(r1.results.first).slice(0, 16) + '...' };
    // second credential on the same authenticator = different PRF secret for the same salt
    const cred2 = await navigator.credentials.create({ publicKey: { rp: { name: 'lab', id: 'localhost' }, user: { id: new Uint8Array([9, 9, 9, 9]), name: 'visitor2', displayName: 'visitor2' }, challenge, pubKeyCredParams: [{ type: 'public-key', alg: -7 }], authenticatorSelection: { residentKey: 'required', userVerification: 'required' }, extensions: { prf: {} } } });
    const a2 = await navigator.credentials.get({ publicKey: { challenge: crypto.getRandomValues(new Uint8Array(32)), rpId: 'localhost', allowCredentials: [{ type: 'public-key', id: cred2.rawId }], userVerification: 'required', extensions: { prf: { eval: { first: salt1 } } } } });
    out.secondCredentialSameSaltDiffers = hex(a2.getClientExtensionResults().prf.results.first) !== hex(r1.results.first);
    return out;
  });
}
await browser.close(); srv.close();
console.log(JSON.stringify(results, null, 2));
