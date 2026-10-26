// MAL53-3, request R4-a (docs/deviations/review-round-media.md): the pin page host in src/loader/app.js passes `discard`, so that an
// item the ledger denies after the pin held it leaves this browser profile's stores (pin-<ih> and pin-torrent-<ih>), not only the swarm.
// The host's own behaviour (sweep, leave, discard call) is tested in pinwire.test.mjs; this pins the wiring in setupPinPage.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const app = readFileSync(fileURLToPath(new URL('../../src/loader/app.js', import.meta.url)), 'utf8');

test('setupPinPage wires discard to deleteName of the pin-<ih> and pin-torrent-<ih> stores (R4-a)', () => {
  const start = app.indexOf('function setupPinPage (A)');
  assert.ok(start > 0, 'setupPinPage is in app.js');
  const body = app.slice(start, app.indexOf('\nfunction ', start + 1));
  const at = body.indexOf('createPinPageHost({');
  assert.ok(at > 0, 'setupPinPage builds the pin page host');
  const call = body.slice(at, body.indexOf('A.win.__mwPinHost', at));
  assert.match(call, /isDenied:\s*denyChecker\(/, 'the host gets the ledger deny check');
  assert.match(call, /discard:\s*async\s*\(ih\)\s*=>\s*\{\s*await be\(\)\.deleteName\('pin-' \+ ih\);\s*await be\(\)\.deleteName\('pin-torrent-' \+ ih\)\s*\}/, 'discard deletes both stores of the item');
});
