// usage: node run-t262.mjs <polyfill.js|none> [filter-substring]
// Runs the tc39/test262 Uint8Array base64/hex tests (downloaded to ./t262) in fresh vm realms, sloppy + strict.
import vm from 'node:vm';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const here = path.dirname(fileURLToPath(import.meta.url));
const [polyArg = 'none', filter = ''] = process.argv.slice(2);
const poly = polyArg === 'none' ? '' : fs.readFileSync(path.resolve(polyArg), 'utf8');
const H = (n) => fs.readFileSync(path.join(here, 't262/harness', n), 'utf8');
function walk(d) { return fs.readdirSync(d, { withFileTypes: true }).flatMap(e => e.isDirectory() ? walk(path.join(d, e.name)) : e.name.endsWith('.js') ? [path.join(d, e.name)] : []); }
const files = walk(path.join(here, 't262/tests')).filter(f => f.includes(filter)).sort();
const results = [];
for (const f of files) {
  const src = fs.readFileSync(f, 'utf8');
  const fm = /\/\*---([\s\S]*?)---\*\//.exec(src)[1];
  const inc = [];
  const im = /includes:\s*\[([^\]]*)\]/.exec(fm);
  if (im) inc.push(...im[1].split(',').map(s => s.trim()).filter(Boolean));
  const flags = (/flags:\s*\[([^\]]*)\]/.exec(fm)?.[1] ?? '').split(',').map(s => s.trim());
  const modes = flags.includes('onlyStrict') ? ['strict'] : flags.includes('noStrict') ? ['sloppy'] : ['sloppy', 'strict'];
  for (const mode of modes) {
    const ctx = vm.createContext({ console, btoa, atob });
    ctx.$262 = { global: ctx, detachArrayBuffer(buf) { structuredClone(buf, { transfer: [buf] }); }, evalScript: (c) => vm.runInContext(c, ctx) };
    let err = null;
    try {
      if (poly) vm.runInContext(poly, ctx, { filename: 'polyfill' });
      for (const h of ['assert.js', 'sta.js', ...inc]) vm.runInContext(H(h), ctx, { filename: h });
      vm.runInContext((mode === 'strict' ? '"use strict";\n' : '') + src, ctx, { filename: path.relative(here, f) });
    } catch (e) { err = String(e && e.message || e).split('\n')[0].slice(0, 200); }
    results.push({ test: path.relative(path.join(here, 't262/tests'), f), mode, ok: !err, err });
  }
}
const pass = results.filter(r => r.ok).length;
console.log(`${polyArg}: ${pass}/${results.length} passed (${files.length} test files x modes)`);
const byDir = {};
for (const r of results) { const d = r.test.split('/').slice(0, -1).join('/'); (byDir[d] ??= { p: 0, n: 0 }); byDir[d].n++; if (r.ok) byDir[d].p++; }
for (const [d, v] of Object.entries(byDir)) console.log(`  ${d.padEnd(28)} ${v.p}/${v.n}`);
for (const r of results.filter(r => !r.ok)) console.log(`  FAIL ${r.test} [${r.mode}]: ${r.err}`);
