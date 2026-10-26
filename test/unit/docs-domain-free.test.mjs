// Domain independence (IND-4, IND-5 and part of IND-3, .orchestration/reports/independence-design-2026-10-25.md): the project owns
// no domain, so no tracked file may point readers at one. A name the project does not hold is a hijack path: whoever registers it
// would receive the security reports sent there and could publish the release key that a document tells readers to prefer. The
// test reads every tracked text file (git ls-files; node_modules, dist, dist-idp and .orchestration are never tracked and are
// skipped in any case). It matches the TLD form only, so the file names felinar.mjs and felinar.js never count. The step 5b gate
// line of docs/PUBLISH-CHECKLIST.md runs the same search and must find nothing.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { ROOT } from '../../tools/lib.mjs';

// Built from parts, so this file never holds the names it looks for.
const TLDS = ['dev', 'app', 'ca', 'io', 'com', 'org', 'net'];
const PROJECT_NAME = new RegExp('felinar\\.(?:' + TLDS.join('|') + ')\\b', 'i');
const DNS_PIN = '_release' + '-key.';
const SKIP = /^(?:node_modules|dist|dist-idp|\.orchestration)(?:\/|$)|\/node_modules\//;

function trackedTextFiles() {
  const r = spawnSync('git', ['ls-files', '-z'], { cwd: ROOT, encoding: 'utf8' });
  if (r.status !== 0) return null;
  const out = [];
  for (const rel of r.stdout.split('\0').filter(Boolean)) {
    if (SKIP.test(rel)) continue;
    let bytes;
    try {
      bytes = readFileSync(join(ROOT, rel));
    } catch (_) {
      continue; // deleted in the work tree, not yet staged
    }
    if (bytes.subarray(0, 8000).includes(0)) continue; // binary
    out.push({ rel, text: bytes.toString('utf8') });
  }
  return out;
}

/** hits(files, re) -> ['path:line: text'] for every line that matches re. */
function hits(files, re) {
  const found = [];
  for (const { rel, text } of files) {
    text.split('\n').forEach((line, i) => {
      if (re.test(line)) found.push(rel + ':' + (i + 1) + ': ' + line.trim().slice(0, 140));
    });
  }
  return found;
}

const FILES = trackedTextFiles();

test('IND-5: no tracked file names a project domain or a mailbox at one (the project holds no domain)', (t) => {
  if (!FILES) return t.skip('not a git work tree');
  assert.ok(FILES.length > 500, 'the tree was read (' + FILES.length + ' text files)');
  const found = hits(FILES, PROJECT_NAME);
  assert.deepEqual(found, [], found.length + ' lines in ' + new Set(found.map((h) => h.split(':')[0])).size + ' files name a domain the project does not hold');
});

test('IND-5: the pattern catches every form it guards, and not the file names of the command', () => {
  for (const tld of TLDS) {
    assert.match('see https://felinar.' + tld + '/x', PROJECT_NAME, tld);
    assert.match('write to security@felinar.' + tld.toUpperCase(), PROJECT_NAME, 'a mailbox, any case: ' + tld);
  }
  for (const ok of ['bin/felinar.mjs', 'felinar.js', 'felinar.devices', 'felinar-0.3.0.tgz', 'felinar.io2', '@felinar/verify']) {
    assert.doesNotMatch(ok, PROJECT_NAME, ok);
  }
});

test('IND-5: the step 5b gate line of the checklist runs the same search, in both copies', () => {
  const checklist = readFileSync(join(ROOT, 'docs/PUBLISH-CHECKLIST.md'), 'utf8');
  const gates = checklist.split('\n').filter((l) => /^if grep -q 'No lawyer has reviewed the privacy texts'/.test(l));
  assert.equal(gates.length, 2, 'the gate line of step 5b and its copy in section 11');
  const needle = "! git grep -q -I -i -P 'felinar\\.(" + TLDS.join('|') + ")\\b'";
  const at = checklist.split('\n').map((l, i) => ({ l, i })).filter(({ l }) => l.includes(needle));
  assert.equal(at.length, 2, 'each gate copy refuses a project domain: ' + needle);
});

test('IND-3: no tracked file names a DNS record as the second pin of the release key', (t) => {
  if (!FILES) return t.skip('not a git work tree');
  const found = hits(FILES, new RegExp(DNS_PIN.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.deepEqual(found, [], 'the project holds no domain, so a TXT record there is a pin anyone could fill');
});

test('IND-4: the checklist sets no homepage demo on a name nobody holds; the demo is optional', () => {
  const checklist = readFileSync(join(ROOT, 'docs/PUBLISH-CHECKLIST.md'), 'utf8');
  assert.doesNotMatch(checklist, /demo\.example\.org/, 'step 1 must not default DEMO_DOMAIN to a name nobody controls');
  assert.match(checklist, /^export DEMO_DOMAIN= *(?:#.*)?$/m, 'step 1 leaves DEMO_DOMAIN empty');
  const homepage = checklist.split('\n').filter((l) => /--homepage/.test(l));
  assert.ok(homepage.length >= 2, 'step 7 and section 12 set the homepage');
  for (const line of homepage) {
    assert.match(line, /^\[ -n "\$DEMO_DOMAIN" \] && gh repo edit "\$OWNER\/felinar" --homepage "https:\/\/\$DEMO_DOMAIN\/"$/, 'the homepage is set only when DEMO_DOMAIN is: ' + line.trim());
  }
  assert.doesNotMatch(checklist, /-f cname=/, 'no custom-domain call: the free route is a repository named <OWNER>.github.io');
});
