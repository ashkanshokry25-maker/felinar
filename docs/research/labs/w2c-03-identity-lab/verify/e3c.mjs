import * as pw from '$HOME/Documents/Projects/magnet-web/node_modules/playwright/index.mjs';
import http from 'node:http';
const srv = http.createServer((req, res) => { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end('<!doctype html><title>e3c</title>e3c'); });
await new Promise((r) => srv.listen(0, '127.0.0.1', r));
const browser = await pw.chromium.launch({ headless: true });
const ctx = await browser.newContext(); const page = await ctx.newPage(); await page.goto(`http://localhost:${srv.address().port}/`);
const cdp = await ctx.newCDPSession(page); await cdp.send('WebAuthn.enable');
const va = await cdp.send('WebAuthn.addVirtualAuthenticator', { options: { protocol: 'ctap2', ctap2Version: 'ctap2_1', transport: 'internal', hasResidentKey: true, hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true, hasPrf: true } });
const res = [];
for (let i = 1; i <= 6; i++) {
  const r = await page.evaluate(async (i) => { try { const c = await navigator.credentials.create({ signal: AbortSignal.timeout(5000), publicKey: { rp: { name: 'e3c', id: 'localhost' }, user: { id: new Uint8Array([i, i, i, i]), name: 'u' + i, displayName: 'u' + i }, challenge: crypto.getRandomValues(new Uint8Array(32)), pubKeyCredParams: [{ type: 'public-key', alg: -7 }], authenticatorSelection: { residentKey: 'required', userVerification: 'required' }, extensions: { prf: {} } } }); return 'ok'; } catch (e) { return e.name; } }, i);
  const cs = await cdp.send('WebAuthn.getCredentials', { authenticatorId: va.authenticatorId });
  res.push([i, r, cs.credentials.length]);
}
console.log(JSON.stringify(res));
// after clear
await cdp.send('WebAuthn.clearCredentials', { authenticatorId: va.authenticatorId });
const r2 = await page.evaluate(async () => { try { await navigator.credentials.create({ signal: AbortSignal.timeout(5000), publicKey: { rp: { name: 'e3c', id: 'localhost' }, user: { id: new Uint8Array([9, 9, 9, 9]), name: 'u9', displayName: 'u9' }, challenge: crypto.getRandomValues(new Uint8Array(32)), pubKeyCredParams: [{ type: 'public-key', alg: -7 }], authenticatorSelection: { residentKey: 'required', userVerification: 'required' }, extensions: { prf: {} } } }); return 'ok'; } catch (e) { return e.name; } });
console.log('after clear create:', r2);
await browser.close(); srv.close();
