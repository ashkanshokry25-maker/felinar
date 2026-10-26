import http from 'node:http';
import { chromium, webkit } from '../../../../node_modules/playwright/index.mjs';
const server = http.createServer((q, r) => { r.writeHead(200, { 'content-type': 'text/html' }); r.end('<!doctype html><title>b</title>'); });
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const url = `http://localhost:${server.address().port}/`;
for (const [name, type] of [['chromium', chromium], ['webkit', webkit]]) {
  const b = await type.launch({ headless: true }); const ctx = await b.newContext(); const p = await ctx.newPage(); await p.goto(url);
  const res = await p.evaluate(async () => {
    const out = {}; const N = 50000;
    const hex = (u8) => Array.from(u8, (x) => x.toString(16).padStart(2, '0')).join('');
    const mkBlock = (i) => { const h = hex(crypto.getRandomValues(new Uint8Array(32))); return { h, e: { v: 1, site: 'host:example.com', author: 'A'.repeat(87), seq: i, prev: [hex(crypto.getRandomValues(new Uint8Array(32)))], ts: 1760000000000 + i, op: { t: 'append', l: 'guestbook', v: { name: 'visitor ' + i, msg: 'x'.repeat(200) } }, nonce: String(i) }, s: 'S'.repeat(86) }; };
    await new Promise((r) => { const q = indexedDB.deleteDatabase('bench'); q.onsuccess = q.onerror = q.onblocked = r; });
    const db = await new Promise((res, rej) => { const r = indexedDB.open('bench', 1); r.onupgradeneeded = () => r.result.createObjectStore('blocks', { keyPath: 'h' }); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
    let t0 = performance.now(); const batch = 1000; let bytes = 0;
    for (let i = 0; i < N; i += batch) {
      await new Promise((res, rej) => { const tx = db.transaction('blocks', 'readwrite'); const st = tx.objectStore('blocks'); for (let j = i; j < i + batch; j++) { const blk = mkBlock(j); bytes += JSON.stringify(blk).length; st.put(blk); } tx.oncomplete = res; tx.onerror = () => rej(tx.error); });
    }
    out.put50kMs = Math.round(performance.now() - t0); out.approxBytesMB = +(bytes / 1048576).toFixed(1);
    db.close();
    t0 = performance.now();
    const db2 = await new Promise((res, rej) => { const r = indexedDB.open('bench', 1); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
    out.openMs = Math.round(performance.now() - t0); t0 = performance.now();
    const all = await new Promise((res, rej) => { const r = db2.transaction('blocks').objectStore('blocks').getAll(); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
    out.getAll50kMs = Math.round(performance.now() - t0); out.count = all.length; db2.close();
    // SHA-256 digest rate (WebCrypto, async) for hashcash calibration
    const data = new TextEncoder().encode(JSON.stringify(mkBlock(1).e)); t0 = performance.now(); let n = 0;
    while (performance.now() - t0 < 1500) { await crypto.subtle.digest('SHA-256', data); n++; }
    out.webcryptoSha256PerSec = Math.round(n / ((performance.now() - t0) / 1000));
    out.bits14MeanSec = +(16384 / out.webcryptoSha256PerSec).toFixed(2);
    return out;
  });
  console.log(name, b.version(), JSON.stringify(res));
  await b.close();
}
server.close();
