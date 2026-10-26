import { argon2id as wasmArgon2id } from 'hash-wasm';
import { argon2id as nobleArgon2id } from '@noble/hashes/argon2.js';
import { scrypt } from '@noble/hashes/scrypt.js';
import { pbkdf2 } from 'node:crypto';
const pw = new TextEncoder().encode('correct horse battery staple'); const salt = new Uint8Array(16).map((_, i) => i * 7 + 1);
const time = async (fn, reps = 4) => { const ts = []; for (let i = 0; i < reps; i++) { const t0 = performance.now(); await fn(); ts.push(performance.now() - t0); } ts.sort((a, b) => a - b); return { min: Math.round(ts[0]), med: Math.round(ts[ts.length >> 1]) }; };
const out = {};
for (const [m, t] of [[19456, 2], [65536, 3]]) {
  out[`wasm argon2id m=${m / 1024}MiB t=${t}`] = await time(() => wasmArgon2id({ password: pw, salt, parallelism: 1, iterations: t, memorySize: m, hashLength: 32, outputType: 'binary' }));
  out[`noble argon2id m=${m / 1024}MiB t=${t}`] = await time(() => nobleArgon2id(pw, salt, { t, m, p: 1, dkLen: 32 }), 2);
}
out['noble scrypt N=2^16 r=8 p=1'] = await time(() => scrypt(pw, salt, { N: 2 ** 16, r: 8, p: 1, dkLen: 32 }), 3);
console.log(JSON.stringify(out, null, 1));
const r = (a, b) => (out[a].med / out[b].med).toFixed(1);
console.log('noble/wasm ratio 19MiB t=2:', r('noble argon2id m=19MiB t=2', 'wasm argon2id m=19MiB t=2'), ' 64MiB t=3:', r('noble argon2id m=64MiB t=3', 'wasm argon2id m=64MiB t=3'));
