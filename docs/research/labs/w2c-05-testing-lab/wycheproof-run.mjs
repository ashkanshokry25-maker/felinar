import fs from 'node:fs';
import http from 'node:http';
import { verify } from '../../../../src/chain/crypto.js';
import { b64url } from '../../../../src/chain/canonical.js';
import { chromium, webkit } from '../../../../node_modules/playwright/index.mjs';
const d = JSON.parse(fs.readFileSync('./vectors/wycheproof_ecdsa_secp256r1_sha256_p1363_test.json', 'utf8'));
const fromHex = (h) => Uint8Array.from(h.match(/../g) || [], (x) => parseInt(x, 16));
const cases = [];
for (const g of d.testGroups) for (const t of g.tests) cases.push({ tcId: t.tcId, pub: g.publicKey.uncompressed, msg: t.msg, sig: t.sig, result: t.result, flags: t.flags, comment: t.comment });
// 1. project code in Node
let mism = [];
for (const c of cases) {
  const pubRaw = fromHex(c.pub);
  const ok = await verify(b64url.encode(pubRaw), fromHex(c.msg), fromHex(c.sig)); // project API: never throws
  const expected = c.result === 'valid';
  if (ok !== expected) mism.push({ tcId: c.tcId, expected: c.result, got: ok, flags: c.flags, comment: c.comment, pubLen: pubRaw.length, sigLen: c.sig.length / 2 });
}
console.log(`Node ${process.version} + src/chain/crypto.js verify(): ${cases.length} vectors, mismatches: ${mism.length}`, mism.slice(0, 5));
// 2. raw WebCrypto in browsers
const server = http.createServer((q, r) => { r.writeHead(200, { 'content-type': 'text/html' }); r.end('<!doctype html><title>w</title>'); });
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const url = `http://localhost:${server.address().port}/`;
for (const [name, type] of [['chromium', chromium], ['webkit', webkit]]) {
  const b = await type.launch({ headless: true }); const p = await (await b.newContext()).newPage(); await p.goto(url);
  const res = await p.evaluate(async (cases) => {
    const fromHex = (h) => Uint8Array.from(h.match(/../g) || [], (x) => parseInt(x, 16));
    const bad = []; let thrown = 0;
    for (const c of cases) {
      let ok = false;
      try {
        const key = await crypto.subtle.importKey('raw', fromHex(c.pub), { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']);
        ok = await crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, key, fromHex(c.sig), fromHex(c.msg));
      } catch (e) { thrown++; ok = false; }
      if (ok !== (c.result === 'valid')) bad.push({ tcId: c.tcId, expected: c.result, got: ok, flags: c.flags });
    }
    return { total: cases.length, mismatches: bad.length, thrown, sample: bad.slice(0, 5) };
  }, cases);
  console.log(`${name} ${b.version()} raw WebCrypto:`, JSON.stringify(res));
  await b.close();
}
server.close();
