// The repository layout of the first public release and the files that run outside this machine: the GitHub
// workflows, the deploy/ files and the site owner's workflow template. Static checks only (nothing here talks to
// the network): the layout stays as documented, every workflow keeps the CI security baseline (docs/DEPLOY.md,
// CI/CD), and every command they run names a script, a file and flags that exist.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';

import { COMMANDS } from '../../bin/felinar.mjs';
import { ROOT } from '../../tools/lib.mjs';

const PKG = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
const read = (rel) => readFileSync(join(ROOT, rel), 'utf8');
const WORKFLOWS = readdirSync(join(ROOT, '.github', 'workflows')).filter((n) => /\.ya?ml$/.test(n)).map((n) => '.github/workflows/' + n);
const TEMPLATES = ['deploy/github-actions/publish-site.yml'];

// The target layout of the release (CONTRIBUTING.md and docs/README.md describe it).
const TOP_LEVEL = new Set([
  'README.md', 'LICENSE', 'SECURITY.md', 'SECURITY-KEY.asc', 'CODE_OF_CONDUCT.md', 'CONTRIBUTING.md', 'GOVERNANCE.md', 'CHANGELOG.md',
  'package.json', 'package-lock.json', 'npm-shrinkwrap.json', 'bin', 'src', 'packages', 'tools', 'build.mjs', 'build.lock.json', 'test', 'examples', 'docs',
  'deploy', '.github', '.editorconfig', '.gitattributes', '.gitignore', '.npmrc', '.nvmrc',
]);

function gitFiles() {
  const r = spawnSync('git', ['ls-files', '-z'], { cwd: ROOT, encoding: 'utf8' });
  return r.status === 0 ? r.stdout.split('\0').filter(Boolean) : null;
}

