// The felinar command (bin/felinar.mjs) and the package metadata that installs it: every subcommand
// maps to a file of this package, arguments and exit codes pass through unchanged, SIGTERM reaches the
// child, and commands that need a checkout say so before they start.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  COMMANDS, ROOT, lookupCommand, resolveCommand, usage, packageVersion, buildPreflight, demoPreflight, commandPreflight, shouldForward,
} from '../../bin/felinar.mjs';

const BIN = join(ROOT, 'bin', 'felinar.mjs');
const PKG = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
const TAGLINE = 'websites loaded by magnet link, verified in your browser, from a plain static host. No backend. The light web.';

function cli(args, opts = {}) {
  return spawnSync(process.execPath, [BIN, ...args], { cwd: ROOT, encoding: 'utf8', timeout: 30000, ...opts });
}

test('the subcommands are the documented thirteen and each one runs a file of this package', () => {
  assert.deepEqual(Object.keys(COMMANDS).sort(), [
    'build', 'check-site', 'check-webseed', 'demo', 'dev', 'keygen', 'ledger', 'pin', 'publish', 'seed', 'ship', 'snapshot', 'tracker',
  ]);
  for (const [name, { file, summary }] of Object.entries(COMMANDS)) {
    assert.ok(existsSync(join(ROOT, file)), name + ' -> ' + file + ' is missing');
    assert.ok(file === 'build.mjs' || /^tools\/[a-z-]+\.mjs$/.test(file), name + ': ' + file);
    assert.ok(summary && !/[\u2013\u2014\u2018\u2019\u201C\u201D]/.test(summary), name + ': summary missing or has an en/em dash or a curly quote');
  }
  assert.equal(COMMANDS.ledger.file, 'tools/ledger-admin.mjs');
  assert.equal(COMMANDS.dev.file, 'tools/dev-server.mjs');
  assert.equal(COMMANDS.ship.file, 'tools/ship.mjs');
});

test('ship: resolves to tools/ship.mjs with its arguments unchanged, is in the usage text, and its own --help and usage errors come through the command', () => {
  const run = resolveCommand(['ship', './my-site', '--ip', '203.0.113.7', '--dry-run']);
  assert.equal(run.kind, 'run');
  assert.equal(run.file, join(ROOT, 'tools', 'ship.mjs'));
  assert.deepEqual(run.args, ['./my-site', '--ip', '203.0.113.7', '--dry-run']);
  assert.deepEqual(resolveCommand(['help', 'ship']).args, ['--help']);
  assert.equal(resolveCommand(['help', 'ship']).file, join(ROOT, 'tools', 'ship.mjs'));
  assert.match(usage(), /^ {2}ship +put a site on a rented server named by its IP address/m);
  assert.equal(commandPreflight('ship', ['./my-site'], ROOT), null, 'ship checks what it needs itself (the built loader, ssh, rsync) and says so');
  const h = cli(['ship', '--help']);
  assert.equal(h.status, 0, h.stderr);
  assert.match(h.stdout, /^Usage: node tools\/ship\.mjs /);
  const noArgs = cli(['ship']);
  assert.equal(noArgs.status, 2, 'a usage error of the tool is the exit code of the command');
  assert.match(noArgs.stderr, /expected exactly one site directory/);
});

test('resolveCommand: help, version, errors and argument pass-through', () => {
  assert.deepEqual(resolveCommand([]), { kind: 'error', message: 'missing command', exitCode: 2 });
  for (const a of ['--help', '-h', 'help']) assert.equal(resolveCommand([a]).kind, 'help');
  for (const a of ['--version', '-v']) assert.equal(resolveCommand([a]).kind, 'version');
  const run = resolveCommand(['publish', 'site', '--name', 'x', '--', '--help']);
  assert.equal(run.kind, 'run');
  assert.equal(run.file, join(ROOT, 'tools', 'publish.mjs'));
  assert.deepEqual(run.args, ['site', '--name', 'x', '--', '--help']);
  assert.deepEqual(resolveCommand(['help', 'tracker']).args, ['--help']);
  assert.equal(resolveCommand(['help', 'tracker']).file, join(ROOT, 'tools', 'tracker.mjs'));
  for (const bad of [['nope'], ['help', 'nope'], ['toString'], ['help', 'constructor'], ['__proto__']]) {
    const r = resolveCommand(bad);
    assert.equal(r.kind, 'error', JSON.stringify(bad));
    assert.equal(r.exitCode, 2);
  }
  assert.equal(lookupCommand('hasOwnProperty'), null);
  assert.equal(lookupCommand(undefined), null);
});

test('usage lists every command with the version and the approved tagline', () => {
  const text = usage();
  assert.ok(text.startsWith('felinar ' + PKG.version + ': ' + TAGLINE), text.split('\n')[0]);
  for (const name of Object.keys(COMMANDS)) assert.match(text, new RegExp('^  ' + name.replace(/-/g, '\\-') + ' +\\S', 'm'));
  assert.equal(packageVersion(), PKG.version);
  assert.equal(packageVersion(join(tmpdir(), 'no-such-dir-for-felinar')), 'unknown');
});

