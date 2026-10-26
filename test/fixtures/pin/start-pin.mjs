// test/fixtures/pin/start-pin.mjs: a pin node for local scenarios, written for the C2 integrator's E-PS-1 (hand-off of an owner's
// upload to a pin, the receipt, the "Kept by the site" label). It runs tools/pin.mjs (runPin) in this process, headless, against a
// site on 127.0.0.1, with a temporary profile and a temporary pin key, and writes the signed heartbeat to statusFile.
//
//   const pin = await startPin({ url: 'http://127.0.0.1:<port>/', statusFile, files: true, autoAccept: 'owner', statusEverySec: 2 })
//   pin.pub            the pin's public key: name it in the site's _mw.cfg.pin (ledger-admin cfg --pin) before visitors check it
//   pin.statusFile     where the heartbeat lands; serve it at <ws base>/pin-status.json (put it in the web seed directory)
//   await pin.ready    the pinned page rendered ("render: ok"); rejects on "render: NOT ok" or after readyTimeoutMs
//   pin.lines          every log line; await pin.waitFor(/re/, ms) resolves with the first matching line
//   await pin.readStatus({ site })            verifyStatus of the file now (src/pin/heartbeat.js): { ok, reason, age, has(ih) }
//   await pin.waitForStatus((v) => v.ok && v.has(ih), ms)   polls the file until the predicate holds
//   pin.host()         the running pin host (createPinHost): files (queue, pinned), meter, signer, store
//   await pin.stop()   aborts the run, waits for it to close the browser, then deletes the temporary profile and key
//   keyFile            (option, C2 integrator) a pin key made beforehand with tools/keygen.mjs; it is not deleted on stop
//
// Network policy (docs/DEV-NETWORK.md): only http://127.0.0.1 URLs are accepted. runPin launches Chromium with
// chromiumArgs({ allowRemote: false }) for a loopback URL, and this helper passes allowRemote: false on top, after checking that
// the local-only resolver rule is in those arguments. Needs Playwright Chromium and a built dist/ served at the URL; the helper
// builds nothing and starts no server.

