// test/e2e/pin-fixture.mjs: a pin node as a child process for the end-to-end scenarios (R 4.2 row E-MD-6; written by the files and
// media rows lane, docs/deviations/rows-media.md). It runs the real command line, `node tools/pin.mjs <url> --headless ...`, against a
// site on 127.0.0.1 with a temporary profile, and the moderator commands (`--approve`, `--pinned`, ...) as separate child processes on
// that profile, the way an operator runs them. test/fixtures/pin/start-pin.mjs (C2) runs runPin in the test's own process instead.
//
//   const pin = await startPinProcess({ url, keyFile, statusFile })   spawns the node; the profile lives until pin.cleanup()
//   await pin.ready                    the pinned page rendered ("render: ok"); rejects on "render: NOT ok", an early exit or a timeout
//   pin.lines                          stdout and stderr lines of every run; await pin.waitFor(/re/, ms) for one of them
//   pin.request({ ih, name, size, author, sha256 })   the operator enters a file request in the profile's queue (as E-PS-1 does)
//   await pin.moderate(['--approve', ih, '--by', name])   `node tools/pin.mjs <args> --profile <dir>` -> { code, out }
//   pin.pinned()                       the pinned files' records on disk (files/pinned/<ih>/meta.json)
//   pin.monthBytes()                   uploaded bytes of pinned files counted this month (pin/month.json; the node saves it every 2 s)
//   await pin.readStatus({ site })     the signed heartbeat now (src/pin/heartbeat.js verifyStatus): { ok, reason, has(ih), count }
//   await pin.waitForStatus(pred, ms)  polls the heartbeat until pred(status) holds
//   await pin.stop()                   SIGTERM: the node aborts, writes an empty heartbeat and closes its browser (SIGKILL after 20 s)
//   await pin.start()                  a new run on the same profile and key (the pinned bytes stay in the profile's IndexedDB)
//   await pin.cleanup()                stop, then delete the temporary profile
//
// Network policy (docs/DEV-NETWORK.md): only http://127.0.0.1 URLs are accepted. For such a URL tools/pin.mjs launches Chromium with
// the local-only flags (tools/live.mjs launchBrowser, allowRemoteFor(url) === false); this file checks both before it spawns anything.
// The child's browser is not watched by the harness's request guard; the local-only resolver rule is what keeps it on loopback.

import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { chromiumArgs } from './browser-args.mjs';
import { ROOT } from './lib.mjs';
import { allowRemoteFor } from '../../tools/live.mjs';
import { PinStore, FilePins, loadPinKey } from '../../tools/pin.mjs';
import { verifyStatus } from '../../src/pin/heartbeat.js';
import { assertLocalUrl } from '../fixtures/pin/start-pin.mjs';

const PIN_CLI = join(ROOT, 'tools', 'pin.mjs');

/** Collects the lines of a child's stdout and stderr into lines and wakes the waiters whose pattern matches. */
function lineSink(lines, waiters) {
  return (chunk, prefix) => {
    const text = String(chunk);
    for (const raw of text.split(/\r?\n/)) {
      if (!raw) continue;
      const line = prefix + raw;
      lines.push(line);
      for (const w of waiters.slice()) if (w.re.test(raw)) w.done(raw);
    }
  };
}

/**
 * startPinProcess({ url, keyFile, statusFile, interval = 2, statusEvery = 2, readyTimeoutMs = 120000, log = null })
 * -> Promise<handle> (see the header). keyFile is a pin key made with tools/keygen.mjs and named in the site's _mw.cfg.pin.
 */
