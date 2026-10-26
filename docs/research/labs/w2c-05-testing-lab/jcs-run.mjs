import fs from 'node:fs';
import { canonicalize, utf8 } from '../../../../src/chain/canonical.js';
for (const f of ['arrays', 'french', 'structures', 'unicode', 'values', 'weird']) {
  const inp = fs.readFileSync(`vectors/jcs/${f}.in.json`, 'utf8'); const out = fs.readFileSync(`vectors/jcs/${f}.out.json`);
  try {
    const got = canonicalize(JSON.parse(inp));
    const gotBytes = typeof got === 'string' ? Buffer.from(got, 'utf8') : Buffer.from(got);
    console.log(f.padEnd(11), gotBytes.equals(out) ? 'MATCH' : `MISMATCH (got ${gotBytes.length} bytes, want ${out.length})`);
    if (!gotBytes.equals(out)) { console.log('   got :', gotBytes.toString().slice(0, 160)); console.log('   want:', out.toString().slice(0, 160)); }
  } catch (e) { console.log(f.padEnd(11), 'THREW', e.message.slice(0, 140)); }
}
