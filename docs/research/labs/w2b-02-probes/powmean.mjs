import { createHash, randomBytes } from 'node:crypto';
function mine(bits) {
  const d = randomBytes(32).toString('hex'); let n = 0; const t0 = performance.now();
  for (;;) {
    const s = '[0,"' + 'a'.repeat(64) + '",1790000000,30311,[["d","' + d + '"],["nonce","' + n + '","' + bits + '"]],"' + 'z'.repeat(600) + '"]';
    const id = createHash('sha256').update(s).digest(); let z = 0;
    for (const byte of id) { if (byte === 0) { z += 8; continue; } z += Math.clz32(byte) - 24; break; }
    if (z >= bits) return { hashes: n + 1, ms: performance.now() - t0 };
    n++;
  }
}
for (const [bits, reps] of [[12, 200], [14, 100], [16, 40], [18, 12]]) {
  const r = Array.from({ length: reps }, () => mine(bits)); const mh = r.reduce((a, b) => a + b.hashes, 0) / reps; const ms = r.reduce((a, b) => a + b.ms, 0) / reps;
  const sorted = r.map(x => x.hashes).sort((a, b) => a - b);
  console.log(JSON.stringify({ bits, reps, expected: 2 ** bits, mean_hashes: Math.round(mh), median_hashes: sorted[Math.floor(reps / 2)], p95_hashes: sorted[Math.floor(reps * 0.95)], mean_ms: +ms.toFixed(1), hashes_per_s: Math.round(mh / (ms / 1000)) }));
}
