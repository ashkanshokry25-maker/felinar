// Scratchpad-only: can a WebAuthn assertion act as a pointer-record signature verified with plain WebCrypto?
// Chromium virtual authenticator (CDP). Also checks PRF determinism on the virtual authenticator.
import http from 'node:http'
import { chromium } from '$HOME/Documents/Projects/magnet-web/node_modules/playwright/index.mjs'
const srv = http.createServer((req, res) => { res.writeHead(200, { 'content-type': 'text/html' }); res.end('<!doctype html><title>wa</title><body>wa') })
await new Promise(r => srv.listen(0, '127.0.0.1', r)); const port = srv.address().port
const browser = await chromium.launch({ headless: true })
const ctx = await browser.newContext(); const page = await ctx.newPage()
await page.goto(`http://localhost:${port}/`)
const cdp = await ctx.newCDPSession(page)
await cdp.send('WebAuthn.enable')
let optsUsed = null
for (const opts of [
  { protocol: 'ctap2', ctap2Version: 'ctap2_1', transport: 'usb', hasResidentKey: true, hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true, hasPrf: true },
  { protocol: 'ctap2', ctap2Version: 'ctap2_1', transport: 'usb', hasResidentKey: true, hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true }
]) { try { await cdp.send('WebAuthn.addVirtualAuthenticator', { options: opts }); optsUsed = opts; break } catch (e) { console.error('addVirtualAuthenticator failed with', Object.keys(opts).join(','), e.message.slice(0, 120)) } }
const result = await page.evaluate(async () => {
  const b64u = (u8) => btoa(String.fromCharCode(...u8)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
  const enc = new TextEncoder()
  const sha256 = async (u8) => new Uint8Array(await crypto.subtle.digest('SHA-256', u8))
  const out = {}
  const cred = await navigator.credentials.create({ publicKey: { rp: { name: 'mw-owner', id: 'localhost' }, user: { id: enc.encode('owner-1'), name: 'owner', displayName: 'owner' }, challenge: crypto.getRandomValues(new Uint8Array(32)), pubKeyCredParams: [{ type: 'public-key', alg: -7 }], authenticatorSelection: { userVerification: 'required', residentKey: 'discouraged' }, extensions: { prf: {} } } })
  out.createExt = cred.getClientExtensionResults()
  out.pubKeyAlg = cred.response.getPublicKeyAlgorithm()
  const spki = new Uint8Array(cred.response.getPublicKey())
  out.spkiBytes = spki.length
  const pub = await crypto.subtle.importKey('spki', spki, { name: 'ECDSA', namedCurve: 'P-256' }, true, ['verify'])
  const raw = new Uint8Array(await crypto.subtle.exportKey('raw', pub)); out.rawPubBytes = raw.length
  // the "signing input" of a pointer record (domain-separated) -> challenge = SHA-256(input)
  const input = enc.encode('mw-pointer-v1\nbtih=0123456789abcdef0123456789abcdef01234567\nseq=7\nexp=1800000000\nexample.com')
  const challenge = await sha256(input)
  const a = await navigator.credentials.get({ publicKey: { challenge, rpId: 'localhost', allowCredentials: [{ type: 'public-key', id: cred.rawId }], userVerification: 'required', extensions: { prf: { eval: { first: enc.encode('mw-owner-wrap-v1') } } } } })
  const authData = new Uint8Array(a.response.authenticatorData), cdj = new Uint8Array(a.response.clientDataJSON), der = new Uint8Array(a.response.signature)
  out.sizes = { authenticatorData: authData.length, clientDataJSON: cdj.length, signatureDER: der.length }
  out.clientDataJSON = new TextDecoder().decode(cdj)
  // DER -> P1363
  const readInt = (buf, o) => { const len = buf[o + 1]; let v = buf.slice(o + 2, o + 2 + len); while (v.length > 32 && v[0] === 0) v = v.slice(1); const p = new Uint8Array(32); p.set(v, 32 - v.length); return [p, o + 2 + len] }
  const [r, o2] = readInt(der, 2); const [s] = readInt(der, o2)
  const p1363 = new Uint8Array(64); p1363.set(r, 0); p1363.set(s, 32)
  const signed = new Uint8Array(authData.length + 32); signed.set(authData, 0); signed.set(await sha256(cdj), authData.length)
  out.verifyWithWebCrypto = await crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, pub, p1363, signed)
  const cd = JSON.parse(out.clientDataJSON)
  out.challengeMatches = cd.challenge === b64u(challenge)
  out.rpIdHashMatches = b64u(authData.slice(0, 32)) === b64u(await sha256(enc.encode('localhost')))
  out.flags = '0x' + authData[32].toString(16) + ' (UP=' + !!(authData[32] & 1) + ', UV=' + !!(authData[32] & 4) + ')'
  // negative control: tamper the input
  const tampered = await sha256(enc.encode('mw-pointer-v1\nbtih=ffffffffffffffffffffffffffffffffffffffff\nseq=7\nexp=1800000000\nexample.com'))
  out.tamperedChallengeMatches = cd.challenge === b64u(tampered)
  // compact record encodings (what would go into the TXT)
  out.compactBytes = { authData_b64url: b64u(authData).length, clientDataJSON_b64url: b64u(cdj).length, sig_p1363_b64url: b64u(p1363).length, rawPub_b64url: b64u(raw).length, plainEcdsaSig_b64url: b64u(p1363).length }
  // PRF determinism
  const prf = async (salt) => { const g = await navigator.credentials.get({ publicKey: { challenge: crypto.getRandomValues(new Uint8Array(32)), rpId: 'localhost', allowCredentials: [{ type: 'public-key', id: cred.rawId }], userVerification: 'required', extensions: { prf: { eval: { first: enc.encode(salt) } } } } }); const e = g.getClientExtensionResults(); return e.prf && e.prf.results && e.prf.results.first ? b64u(new Uint8Array(e.prf.results.first)) : null }
  const p1 = await prf('salt-A'), p2 = await prf('salt-A'), p3 = await prf('salt-B')
  out.prf = { available: !!p1, sameSaltEqual: p1 === p2, differentSaltDiffer: p1 !== p3, outputBytes: p1 ? atob(p1.replace(/-/g, '+').replace(/_/g, '/')).length : null }
  return out
}).catch(e => ({ error: String(e) }))
console.log(JSON.stringify({ chromium: browser.version(), virtualAuthenticatorOptions: optsUsed && Object.keys(optsUsed).join(','), result }, null, 1))
await browser.close(); srv.close(); process.exit(0)
