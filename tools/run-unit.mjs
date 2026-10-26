#!/usr/bin/env node
// tools/run-unit.mjs: runs the Node unit tests with an explicit file list (npm test, npm run
// test:unit, npm run test:browser). The list is built here because `node --test <directory>` fails
// on Node 24 and a glob cannot exclude files: test/unit/*.test.mjs without the *-browser*
// files, which launch Playwright and belong to `npm run test:browser`.
//
//   node tools/run-unit.mjs [--browser] [--list] [--timeout <ms per test>] [--total <ms>] [file...]
//
//   (no flag)   every test/unit/*.test.mjs except *-browser*
//   --browser   only the *-browser* files (Chromium with the local-only flags, WebKit on 127.0.0.1)
//   --list      print the files and exit
//   file...     run exactly these files (paths relative to the repository root or to test/unit)
//
// Each test gets --test-timeout (default 180000 ms). A watchdog stops the whole run after --total
// ms (default 300000: the whole unit suite takes seconds), because a test file that leaks a handle never
// exits by itself.

import { readdirSync, existsSync } from 'node:fs';
import { join, resolve, isAbsolute } from 'node:path';
import { spawn } from 'node:child_process';

import { parseCli, runMain, isMain, ROOT, UsageError, ToolError, out } from './lib.mjs';

const USAGE = `
Usage: node tools/run-unit.mjs [--browser] [--list] [--timeout <ms>] [--total <ms>] [file...]
`;

export const UNIT_DIR = join(ROOT, 'test', 'unit');

/** True for the test files that launch a browser (*-browser*.test.mjs). */
export function isBrowserTest(name) {
  return /-browser/.test(name);
}

/** unitTestFiles({ dir, browser }) → sorted absolute paths of the *.test.mjs files to run. */
export function unitTestFiles({ dir = UNIT_DIR, browser = false } = {}) {
  return readdirSync(dir)
    .filter((name) => name.endsWith('.test.mjs') && isBrowserTest(name) === browser)
    .sort()
    .map((name) => join(dir, name));
}

function explicitFiles(names) {
  return names.map((name) => {
    const candidates = isAbsolute(name) ? [name] : [resolve(process.cwd(), name), resolve(ROOT, name), join(UNIT_DIR, name)];
    const hit = candidates.find((p) => existsSync(p));
    if (!hit) throw new UsageError('no such test file: ' + name);
    return hit;
  });
}

async function main(argv) {
  const { flags, positionals } = parseCli(argv, {
    browser: { type: 'boolean' },
    list: { type: 'boolean' },
    timeout: { type: 'int', default: Number(process.env.MW_TEST_TIMEOUT) || 180000 },
    total: { type: 'int', default: Number(process.env.MW_UNIT_TOTAL_MS) || 300000 },
  });
  if (flags.help) {
    out(USAGE.trim());
    return 0;
  }
  const files = positionals.length ? explicitFiles(positionals) : unitTestFiles({ browser: flags.browser });
  if (!files.length) throw new ToolError('no test files found in ' + UNIT_DIR);
  if (flags.list) {
    for (const f of files) out(f);
    return 0;
  }
  const args = ['--test', '--test-timeout=' + flags.timeout, ...files];
  return new Promise((resolveRun) => {
    // The browser files gate themselves on MW_BROWSER=1 so a stray `node --test` never starts a
    // browser; `--browser` is the explicit request, so it sets the gate.
    const env = flags.browser ? Object.assign({}, process.env, { MW_BROWSER: '1' }) : process.env;
    // POSIX: the runner and its per-file test processes get a process group of their own, so the watchdog
    // stops all of them. Killing only the runner left a hanging test file's process running forever.
    const group = process.platform !== 'win32';
    const child = spawn(process.execPath, args, { stdio: 'inherit', cwd: ROOT, env, detached: group });
    const signalAll = (sig) => {
      try {
        if (group) process.kill(-child.pid, sig);
        else child.kill(sig);
      } catch (_) { /* already gone */ }
    };
    // A separate group gets no signals from the terminal: pass Ctrl-C, SIGTERM and hang-up on.
    const relays = ['SIGINT', 'SIGTERM', 'SIGHUP'].map((sig) => {
      const relay = () => signalAll(sig);
      process.on(sig, relay);
      return [sig, relay];
    });
    let killed = false;
    const watchdog = setTimeout(() => {
      killed = true;
      process.stderr.write('run-unit: stopping after ' + flags.total + ' ms; a test file did not exit (open handle?)\n');
      signalAll('SIGKILL');
    }, flags.total);
    child.on('exit', (code, signal) => {
      clearTimeout(watchdog);
      for (const [sig, relay] of relays) process.off(sig, relay);
      if (group) signalAll('SIGKILL'); // a test file's process that outlived the runner
      resolveRun(killed ? 1 : code === null ? (signal ? 1 : 0) : code);
    });
    child.on('error', (err) => {
      clearTimeout(watchdog);
      for (const [sig, relay] of relays) process.off(sig, relay);
      process.stderr.write('run-unit: cannot start node: ' + err.message + '\n');
      resolveRun(1);
    });
  });
}

if (isMain(import.meta.url)) runMain(main, USAGE);
