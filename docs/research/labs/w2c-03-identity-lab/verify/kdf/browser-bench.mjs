import * as pw from '$HOME/Documents/Projects/magnet-web/node_modules/playwright/index.mjs';
import http from 'node:http'; import fs from 'node:fs'; import path from 'node:path';
const engine = process.argv[2];
const types = { '.js': 'text/javascript', '.mjs': 'text/javascript', '.html': 'text/html; charset=utf-8', '.wasm': 'application/wasm', '.json': 'application/json' };
const srv = http.createServer((req, res) => { const u = new URL(req.url, 'http://x'); let p = u.pathname === '/' ? null : path.join(process.cwd(), decodeURIComponent(u.pathname)); if (!p) { res.writeHead(200, { 'content-type': 'text/html' }).end('<!doctype html><title>b</title>b'); return; } if (!fs.existsSync(p) || fs.statSync(p).isDirectory()) { res.writeHead(404).end('nf'); return; } res.writeHead(200, { 'content-type': types[path.extname(p)] || 'application/octet-stream' }); fs.createReadStream(p).pipe(res); });
await new Promise((r) => srv.listen(0, '127.0.0.1', r));
const browser = await pw[engine].launch({ headless: true }); const page = await (await browser.newContext()).newPage();
await page.goto(`http://localhost:${srv.address().port}/`);
const out = await page.evaluate(async () => {
  const hw = await import('/node_modules/hash-wasm/dist/index.esm.js');
  const na = await import('/node_modules/@noble/hashes/argon2.js');
  const ns = await import('/node_modules/@noble/hashes/scrypt.js');
  const pw = new TextEncoder().encode('correct horse battery staple'); const salt = new Uint8Array(16).map((_, i) => i * 7 + 1);
  const time = async (fn, reps) => { const ts = []; for (let i = 0; i < reps; i++) { const t0 = performance.now(); await fn(); ts.push(performance.now() - t0); } ts.sort((a, b) => a - b); return { min: Math.round(ts[0]), med: Math.round(ts[ts.length >> 1]) }; };
  const o = {};
  for (const [m, t] of [[19456, 2], [65536, 3]]) {
    o[`wasm m=${m / 1024}MiB t=${t}`] = await time(() => hw.argon2id({ password: pw, salt, parallelism: 1, iterations: t, memorySize: m, hashLength: 32, outputType: 'binary' }), 4);
    o[`noble m=${m / 1024}MiB t=${t}`] = await time(() => na.argon2id(pw, salt, { t, m, p: 1, dkLen: 32 }), 2);
  }
  o['noble scrypt N=2^16'] = await time(() => ns.scrypt(pw, salt, { N: 2 ** 16, r: 8, p: 1, dkLen: 32 }), 3);
  return o;
});
const r = (a, b) => (out[a].med / out[b].med).toFixed(1);
console.log(engine, browser.version(), JSON.stringify(out), '\n ratio noble/wasm 19MiB t=2:', r('noble m=19MiB t=2', 'wasm m=19MiB t=2'), ' 64MiB t=3:', r('noble m=64MiB t=3', 'wasm m=64MiB t=3'));
await browser.close(); srv.close();