import { mkdtempSync, mkdirSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { chromiumArgs } from '../../e2e/browser-args.mjs';
import { keygen } from '../../../tools/keygen.mjs';
import { runPin, loadPinKey } from '../../../tools/pin.mjs';
import { verifyStatus } from '../../../src/pin/heartbeat.js';

/** assertLocalUrl(url) → the URL's href when it is http://127.0.0.1[:port]/...; TypeError otherwise. */
export function assertLocalUrl(url) {
  let u;
  try {
    u = new URL(String(url));
  } catch (_) {
    throw new TypeError('startPin: not a URL: ' + url);
  }
  if (u.protocol !== 'http:' || u.hostname !== '127.0.0.1') {
    throw new TypeError('startPin: only http://127.0.0.1 URLs (docs/DEV-NETWORK.md); got ' + u.href);
  }
  return u.href;
}

/**
 * startPin(options) → Promise<handle> (see the header). Options: url (required), statusFile (default <tmp>/ws/pin-status.json),
 * files (true), autoAccept ('owner'; only with files), monthCap (null), mailbox (false), statusEverySec (2), intervalSec (5),
 * consent (true), maxRestarts (0), readyTimeoutMs (120000), keep (false: delete the temporary directory on stop), log (a function
 * for each line), run (runPin; tests pass a fake).
 */
export async function startPin({
  url, statusFile = null, files = true, autoAccept = 'owner', monthCap = null, mailbox = false, statusEverySec = 2, intervalSec = 5,
  consent = true, maxRestarts = 0, readyTimeoutMs = 120000, keep = false, log = null, run = runPin, keyFile: givenKey = null,
} = {}) {
  const href = assertLocalUrl(url);
  const args = chromiumArgs({ allowRemote: false });
  if (!args.some((a) => a.startsWith('--host-resolver-rules='))) throw new Error('startPin: chromiumArgs({ allowRemote: false }) has no local-only resolver rule');
  const dir = mkdtempSync(join(tmpdir(), 'mw-pin-fixture-'));
  const profileDir = join(dir, 'profile');
  mkdirSync(profileDir, { recursive: true, mode: 0o700 });
  // C2 integrator: keyFile (optional) is a pin key made beforehand, so the site's _mw.cfg.pin can name it before the pinned
  // page first loads the ledger (E-PS-1); without it a key is made here as before.
  const keyFile = givenKey || join(dir, 'pin.jwk');
  if (!givenKey) await keygen({ out: keyFile });
  const pinKey = await loadPinKey(keyFile);
  const status = statusFile || join(dir, 'ws', 'pin-status.json');

  const lines = [];
  const waiters = [];
  const onLine = (line) => {
    const text = String(line);
    lines.push(text);
    if (typeof log === 'function') log(text);
    for (const w of waiters.slice()) {
      if (w.re.test(text)) w.done(text);
    }
  };
  const waitFor = (re, timeoutMs = readyTimeoutMs) => {
    const hit = lines.find((l) => re.test(l));
    if (hit !== undefined) return Promise.resolve(hit);
    return new Promise((resolve, reject) => {
      const w = { re, done: null };
      const t = setTimeout(() => {
        waiters.splice(waiters.indexOf(w), 1);
        reject(new Error('startPin: no log line matched ' + re + ' within ' + timeoutMs + ' ms; last lines:\n' + lines.slice(-12).join('\n')));
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

  const controller = new AbortController();
  let host = null;
  let pinnedPage = null;
  const done = Promise.resolve().then(() => run({
    url: href, headless: true, profileDir, intervalSec, consent, mailbox, files, maxRestarts,
    pinKey, statusFile: status, statusEverySec, autoAccept: files ? autoAccept : null, monthCap,
    allowRemote: false, log: onLine, signal: controller.signal, onHost: (h) => { host = h; }, onPage: (p) => { pinnedPage = p; },
  }));
  done.catch(() => {});
  const ready = waitFor(/^render: /).then((line) => {
    if (!/^render: ok/.test(line)) throw new Error('startPin: the pinned page did not render: ' + line);
    return line;
  });
  ready.catch(() => {});

  const readStatus = async ({ site = null, now = Date.now() } = {}) => {
    if (!existsSync(status)) return { ok: false, reason: 'no-file', age: null, count: 0, has: () => false, status: null };
    return verifyStatus(readFileSync(status), { expectKey: pinKey.pub, site, now });
  };
  const waitForStatus = async (pred, timeoutMs = readyTimeoutMs, { site = null } = {}) => {
    const until = Date.now() + timeoutMs;
    let last = null;
    for (;;) {
      last = await readStatus({ site });
      if (pred(last)) return last;
      if (Date.now() > until) throw new Error('startPin: the heartbeat never matched within ' + timeoutMs + ' ms (last: ' + (last.reason || 'ok') + ', ' + last.count + ' items)');
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  };

  let stopped = null;
  return {
    pub: pinKey.pub,
    fingerprint: pinKey.fingerprint,
    statusFile: status,
    profileDir,
    keyFile,
    dir,
    lines,
    ready,
    done,
    waitFor,
    readStatus,
    waitForStatus,
    host: () => host,
    // C2 integrator: the pinned page's read-only loader state (window.__mwShell.inspect()), or null.
    inspect: async () => {
      if (!pinnedPage) return null;
      try { return await pinnedPage.evaluate(() => (window.__mwShell ? window.__mwShell.inspect() : null)); } catch (_) { return null; }
    },
    // C2 integrator: runs fn(arg) in the pinned page's top frame, as the site's own code could (a test of what that code can reach).
    evaluate: async (fn, arg) => (pinnedPage ? pinnedPage.evaluate(fn, arg) : null),
    stop() {
      if (!stopped) {
        controller.abort();
        stopped = done.catch(() => {}).finally(() => {
          if (!keep) rmSync(dir, { recursive: true, force: true });
        });
      }
      return stopped;
    },
  };
}