test('the top level holds only what the release layout lists, and the moves of 0.2.1 stay done', (t) => {
  const files = gitFiles();
  if (!files) return t.skip('not a git work tree');
  const tops = new Set(files.map((f) => f.split('/')[0]));
  const extra = Array.from(tops).filter((n) => !TOP_LEVEL.has(n)).sort();
  assert.deepEqual(extra, [], 'tracked top-level entries the layout does not list');
  for (const gone of ['example-site', 'ng-app', 'test/fixtures/existing-site']) {
    assert.ok(!files.some((f) => f === gone || f.startsWith(gone + '/')), gone + ' moved in 0.2.1 and must not come back');
  }
  const examples = new Set(files.filter((f) => f.startsWith('examples/')).map((f) => f.split('/')[1]));
  // v0.3 (intended change): examples/social is the social-network demo of R Part 3 (lane X1).
  assert.deepEqual(Array.from(examples).sort(), ['existing-site-dropin', 'landing', 'peer-guestbook', 'social']);
  const research = new Set(files.filter((f) => /^docs\/research\/[^/]+\//.test(f)).map((f) => f.split('/')[2]));
  // v0.3 (intended change): docs/research/v03/ holds the v0.3 program's design documents (the V03-DESIGN-REVIEW cites them), not lab evidence.
  assert.deepEqual(Array.from(research).filter((d) => d !== 'labs' && d !== 'v03').sort(), [], 'research evidence directories live under docs/research/labs/');
  assert.ok(existsSync(join(ROOT, 'docs/research/labs/w2a-01-lab/ng-app/package.json')), 'the Angular scaffold sits next to the w2a-01 lab');
  assert.ok(existsSync(join(ROOT, 'examples/existing-site-dropin/EXPECTED.md')));
  // Examples hold only what a site owner copies: their checks and fixtures live under test/ (0.2.1).
  const dotDirs = files.filter((f) => f.startsWith('examples/') && f.split('/').slice(2, -1).some((seg) => seg.startsWith('.')));
  assert.deepEqual(dotDirs, [], 'dot-directories (test tooling) under examples/');
  assert.match(read('test/e2e/run.mjs'), /'\.\.\/fixtures\/existing-site-dropin\/stage\.mjs'/);
  for (const f of ['test/example/site.test.mjs', 'test/example/browser.test.mjs', 'test/fixtures/existing-site-dropin/stage.mjs']) {
    assert.ok(existsSync(join(ROOT, f)), f);
  }
});

// ------------------------------------------------------------------------------------------- workflows

/** The run: blocks of a workflow as { line, text } (an indentation scan; the files are plain block YAML). */
function runBlocks(text) {
  const lines = text.split('\n');
  const blocks = [];
  for (let i = 0; i < lines.length; i++) {
    const m = /^(\s*)(?:- )?run: (\|)?(.*)$/.exec(lines[i]);
    if (!m) continue;
    if (!m[2]) {
      blocks.push({ line: i + 1, text: m[3] });
      continue;
    }
    const indent = m[1].length + (lines[i].trimStart().startsWith('- ') ? 2 : 0);
    const body = [];
    let j = i + 1;
    for (; j < lines.length; j++) {
      if (lines[j].trim() === '') { body.push(''); continue; }
      if (lines[j].length - lines[j].trimStart().length <= indent) break;
      body.push(lines[j]);
    }
    blocks.push({ line: i + 1, text: body.join('\n') });
    i = j - 1;
  }
  return blocks;
}

test('workflows: no permissions at the top, actions pinned to a commit, checkout without persisted credentials', () => {
  for (const file of WORKFLOWS.concat(TEMPLATES)) {
    const text = read(file);
    assert.match(text, /^permissions: \{\}$/m, file + ': permissions: {} at the workflow level');
    const uses = Array.from(text.matchAll(/^\s*(?:- )?uses: (\S+)(.*)$/gm));
    assert.ok(uses.length > 0, file + ' uses no action');
    for (const [, ref, rest] of uses) {
      if (ref.startsWith('./')) continue;
      assert.match(ref, /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_./-]+@[0-9a-f]{40}$/, file + ': ' + ref + ' is not pinned to a full commit SHA');
      assert.match(rest, /^ # v\d+(\.\d+){1,2}$/, file + ': ' + ref + ' needs its version in a comment (Dependabot keeps both)');
    }
    // Each checkout step carries persist-credentials: false before the next step starts.
    const steps = text.split(/\n(?=\s*- (?:uses|name|id|if|run):)/);
    for (const step of steps) {
      if (/uses: actions\/checkout@/.test(step)) assert.match(step, /persist-credentials: false/, file + ': a checkout keeps its credentials');
    }
    for (const block of runBlocks(text)) {
      assert.doesNotMatch(block.text, /\$\{\{/, file + ':' + block.line + ': an expression inside run: (pass it through env: instead)');
    }
    assert.doesNotMatch(text, /pull_request_target|workflow_run/, file + ': privileged triggers are not used');
  }
});

/** The jobs of a workflow as { name, text } (two-space job keys under jobs:). */
function jobsOf(text) {
  const start = text.search(/^jobs:$/m);
  const lines = text.slice(start).split('\n').slice(1);
  const jobs = [];
  for (const line of lines) {
    const m = /^  ([A-Za-z][\w-]*):\s*$/.exec(line);
    if (m) jobs.push({ name: m[1], text: '' });
    else if (jobs.length) jobs[jobs.length - 1].text += line + '\n';
  }
  return jobs;
}

test('workflows: a job that runs npm code holds no write token and no OIDC token; OIDC only where an action needs it', () => {
  let seen = 0;
  for (const file of WORKFLOWS.concat(TEMPLATES)) {
    for (const job of jobsOf(read(file))) {
      seen++;
      const npm = runBlocks(job.text).some((b) => /\bnpm (ci|install|run|test|pack)\b|\bnpx\b/.test(b.text));
      const write = /^\s+contents: write$/m.test(job.text);
      const oidc = /^\s+id-token: write\b/m.test(job.text);
      if (npm) assert.ok(!write && !oidc, file + ': job ' + job.name + ' runs npm code with ' + (write ? 'contents: write' : 'id-token: write'));
      // v0.3 (intended change, V03-DESIGN-REVIEW 2.19): the release provenance attestation needs the OIDC token to sign with.
      if (oidc) assert.match(job.text, /uses: (aws-actions\/configure-aws-credentials|actions\/deploy-pages|actions\/attest-build-provenance)@/, file + ': job ' + job.name + ' mints an OIDC token nothing uses');
    }
  }
  assert.ok(seen >= 10, 'only ' + seen + ' jobs found');
});

test('workflows: every npm script, file and command they run exists', () => {
  for (const file of WORKFLOWS.concat(TEMPLATES)) {
    const text = read(file);
    for (const block of runBlocks(text)) {
      for (const m of block.text.matchAll(/\bnpm run ([a-z][a-z0-9:-]*)/g)) {
        assert.ok(PKG.scripts[m[1]], file + ':' + block.line + ': npm run ' + m[1] + ' is not a script in package.json');
      }
      if (file.startsWith('deploy/')) continue; // the template runs inside a felinar clone ($mw)
      for (const m of block.text.matchAll(/\bnode ((?:tools|test\/e2e)\/[a-z0-9-]+\.mjs|build\.mjs)/g)) {
        assert.ok(existsSync(join(ROOT, m[1])), file + ':' + block.line + ': ' + m[1] + ' does not exist');
      }
    }
  }
  assert.ok(existsSync(join(ROOT, '.nvmrc')), 'node-version-file: .nvmrc');
});

// Flags named on a command line of a tool must be flags of that tool ("never document a flag that does not exist").
const helpCache = new Map();
function helpOf(file) {
  if (!helpCache.has(file)) {
    const r = spawnSync(process.execPath, [join(ROOT, file), '--help'], { cwd: ROOT, encoding: 'utf8', timeout: 30000 });
    assert.equal(r.status, 0, file + ' --help failed: ' + r.stderr);
    helpCache.set(file, r.stdout + r.stderr);
  }
  return helpCache.get(file);
}

/** Command lines (continuations joined) that start a tool, with the tool's file. */
function toolCommands(text) {
  const joined = text.replace(/\\\n\s*/g, ' ');
  const found = [];
  for (const line of joined.split('\n')) {
    let m = /(?:^|[\s"'`])(?:node\s+)?"?[^\s"']*?(tools\/[a-z0-9-]+\.mjs|build\.mjs)"?((?:\s+[^\s|;&]+)*)/.exec(line);
    if (m && (m[1] === 'build.mjs' || existsSync(join(ROOT, m[1])))) {
      found.push({ file: m[1], args: m[2], line });
      continue;
    }
    m = /\b(?:felinar|magnet-web)(?:\.mjs"?)?\s+([a-z][a-z-]*)((?:\s+[^\s|;&]+)*)/.exec(line);
    if (m && Object.prototype.hasOwnProperty.call(COMMANDS, m[1])) found.push({ file: COMMANDS[m[1]].file, args: m[2], line });
  }
  return found;
}

test('workflows, deploy files and their READMEs use only flags the tools have', () => {
  // v0.3 C2 (integrator): the one-box rung's README and Compose file (lane zero-setup) are checked the same way.
  const sources = WORKFLOWS.concat(TEMPLATES, ['deploy/tracker/README.md', 'deploy/pin/README.md', 'deploy/tracker/docker-compose.yml', 'deploy/pin/Dockerfile',
    'deploy/one-box/README.md', 'deploy/one-box/docker-compose.yml']);
  let checked = 0;
  for (const file of sources) {
    for (const cmd of toolCommands(read(file))) {
      const help = helpOf(cmd.file);
      for (const [flag] of cmd.args.matchAll(/(?<![\w-])--[a-z][a-z0-9-]*/g)) {
        checked++;
        assert.ok(help.includes(flag), file + ': ' + cmd.file + ' has no ' + flag + ' (in: ' + cmd.line.trim().slice(0, 160) + ')');
      }
    }
  }
  assert.ok(checked > 30, 'only ' + checked + ' flags found');
});

// --------------------------------------------------------------------------------------------- deploy/

test('deploy/tracker: Compose runs tools/tracker.mjs with an allow file from a mounted directory, behind Caddy', () => {
  const compose = read('deploy/tracker/docker-compose.yml');
  const caddy = read('deploy/tracker/Caddyfile');
  assert.match(compose, /ENTRYPOINT \["node", "tools\/tracker\.mjs"\]/);
  const command = /command: (\[.*\])/.exec(compose);
  const args = JSON.parse(command[1]);
  const help = helpOf('tools/tracker.mjs');
  for (const a of args.filter((x) => x.startsWith('--'))) assert.ok(help.includes(a), 'tracker has no ' + a);
  assert.ok(!args.includes('--open'), 'the deployed tracker serves only the allow list');
  const allow = args[args.indexOf('--allow') + 1];
  const mount = /- \.\/allow:(\S+):ro/.exec(compose);
  assert.ok(mount && allow.startsWith(mount[1] + '/'), 'the allow file is inside the mounted directory, not a single-file mount');
  const port = args[args.indexOf('--port') + 1];
  assert.match(caddy, new RegExp('reverse_proxy tracker:' + port + ' \\{'));
  assert.match(caddy, /^\{\$TRACKER_DOMAIN\} \{$/m);
  assert.match(compose, /TRACKER_DOMAIN: \$\{TRACKER_DOMAIN:\?/);
  assert.doesNotMatch(compose.replace(/^\s*#.*$/gm, ''), /^\s*- "?8000/m, 'the tracker port is not published to the host');
  for (const copied of ['package.json', 'package-lock.json', '.npmrc', 'src', 'tools']) assert.ok(existsSync(join(ROOT, copied)), copied);
});

test('deploy/pin: the image copies what tools/pin.mjs imports and starts it with flags it has', () => {
  const docker = read('deploy/pin/Dockerfile');
  for (const m of docker.matchAll(/^COPY (.+) \S+$/gm)) {
    for (const src of m[1].split(/\s+/)) assert.ok(existsSync(join(ROOT, src)), 'COPY ' + src + ' does not exist');
  }
  // tools/live.mjs (used by pin) imports the browser launch policy from test/e2e/.
  assert.match(read('tools/live.mjs'), /from '\.\.\/test\/e2e\/browser-args\.mjs'/);
  assert.match(docker, /^COPY test\/e2e\/browser-args\.mjs /m);
  const entry = JSON.parse(/^ENTRYPOINT (\[.*\])$/m.exec(docker)[1]);
  assert.equal(entry[0], '/bin/sh');
  assert.match(entry[2], /exec node tools\/pin\.mjs "\$PIN_URL"/);
  const help = helpOf('tools/pin.mjs');
  for (const [flag] of entry[2].matchAll(/--[a-z][a-z-]*/g)) assert.ok(help.includes(flag), 'pin has no ' + flag);
});

test('deploy/ READMEs link only to files that exist', () => {
  for (const file of ['deploy/tracker/README.md', 'deploy/pin/README.md', 'deploy/one-box/README.md']) {
    const text = read(file).replace(/```[\s\S]*?```/g, '');
    for (const m of text.matchAll(/\]\(([^)\s#]+)(?:#[^)]*)?\)/g)) {
      if (/^[a-z]+:/i.test(m[1])) continue;
      const target = join(ROOT, dirname(file), m[1]);
      assert.ok(existsSync(target), file + ' links to ' + m[1] + ' (' + relative(ROOT, target) + '), which does not exist');
      assert.ok(statSync(target), target);
    }
  }
});
