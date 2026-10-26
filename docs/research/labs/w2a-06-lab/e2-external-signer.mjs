// E2: can an EXTERNAL signer (openssl here; AWS KMS / YubiKey PIV / Vault transit produce the same DER) sign a pointer
// that the project's verify() accepts? Needs DER ECDSA-Sig-Value -> raw 64-byte r||s (IEEE P1363) conversion.
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const SRC = '$HOME/Documents/Projects/magnet-web/src';
const { verify } = await import(pathToFileURL(`${SRC}/chain/crypto.js`).href);
const { b64url } = await import(pathToFileURL(`${SRC}/chain/canonical.js`).href);

const OSSL = '/opt/homebrew/bin/openssl';
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mwe2-'));
const key = path.join(dir, 'owner.pem');
execFileSync(OSSL, ['ecparam', '-name', 'prime256v1', '-genkey', '-noout', '-out', key]);
// raw 65-byte uncompressed public point = last 65 bytes of the SubjectPublicKeyInfo DER
const spki = execFileSync(OSSL, ['ec', '-in', key, '-pubout', '-conv_form', 'uncompressed', '-outform', 'DER'], { stdio: ['ignore', 'pipe', 'ignore'] });
const pubRaw = spki.subarray(spki.length - 65);
if (pubRaw[0] !== 0x04) throw new Error('unexpected pubkey encoding');
const owner = b64url.encode(new Uint8Array(pubRaw));

/** DER ECDSA-Sig-Value -> raw r||s, 32 bytes each (strip ASN.1 sign-padding zero, left-pad short ints). */
export function derToRaw(der, size = 32) {
  let i = 0;
  const readLen = () => { let l = der[i++]; if (l & 0x80) { const n = l & 0x7f; l = 0; for (let k = 0; k < n; k++) l = (l << 8) | der[i++]; } return l; };
  if (der[i++] !== 0x30) throw new Error('not a DER SEQUENCE');
  readLen();
  const ints = [];
  for (let k = 0; k < 2; k++) {
    if (der[i++] !== 0x02) throw new Error('not a DER INTEGER');
    let len = readLen(); let v = der.subarray(i, i + len); i += len;
    while (v.length > size && v[0] === 0) v = v.subarray(1);          // drop sign-padding zero(s)
    if (v.length > size) throw new Error('integer too large for curve');
    const out = new Uint8Array(size); out.set(v, size - v.length); ints.push(out); // left-pad short integers
  }
  const raw = new Uint8Array(size * 2); raw.set(ints[0], 0); raw.set(ints[1], size); return raw;
}

// A realistic signing input per ARCHITECTURE section 4 (sorted k=v lines excluding sig, then scope).
const base = { v: 'mw1', btih: 'a'.repeat(40), seq: '1', owner };
let ok = 0, bad = 0, sizes = new Set(), minLen = 99, maxLen = 0;
for (let n = 0; n < 120; n++) {
  const rec = { ...base, seq: String(n + 1), btih: randomBytes(20).toString('hex') };
  const lines = Object.entries(rec).map(([k, v]) => `${k}=${v}`).sort();
  const signingInput = lines.join('\n') + '\nexample.com';
  const msgFile = path.join(dir, 'm.txt'); fs.writeFileSync(msgFile, signingInput);
  const der = execFileSync(OSSL, ['dgst', '-sha256', '-sign', key, msgFile]);   // what KMS Sign(MessageType=RAW, ECDSA_SHA_256) / PIV return
  minLen = Math.min(minLen, der.length); maxLen = Math.max(maxLen, der.length); sizes.add(der.length);
  const raw = derToRaw(new Uint8Array(der));
  const good = await verify(owner, signingInput, raw);
  const naive = await verify(owner, signingInput, new Uint8Array(der).subarray(0, 64)); // wrong on purpose: what happens if you forget to convert
  const tamper = await verify(owner, signingInput + 'x', raw);
  if (good && !naive && !tamper) ok++; else bad++;
}
console.log(`external-signer signatures verified by project verify(): ok=${ok} bad=${bad} (DER lengths seen: ${[...sizes].sort().join(',')}; min ${minLen}, max ${maxLen})`);
console.log('owner (b64url, 65-byte point):', owner.length, 'chars');
fs.rmSync(dir, { recursive: true, force: true });
