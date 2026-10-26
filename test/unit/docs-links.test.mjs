// Code review round 1 (F10, DESIGN-REVIEW item 24): every repository-relative *.md path that tool output,
// SECURITY.md, the GitHub templates, the top-level docs and DIGEST-AMENDMENTS name must exist, and the
// user-facing docs keep the wording rules of DESIGN-REVIEW section 4.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join, dirname, relative } from 'node:path';

import { ROOT } from '../../tools/lib.mjs';

function filesUnder(dir, keep) {
  const out = [];
  if (!existsSync(dir)) return out;
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...filesUnder(p, keep));
    else if (keep(name)) out.push(p);
  }
  return out;
}

const TOP_DOCS = readdirSync(join(ROOT, 'docs')).filter((n) => n.endsWith('.md')).map((n) => join(ROOT, 'docs', n));
const SOURCES = [
  ...readdirSync(join(ROOT, 'tools')).filter((n) => n.endsWith('.mjs')).map((n) => join(ROOT, 'tools', n)),
  join(ROOT, 'build.mjs'),
  ...['SECURITY.md', 'CODE_OF_CONDUCT.md', 'CHANGELOG.md', 'README.md', 'CONTRIBUTING.md', 'GOVERNANCE.md'].map((n) => join(ROOT, n)).filter((p) => existsSync(p)),
  ...filesUnder(join(ROOT, '.github'), () => true),
  ...TOP_DOCS,
  join(ROOT, 'docs', 'review', 'DIGEST-AMENDMENTS.md'),
];

// Bare names that are documents of this repository (README.md is also a file name of published sites,
// so only explicit paths and Markdown links to it are checked).
const DOC_NAME = /\b((?:[A-Z][A-Z0-9]*-)*[A-Z][A-Z0-9]*\.md)\b/g;
const PATHISH = /(?:^|[\s`'"(\[])((?:\.\.?\/)*(?:docs|test|tools|examples|deploy|\.github)\/[A-Za-z0-9_./-]+\.md)\b/g;
const MD_LINK = /\]\(([^)#\s]+\.md)(?:#[^)]*)?\)/g;
// v0.3 C2 (integrator): docs/research/v03, because the top documents cite the C2 design and S1 to S4 by name.
const SEARCH = ['', 'docs', 'docs/research', 'docs/research/v03', 'docs/review', 'docs/deviations', 'examples/existing-site-dropin'];

function resolves(ref, from) {
  if (/^[a-z]+:/i.test(ref)) return true; // a URL
  const candidates = [join(dirname(from), ref)].concat(SEARCH.map((d) => join(ROOT, d, ref)));
  return candidates.some((c) => existsSync(c));
}

test('every *.md path named by tools, SECURITY.md, the GitHub templates, the docs and DIGEST-AMENDMENTS exists', () => {
  const missing = [];
  let checked = 0;
  for (const file of SOURCES) {
    const text = readFileSync(file, 'utf8');
    const refs = new Set();
    for (const re of [DOC_NAME, PATHISH, MD_LINK]) {
      re.lastIndex = 0;
      for (const m of text.matchAll(re)) {
        const ref = m[1];
        if (ref === 'README.md' && re === DOC_NAME) continue;
        refs.add(ref);
      }
    }
    for (const ref of refs) {
      checked++;
      if (!resolves(ref, file)) missing.push(relative(ROOT, file) + ' -> ' + ref);
    }
  }
  assert.ok(checked > 50, 'only ' + checked + ' references found');
  assert.deepEqual(missing, [], 'documents that do not exist:\n' + missing.join('\n'));
});

test('publish points owners at docs/DEPLOY.md, which has the "Owner duties" section and the DESIGN-REVIEW 4.5 owner sentence', () => {
  const publish = readFileSync(join(ROOT, 'tools', 'publish.mjs'), 'utf8');
  assert.match(publish, /docs\/DEPLOY\.md, "Owner duties"/);
  const deploy = readFileSync(join(ROOT, 'docs', 'DEPLOY.md'), 'utf8');
  assert.match(deploy, /^## Owner duties$/m);
  assert.ok(deploy.replace(/\s+/g, ' ').includes('With open writing, every visitor stores and passes on posts by strangers. You moderate what your site makes visitors redistribute.'));
});

// DESIGN-REVIEW section 4: "blockchain" only in README's "Why not a blockchain?" paragraph; never
// "serverless", "unstoppable", "censorship-resistant", "fully decentralized" or "sub-second" except where a
// rule quotes them; never an isolation claim for a shared-origin hub.
test('wording rules over README.md and docs/*.md: banned words only where a rule quotes them, no isolation claim for a shared hub', () => {
  const docs = TOP_DOCS.concat(existsSync(join(ROOT, 'README.md')) ? [join(ROOT, 'README.md')] : []);
  const problems = [];
  for (const file of docs) {
    const text = readFileSync(file, 'utf8');
    const lines = text.split('\n');
    // Quotes may span the lines of a paragraph: blank quoted and code spans over the whole text first
    // (keeping newlines), then read it line by line.
    const blank = (m) => m.replace(/[^\n]/g, ' ');
    const unquotedLines = text.replace(/"[^"]*"/g, blank).replace(/`[^`]*`/g, blank).split('\n');
    let inWhyNotBlockchain = false;
    lines.forEach((line, i) => {
      if (/^#+ /.test(line)) inWhyNotBlockchain = /why not a blockchain/i.test(line);
      const unquoted = unquotedLines[i] || '';
      for (const word of ['serverless', 'unstoppable', 'censorship-resistant', 'fully decentralized', 'sub-second']) {
        if (unquoted.toLowerCase().includes(word)) problems.push(relative(ROOT, file) + ':' + (i + 1) + ' ' + word);
      }
      if (/blockchain/i.test(unquoted) && !(file.endsWith('README.md') && inWhyNotBlockchain)) problems.push(relative(ROOT, file) + ':' + (i + 1) + ' blockchain');
      if (/isolat/i.test(line) && /hub|shared origin|shared-origin/i.test(line) && !/never|no isolation|not isolat|cannot isolate/i.test(line)) {
        problems.push(relative(ROOT, file) + ':' + (i + 1) + ' isolation claim');
      }
    });
  }
  assert.deepEqual(problems, []);
});

