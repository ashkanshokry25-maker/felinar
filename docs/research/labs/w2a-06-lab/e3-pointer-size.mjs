// E3: byte size of a realistic signed v=mw1 pointer (ARCHITECTURE section 4) and how it splits into <=255-byte TXT strings.
import { randomBytes } from 'node:crypto';
const b64u = n => randomBytes(n).toString('base64url');
const hex40 = randomBytes(20).toString('hex');
const owner = b64u(65), sig = b64u(64);                       // 87 + 86 chars
const parts = {
  minimal:   [`v=mw1`, `btih=${hex40}`, `owner=${owner}`, `seq=1`, `sig=${sig}`],
  typical:   [`v=mw1`, `btih=${hex40}`, `dn=example.com`, `ws=https://cdn.example.com/r/1.4.2-3a1b2c4d/`, `tr=wss://tracker.example.com`, `owner=${owner}`, `seq=1792270345`, `exp=1800046345`, `sig=${sig}`],
  withXsRel: [`v=mw1`, `btih=${hex40}`, `dn=example.com`, `ws=https://cdn.example.com/r/1.4.2-3a1b2c4d/`, `xs=https://cdn.example.com/r/1.4.2-3a1b2c4d/site.torrent`, `tr=wss://tracker.example.com`, `tr=wss://tracker2.example.com`, `rel=1.4.2`, `chain=host:example.com`, `owner=${owner}`, `seq=1792270345`, `exp=1800046345`, `sig=${sig}`],
};
const enc = new TextEncoder();
for (const [name, p] of Object.entries(parts)) {
  const s = p.join('; ');
  const bytes = enc.encode(s).length;
  const strings = Math.ceil(bytes / 255);
  console.log(`${name.padEnd(10)} ${String(bytes).padStart(4)} bytes -> ${strings} TXT string(s) of <=255 B (Route 53 value limit 4000 chars incl. quotes+spaces)`);
}
// Chunker + Route 53 / Cloudflare / BIND renderings
function splitTxt(s, max = 255) { const b = enc.encode(s); const out = []; for (let i = 0; i < b.length; i += max) out.push(new TextDecoder().decode(b.subarray(i, i + max))); return out; }
const rec = parts.typical.join('; ');
const chunks = splitTxt(rec);
const r53Value = chunks.map(c => `"${c.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`).join(' ');
console.log('\nchunk sizes:', chunks.map(c => enc.encode(c).length).join(' + '), '| Route53 Value length incl quotes/spaces:', r53Value.length);
const batch = { Comment: 'magnet-web pointer seq=1792270345', Changes: [{ Action: 'UPSERT', ResourceRecordSet: { Name: '_magnet.example.com.', Type: 'TXT', TTL: 300, ResourceRecords: [{ Value: r53Value }] } }] };
console.log('Route 53 ChangeBatch JSON bytes:', JSON.stringify(batch).length, '(API limit 32,000 chars per request)');
console.log('round trip equals original:', chunks.join('') === rec);
