// Scratchpad-only PoC: verify an OpenSSH SSHSIG (ssh-keygen -Y sign) with WebCrypto only.
// Real-world path tested: ecdsa-sha2-nistp256 (made by OpenSSH_10.6p1). The sk-ecdsa path is implemented from PROTOCOL.u2f
// and exercised only with a synthetic "authenticator" (software key) -> self-consistency, NOT hardware-verified.
import { readFileSync } from 'node:fs'
import { webcrypto as crypto } from 'node:crypto'
const te = new TextEncoder(), td = new TextDecoder()
const u32 = (b, o) => ((b[o] << 24) | (b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3]) >>> 0
function readString (b, o) { const n = u32(b, o); return [b.subarray(o + 4, o + 4 + n), o + 4 + n] }
function concat (...a) { const n = a.reduce((s, x) => s + x.length, 0); const r = new Uint8Array(n); let o = 0; for (const x of a) { r.set(x, o); o += x.length } return r }
const sshString = (bytes) => { const r = new Uint8Array(4 + bytes.length); new DataView(r.buffer).setUint32(0, bytes.length); r.set(bytes, 4); return r }
const sha = async (alg, u8) => new Uint8Array(await crypto.subtle.digest(alg, u8))
function mpintTo32 (b) { let v = b; while (v.length > 32 && v[0] === 0) v = v.subarray(1); const p = new Uint8Array(32); p.set(v, 32 - v.length); return p }

export async function verifySshSig (armored, message, { expectNamespace } = {}) {
  const b64 = armored.replace(/-----(BEGIN|END) SSH SIGNATURE-----/g, '').replace(/\s+/g, '')
  const blob = Uint8Array.from(Buffer.from(b64, 'base64'))
  if (td.decode(blob.subarray(0, 6)) !== 'SSHSIG') throw new Error('bad magic')
  if (u32(blob, 6) !== 1) throw new Error('unsupported version')
  let o = 10; let pk, ns, reserved, hashAlg, sig
  ;[pk, o] = readString(blob, o); [ns, o] = readString(blob, o); [reserved, o] = readString(blob, o); [hashAlg, o] = readString(blob, o); [sig, o] = readString(blob, o)
  const namespace = td.decode(ns), hash = td.decode(hashAlg)
  if (expectNamespace && namespace !== expectNamespace) throw new Error('namespace mismatch: ' + namespace)
  if (!['sha256', 'sha512'].includes(hash)) throw new Error('hash alg not allowed: ' + hash)
  // public key
  let p = 0; let ktBytes, curve, Q, app
  ;[ktBytes, p] = readString(pk, p); const keyType = td.decode(ktBytes)
  ;[curve, p] = readString(pk, p); [Q, p] = readString(pk, p)
  if (keyType === 'sk-ecdsa-sha2-nistp256@openssh.com') [app, p] = readString(pk, p)
  else if (keyType !== 'ecdsa-sha2-nistp256') throw new Error('unsupported key type ' + keyType)
  const pub = await crypto.subtle.importKey('raw', Q, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify'])
  // signature
  let q = 0; let stBytes, inner
  ;[stBytes, q] = readString(sig, q); [inner, q] = readString(sig, q)
  const sigType = td.decode(stBytes)
  let rs = 0; let r, s
  ;[r, rs] = readString(inner, rs); [s, rs] = readString(inner, rs)
  const p1363 = concat(mpintTo32(r), mpintTo32(s))
  // signed data per PROTOCOL.sshsig
  const hm = await sha(hash === 'sha256' ? 'SHA-256' : 'SHA-512', message)
  const signedData = concat(te.encode('SSHSIG'), sshString(ns), sshString(reserved), sshString(hashAlg), sshString(hm))
  let dataForEcdsa = signedData
  let flags = null, counter = null
  if (sigType === 'sk-ecdsa-sha2-nistp256@openssh.com') {
    flags = sig[q]; counter = u32(sig, q + 1)
    dataForEcdsa = concat(await sha('SHA-256', app), Uint8Array.of(flags), Uint8Array.of(counter >>> 24, (counter >>> 16) & 255, (counter >>> 8) & 255, counter & 255), await sha('SHA-256', signedData))
  } else if (sigType !== 'ecdsa-sha2-nistp256') throw new Error('unexpected sig type ' + sigType)
  const ok = await crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, pub, p1363, dataForEcdsa)
  return { ok, keyType, sigType, namespace, hash, flags, counter, pubRawBytes: Q.length, sigBlobBytes: blob.length, armoredChars: armored.length }
}

