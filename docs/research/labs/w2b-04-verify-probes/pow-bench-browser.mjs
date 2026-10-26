// VERIFY claim 5: browser-side hashcash cost on this M3: aggregate H/s with 1/4/5 Workers (pure JS, fixed-width nonce) and with a WebCrypto await-loop.
import http from 'node:http'
import fs from 'node:fs'
import crypto from 'node:crypto'
const PROJ = new URL('../../../../', import.meta.url).pathname.replace(/\/$/, '') // <repo root>
const SCR = new URL('.', import.meta.url).pathname
const { canonicalize } = await import(PROJ + '/src/chain/canonical.js')
const { chromium, webkit } = await import(PROJ + '/node_modules/playwright/index.mjs')
const core = fs.readFileSync(SCR + 'miner-core.js', 'utf8')
const b64u = (n) => crypto.randomBytes(n).toString('base64url'); const hex = (n) => crypto.randomBytes(n).toString('hex')
const mk = (np) => canonicalize({ v: 1, site: b64u(32), author: 'B' + b64u(64).slice(0, 86), seq: 7, prev: Array.from({ length: np }, () => hex(32)).sort(), ts: 1792000000000, bits: 14, op: { t: 'append', l: '_tel', vh: hex(32) }, nonce: 'NNNNNNNN' })
const cases = [1, 3].map((np) => { const c = mk(np); return { np, canon: c, off: c.indexOf('NNNNNNNN'), bytes: new TextEncoder().encode(c).length } })
const PAGE = `<!doctype html><meta charset=utf-8><script>
const coreSrc = ${JSON.stringify(core)};
const workerSrc = coreSrc + \`
self.onmessage = async (ev) => {
  const { kind, tpl, off, iters, bits, reps } = ev.data;
  if (kind === 'rate') { const m = makeMiner(new Uint8Array(tpl), off, 8); const t0 = performance.now(); const r = m.mine(32, 1, iters); /* bits=32 -> practically never hits; runs 'iters' hashes */ self.postMessage({ ms: performance.now() - t0, hashes: iters }); }
  if (kind === 'mint') { const m = makeMiner(new Uint8Array(tpl), off, 8); const out = []; for (let i = 0; i < reps; i++) { const t0 = performance.now(); const k = m.mine(bits, (Math.random() * 4294967296) >>> 0, 1e9); out.push([performance.now() - t0, k]); } self.postMessage({ out }); }
  if (kind === 'webcrypto') { const buf = new Uint8Array(tpl); const dv = new DataView(buf.buffer); const t0 = performance.now(); for (let i = 0; i < iters; i++) { dv.setUint32(off, i); await crypto.subtle.digest('SHA-256', buf); } self.postMessage({ ms: performance.now() - t0, hashes: iters }); }
};\`;
const mkWorker = () => new Worker(URL.createObjectURL(new Blob([workerSrc], { type: 'text/javascript' })));
const once = (w, msg) => new Promise((r) => { w.onmessage = (e) => r(e.data); w.postMessage(msg) });
window.run = async (tpl, off) => {
  const res = {};
  // aggregate rate with N workers (each does 'iters' hashes concurrently)
  for (const N of [1, 4, 5]) {
    const ws = Array.from({ length: N }, mkWorker);
    await Promise.all(ws.map((w) => once(w, { kind: 'rate', tpl, off, iters: 1000 }))) // warm-up
    const iters = 400000; const t0 = performance.now()
    await Promise.all(ws.map((w) => once(w, { kind: 'rate', tpl, off, iters })))
    const wall = performance.now() - t0
    res['js_' + N + 'w_MHs'] = +((N * iters) / (wall / 1000) / 1e6).toFixed(3)
    ws.forEach((w) => w.terminate())
  }
  // webcrypto await-loop, 1 worker
  { const w = mkWorker(); const r = await once(w, { kind: 'webcrypto', tpl, off, iters: 30000 }); res.webcrypto_1w_MHs = +(r.hashes / (r.ms / 1000) / 1e6).toFixed(3); w.terminate() }
  // actual mints, 1 worker, 14 and 16 bits
  for (const [bits, reps] of [[14, 150], [16, 60]]) { const w = mkWorker(); const r = await once(w, { kind: 'mint', tpl, off, bits, reps }); const ms = r.out.map((x) => x[0]).sort((a, b) => a - b); res['mint' + bits + '_1w_ms'] = { mean: +(ms.reduce((s, x) => s + x, 0) / ms.length).toFixed(1), median: +ms[Math.floor(ms.length / 2)].toFixed(1), p95: +ms[Math.floor(ms.length * 0.95)].toFixed(1) }; w.terminate() }
  return res;
};
</script>`
const srv = http.createServer((req, res) => { res.writeHead(200, { 'content-type': 'text/html' }); res.end(PAGE) })
await new Promise((r) => srv.listen(0, '127.0.0.1', r))
const port = srv.address().port
for (const [name, eng] of [['chromium', chromium], ['webkit', webkit]]) {
  const b = await eng.launch({ headless: true })
  console.log('###', name, b.version())
  const page = await (await b.newContext()).newPage()
  page.on('pageerror', (e) => console.log('pageerror', String(e).slice(0, 200)))
  await page.goto(`http://127.0.0.1:${port}/`)
  for (const c of cases) {
    const r = await page.evaluate(([t, o]) => window.run(t, o), [[...new TextEncoder().encode(c.canon)], c.off])
    const exp = (bits, mh) => +((2 ** bits) / (mh * 1e6) * 1000).toFixed(2)
    console.log(`  preimage ${c.bytes} bytes (${c.np} parent):`, JSON.stringify(r))
    console.log(`     implied expected mint ms @14 bits: 1w JS ${exp(14, r.js_1w_MHs)}, 4w ${exp(14, r.js_4w_MHs)}, 5w ${exp(14, r.js_5w_MHs)}, webcrypto-loop ${exp(14, r.webcrypto_1w_MHs)} | @16 bits: 1w ${exp(16, r.js_1w_MHs)}, 5w ${exp(16, r.js_5w_MHs)}, webcrypto ${exp(16, r.webcrypto_1w_MHs)}`)
  }
  await b.close()
}
srv.close(); process.exit(0)
