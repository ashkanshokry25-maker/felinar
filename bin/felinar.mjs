#!/usr/bin/env node
// bin/felinar.mjs: the felinar command. Each subcommand runs one file of this package (tools/*.mjs
// or build.mjs) in a child Node process with the remaining arguments passed through unchanged, so
// `felinar publish <args>` is `node tools/publish.mjs <args>`: same flags, same output, same exit code.
//
//   felinar <command> [arguments]
//   felinar <command> --help        the command's own options
//   felinar help [<command>]
//   felinar --help | --version
//
// Signals: SIGTERM (a supervisor such as systemd or `docker stop`) is passed to the child. SIGINT and
// SIGHUP are passed on too, except in an interactive terminal: there Ctrl-C and a hang-up already reach
// the child, which runs in the same foreground process group, and a second copy would cut short a tool
// that stops cleanly on the first one. When the child ends on a signal, this process ends on the same
// signal.

import { spawn } from 'node:child_process';
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { createRequire } from 'node:module';
import { constants } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/** Subcommand -> file (relative to the package root) and a one-line summary for --help. */
export const COMMANDS = Object.freeze({
  publish: { file: 'tools/publish.mjs', summary: 'pack a site into a torrent and sign its pointer; --withdraw takes a site down' },
  ship: { file: 'tools/ship.mjs', summary: 'put a site on a rented server named by its IP address (nip.io), with automatic HTTPS; --dry-run first' },
  keygen: { file: 'tools/keygen.mjs', summary: "create the site owner's P-256 signing key (a JWK file with mode 600)" },
  ledger: { file: 'tools/ledger-admin.mjs', summary: 'site ledger admin: genesis, policy, owner hand-over, accept, allow, ban, tombstone, show' },
  tracker: { file: 'tools/tracker.mjs', summary: 'WebSocket tracker that serves only the infohashes you allow (--allow)' },
  dev: { file: 'tools/dev-server.mjs', summary: 'local static server for the loader, with a web seed and pointer injection' },
  demo: { file: 'tools/demo.mjs', summary: 'build, publish and serve the example guestbook on this computer (needs a checkout)' },
  'check-site': { file: 'tools/check-site.mjs', summary: 'check a live site from outside: pointer, torrent, web seed, trackers' },
  'check-webseed': { file: 'tools/check-webseed.mjs', summary: 'verify a web seed or a drop-in host against a .torrent' },
  pin: { file: 'tools/pin.mjs', summary: 'keep a site and its ledger online from a browser that stays open' },
  seed: { file: 'tools/seed.mjs', summary: 'seed a published site from Node (needs node-datachannel)' },
  snapshot: { file: 'tools/snapshot.mjs', summary: 'write a ledger snapshot file for the pointer key cs=' },
  build: { file: 'build.mjs', summary: 'build the loader into dist/ (needs a checkout with dev dependencies)' },
});

const TAGLINE = 'websites loaded by magnet link, verified in your browser, from a plain static host. No backend. The light web.';

/** The command entry for a name, or null (own properties only: "toString" is not a command). */
export function lookupCommand(name) {
  return typeof name === 'string' && Object.prototype.hasOwnProperty.call(COMMANDS, name) ? COMMANDS[name] : null;
}

export function packageVersion(root = ROOT) {
  try {
    return JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version || 'unknown';
  } catch (_) {
    return 'unknown';
  }
}

export function usage() {
  const width = Math.max(...Object.keys(COMMANDS).map((name) => name.length)) + 2;
  const lines = [
    'felinar ' + packageVersion() + ': ' + TAGLINE,
    '',
    'Usage: felinar <command> [arguments]',
    '       felinar <command> --help    (the options of one command)',
    '       felinar --version',
    '',
    'Commands:',
    ...Object.keys(COMMANDS).map((name) => '  ' + name.padEnd(width) + COMMANDS[name].summary),
    '',
    'Each command runs the matching file with the arguments unchanged:',
    '"felinar publish <args>" is "node tools/publish.mjs <args>" in this package.',
  ];
  return lines.join('\n');
}

/**
 * resolveCommand(argv) -> { kind: 'help' | 'version' | 'run' | 'error', ... }
 * Pure: decides what the arguments ask for without running anything.
 */
export function resolveCommand(argv) {
  const [first, ...rest] = argv;
  if (first === undefined) return { kind: 'error', message: 'missing command', exitCode: 2 };
  if (first === '--help' || first === '-h') return { kind: 'help' };
  if (first === '--version' || first === '-v') return { kind: 'version' };
  if (first === 'help') {
    if (rest.length === 0) return { kind: 'help' };
    const target = lookupCommand(rest[0]);
    if (!target) return { kind: 'error', message: 'unknown command ' + JSON.stringify(rest[0]), exitCode: 2 };
    return { kind: 'run', name: rest[0], file: join(ROOT, target.file), args: ['--help'] };
  }
  const target = lookupCommand(first);
  if (!target) return { kind: 'error', message: 'unknown command ' + JSON.stringify(first), exitCode: 2 };
  return { kind: 'run', name: first, file: join(ROOT, target.file), args: rest };
}

function resolvable(root, specifier) {
  try {
    createRequire(pathToFileURL(join(root, 'package.json')).href).resolve(specifier);
    return true;
  } catch (_) {
    return false;
  }
}

/**
 * buildPreflight(root) -> null | string: why `build` cannot run here. build.mjs imports esbuild (a dev
 * dependency) and copies node_modules/webtorrent/dist/webtorrent.min.js from the package root, so an
 * install without dev dependencies cannot build.
 */
