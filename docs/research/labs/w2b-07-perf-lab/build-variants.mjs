// Lab 1a: size of webtorrent 3.0.21 when rebuilt from npm source with esbuild vs the vendored dist/webtorrent.min.js.
// Run: node build-variants.mjs   (needs the repo's node_modules). Output: out/build-variants.json
import { build } from '../../../../node_modules/esbuild/lib/main.js';
import fs from 'node:fs';
import zlib from 'node:zlib';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '../../..');
const sizes = (buf) => ({
  raw: buf.length,
  gzip9: zlib.gzipSync(buf, { level: 9 }).length,
  br11: zlib.brotliCompressSync(buf, { params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 11, [zlib.constants.BROTLI_PARAM_SIZE_HINT]: buf.length } }).length,
});
const rows = [];
const dist = fs.readFileSync(path.join(root, 'node_modules/webtorrent/dist/webtorrent.min.js'));
rows.push({ name: 'vendored dist/webtorrent.min.js (webpack+terser, as shipped)', ...sizes(dist) });
const entry = path.join(here, 'wt-entry.js');
fs.writeFileSync(entry, "export { default } from 'webtorrent';\n");
const dbgStub = path.join(here, 'debug-stub.js');
fs.writeFileSync(dbgStub, "const noop = () => {}; const d = () => noop; d.enabled = () => false; d.enable = noop; d.disable = noop; export default d;\n");
async function variant(name, opts) {
  const r = await build({
    entryPoints: [entry], bundle: true, write: false, format: 'esm', platform: 'browser', minify: true,
    legalComments: 'none', logLevel: 'silent', absWorkingDir: root, define: { 'process.browser': 'true', 'global': 'globalThis' },
    ...opts,
  });
  const out = Buffer.from(r.outputFiles[0].contents);
  rows.push({ name, ...sizes(out), warnings: r.warnings.length });
  return out;
}
const v1 = await variant('esbuild from npm source, minify, es2022', { target: 'es2022' });
await variant('esbuild from npm source, minify, es2017', { target: 'es2017' });
await variant('esbuild from npm source, minify, es2020 + debug stubbed out', { target: 'es2020', alias: { debug: dbgStub } });
fs.writeFileSync(path.join(here, 'out/wt-esbuild-es2022.js'), v1);
fs.writeFileSync(path.join(here, 'out/build-variants.json'), JSON.stringify(rows, null, 1));
for (const r of rows) console.log(r.name.padEnd(72), String(r.raw).padStart(8), 'raw', String(r.gzip9).padStart(7), 'gzip9', String(r.br11).padStart(7), 'br11');
