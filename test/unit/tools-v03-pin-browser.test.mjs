// Real-browser check of tools/seeder.html ?persist=1 (V03-DESIGN-REVIEW 2.8.6, MF-50; opt-in, like the other *-browser tests):
//   MW_BROWSER=1 node --test test/unit/tools-v03-pin-browser.test.mjs
// A site is published to a temporary directory, the dev server serves dist/ (not rebuilt here) and that directory as the web seed, and
// a Chromium with a PROFILE DIRECTORY (local-only flags, 127.0.0.1 only) opens the seeder page twice. The first run seeds from the web
// seed and keeps every piece in the profile (IndexedDB); the second run, on the same profile, resumes from the profile and asks the web
// seed for no file. It needs dist/_mw/webtorrent.min.js (node build.mjs) and Playwright Chromium; without them the test is skipped.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomBytes } from 'node:crypto';

import { publish } from '../../tools/publish.mjs';
import { keygen } from '../../tools/keygen.mjs';
import { createDevServer } from '../../tools/dev-server.mjs';
import { launchBrowser } from '../../tools/live.mjs';
import { ROOT } from '../../tools/lib.mjs';

const ENABLED = process.env.MW_BROWSER === '1';
const DIST = join(ROOT, 'dist');
const READY = existsSync(join(DIST, '_mw', 'webtorrent.min.js')) && existsSync(join(ROOT, 'src', 'files', 'store-idb.js'));
const skip = !ENABLED ? 'set MW_BROWSER=1 to run the browser checks' : !READY ? 'dist/_mw/webtorrent.min.js is missing: run node build.mjs first (this test never rebuilds dist/)' : false;

const work = mkdtempSync(join(tmpdir(), 'mw-v03-seeder-'));
after(() => rmSync(work, { recursive: true, force: true }));

test('seeder.html ?persist=1 keeps the pieces in the browser profile and a restart seeds from disk without fetching the files again', { skip, timeout: 240000 }, async () => {
  const site = join(work, 'site');
  mkdirSync(site, { recursive: true });
  writeFileSync(join(site, 'index.html'), '<!doctype html><title>seeded</title><p>seeded\n');
  for (const n of ['a.bin', 'b.bin', 'c.bin']) writeFileSync(join(site, n), randomBytes(210 * 1024));
  const key = join(work, 'owner.jwk');
  await keygen({ out: key });
  const out = join(work, 'out');
  const res = await publish({ dir: site, name: 'seed-persist', scope: '127.0.0.1', key, out, tr: ['ws://127.0.0.1:9'], ws: ['http://127.0.0.1:1/ws/'], quiet: true, policy: 'open', bits: 4 });
  assert.match(res.btih, /^[0-9a-f]{40}$/);

  const lines = [];
  const dev = await createDevServer({ root: DIST, webseed: out, port: 0, dev: true, log: (l) => lines.push(l) });
  const url = dev.url + '_dev/seeder.html?persist=1&tr=' + encodeURIComponent('ws://127.0.0.1:9');
  const profile = join(work, 'profile');
  mkdirSync(profile, { recursive: true });
  const remote = [];
  async function session() {
    const before = lines.length;
    const s = await launchBrowser({ headless: true, profileDir: profile, allowRemote: false });
    try {
      const page = s.context.pages()[0] || await s.context.newPage();
      page.on('request', (r) => { if (!/^(http:\/\/127\.0\.0\.1|ws:\/\/127\.0\.0\.1|data:|blob:|about:)/.test(r.url())) remote.push(r.url()); });
      await page.goto(url);
      await page.waitForFunction(() => window.__seeder && (window.__seeder.error || (window.__seeder.ok && window.__seeder.persisted)), null, { timeout: 90000 });
      const state = await page.evaluate(() => window.__seeder);
      const fileGets = lines.slice(before).filter((l) => /GET \/ws\/seed-persist\/.* 200/.test(l)).length;
      return { state, fileGets };
    } finally {
      await s.close();
    }
  }
  try {
    const first = await session();
    assert.equal(first.state.error, null, String(first.state.error));
    assert.equal(first.state.ok, true);
    assert.equal(first.state.persist, true);
    assert.equal(first.state.resumed, false);
    assert.equal(first.state.persisted, true, 'every piece is in the profile');
    assert.equal(first.state.btih, res.btih);
    assert.ok(first.fileGets >= 4, 'the first run read the files from the web seed directory: ' + first.fileGets);
    const second = await session();
    assert.equal(second.state.error, null, String(second.state.error));
    assert.equal(second.state.ok, true);
    assert.equal(second.state.resumed, true, 'the second run resumed from the profile');
    assert.equal(second.state.persisted, true);
    assert.equal(second.state.btih, res.btih);
    assert.equal(second.fileGets, 0, 'and fetched no file again');
    assert.deepEqual(remote, [], 'the browser reached nothing but 127.0.0.1');
  } finally {
    await dev.close();
  }
});
