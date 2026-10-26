// Usage: node kit-size-repro.mjs. Builds the loader twice into two scratch directories (node build.mjs --out <dir>), compares the
// per-file SHA-256 lists, and prints file count, raw bytes, gzip-9 and brotli-11 totals (each file compressed alone).
// Needs the repository's node_modules. Writes nothing inside the repository. Behind S4-doors.md finding F5.
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import zlib from 'node:zlib';
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
const tmp = mkdtempSync(join(tmpdir(), 's4-kit-'));
const walk = (d, base = d) => readdirSync(d, { withFileTypes: true }).flatMap((e) => e.isDirectory() ? walk(join(d, e.name), base) : [join(d, e.name).slice(base.length + 1)]).sort();
const sums = {};
for (const name of ['a', 'b']) {
  execFileSync(process.execPath, [join(ROOT, 'build.mjs'), '--out', join(tmp, name), '--quiet'], { cwd: ROOT, stdio: 'pipe' });
  sums[name] = walk(join(tmp, name)).map((f) => f + ' ' + createHash('sha256').update(readFileSync(join(tmp, name, f))).digest('hex')).join('\n');
}
const files = walk(join(tmp, 'a'));
let raw = 0, gz = 0, br = 0;
for (const f of files) { const b = readFileSync(join(tmp, 'a', f)); raw += b.length; gz += zlib.gzipSync(b, { level: 9 }).length; br += zlib.brotliCompressSync(b, { params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 11 } }).length; }
const build = JSON.parse(readFileSync(join(tmp, 'a', 'build.json'), 'utf8'));
console.log(JSON.stringify({ version: build.version, buildId: build.buildId, files: files.length, raw, rawMiB: +(raw / 1048576).toFixed(2), gzip9: gz, brotli11: br, twoBuildsIdentical: sums.a === sums.b }));
for (const f of files) console.log(String(statSync(join(tmp, 'a', f)).size).padStart(8), f);
process.exit(0);
