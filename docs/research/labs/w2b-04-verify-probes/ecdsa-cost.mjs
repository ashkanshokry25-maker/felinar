// VERIFY claim 5: cost of a throw-away identity (ECDSA P-256 keygen + export + sign) and of verifying, on this M3 (Node WebCrypto)
const { subtle } = globalThis.crypto
const N = 300
const msg = new TextEncoder().encode('mw-block-v1\n' + 'a'.repeat(64))
let t0 = performance.now(); const kps = []
for (let i = 0; i < N; i++) kps.push(await subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']))
const gen = (performance.now() - t0) / N
t0 = performance.now(); const pubs = []
for (const kp of kps) pubs.push(new Uint8Array(await subtle.exportKey('raw', kp.publicKey)))
const exp = (performance.now() - t0) / N
t0 = performance.now(); const sigs = []
for (const kp of kps) sigs.push(await subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, kp.privateKey, msg))
const sign = (performance.now() - t0) / N
t0 = performance.now(); let ok = 0
for (let i = 0; i < N; i++) ok += (await subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, kps[i].publicKey, sigs[i], msg)) ? 1 : 0
const ver = (performance.now() - t0) / N
console.log(JSON.stringify({ N, keygen_ms: +gen.toFixed(3), exportRaw_ms: +exp.toFixed(3), sign_ms: +sign.toFixed(3), verify_ms: +ver.toFixed(3), verified_ok: ok, fresh_identity_total_ms: +(gen + exp + sign).toFixed(3) }))
