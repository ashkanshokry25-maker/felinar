// The MW-PTR/1 size budget in tools/publish.mjs (v0.2.1, DIGEST-AMENDMENTS A3): a pointer above 900
// bytes is refused (MUST), one above 450 bytes is published with a warning (SHOULD). Files only.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { publish } from '../../tools/publish.mjs';
import { keygen } from '../../tools/keygen.mjs';
import { ToolError } from '../../tools/lib.mjs';
import { pointerBudget, POINTER_SIZE_MAX, POINTER_SIZE_SHOULD } from '../../src/common/pointer.js';

const work = mkdtempSync(join(tmpdir(), 'mw-budget-test-'));
after(() => rmSync(work, { recursive: true, force: true }));
const NOW = Date.UTC(2026, 9, 19, 12, 0, 30);

async function fixture(label) {
  const dir = join(work, label);
  mkdirSync(join(dir, 'site'), { recursive: true });
  writeFileSync(join(dir, 'site', 'index.html'), '<!doctype html><title>Budget</title><h1>Budget</h1>\n');
  writeFileSync(join(dir, 'site', 'app.css'), 'body { margin: 0 }\n');
  const key = await keygen({ out: join(dir, 'owner.jwk') });
  return { dir, site: join(dir, 'site'), key: key.file, out: join(dir, 'out') };
}

test('publish refuses a pointer above 900 bytes and writes no pointer file', async () => {
  const f = await fixture('over');
  const tr = Array.from({ length: 12 }, (_, i) => 'wss://tracker-' + i + '.a-long-tracker-domain-name.example');
  await assert.rejects(
    publish({ dir: f.site, name: 'budget', scope: 'example.com', key: f.key, out: f.out, tr, ws: ['https://cdn.example.com/ws/'], now: NOW, quiet: true }),
    (err) => err instanceof ToolError && new RegExp('must stay at or under ' + POINTER_SIZE_MAX).test(err.message),
  );
  assert.equal(existsSync(join(f.out, 'pointer.txt')), false, 'nothing to publish');
});

test('publish warns above 450 bytes (a realistic signed pointer) and states the size in TXT strings', async () => {
  const f = await fixture('warn');
  const res = await publish({
    dir: f.site, name: 'budget', scope: 'example.com', key: f.key, out: f.out, now: NOW, quiet: true,
    tr: ['wss://tracker.example.com', 'wss://tracker.webtorrent.dev'], ws: ['https://cdn.example.com/ws/'],
  });
  const b = pointerBudget(res.pointer);
  assert.ok(b.bytes > POINTER_SIZE_SHOULD && b.withinMax, b.bytes + ' bytes');
  assert.ok(res.warnings.some((w) => new RegExp('should stay at or under ' + POINTER_SIZE_SHOULD).test(w) && /TXT strings/.test(w)), res.warnings.join('\n'));
  assert.ok(res.pointer.includes('owner=p256:'), 'the owner key is algorithm-tagged');
});
