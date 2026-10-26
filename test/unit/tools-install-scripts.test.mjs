// Review round SUP-1 (MF-78, SC-3): install scripts. Every package of npm-shrinkwrap.json that has an install script is listed with a
// reason in tools/install-scripts.json, and every install instruction outside a clone carries --ignore-scripts (a dependency's
// preinstall runs on `npm install -g <tarball>` and under npx even on npm 11.19: the clone's .npmrc is not in the package).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';

import { ROOT } from '../../tools/lib.mjs';

const read = (rel) => readFileSync(join(ROOT, rel), 'utf8');

test('SUP-1: the packages with install scripts are exactly the reviewed list, each with a reason', () => {
  const shrink = JSON.parse(read('npm-shrinkwrap.json'));
  const withScripts = Object.entries(shrink.packages || {})
    .filter(([path, meta]) => path && meta && meta.hasInstallScript)
    .map(([path]) => path.slice(path.lastIndexOf('node_modules/') + 'node_modules/'.length))
    .sort();
  const listed = JSON.parse(read('tools/install-scripts.json')).packages;
  assert.deepEqual(withScripts, Object.keys(listed).sort(), 'a package gained or lost an install script: review it and update tools/install-scripts.json');
  for (const [name, reason] of Object.entries(listed)) assert.ok(typeof reason === 'string' && reason.length > 40, name + ' needs a reason');
});

// An install that does not read the clone's .npmrc: a global or tarball install, a registry package, npx of a registry version.
const OUTSIDE_CLONE = /\bnpm (?:install|i)\b[^\n`]*(?:\s-g\b|--global|\.tgz|\s(?:felinar)(?:@|\s|$)|@(?:felinar)\/|node-datachannel)|\bnpx\s+(?:--yes\s+)?(?:felinar)@|\bnpx\s+--package\b/;
const SAFE = /--ignore-scripts|npm_config_ignore_scripts=true/;

function offenders(rel) {
  if (!existsSync(join(ROOT, rel))) return [];
  return read(rel).split('\n').map((line, i) => ({ line, at: rel + ':' + (i + 1) })).filter(({ line }) => OUTSIDE_CLONE.test(line) && !SAFE.test(line)).map((x) => x.at + ': ' + x.line.trim().slice(0, 100));
}

const OWNED = ['SECURITY.md', 'docs/DEPLOY.md', 'docs/OPERATIONS.md', 'docs/THREAT-MODEL.md', 'deploy/github-actions/publish-site.yml']
  .concat(readdirSync(join(ROOT, 'deploy')).map((d) => 'deploy/' + d + '/README.md'))
  .concat(readdirSync(join(ROOT, 'tools')).filter((f) => f.endsWith('.mjs')).map((f) => 'tools/' + f));

test('SUP-1: every install instruction outside a clone in the tools, deploy, SECURITY, DEPLOY and OPERATIONS carries --ignore-scripts', () => {
  const found = OWNED.flatMap(offenders);
  assert.deepEqual(found, []);
  assert.match(read('SECURITY.md'), /npm install -g --ignore-scripts \.\/felinar-<version>\.tgz/, 'SECURITY.md gives the safe install line');
});

// The release notes, README, CHANGELOG, QUICKSTART and PUBLISH-CHECKLIST belong to other lanes; the integrator applies the same rule there
// (docs/deviations/review-round-tools.md, Requests). Until then this is a todo: it reports the lines and does not fail the run.
test('SUP-1: the same rule for the release notes template, README, CHANGELOG, QUICKSTART and PUBLISH-CHECKLIST', { todo: 'integrator request R-SUP-1 (docs/deviations/review-round-tools.md)' }, () => {
  const found = ['.github/workflows/release.yml', 'README.md', 'CHANGELOG.md', 'docs/QUICKSTART.md', 'docs/PUBLISH-CHECKLIST.md'].flatMap(offenders);
  assert.deepEqual(found, []);
});
