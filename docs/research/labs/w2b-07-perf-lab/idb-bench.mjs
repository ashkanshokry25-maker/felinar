// Lab 3: where does a downloaded small site get persisted, and how fast? IndexedDB (Blob vs ArrayBuffer values, one transaction vs one per piece),
// Cache Storage, OPFS (sync access handle in a worker). Chromium + WebKit, disk-backed persistent profiles, this Mac's NVMe (desktop proxy: only ratios transfer).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, webkit } from '../../../../node_modules/playwright/index.mjs';
import { startServer } from './lab-server.mjs';
const here = path.dirname(fileURLToPath(import.meta.url));
const { port, close } = await startServer({ '/b.html': { body: Buffer.from('<!doctype html><meta charset=utf-8><title>b</title><body>b'), type: 'text/html' } });
const base = 'http://127.0.0.1:' + port;
const fnSrc = `async ([totalMiB, nFiles, runs]) => {
  const total = totalMiB * 1048576, fileSize = Math.floor(total / nFiles), PIECE = 262144;
  const rnd = (n) => { const b = new Uint8Array(n); for (let i = 0; i < n; i += 65536) crypto.getRandomValues(b.subarray(i, Math.min(n, i + 65536))); return b; };
  const files = []; for (let i = 0; i < nFiles; i++) files.push(rnd(fileSize));
  const nPieces = Math.ceil(total / PIECE); const pieces = []; for (let i = 0; i < nPieces; i++) pieces.push(files[i % nFiles].subarray(0, Math.min(PIECE, fileSize)));
  const median = (a) => [...a].sort((x, y) => x - y)[Math.floor(a.length / 2)];
  const open = (name) => new Promise((ok, err) => { const r = indexedDB.open(name, 1); r.onupgradeneeded = () => { r.result.createObjectStore('s'); }; r.onsuccess = () => ok(r.result); r.onerror = () => err(r.error); });
  const txDone = (tx) => new Promise((ok, err) => { tx.oncomplete = ok; tx.onerror = () => err(tx.error); tx.onabort = () => err(tx.error); });
  const del = (name) => new Promise(ok => { const r = indexedDB.deleteDatabase(name); r.onsuccess = r.onerror = r.onblocked = () => ok(); });
  const out = {};
  async function idbOne(label, makeVals, durability) {
    const ts = [], rd = [], cold = [];
    for (let k = 0; k < runs; k++) {
      const name = 'db-' + label + '-' + k + '-' + Math.random(); const db = await open(name); const vals = makeVals();
      let t = performance.now();
      const tx = db.transaction('s', 'readwrite', durability ? { durability } : undefined); const st = tx.objectStore('s');
      vals.forEach((v, i) => st.put(v, i)); await txDone(tx); ts.push(performance.now() - t);
      t = performance.now(); const tx2 = db.transaction('s', 'readonly'); const st2 = tx2.objectStore('s');
      const got = await Promise.all(vals.map((_, i) => new Promise((ok, err) => { const r = st2.get(i); r.onsuccess = () => ok(r.result); r.onerror = () => err(r.error); })));
      let n = 0; for (const g of got) { const ab = g instanceof Blob ? await g.arrayBuffer() : g.buffer ? g.buffer : g; n += ab.byteLength; } rd.push(performance.now() - t);
      db.close(); const db2 = await open(name); t = performance.now();
      const tx3 = db2.transaction('s', 'readonly'); const g0 = await new Promise((ok, err) => { const r = tx3.objectStore('s').get(0); r.onsuccess = () => ok(r.result); r.onerror = () => err(r.error); });
      if (g0 instanceof Blob) await g0.arrayBuffer(); cold.push(performance.now() - t); db2.close(); await del(name);
    }
    out[label] = { writeMs: +median(ts).toFixed(1), readAllMs: +median(rd).toFixed(1), reopenAndReadFirstMs: +median(cold).toFixed(1) };
  }
  await idbOne('idb files as Blob, 1 tx (default durability)', () => files.map(f => new Blob([f])));
  await idbOne('idb files as Blob, 1 tx (durability strict)', () => files.map(f => new Blob([f])), 'strict');
  await idbOne('idb files as Blob, 1 tx (durability relaxed)', () => files.map(f => new Blob([f])), 'relaxed');
  await idbOne('idb files as Uint8Array, 1 tx', () => files.map(f => f.slice()));
  await idbOne('idb 256KiB pieces as Uint8Array, 1 tx', () => pieces.map(p => p.slice()));
  // naive chunk store: one transaction per piece
  { const ts = []; for (let k = 0; k < Math.min(runs, 3); k++) { const name = 'dbp-' + k + Math.random(); const db = await open(name); const t = performance.now();
      for (let i = 0; i < pieces.length; i++) { const tx = db.transaction('s', 'readwrite'); tx.objectStore('s').put(pieces[i].slice(), i); await txDone(tx); }
      ts.push(performance.now() - t); db.close(); await del(name); } out['idb 256KiB pieces, 1 tx PER piece'] = { writeMs: +median(ts).toFixed(1) }; }
  // Cache Storage
  { const ts = [], rd = []; for (let k = 0; k < runs; k++) { const cn = 'c-' + k + Math.random(); const c = await caches.open(cn); let t = performance.now();
      await Promise.all(files.map((f, i) => c.put('/f/' + i, new Response(new Blob([f]), { headers: { 'content-type': 'application/octet-stream' } })))); ts.push(performance.now() - t);
      t = performance.now(); for (let i = 0; i < nFiles; i++) { const r = await c.match('/f/' + i); await r.arrayBuffer(); } rd.push(performance.now() - t); await caches.delete(cn); }
    out['Cache Storage put(Response(Blob)) x files'] = { writeMs: +median(ts).toFixed(1), readAllMs: +median(rd).toFixed(1) }; }
  // OPFS via sync access handle in a worker
  try {
    const workerSrc = \`self.onmessage = async (e) => { const { files, runs } = e.data; const ts = [], rd = [];
      try { const root = await navigator.storage.getDirectory();
        for (let k = 0; k < runs; k++) { const dir = await root.getDirectoryHandle('d' + k + Math.random().toString(36).slice(2), { create: true }); let t = performance.now();
          for (let i = 0; i < files.length; i++) { const fh = await dir.getFileHandle('f' + i, { create: true }); const ah = await fh.createSyncAccessHandle(); ah.write(files[i], { at: 0 }); ah.flush(); ah.close(); }
          ts.push(performance.now() - t); t = performance.now();
          for (let i = 0; i < files.length; i++) { const fh = await dir.getFileHandle('f' + i); const f = await fh.getFile(); await f.arrayBuffer(); } rd.push(performance.now() - t);
          await root.removeEntry(dir.name, { recursive: true }); }
        self.postMessage({ ts, rd }); } catch (err) { self.postMessage({ error: String(err) }); } }\`;
    const w = new Worker(URL.createObjectURL(new Blob([workerSrc])));
    const r = await new Promise((ok, err) => { w.onmessage = (e) => ok(e.data); w.onerror = (e) => err(new Error(e.message)); w.postMessage({ files, runs }); });
    out['OPFS createSyncAccessHandle (worker) per file'] = r.error ? { error: r.error } : { writeMs: +median(r.ts).toFixed(1), readAllMs: +median(r.rd).toFixed(1) };
  } catch (e) { out['OPFS createSyncAccessHandle (worker) per file'] = { error: String(e) }; }
  return out;
}`;
const res = { date: new Date().toISOString(), cpu: os.cpus()[0].model, results: {} };
for (const [name, type] of [['chromium', chromium], ['webkit', webkit]]) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mwidb-'));
  let ctx;
  try { ctx = await type.launchPersistentContext(dir, { headless: true }); } catch (e) { console.log(name, 'launch failed', e.message.split('\n')[0]); continue; }
  const ver = ctx.browser()?.version?.() || '';
  const page = await ctx.newPage(); await page.goto(base + '/b.html');
  for (const [mib, n] of [[2, 20], [16, 60], [48, 120]]) {
    let r; try { r = await page.evaluate(`(${fnSrc})(${JSON.stringify([mib, n, 5])})`); } catch (e) { console.log(name, mib, 'MiB failed', String(e).slice(0, 200)); continue; }
    res.results[`${name} ${ver} | ${mib} MiB in ${n} files`] = r;
    console.log(`\n=== ${name} ${ver} | ${mib} MiB site in ${n} files (median of 5; ms)`);
    for (const [k, v] of Object.entries(r)) console.log(k.padEnd(52), JSON.stringify(v));
  }
  await ctx.close(); fs.rmSync(dir, { recursive: true, force: true });
}
fs.writeFileSync(path.join(here, 'out/idb-bench.json'), JSON.stringify(res, null, 1));
close();
