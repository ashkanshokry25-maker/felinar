// Regression tests for the cross-agent fixes made by the v0.2.1 verifier (docs/deviations/harden-verify.md):
// places where one hardening agent's contract met another agent's code. Each test names the
// DIGEST-AMENDMENTS item it protects. No network: publish runs on temporary directories only.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { publish, audienceList, AUD_TOKENS, rendezvousBtihFor, anchorInfoHash, egressNote } from '../../tools/publish.mjs';
import { hashesFromText } from '../../tools/tracker.mjs';
import { keygen } from '../../tools/keygen.mjs';
import { TOOLS_VERSION } from '../../tools/lib.mjs';
import { parsePointer, AUDIENCES } from '../../src/common/pointer.js';
import { CONFIG } from '../../src/loader/config.js';
import { rendezvousInfoHash } from '../../src/loader/torrent.js';
import { consentModeFor, ConsentWaiters } from '../../src/loader/app.js';
import { trustedOnly } from '../../src/loader/ui.js';
import { STRINGS } from '../../src/loader/strings.js';
import { ConsentRequests } from '../../src/loader/api.js';
import { SDK_VERSION } from '../../src/sdk/sdk.js';
import { CONSENT_ACCEPT_RE, CONSENT_ACCEPT_LABELS } from '../../tools/live.mjs';

const ROOT = new URL('../../', import.meta.url);
const source = (rel) => readFileSync(new URL(rel, ROOT), 'utf8');

const work = mkdtempSync(join(tmpdir(), 'mw-v021-integration-'));
after(() => rmSync(work, { recursive: true, force: true }));
let counter = 0;
const fresh = (label) => {
  const dir = join(work, label + '-' + ++counter);
  mkdirSync(dir, { recursive: true });
  return dir;
};
const NOW = Date.UTC(2026, 9, 19, 14, 0, 0);

function site() {
  const dir = fresh('site');
  writeFileSync(join(dir, 'index.html'), '<!doctype html><html><head><title>t</title></head><body><h1>t</h1></body></html>\n');
  writeFileSync(join(dir, 'app.css'), 'body { margin: 0 }\n');
  return dir;
}

let keyFile = null;
async function key() {
  if (!keyFile) {
    keyFile = join(work, 'owner.jwk');
    await keygen({ out: keyFile });
  }
  return keyFile;
}

function run(extra = {}) {
  return key().then((k) => publish(Object.assign({
    dir: site(), name: 'v021-int', scope: 'example.com', key: k, tr: ['wss://tracker.example'], ws: ['https://static.example/ws/'],
    out: fresh('out'), now: NOW, quiet: true, env: {},
  }, extra)));
}

// ---------------------------------------------------------------------------------------------- C1 x A3 x E
test('C1/A3: publish --aud takes the token list the loader reads; personal, eea, uk and qc make the gate the default', async () => {
  // Every token the loader's consent rule knows is publishable, and every content audience too.
  for (const t of CONFIG.consent.gateAudiences) assert.ok(AUD_TOKENS.includes(t), t + ' is publishable');
  for (const t of AUDIENCES) assert.ok(AUD_TOKENS.includes(t), t + ' is publishable');
  assert.equal(audienceList('EEA, personal'), 'eea,personal');
  assert.equal(audienceList('kids+kids'), 'kids', 'de-duplicated');
  assert.throws(() => audienceList('everyone'), /--aud must be one or more of .*\(unknown: everyone\)/);
  assert.throws(() => audienceList(' , '), /--aud must be/);

  const res = await run({ aud: 'EEA,personal' });
  const rec = parsePointer(res.pointer).record;
  assert.equal(rec.aud, 'eea,personal', 'signed into the pointer as a normalised list');
  assert.equal(consentModeFor(rec), 'gate', 'the loader shows the blocking gate for this pointer');
  const plain = await run({ aud: 'general' });
  assert.equal(consentModeFor(parsePointer(plain.pointer).record), 'notice');
  await assert.rejects(run({ aud: 'everyone' }), /--aud must be/);
});

// ---------------------------------------------------------------------------------------------- B2 x tools
test('B2: publish names the ledger rendezvous infohash the loader announces, and an --allow tracker accepts it', async () => {
  const res = await run();
  const rv = await rendezvousInfoHash(res.ledgerId);
  assert.equal(await rendezvousBtihFor(res.ledgerId), rv);
  assert.equal(res.rendezvousBtih, rv);
  assert.equal(res.anchorBtih, rv, 'the deprecated v0.2 key carries the rendezvous infohash for one release');
  assert.equal(await anchorInfoHash(res.ledgerId), rv, 'the deprecated helper is an alias');
  const summaryText = readFileSync(join(res.outDir, 'summary.json'), 'utf8');
  const summary = JSON.parse(summaryText);
  assert.equal(summary.rendezvousBtih, rv);
  assert.equal(summary.anchorBtih, rv);
  const allowed = hashesFromText(summaryText);
  assert.ok(allowed.has(summary.btih) && allowed.has(rv), 'tracker --allow summary.json lets the site and its ledger swarm in');
  // Only rendezvousBtih (a summary written without the deprecated key) is enough too.
  const onlyRv = hashesFromText(JSON.stringify({ btih: summary.btih, rendezvousBtih: rv }));
  assert.ok(onlyRv.has(rv));
});