test('the user-facing documents written in code review round 1 use no em or en dashes and straight quotes', () => {
  for (const name of ['docs/DEPLOY.md', 'docs/SECURITY-MODEL.md', 'docs/PRIVACY.md', 'docs/ROADMAP.md', 'docs/DEMO-RESULTS.md', 'CHANGELOG.md']) {
    const text = readFileSync(join(ROOT, name), 'utf8');
    assert.equal(/[–—]/.test(text), false, name + ' has an en or em dash');
    assert.equal(/[‘’“”]/.test(text), false, name + ' has curly quotes');
  }
});

// Post-wave fix (J): the test above checks *.md names only, so a link to a missing workflow template, image or
// script went unnoticed (deploy/github-actions/publish-site.yml was linked before it existed). Every relative link
// target of any kind in the README, the docs, the recipes and the example READMEs must exist.
test('every relative link in README.md, docs/*.md, docs/recipes/*.md and the example READMEs points at a file that exists', () => {
  const files = [join(ROOT, 'README.md'), ...TOP_DOCS, ...filesUnder(join(ROOT, 'docs', 'recipes'), (n) => n.endsWith('.md')),
    ...filesUnder(join(ROOT, 'examples'), (n) => n === 'README.md')].filter((p) => existsSync(p));
  const LINK = /\]\(([^)\s#]+)(?:#[^)\s]*)?(?:\s+"[^"]*")?\)|\b(?:src|href)="([^"#]+)(?:#[^"]*)?"/g;
  const missing = [];
  let checked = 0;
  for (const file of files) {
    // Fenced code shows commands and sample output, not links.
    const text = readFileSync(file, 'utf8').replace(/^```[\s\S]*?^```/gm, '');
    for (const m of text.matchAll(LINK)) {
      const ref = m[1] || m[2];
      if (!ref || /^[a-z][a-z0-9+.-]*:/i.test(ref) || ref.startsWith('/') || ref.startsWith('<')) continue; // URLs, site paths
      checked++;
      if (!existsSync(join(dirname(file), decodeURIComponent(ref)))) missing.push(relative(ROOT, file) + ' -> ' + ref);
    }
  }
  assert.ok(checked > 100, 'only ' + checked + ' links found');
  assert.deepEqual(missing, [], 'relative links whose target does not exist:\n' + missing.join('\n'));
});
