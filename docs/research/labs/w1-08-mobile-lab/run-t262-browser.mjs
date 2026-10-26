// usage: node run-t262-browser.mjs <mode> [polyfill.js]
//   mode: native            -> run tests against the engine's own implementation (control)
//         stripped          -> delete the 6 native methods first, no polyfill (expect failures)
//         stripped+polyfill -> delete natives, then install polyfill
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { launchEngine, ENGINE } from './lab-browsers.mjs';
const here = path.dirname(fileURLToPath(import.meta.url));
const [mode = 'native', polyArg] = process.argv.slice(2);
const poly = polyArg ? fs.readFileSync(path.resolve(polyArg), 'utf8') : '';
const H = (n) => fs.readFileSync(path.join(here, 't262/harness', n), 'utf8');
function walk(d) { return fs.readdirSync(d, { withFileTypes: true }).flatMap(e => e.isDirectory() ? walk(path.join(d, e.name)) : e.name.endsWith('.js') ? [path.join(d, e.name)] : []); }
const files = walk(path.join(here, 't262/tests')).sort();
const jobs = [];
for (const f of files) {
  const src = fs.readFileSync(f, 'utf8');
  const fm = /\/\*---([\s\S]*?)---\*\//.exec(src)[1];
  const inc = (/includes:\s*\[([^\]]*)\]/.exec(fm)?.[1] ?? '').split(',').map(s => s.trim()).filter(Boolean);
  const flags = (/flags:\s*\[([^\]]*)\]/.exec(fm)?.[1] ?? '').split(',').map(s => s.trim());
  const modes = flags.includes('onlyStrict') ? ['strict'] : flags.includes('noStrict') ? ['sloppy'] : ['sloppy', 'strict'];
  for (const m of modes) jobs.push({ test: path.relative(path.join(here, 't262/tests'), f), mode: m, src, harness: ['assert.js', 'sta.js', ...inc].map(H) });
}
const browser = await launchEngine();
const page = await browser.newPage();
await page.goto('about:blank');
const out = await page.evaluate(async ({ jobs, strip, poly }) => {
  const res = [];
  for (const j of jobs) {
    const fr = document.createElement('iframe'); document.body.appendChild(fr);
    const w = fr.contentWindow;
    w.$262 = { global: w, detachArrayBuffer(buf) { w.structuredClone(buf, { transfer: [buf] }); }, evalScript: (c) => w.eval(c) };
    let err = null;
    try {
      if (strip) { for (const k of ['toHex', 'toBase64', 'setFromHex', 'setFromBase64']) delete w.Uint8Array.prototype[k]; for (const k of ['fromHex', 'fromBase64']) delete w.Uint8Array[k]; }
      if (poly) w.eval(poly);
      for (const h of j.harness) w.eval(h);
      w.eval((j.mode === 'strict' ? '"use strict";\n' : '') + j.src);
    } catch (e) { err = String((e && e.message) || e).split('\n')[0].slice(0, 160); }
    res.push({ test: j.test, mode: j.mode, ok: !err, err });
    fr.remove();
  }
  return res;
}, { jobs, strip: mode !== 'native', poly: mode === 'stripped+polyfill' ? poly : '' });
const ver = browser.version();
await browser.close();
const pass = out.filter(r => r.ok).length;
console.log(`${mode}${polyArg ? ' ' + polyArg : ''} on ${ENGINE} ${ver}: ${pass}/${out.length} passed`);
const byDir = {};
for (const r of out) { const d = r.test.split('/').slice(0, -1).join('/'); (byDir[d] ??= { p: 0, n: 0 }); byDir[d].n++; if (r.ok) byDir[d].p++; }
for (const [d, v] of Object.entries(byDir)) console.log(`  ${d.padEnd(28)} ${v.p}/${v.n}`);
for (const r of out.filter(r => !r.ok).slice(0, 12)) console.log(`  FAIL ${r.test} [${r.mode}]: ${r.err}`);