export function buildPreflight(root = ROOT) {
  const missing = [];
  if (!resolvable(root, 'esbuild')) missing.push('esbuild');
  if (!existsSync(join(root, 'node_modules', 'webtorrent', 'dist', 'webtorrent.min.js'))) missing.push('node_modules/webtorrent/dist/webtorrent.min.js');
  if (!missing.length) return null;
  return 'felinar build needs a repository checkout with its dev dependencies (missing: ' + missing.join(', ') + ').\n' +
    'Run it there: git clone the repository, npm ci, then npm run build (or felinar build).\n' +
    'A release build of the loader is the dist zip on the GitHub release page (felinar-<version>-dist.zip).';
}

/**
 * demoPreflight(args, root) -> null | string: why `demo` cannot run here. tools/demo.mjs imports build.mjs,
 * and with it esbuild, even with --no-build, and its default site is examples/peer-guestbook, which only a
 * checkout has.
 */
export function demoPreflight(args = [], root = ROOT) {
  const missing = [];
  if (!resolvable(root, 'esbuild')) missing.push('esbuild');
  if (!args.includes('--no-build') && !existsSync(join(root, 'node_modules', 'webtorrent', 'dist', 'webtorrent.min.js'))) {
    missing.push('node_modules/webtorrent/dist/webtorrent.min.js');
  }
  if (!args.includes('--site') && !existsSync(join(root, 'examples', 'peer-guestbook', 'index.html'))) missing.push('examples/peer-guestbook');
  if (!missing.length) return null;
  return 'felinar demo needs a repository checkout with its dev dependencies (missing: ' + missing.join(', ') + ').\n' +
    'Run it there: git clone the repository, npm ci, then npm run demo (or felinar demo).';
}

/** commandPreflight(name, args, root) -> null | string: a reason the command cannot start, before it runs. */
export function commandPreflight(name, args = [], root = ROOT) {
  if (args.includes('--help') || args.includes('-h')) return null;
  if (name === 'build') return buildPreflight(root);
  if (name === 'demo') return demoPreflight(args, root);
  return null;
}

// Signals this platform knows; a child that ends on one of them makes this process end on it too.
const FORWARD = ['SIGINT', 'SIGTERM', 'SIGHUP', 'SIGBREAK'].filter((name) => constants.signals && name in constants.signals);

/**
 * shouldForward(signal, { interactive }) -> boolean. In an interactive terminal the terminal driver sends
 * SIGINT (Ctrl-C), SIGHUP and SIGBREAK to the whole foreground process group, the child included, so they
 * are not sent a second time. SIGTERM comes from another process (a supervisor, `kill`, `docker stop`) and
 * reaches only this process, so it is always passed on; so is everything when this process has no terminal.
 */
export function shouldForward(signal, { interactive = false } = {}) {
  if (signal === 'SIGTERM') return true;
  return !interactive;
}

/** runFile(file, args) -> Promise<{ code, signal }>: runs `node <file> <args>` with this process's stdio. */
export function runFile(file, args, { execArgv = process.execArgv, env = process.env, interactive = Boolean(process.stdin && process.stdin.isTTY) } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [...execArgv, file, ...args], { stdio: 'inherit', env });
    const handlers = new Map();
    for (const signal of FORWARD) {
      // A handler stays installed even when the signal is not passed on: without one, Ctrl-C would end this
      // process at once and leave the child without the parent that reports its exit code.
      const handler = () => {
        if (!shouldForward(signal, { interactive })) return;
        try {
          child.kill(signal);
        } catch (_) { /* the child is already gone */ }
      };
      handlers.set(signal, handler);
      process.on(signal, handler);
    }
    const detach = () => {
      for (const [signal, handler] of handlers) process.removeListener(signal, handler);
    };
    child.once('error', (err) => {
      detach();
      reject(err);
    });
    child.once('exit', (code, signal) => {
      detach();
      resolve({ code, signal });
    });
  });
}

async function main(argv) {
  const plan = resolveCommand(argv);
  if (plan.kind === 'help') {
    process.stdout.write(usage() + '\n');
    return 0;
  }
  if (plan.kind === 'version') {
    process.stdout.write('felinar ' + packageVersion() + '\n');
    return 0;
  }
  if (plan.kind === 'error') {
    process.stderr.write('error: ' + plan.message + '\n\n' + usage() + '\n');
    return plan.exitCode;
  }
  const why = commandPreflight(plan.name, plan.args);
  if (why) {
    process.stderr.write('error: ' + why + '\n');
    return 1;
  }
  if (!existsSync(plan.file)) {
    process.stderr.write('error: ' + plan.file + ' is missing from this installation\n');
    return 1;
  }
  const { code, signal } = await runFile(plan.file, plan.args);
  if (signal) {
    // End the way the child ended, so a shell or supervisor sees the signal (128 + n).
    process.kill(process.pid, signal);
    return 128 + ((constants.signals && constants.signals[signal]) || 0);
  }
  return code === null ? 1 : code;
}

// Run main only when this file is the program (npm links bin files, so compare real paths), not when
// a test imports it.
function invokedDirectly() {
  if (!process.argv[1]) return false;
  try {
    return pathToFileURL(realpathSync(process.argv[1])).href === import.meta.url;
  } catch (_) {
    return false;
  }
}

if (invokedDirectly()) {
  main(process.argv.slice(2)).then((code) => {
    process.exitCode = code;
  }, (err) => {
    process.stderr.write('error: ' + (err && err.message ? err.message : String(err)) + '\n');
    process.exitCode = 1;
  });
}
