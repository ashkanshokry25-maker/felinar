// E3b: deleting a passkey destroys the PRF-derived secret (re-registering the same user gives a different secret); UV toggle
import * as pw from '$HOME/Documents/Projects/magnet-web/node_modules/playwright/index.mjs';
import http from 'node:http';
const srv = http.createServer((req, res) => { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end('<!doctype html><title>e3b</title>e3b'); });
await new Promise((r) => srv.listen(0, '127.0.0.1', r));
const browser = await pw.chromium.launch({ headless: true });
const ctx = await browser.newContext(); const page = await ctx.newPage(); await page.goto(`http://localhost:${srv.address().port}/`);
const cdp = await ctx.newCDPSession(page); await cdp.send('WebAuthn.enable');
const va = await cdp.send('WebAuthn.addVirtualAuthenticator', { options: { protocol: 'ctap2', ctap2Version: 'ctap2_1', transport: 'internal', hasResidentKey: true, hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true, hasPrf: true } });
await page.evaluate(() => {
  window.hex = (b) => Array.from(new Uint8Array(b)).map((x) => x.toString(16).padStart(2, '0')).join('');
  window.mk = (uid) => navigator.credentials.create({ publicKey: { rp: { name: 'e3b', id: 'localhost' }, user: { id: new Uint8Array(uid), name: 'same-user', displayName: 'same-user' }, challenge: crypto.getRandomValues(new Uint8Array(32)), pubKeyCredParams: [{ type: 'public-key', alg: -7 }], authenticatorSelection: { residentKey: 'required', userVerification: 'required' }, extensions: { prf: {} } } });
  window.gt = async (cred, uv, salt) => { try { const a = await navigator.credentials.get({ signal: AbortSignal.timeout(6000), publicKey: { challenge: crypto.getRandomValues(new Uint8Array(32)), rpId: 'localhost', allowCredentials: cred ? [{ type: 'public-key', id: cred.rawId }] : [], userVerification: uv, extensions: { prf: { eval: { first: new TextEncoder().encode(salt) } } } } }); const p = a.getClientExtensionResults().prf; return p && p.results ? window.hex(p.results.first).slice(0, 16) : 'no-result'; } catch (e) { return e.name; } };
});
const out = {};
await page.evaluate(async () => { window.c1 = await window.mk([7, 7, 7, 7]); });
out.v1_uvRequired = await page.evaluate(() => window.gt(window.c1, 'required', 'salt'));
out.v1_again = await page.evaluate(() => window.gt(window.c1, 'required', 'salt'));
out.v1_uvDiscouraged_authenticatorUV_on = await page.evaluate(() => window.gt(window.c1, 'discouraged', 'salt'));
await cdp.send('WebAuthn.setUserVerified', { authenticatorId: va.authenticatorId, isUserVerified: false });
out.v1_uvDiscouraged_authenticatorUV_off = await page.evaluate(() => window.gt(window.c1, 'discouraged', 'salt'));
out.v1_uvRequired_authenticatorUV_off = await page.evaluate(() => window.gt(window.c1, 'required', 'salt'));
await cdp.send('WebAuthn.setUserVerified', { authenticatorId: va.authenticatorId, isUserVerified: true });
await cdp.send('WebAuthn.clearCredentials', { authenticatorId: va.authenticatorId });   // "delete the passkey"
out.afterDelete_get = await page.evaluate(() => window.gt(window.c1, 'required', 'salt'));
await new Promise((r) => setTimeout(r, 3000));
await page.evaluate(async () => { try { window.c2 = await window.mk([7, 7, 7, 7]); } catch (e) { window.c2err = e.name; } });
out.reRegisterError = await page.evaluate(() => window.c2err || null);          // re-register same RP + same user handle
out.reRegistered_get = await page.evaluate(() => window.gt(window.c2, 'required', 'salt'));
out.reRegisteredDiffersFromOriginal = out.reRegistered_get !== out.v1_uvRequired;
console.log(JSON.stringify(out, null, 1));
await browser.close(); srv.close();