// ---------------------------------------------------------------------------------------------- versions
// v0.3 integration (I-6): INTERFACES v0.3 sets SDK_VERSION = '0.3.0', so the runtime and the tools follow; package.json is
// bumped by its owner (lane tools) or the final integrator.
test('the runtime, the SDK, the tools and package.json all say 0.3.0', () => {
  assert.equal(CONFIG.version, '0.3.0');
  assert.equal(SDK_VERSION, CONFIG.version);
  assert.equal(TOOLS_VERSION, CONFIG.version);
  // Code review round 1: package.json said 0.1.0.
  const pkg = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8'));
  assert.equal(pkg.version, CONFIG.version);
});

// ---------------------------------------------------------------------------------------------- A4 x C1 (shell)
test('A4: shell decisions ignore script-made clicks; the consent card, gate, export and import use the guard', () => {
  const calls = [];
  const h = trustedOnly((ev) => { calls.push(ev.type); return 'ran'; });
  assert.equal(h({ type: 'click', isTrusted: false }), undefined, 'el.click() / dispatchEvent from a script');
  assert.equal(h({ type: 'click', isTrusted: true }), 'ran', 'the visitor\'s click');
  assert.equal(h({ type: 'click' }), 'ran', 'fakes without isTrusted pass');
  assert.deepEqual(calls, ['click', 'click']);
  // Every loader-owned decision in ui.js goes through decision() (= trustedOnly): the first-run card,
  // the gate, the v0.2 notice, "Change your sharing choice" and identity export/import.
  const ui = source('src/loader/ui.js');
  for (const key of ['consentShare', 'consentHostOnly', 'gateHostOnly', 'gateCancel', 'noticeOk', 'settingsConsentAgain', 'settingsExportIdentity', 'settingsImportIdentity']) {
    assert.match(ui, new RegExp('decision\\((blocking \\? S\\.gateCancel : S\\.consentNoHost|S\\.' + key + ')'), key + ' is a guarded decision');
  }
  assert.match(ui, /decision\(sharedOrigin \? S\.hubSharedLoad : S\.gateLoad/, 'the gate Load button is guarded');
});

test('A4/C1: tools click the v0.2.1 first-run card ("Share and load") with a trusted click, never "Load from host only"', () => {
  assert.deepEqual([...CONSENT_ACCEPT_LABELS], [STRINGS.consentShare, STRINGS.gateLoad, STRINGS.noticeOk]);
  for (const l of [STRINGS.consentShare, STRINGS.gateLoad, STRINGS.noticeOk]) assert.ok(CONSENT_ACCEPT_RE.test(l), l);
  for (const l of [STRINGS.consentHostOnly, STRINGS.gateHostOnly, STRINGS.hubSharedLoad, STRINGS.consentNoHost]) assert.equal(CONSENT_ACCEPT_RE.test(l), false, l);
  const live = source('tools/live.mjs');
  assert.doesNotMatch(live, /hit\.click\(\)/, 'no script click left in tools/live.mjs');
});

test('A4: mw.consent.request() in the shell settles with pending when the card closes without a choice', async () => {
  const waiters = new ConsentWaiters();
  const a = waiters.wait();
  const b = waiters.wait();
  assert.equal(waiters.size, 2);
  assert.equal(waiters.settle('pending'), 2, '"Not now" or gate Cancel');
  assert.deepEqual(await Promise.all([a, b]), ['pending', 'pending']);
  assert.equal(waiters.size, 0);
  const c = waiters.wait();
  waiters.settle('accepted');
  assert.equal(await c, 'accepted');
  // With the shell's opener settling 'pending', ConsentRequests applies its cooldown instead of holding
  // one promise forever, and a later request opens the card again.
  let t = 0;
  let state = 'pending';
  const shellWaiters = new ConsentWaiters();
  let opened = 0;
  const reqs = new ConsentRequests({ consent: { state: () => state }, ui: { openConsent: () => { opened++; return shellWaiters.wait(); } }, now: () => t, cooldownMs: 10000 });
  const first = reqs.request();
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(opened, 1);
  shellWaiters.settle('pending');
  assert.equal(await first, 'pending');
  assert.equal(await reqs.request(), 'pending', 'within the cooldown: no new card');
  assert.equal(opened, 1);
  t = 10001;
  const again = reqs.request();
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(opened, 2, 'after the cooldown the site may ask again');
  state = 'accepted';
  shellWaiters.settle('accepted');
  assert.equal(await again, 'accepted');
  const app = source('src/loader/app.js');
  assert.match(app, /onCancel: \(\) => \{ A\.hideNotice = null; A\.ui\.setStatus\(STRINGS\.consentNotNow, 'warn'\); A\.consentWaiters\.settle\('pending'\) \}/, '"Not now" settles the waiters');
  assert.match(app, /A\.consentWaiters\.settle\(state\)/, 'a choice settles the waiters');
});

// ---------------------------------------------------------------------------------------------- E5
test('E5: publish --dropin states the egress multiplier with the copy size', () => {
  const note = egressNote(20 * 1024 * 1024);
  assert.match(note, /whole copy \(20(\.0)? MiB of non-HTML files\)/);
  assert.match(note, /13\.3 times/);
  // Post-wave fix A: research w2a-07 F21 labels the multiplier a model; the note keeps its arithmetic.
  assert.match(note, /in a model \(arithmetic, not a measurement\), a 20 MB copy completed after a 1\.5 MB page view/);
  assert.doesNotMatch(note, /measured/);
  assert.match(note, /cellular and Save-Data visitors fill it from peers only/);
  assert.doesNotMatch(note, /[–—]/, 'no dashes');
  const src = source('tools/publish.mjs');
  const dropinBranch = src.slice(src.indexOf('  if (dropin) {\n    if (pagesWithoutScript.length)'), src.indexOf('  } else {\n    log(\'Deploy order:'));
  assert.match(dropinBranch, /log\(egressNote\(total\)\)/, 'printed in drop-in mode');
});
