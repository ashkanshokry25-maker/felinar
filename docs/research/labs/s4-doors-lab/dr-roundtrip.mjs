// Usage: node dr-roundtrip.mjs. An unknown dr= key is kept and signed by src/common/pointer.js; a record signed for scope btih:<hex> verifies on any door and fails under a hostname scope.
import { resolve as __resolve, dirname as __dirname } from 'node:path';
import { fileURLToPath as __fu } from 'node:url';
const ROOT = __resolve(__dirname(__fu(import.meta.url)), '../../../..');
const P = await import(ROOT + '/src/common/pointer.js');
const C = await import(ROOT + '/src/chain/crypto.js');
const { privateKey, publicKey } = await C.generateKeyPair({ extractable: true });
const owner = await C.exportPublicKey(publicKey);
const btih = 'b'.repeat(40); const now = Math.floor(Date.now() / 1000);
const rec = { v: 'mw1', btih, dn: 'x', owner, chain: 'c', seq: now, exp: now + 86400 * 30, extra: { dr: 'a.example.org,b.example.net' } };
const signed = await P.signPointer(rec, 'btih:' + btih, privateKey);
const text = P.formatPointer(signed);
console.log(text.replace(/sig=.*/, 'sig=...').replace(/owner=p256:[^;]*/, 'owner=p256:...'));
const parsed = P.parsePointer(text);
console.log('parsed ok', parsed.ok, 'extra.dr =', parsed.record && parsed.record.extra && parsed.record.extra.dr);
const v = await P.verifyPointer(parsed.record, 'btih:' + btih, { now: Date.now() });
console.log('verify with the same scope:', JSON.stringify({ ok: v.ok, reason: v.reason }));
const v2 = await P.verifyPointer(parsed.record, 'example.org', { now: Date.now() });
console.log('verify under a hostname scope (a different door):', JSON.stringify({ ok: v2.ok, reason: v2.reason }));
// tamper: drop a door from the text and re-verify
const tampered = text.replace('a.example.org,b.example.net', 'b.example.net');
const pt = P.parsePointer(tampered);
const v3 = await P.verifyPointer(pt.record, 'btih:' + btih, { now: Date.now() });
console.log('verify after a door was removed from the text:', JSON.stringify({ ok: v3.ok, reason: v3.reason }));
process.exit(0);