// ---- real ssh-keygen output
const armored = readFileSync('input.txt.sig', 'utf8'); const msg = readFileSync('input.txt')
console.log('REAL ssh-keygen -Y sign (ecdsa-sha2-nistp256):', JSON.stringify(await verifySshSig(armored, msg, { expectNamespace: 'magnet-web-pointer-v1' })))
const tampered = Buffer.from(msg); tampered[20] ^= 1
console.log('tampered message ->', JSON.stringify(await verifySshSig(armored, tampered).catch(e => ({ ok: false, err: e.message }))))
console.log('wrong namespace expectation ->', JSON.stringify(await verifySshSig(armored, msg, { expectNamespace: 'file' }).catch(e => ({ ok: false, err: e.message }))))
// ---- cross-check against OpenSSH's own verifier is done in the shell (ssh-keygen -Y verify)
// ---- synthetic sk-ecdsa signature (software key standing in for the authenticator)
const kp = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify'])
const Qraw = new Uint8Array(await crypto.subtle.exportKey('raw', kp.publicKey))
const application = te.encode('ssh:'); const hashAlgB = te.encode('sha512'); const ns = te.encode('magnet-web-pointer-v1')
const hm = await sha('SHA-512', msg)
const signedData = concat(te.encode('SSHSIG'), sshString(ns), sshString(new Uint8Array(0)), sshString(hashAlgB), sshString(hm))
const flags = 0x05, counter = 42
const toSign = concat(await sha('SHA-256', application), Uint8Array.of(flags), Uint8Array.of(0, 0, 0, counter), await sha('SHA-256', signedData))
const raw = new Uint8Array(await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, kp.privateKey, toSign))
const mp = (x) => { let i = 0; while (i < x.length - 1 && x[i] === 0) i++; let v = x.subarray(i); if (v[0] & 0x80) v = concat(Uint8Array.of(0), v); return sshString(v) }
const ecdsaSig = concat(mp(raw.subarray(0, 32)), mp(raw.subarray(32)))
const skSig = concat(sshString(te.encode('sk-ecdsa-sha2-nistp256@openssh.com')), sshString(ecdsaSig), Uint8Array.of(flags), Uint8Array.of(0, 0, 0, counter))
const skPk = concat(sshString(te.encode('sk-ecdsa-sha2-nistp256@openssh.com')), sshString(te.encode('nistp256')), sshString(Qraw), sshString(application))
const sshsigBlob = concat(te.encode('SSHSIG'), Uint8Array.of(0, 0, 0, 1), sshString(skPk), sshString(ns), sshString(new Uint8Array(0)), sshString(hashAlgB), sshString(concat(sshString(te.encode('sk-ecdsa-sha2-nistp256@openssh.com')), sshString(ecdsaSig), Uint8Array.of(flags), Uint8Array.of(0, 0, 0, counter))))
const armoredSk = '-----BEGIN SSH SIGNATURE-----\n' + Buffer.from(sshsigBlob).toString('base64').replace(/(.{76})/g, '$1\n') + '\n-----END SSH SIGNATURE-----\n'
console.log('SYNTHETIC sk-ecdsa (self-consistency only):', JSON.stringify(await verifySshSig(armoredSk, msg, { expectNamespace: 'magnet-web-pointer-v1' })))
