import { createRequire } from 'node:module';
import http from 'node:http';
const require = createRequire(new URL('../../../../package.json', import.meta.url));
const { chromium, webkit } = require('playwright');
const page = http.createServer((req, res) => { res.writeHead(200, { 'content-type': 'text/html' }); res.end('<!doctype html><title>t</title>'); });
await new Promise(r => page.listen(0, '127.0.0.1', r)); const pp = page.address().port;
const probe = `(async () => {
  const out = {};
  const tryGen = async (label, algo, usages) => { try { await crypto.subtle.generateKey(algo, false, usages); out[label] = 'supported'; } catch (e) { out[label] = e.name + ': ' + String(e.message).slice(0, 40); } };
  await tryGen('ECDSA secp256k1', { name: 'ECDSA', namedCurve: 'secp256k1' }, ['sign', 'verify']);
  await tryGen('ECDSA P-256', { name: 'ECDSA', namedCurve: 'P-256' }, ['sign', 'verify']);
  await tryGen('Ed25519', { name: 'Ed25519' }, ['sign', 'verify']);
  await tryGen('ECDH secp256k1', { name: 'ECDH', namedCurve: 'secp256k1' }, ['deriveBits']);
  return out; })()`;
for (const [name, type] of [['chromium', chromium], ['webkit', webkit]]) {
  const b = await type.launch({ headless: true }); const p = await (await b.newContext()).newPage(); await p.goto(`http://127.0.0.1:${pp}/`);
  console.log(name, b.version(), JSON.stringify(await p.evaluate(probe))); await b.close();
}
// Node too
const subtle = globalThis.crypto.subtle; const o = {};
for (const [l, a, u] of [['ECDSA secp256k1', { name: 'ECDSA', namedCurve: 'secp256k1' }, ['sign']], ['ECDSA P-256', { name: 'ECDSA', namedCurve: 'P-256' }, ['sign']]]) { try { await subtle.generateKey(a, false, u); o[l] = 'supported'; } catch (e) { o[l] = e.name; } }
console.log('node', process.version, JSON.stringify(o)); page.close();