test('package.json installs the command and ships only the runtime, the tools and the build', () => {
  assert.equal(PKG.name, 'felinar');
  assert.equal(PKG.description, 'felinar: ' + TAGLINE);
  assert.equal(PKG.license, 'MIT');
  assert.equal(PKG.type, 'module');
  assert.deepEqual(PKG.bin, { felinar: 'bin/felinar.mjs', 'magnet-web': 'bin/felinar.mjs' }, 'magnet-web stays as an alias for one release; the lightweb alias went with the name (nothing was published under it)');
  assert.equal(PKG.engines.node, '>=22');
  assert.ok(readFileSync(BIN, 'utf8').startsWith('#!/usr/bin/env node\n'), 'the bin file needs a node shebang');
  for (const key of ['homepage', 'bugs', 'repository']) {
    const value = typeof PKG[key] === 'string' ? PKG[key] : PKG[key].url;
    assert.match(value, /github\.com\/[A-Za-z0-9_.-]+\/felinar\b/, key);
  }
  for (const entry of PKG.files) assert.ok(existsSync(join(ROOT, entry)), 'files lists ' + entry + ', which does not exist');
  for (const needed of ['bin/', 'src/', 'tools/', 'build.mjs', 'build.lock.json', 'test/e2e/browser-args.mjs']) {
    assert.ok(PKG.files.includes(needed), 'files must list ' + needed);
  }
  for (const entry of PKG.files) {
    assert.ok(!/^(dist|examples|docs|deploy|\.github|node_modules|\.tools|test\/unit|test\/vectors)\b/.test(entry), entry + ' must not be packed');
  }
  // Every file a script names exists (npm run <script> after a move).
  for (const [name, cmd] of Object.entries(PKG.scripts)) {
    for (const m of cmd.matchAll(/\bnode\s+(?:--[a-z-]+(?:=\S+)?\s+)*"?([A-Za-z0-9_./-]+\.m?js)\b/g)) {
      assert.ok(existsSync(join(ROOT, m[1])), 'script ' + name + ' runs ' + m[1] + ', which does not exist');
    }
  }
});

test('build and demo say what a checkout needs before they start; --help always passes', () => {
  assert.equal(commandPreflight('build', [], ROOT), null);
  assert.equal(commandPreflight('demo', [], ROOT), null);
  assert.equal(commandPreflight('publish', [], ROOT), null);
  const bare = mkdtempSync(join(tmpdir(), 'mw-cli-'));
  try {
    writeFileSync(join(bare, 'package.json'), JSON.stringify({ name: 'felinar', version: '0.0.0', type: 'module' }));
    const b = buildPreflight(bare);
    assert.match(b, /esbuild/);
    assert.match(b, /webtorrent\.min\.js/);
    assert.match(b, /felinar-<version>-dist\.zip/);
    const d = demoPreflight([], bare);
    assert.match(d, /esbuild/);
    assert.match(d, /examples\/peer-guestbook/);
    assert.doesNotMatch(demoPreflight(['--site', 'my-site', '--no-build'], bare), /peer-guestbook|webtorrent/);
    assert.equal(commandPreflight('build', ['--help'], bare), null);
    assert.equal(commandPreflight('demo', ['-h'], bare), null);
  } finally {
    rmSync(bare, { recursive: true, force: true });
  }
});

test('signals: SIGTERM is always passed on; Ctrl-C and hang-up only when there is no terminal', () => {
  assert.equal(shouldForward('SIGTERM', { interactive: true }), true);
  assert.equal(shouldForward('SIGTERM', { interactive: false }), true);
  for (const s of ['SIGINT', 'SIGHUP', 'SIGBREAK']) {
    assert.equal(shouldForward(s, { interactive: true }), false, s);
    assert.equal(shouldForward(s, { interactive: false }), true, s);
  }
});

test('the command runs: --version, a tool\'s own --help, and the exit code of a usage error', () => {
  const v = cli(['--version']);
  assert.equal(v.status, 0, v.stderr);
  assert.equal(v.stdout, 'felinar ' + PKG.version + '\n');
  const h = cli(['keygen', '--help']);
  assert.equal(h.status, 0, h.stderr);
  assert.match(h.stdout, /^Usage: node tools\/keygen\.mjs/);
  const unknown = cli(['frobnicate']);
  assert.equal(unknown.status, 2);
  assert.match(unknown.stderr, /unknown command "frobnicate"/);
  const usageError = cli(['publish']);
  assert.equal(usageError.status, 2, 'publish without a directory is a usage error (exit 2) in the child, and the command keeps it');
});

test('SIGTERM to the command stops the child cleanly (tracker on 127.0.0.1, exit 0)', async () => {
  const child = spawn(process.execPath, [BIN, 'tracker', '--open', '--host', '127.0.0.1', '--port', '0', '--json'], { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (d) => { stdout += d; });
  child.stderr.on('data', (d) => { stderr += d; });
  const exited = new Promise((resolve) => child.once('exit', (code, signal) => resolve({ code, signal })));
  const deadline = Date.now() + 20000;
  while (!/"url":"ws:\/\/127\.0\.0\.1:\d+"/.test(stdout)) {
    if (Date.now() > deadline || child.exitCode !== null) {
      child.kill('SIGKILL');
      assert.fail('the tracker did not start: ' + stdout + stderr);
    }
    await new Promise((r) => setTimeout(r, 50));
  }
  child.kill('SIGTERM');
  const timer = setTimeout(() => child.kill('SIGKILL'), 15000);
  const { code, signal } = await exited;
  clearTimeout(timer);
  assert.equal(signal, null, 'the command ended on ' + signal + ': ' + stderr);
  assert.equal(code, 0, stderr);
});