export async function startPinProcess({ url, keyFile, statusFile, interval = 2, statusEvery = 2, readyTimeoutMs = 120000, log = null } = {}) {
  const href = assertLocalUrl(url);
  if (allowRemoteFor(href) !== false) throw new Error('pin-fixture: tools/pin.mjs would launch a browser that reaches remote hosts for ' + href);
  if (!chromiumArgs({ allowRemote: false }).some((a) => a.startsWith('--host-resolver-rules='))) throw new Error('pin-fixture: the local-only resolver rule is missing');
  if (!keyFile || !existsSync(keyFile)) throw new Error('pin-fixture: a pin key file is needed (tools/keygen.mjs)');
  if (!statusFile) throw new Error('pin-fixture: a heartbeat file is needed');
  const pinKey = await loadPinKey(keyFile);
  const dir = mkdtempSync(join(tmpdir(), 'mw-pin-proc-'));
  const profileDir = join(dir, 'profile');
  mkdirSync(profileDir, { recursive: true, mode: 0o700 });

  const lines = [];
  const waiters = [];
  const sink = lineSink(lines, waiters);
  let child = null;
  let exited = null;
  let runs = 0;

  const waitFor = (re, timeoutMs = readyTimeoutMs, { from = 0 } = {}) => {
    const hit = lines.slice(from).map((l) => l.replace(/^\[[^\]]*\] /, '')).find((l) => re.test(l));
    if (hit !== undefined) return Promise.resolve(hit);
    return new Promise((resolve, reject) => {
      const w = { re, done: null };
      const t = setTimeout(() => {
        waiters.splice(waiters.indexOf(w), 1);
        reject(new Error('pin-fixture: no line matched ' + re + ' within ' + timeoutMs + ' ms; last lines:\n    ' + lines.slice(-15).join('\n    ')));
      }, timeoutMs);
      if (t.unref) t.unref();
      w.done = (text) => {
        clearTimeout(t);
        waiters.splice(waiters.indexOf(w), 1);
        resolve(text);
      };
      waiters.push(w);
    });
  };

  const handle = {
    pub: pinKey.pub,
    dir,
    profileDir,
    statusFile,
    lines,
    ready: null,
    waitFor,
    runs: () => runs,
    running: () => Boolean(child && !exited),

    /** start(): a run of `node tools/pin.mjs <url> --headless --profile <dir> --files --pin-key <key> --status <file>`. */
    start() {
      if (child && !exited) throw new Error('pin-fixture: the node is already running');
      runs++;
      const tag = '[pin run ' + runs + '] ';
      const from = lines.length;
      const args = [PIN_CLI, href, '--headless', '--profile', profileDir, '--files', '--pin-key', keyFile, '--status', statusFile,
        '--status-every', String(statusEvery), '--interval', String(interval), '--max-restarts', '0'];
      child = spawn(process.execPath, args, { cwd: ROOT, env: process.env, stdio: ['ignore', 'pipe', 'pipe'] });
      const me = child;
      exited = null;
      const onOut = (c) => { sink(c, tag); if (typeof log === 'function') log(tag + String(c).trimEnd()); };
      me.stdout.on('data', onOut);
      me.stderr.on('data', onOut);
      const gone = new Promise((resolve) => me.once('exit', (code, signal) => resolve({ code, signal })));
      me.exitPromise = gone;
      gone.then((r) => { if (child === me) exited = r; });
      const rendered = waitFor(/^render: /, readyTimeoutMs, { from }).then((line) => {
        if (!/^render: ok/.test(line)) throw new Error('pin-fixture: the pinned page did not render: ' + line);
        return line;
      });
      handle.ready = Promise.race([rendered, gone.then((r) => { throw new Error('pin-fixture: tools/pin.mjs exited before rendering: ' + JSON.stringify(r) + '\n    ' + lines.slice(-15).join('\n    ')); })]);
      handle.ready.catch(() => {});
      return handle.ready;
    },

    /** stop(): SIGTERM and wait for the exit (the node writes an empty heartbeat on the way out); SIGKILL after timeoutMs. */
    async stop({ timeoutMs = 20000 } = {}) {
      const me = child;
      if (!me || exited) return exited;
      me.kill('SIGTERM');
      let timer = null;
      const killed = new Promise((resolve) => {
        timer = setTimeout(() => {
          try { me.kill('SIGKILL'); } catch (_) { /* gone */ }
          resolve(null);
        }, timeoutMs);
      });
      await Promise.race([me.exitPromise, killed]);
      clearTimeout(timer);
      return me.exitPromise;
    },

    /** request(entry): the operator enters a file request in this profile's queue (no page-to-pin request path exists yet, pin-node O-1). */
    request(entry) {
      return new FilePins({ store: new PinStore({ profileDir }) }).request(entry);
    },

    /** moderate(args): `node tools/pin.mjs <args> --profile <dir>` as its own process -> { code, out }. */
    moderate(args, { timeoutMs = 30000 } = {}) {
      return new Promise((resolve, reject) => {
        const p = spawn(process.execPath, [PIN_CLI, ...args, '--profile', profileDir], { cwd: ROOT, env: process.env, stdio: ['ignore', 'pipe', 'pipe'] });
        let out = '';
        p.stdout.on('data', (c) => { out += c; });
        p.stderr.on('data', (c) => { out += c; });
        const t = setTimeout(() => { p.kill('SIGKILL'); reject(new Error('pin-fixture: ' + args.join(' ') + ' did not finish in ' + timeoutMs + ' ms')); }, timeoutMs);
        p.once('exit', (code) => { clearTimeout(t); resolve({ code, out: out.trim() }); });
      });
    },

    pinned() {
      return new FilePins({ store: new PinStore({ profileDir }) }).pinned();
    },

    monthBytes() {
      try {
        const m = JSON.parse(readFileSync(join(profileDir, 'pin', 'month.json'), 'utf8'));
        return Number.isSafeInteger(m.bytes) ? m.bytes : 0;
      } catch (_) {
        return 0;
      }
    },

    async readStatus({ site = null, now = Date.now() } = {}) {
      if (!existsSync(statusFile)) return { ok: false, reason: 'no-file', count: 0, has: () => false };
      return verifyStatus(readFileSync(statusFile), { expectKey: pinKey.pub, site, now });
    },

    async waitForStatus(pred, timeoutMs = 30000, { site = null } = {}) {
      const until = Date.now() + timeoutMs;
      let last = null;
      for (;;) {
        last = await handle.readStatus({ site });
        if (pred(last)) return last;
        if (Date.now() > until) throw new Error('pin-fixture: the heartbeat never matched within ' + timeoutMs + ' ms (last: ' + (last.reason || 'ok') + ', ' + last.count + ' item(s))');
        await new Promise((r) => setTimeout(r, 250));
      }
    },

    async cleanup() {
      await handle.stop().catch(() => {});
      rmSync(dir, { recursive: true, force: true });
    },
  };
  return handle;
}
