// Review round (tools fixer, 2026-10-24): the parts of SUP-2, SUP-3, SUP-4, SUP-8, SUP-10, SUP-11 and SUP-14 that live in files other
// workflows own (.github/**, docs/PUBLISH-CHECKLIST.md, .npmrc, package.json, README.md). Each case states the rule the integrator's
// change must meet (docs/deviations/review-round-tools.md, "Requests"); until it lands it is a node:test todo, which reports its
// assertion and does not fail the run. Remove the todo option when the request is applied.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

import { ROOT } from '../../tools/lib.mjs';

const read = (rel) => (existsSync(join(ROOT, rel)) ? readFileSync(join(ROOT, rel), 'utf8') : '');
const lines = (rel, re) => read(rel).split('\n').map((l, i) => ({ l, at: rel + ':' + (i + 1) })).filter(({ l }) => re.test(l));
const TODO = (id) => ({ todo: 'integrator request ' + id + ' (docs/deviations/review-round-tools.md)' });

test('SUP-2: the tag ruleset restricts creation, and the release build refuses a commit that is not on main', TODO('R-SUP-2a'), () => {
  assert.match(read('docs/PUBLISH-CHECKLIST.md'), /\{ "type": "creation" \}/);
  assert.match(read('.github/workflows/release.yml'), /git merge-base --is-ancestor "\$GITHUB_SHA" origin\/main/);
});

test('SUP-2: every documented attestation check is bound to the release workflow, the tag and the commit', TODO('R-SUP-2b'), () => {
  const checks = ['SECURITY.md', 'docs/PUBLISH-CHECKLIST.md', 'docs/SECURITY-MODEL.md', '.github/workflows/release.yml'].flatMap((f) => lines(f, /gh attestation verify/))
    .filter(({ l }) => !/^\s*#/.test(l));
  assert.ok(checks.length >= 4);
  for (const c of checks) assert.match(c.l, /--signer-workflow[\s\S]*--source-ref/, c.at);
});

// R-SUP-3 applied by the independence round (2026-10-25, IND-6, docs/deviations/independence-release-docs.md); the attestation flags
// of the checklist's gh attestation verify lines stay with R-SUP-2b's todo above.
test('SUP-3: the owner signs only with --rebuilt and verifies with --expect-version', () => {
  for (const c of lines('docs/PUBLISH-CHECKLIST.md', /verify-release\.mjs sign /)) assert.match(c.l, /--rebuilt /, c.at);
  for (const c of lines('docs/PUBLISH-CHECKLIST.md', /verify-release\.mjs verify /)) assert.match(c.l, /--expect-version /, c.at);
});

test('SUP-4: the release job lists dist and dist-idp before it downloads browsers, and compares the lists after the e2e run', TODO('R-SUP-4'), () => {
  const text = read('.github/workflows/release.yml');
  const pinned = text.indexOf('verify-release.mjs list dist --out "$RUNNER_TEMP/pinned/hashes-dist.json"');
  const browsers = text.indexOf('playwright install');
  assert.ok(pinned > 0 && pinned < browsers, 'the lists are made before playwright install');
  assert.match(text, /cmp "\$RUNNER_TEMP\/pinned\/hashes-dist\.json" release\/hashes-dist\.json/);
});

test('SUP-8: CODEOWNERS covers the code and files that enforce the lock and the release key', TODO('R-SUP-8'), () => {
  const owners = read('.github/CODEOWNERS');
  for (const p of ['/.npmrc', '/package.json', '/build.mjs', '/tools/build-idp.mjs', '/tools/verify-release.mjs', '/tools/install-scripts.json', '/tools/lib.mjs', '/SECURITY.md', '/README.md', '/packages/verify/', '/src/idp/', '/src/identity/', '/src/sw/', '/deploy/', '/bin/']) {
    assert.match(owners, new RegExp('^' + p.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&') + '\\s', 'm'), p);
  }
  for (const c of lines('.github/workflows/pages-demo.yml', /\bnpm ci\b/)) assert.match(c.l, /--ignore-scripts/, c.at);
});

test('SUP-10: the release signs a list of the npm package too', TODO('R-SUP-10'), () => {
  assert.match(read('.github/workflows/release.yml'), /verify-release\.mjs list [^\n]* --out release\/hashes-pkg\.json --tree pkg/);
});

test('SUP-11: npm audit signatures in CI and release, a minimum release age, an npm floor and explicit allowScripts entries', TODO('R-SUP-11'), () => {
  assert.match(read('.npmrc'), /^min-release-age=7$/m);
  for (const f of ['.github/workflows/ci.yml', '.github/workflows/release.yml']) assert.match(read(f), /npm audit signatures/, f);
  const pkg = JSON.parse(read('package.json') || '{}');
  assert.ok(pkg.engines && /11\.19/.test(String(pkg.engines.npm)), 'engines.npm >=11.19');
  for (const name of ['bufferutil', 'utf-8-validate', 'utp-native', 'ip-set', 'node-datachannel']) assert.equal(pkg.allowScripts && pkg.allowScripts[name], false, name);
});

test('SUP-14: the github-pages environment needs a reviewer, and the threat model says so', TODO('R-SUP-14'), () => {
  assert.match(read('docs/PUBLISH-CHECKLIST.md'), /environments\/github-pages/);
  assert.match(read('docs/THREAT-MODEL.md'), /\| SC-9 demo deploy on push \| mitigated \| [^|]*reviewer/);
});
