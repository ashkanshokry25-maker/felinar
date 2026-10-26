import * as jd from 'jdenticon';
import { createHash, randomBytes } from 'node:crypto';
const toSvg = jd.toSvg || jd.default?.toSvg;
const N = Number(process.argv[2] || 200000);
const seen = new Set(); const t0 = Date.now();
for (let i = 0; i < N; i++) {
  const h = createHash('sha256').update(randomBytes(32)).digest('hex');
  seen.add(toSvg(h, 64));
}
const uniq = seen.size;
console.log(JSON.stringify({ N, distinctSvg: uniq, collisions: N - uniq, effectiveBitsIfUniform: +(Math.log2((N * N) / (2 * Math.max(1, N - uniq)))).toFixed(1), ms: Date.now() - t0 }));
