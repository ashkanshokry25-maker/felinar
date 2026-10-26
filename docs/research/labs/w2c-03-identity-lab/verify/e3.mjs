// E3: WebAuthn PRF semantics in Chromium's CDP virtual CTAP2 authenticator (software; validates client flow only).
// NOTE: the virtual authenticator stores at most 3 resident credentials; a 4th create() fails with NotAllowedError (see e3c.mjs).
import * as pw from '$HOME/Documents/Projects/magnet-web/node_modules/playwright/index.mjs';
import http from 'node:http';
const srv = http.createServer((req, res) => { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end('<!doctype html><title>e3</title>e3'); });
await new Promise((r) => srv.listen(0, '127.0.0.1', r));
const origin = `http://localhost:${srv.address().port}/`;
const browser = await pw.chromium.launch({ headless: true });
const ctx = await browser.newContext(); const page = await ctx.newPage(); await page.goto(origin);
const cdp = await ctx.newCDPSession(page); await cdp.send('WebAuthn.enable');
const va = await cdp.send('WebAuthn.addVirtualAuthenticator', { options: { protocol: 'ctap2', ctap2Version: 'ctap2_1', transport: 'internal', hasResidentKey: true, hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true, hasPrf: true } });
const out = { chromium: browser.version() };
const run = (fn, arg) => page.evaluate(fn, arg);
const common = `
  const hex = (b) => Array.from(new Uint8Array(b)).map((x) => x.toString(16).padStart(2, '0')).join('');
  const enc = (s) => new TextEncoder().encode(s);
`;
out.A = await run(async () => {
  const hex = (b) => Array.from(new Uint8Array(b)).map((x) => x.toString(16).padStart(2, '0')).join('');
  const enc = (s) => new TextEncoder().encode(s);
  const o = {};
  const caps = await PublicKeyCredential.getClientCapabilities();
  o.caps = { prf: caps['extension:prf'], relatedOrigins: caps.relatedOrigins, hybridTransport: caps.hybridTransport };
  const mk = async (id, ext) => navigator.credentials.create({ publicKey: { rp: { name: 'e3', id: 'localhost' }, user: { id: new Uint8Array([id]), name: 'u' + id, displayName: 'u' + id }, challenge: crypto.getRandomValues(new Uint8Array(32)), pubKeyCredParams: [{ type: 'public-key', alg: -7 }], authenticatorSelection: { residentKey: 'required', userVerification: 'required' }, extensions: ext } });
  const c1 = await mk(1, { prf: {} });
  const x1 = c1.getClientExtensionResults();
  o.createEmpty = { enabled: x1.prf && x1.prf.enabled, hasResults: !!(x1.prf && x1.prf.results) };
  try { const c1b = await mk(11, { prf: { eval: { first: enc('create-time-eval') } } });
  const x1b = c1b.getClientExtensionResults();
  o.createWithEval = { enabled: x1b.prf && x1b.prf.enabled, hasResults: !!(x1b.prf && x1b.prf.results) }; } catch (e) { o.createWithEval = e.name + ': ' + String(e.message).slice(0, 90); }
  const get = async (cred, prf, uv = 'required') => { const a = await navigator.credentials.get({ publicKey: { challenge: crypto.getRandomValues(new Uint8Array(32)), rpId: 'localhost', allowCredentials: [{ type: 'public-key', id: cred.rawId }], userVerification: uv, extensions: { prf } } }); return a.getClientExtensionResults().prf; };
  const s1 = enc('salt-one'), s2 = enc('salt-two');
  const g1 = await get(c1, { eval: { first: s1 } }); const g1b = await get(c1, { eval: { first: s1 } });
  const g2 = await get(c1, { eval: { first: s2, second: s1 } });
  o.get = { len: g1.results.first.byteLength, stable: hex(g1.results.first) === hex(g1b.results.first), saltSeparated: hex(g1.results.first) !== hex(g2.results.first), secondEqualsFirstOfSameSalt: hex(g2.results.second) === hex(g1.results.first), hasEnabledAtGet: 'enabled' in g1 };
  const c2 = await mk(2, { prf: {} });
  const h2 = await get(c2, { eval: { first: s1 } });
  o.secondCredentialDiffers = hex(h2.results.first) !== hex(g1.results.first);
  // evalByCredential
  try { const e = await get(c1, { evalByCredential: { [btoa(String.fromCharCode(...new Uint8Array(c1.rawId))).replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'')]: { first: s1 } } }); o.evalByCredential = { equalsEval: hex(e.results.first) === hex(g1.results.first) }; } catch (e) { o.evalByCredential = e.name + ': ' + e.message; }
  o._ids = { c1: Array.from(new Uint8Array(c1.rawId)).slice(0, 8) };
  window.__c1 = c1; window.__s1 = s1;
  return o;
});
console.log(JSON.stringify(out, null, 1));
await browser.close(); srv.close();
