// test/e2e/lib.mjs: the machinery behind test/e2e/run.mjs (ARCHITECTURE section 12, E2E).
//
// Everything stays on 127.0.0.1 (docs/DEV-NETWORK.md):
//  - every Chromium launch passes chromiumArgs({ allowRemote: false }) from ./browser-args.mjs;
//  - every page gets an init script that empties RTCPeerConnection iceServers, so the loader's STUN
//    list is never contacted even if a resolver rule were missing (host candidates suffice on one
//    machine);
//  - every request and WebSocket of every context is checked: anything that is not 127.0.0.1,
//    localhost or ::1 is recorded as a network-policy violation and fails the run.
//
// The stack: build -> keygen (owner + moderator) -> tracker (open, ephemeral port) -> dev server
// (--dev, --webseed <publish out>) behind a small "gate" proxy that the tests can switch to "host
// down" or use to refuse the web seed's file bytes -> the identity origin (v0.3: tools/build-idp.mjs into the run
// directory, served by test/fixtures/idp/serve.mjs on a SECOND loopback port, so origin separation is real) ->
// publish examples/peer-guestbook (--policy open, low bits, --scope 127.0.0.1, tr/ws/xs/cs pointing at the local
// servers, idp= the identity origin) -> dev.setPointer(pointer). A visitor who posts signs in at that identity
// origin's popup "for this visit only" (signInPopup below): v0.3 writes need a sign-in (R 2.4.1).

import http from 'node:http';
import { mkdirSync, rmSync, existsSync, statSync, createReadStream, mkdtempSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import { tmpdir } from 'node:os';

import { chromiumArgs, firefoxLaunchOptions, localOnlyProxy } from './browser-args.mjs';
import { build } from '../../build.mjs';
import { keygen } from '../../tools/keygen.mjs';
import { publish } from '../../tools/publish.mjs';
import { createTracker } from '../../tools/tracker.mjs';
import { createDevServer } from '../../tools/dev-server.mjs';
import { ROOT, loadOwnerKey } from '../../tools/lib.mjs';
import { signPointer } from '../../src/common/pointer.js';
import { mimeFor } from '../../src/sw/lib.js';
import { CONSENT_ACCEPT_RE } from '../../tools/live.mjs';
import { buildIdp } from '../../tools/build-idp.mjs';
import { startIdpServer } from '../fixtures/idp/serve.mjs';
import { STRINGS as IDP_STRINGS } from '../../src/idp/strings.js';
import { MIN_PRESS_MS } from '../../src/idp/cards.js';
import { UI_TEXT } from '../../src/loader/strings.js';

export { ROOT };
export const SITE_NAME = 'peer-guestbook';
export const SITE_TITLE = 'Peer Guestbook';
export const CLIP_BYTES = 18833;
export const PLACEHOLDER_TITLES = ["This site isn't ready yet", "You're offline", 'Saved files were removed', 'Something went wrong'];

const LOCAL_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]', '::1']);

// ---------------------------------------------------------------------------------------------
// small utilities
// ---------------------------------------------------------------------------------------------

export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export class StepError extends Error {}

/** withTimeout(promise, ms, label): rejects with a StepError after ms. */
export function withTimeout(promise, ms, label) {
  let timer;
  return Promise.race([
    Promise.resolve(promise),
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new StepError(label + ': timed out after ' + ms + ' ms')), ms);
    }),
  ]).finally(() => clearTimeout(timer));
}

/** waitUntil(fn, { timeoutMs, stepMs, label }): polls fn until it returns a truthy value. */
export async function waitUntil(fn, { timeoutMs = 30000, stepMs = 200, label = 'condition' } = {}) {
  const end = Date.now() + timeoutMs;
  let last = null;
  for (;;) {
    try {
      last = await fn();
    } catch (err) {
      if (err instanceof StepError) throw err; // a definite failure, not a page that is navigating
      last = null;
    }
    if (last) return last;
    if (Date.now() > end) throw new StepError(label + ': not reached within ' + timeoutMs + ' ms');
    await sleep(stepMs);
  }
}

export function isLocalUrl(href) {
  let u;
  try {
    u = new URL(href);
  } catch (_) {
    return true; // not a URL we can classify (about:srcdoc and the like)
  }
  if (u.protocol === 'data:' || u.protocol === 'blob:' || u.protocol === 'about:' || u.protocol === 'chrome-extension:') return true;
  // v0.3 final integration: <label>.localhost (the loopback subdomain hub; Chromium answers *.localhost itself).
  return LOCAL_HOSTS.has(u.hostname) || /^[a-z0-9-]+(\.[a-z0-9-]+)*\.localhost$/.test(u.hostname);
}

// ---------------------------------------------------------------------------------------------
// the gate: a proxy in front of the dev server that can play "host down" or refuse paths
// ---------------------------------------------------------------------------------------------

export async function createGate(targetPort) {
  const sockets = new Set();
  const state = { down: false, block: null, route: null, served: 0, refused: 0, log: [] };
  const server = http.createServer((req, res) => {
    if (state.log.length < 2000) state.log.push({ t: Date.now(), method: req.method, url: req.url });
    if (state.down) {
      state.refused++;
      req.socket.destroy();
      return;
    }
    if (state.route) {
      let handled = false;
      try {
        handled = state.route(req, res) === true;
      } catch (_) {
        handled = false;
      }
      if (handled) {
        state.served++;
        return;
      }
    }
    if (state.block && state.block(req.method, req.url)) {
      state.refused++;
      res.writeHead(503, {
        'content-type': 'text/plain; charset=utf-8',
        'cache-control': 'no-store',
        'access-control-allow-origin': '*',
        'access-control-allow-headers': '*',
        'access-control-allow-methods': 'GET, HEAD, OPTIONS',
      });
      res.end('refused by the e2e gate\n');
      return;
    }
    state.served++;
    const preq = http.request({ host: '127.0.0.1', port: targetPort, method: req.method, path: req.url, headers: req.headers }, (pres) => {
      res.writeHead(pres.statusCode, pres.headers);
      pres.pipe(res);
    });
    preq.on('error', () => res.destroy());
    req.pipe(preq);
  });
  server.keepAliveTimeout = 2000;
  server.on('connection', (s) => {
    sockets.add(s);
    s.on('close', () => sockets.delete(s));
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const port = server.address().port;
  return {
    port,
    url: 'http://127.0.0.1:' + port + '/',
    state,
    setDown(on) {
      state.down = !!on;
      if (on) for (const s of sockets) s.destroy();
    },
    /** block(predicate(method, url) | null) */
    setBlock(fn) {
      state.block = fn || null;
    },
    /** route(handler(req, res) → true when it answered | null): answers some requests itself. */
    setRoute(fn) {
      state.route = fn || null;
    },
    clearLog() {
      state.log.length = 0;
    },
    close: () => new Promise((resolve) => {
      for (const s of sockets) s.destroy();
      server.close(() => resolve());
    }),
  };
}

// ---------------------------------------------------------------------------------------------
// the stack
// ---------------------------------------------------------------------------------------------

/**
 * setupStack({ log, bits }) → { runDir, origin, tracker, dev, gate, pub, owner, moderator, siteFilesPrefix, close() }
 */
export async function setupStack({ log = () => {}, bits = 4, keep = false } = {}) {
  // Integrator (R 5.3): the process id and random bytes too, so concurrent runs started in the same millisecond never share a
  // run directory (two runs once collided on owner.jwk).
  const runDir = join(ROOT, '.tools', 'e2e', 'run-' + Date.now().toString(36) + '-' + process.pid.toString(36) + '-' + Math.random().toString(36).slice(2, 8));
  mkdirSync(runDir, { recursive: true });
  const closers = [];
  const close = async () => {
    for (const fn of closers.reverse()) {
      try {
        await fn();
      } catch (_) { /* shutting down */ }
    }
    closers.length = 0;
    if (!keep) {
      try {
        rmSync(runDir, { recursive: true, force: true });
      } catch (_) { /* best effort */ }
    }
  };
  try {
    // Code review round 1 (F40): a build of its own per run, so two runs (or a run beside npm test or the
    // demo) never serve each other's half-written dist/.
    const dist = join(runDir, 'dist');
    log('building the loader into ' + dist);
    await build({ outDir: dist, quiet: true });
    if (!existsSync(join(dist, 'index.html'))) throw new Error('the build did not produce dist/index.html');

    const owner = await keygen({ out: join(runDir, 'owner.jwk') });
    const moderator = await keygen({ out: join(runDir, 'moderator.jwk') });

    const tracker = await createTracker({ port: 0, open: true, quiet: true });
    closers.push(() => tracker.close());
    // Every announce the tracker accepts: { t, event, btih, peer } (bittorrent-tracker emits one
    // event per announce, with the infohash in hex).
    tracker.announces = [];
    for (const ev of ['start', 'update', 'complete', 'stop', 'pause']) {
      tracker.server.on(ev, (_addr, params) => {
        if (tracker.announces.length > 20000) tracker.announces.splice(0, 5000);
        tracker.announces.push({ t: Date.now(), event: ev, btih: params && params.info_hash, peer: params && params.peer_id });
      });
    }
    const outDir = join(runDir, 'publish');
    const dev = await createDevServer({ root: dist, webseed: outDir, port: 0, host: '127.0.0.1', dev: true, quiet: true });
    closers.push(() => dev.close());
    const gate = await createGate(dev.port);
    closers.push(() => gate.close());
    const origin = gate.url;

    // v0.3: the identity origin, built from this checkout and served on its own loopback port.
    const idpDir = join(runDir, 'dist-idp');
    await buildIdp({ outDir: idpDir, quiet: true });
    const idp = await startIdpServer({ dir: idpDir, host: '127.0.0.1' });
    closers.push(() => idp.close());
    log('identity origin ' + idp.url);

    const pub = await publish({
      dir: join(ROOT, 'examples', 'peer-guestbook'), name: SITE_NAME, scope: '127.0.0.1', key: owner.file, out: outDir,
      policy: 'open', bits, tr: [tracker.url], ws: [origin + 'ws/'], cs: origin + 'ws/genesis.json',
      moderator: [moderator.pub], exp: 30, quiet: true, idp: idp.url,
    });
    dev.setPointer(pub.pointer);
    log('published ' + SITE_NAME + ': btih ' + pub.btih + ', ledger ' + pub.ledgerId + ', ' + pub.files.length + ' files');
    log('origin ' + origin + ', tracker ' + tracker.url);
    return {
      runDir, dist, origin, tracker, dev, gate, pub, owner, moderator, outDir, idp,
      siteFilesPrefix: '/ws/' + SITE_NAME + '/',
      close,
    };
  } catch (err) {
    await close();
    throw err;
  }
}

// ---------------------------------------------------------------------------------------------
// browsers and visitors
// ---------------------------------------------------------------------------------------------

export async function launchChromium({ headless = true } = {}) {
  const pw = await import('playwright');
  const chromium = pw.chromium || (pw.default && pw.default.chromium);
  // chromiumArgs() is the policy (docs/DEV-NETWORK.md). The loopback switch only adds 127.0.0.1 host
  // candidates, so tabs still connect on a machine (or CI runner) without a LAN interface.
  return chromium.launch({ headless, args: chromiumArgs({ allowRemote: false }).concat(['--allow-loopback-in-peer-connection']) });
}

/**
 * WebKit, for checks whose every URL is http://127.0.0.1 (docs/DEV-NETWORK.md); null when not installed.
 * Firefox lane: launched with the loopback proxy (localOnlyProxy in ./browser-args.mjs), so a non-loopback request
 * fails at a closed loopback port without a DNS query. Inside withEngine('firefox', fn) it launches Firefox instead:
 * that is how run.mjs runs the F-* variants of the WebKit scenarios without copying them.
 */
export async function launchWebkit({ headless = true } = {}) {
  if (engineStandIn === 'firefox') return launchFirefox({ headless });
  const pw = await import('playwright');
  const webkit = pw.webkit || (pw.default && pw.default.webkit);
  try {
    return await webkit.launch({ headless, proxy: localOnlyProxy() });
  } catch (_) {
    return null;
  }
}

// Permissions Playwright's Firefox does not know; firefoxUserPrefs grants them already (generated streams, no prompt).
const FIREFOX_PREF_GRANTED = new Set(['camera', 'microphone']);

/** Firefox, for the same checks as WebKit, with firefoxLaunchOptions() (docs/DEV-NETWORK.md); null when not installed. */
export async function launchFirefox({ headless = true } = {}) {
  const pw = await import('playwright');
  const firefox = pw.firefox || (pw.default && pw.default.firefox);
  // A throwaway home per browser (firefoxLaunchOptions in ./browser-args.mjs says why), removed when it closes.
  const home = mkdtempSync(join(tmpdir(), 'mw-firefox-home-'));
  let browser = null;
  try {
    browser = await firefox.launch(firefoxLaunchOptions({ headless, home }));
  } catch (err) {
    removeHome(home);
    if (process.env.MW_E2E_DEBUG) console.error('launchFirefox: ' + ((err && err.message) || err));
    return null;
  }
  browser.on('disconnected', () => removeHome(home));
  const newContext = browser.newContext.bind(browser);
  browser.newContext = (opts = {}) => newContext(Array.isArray(opts.permissions)
    ? Object.assign({}, opts, { permissions: opts.permissions.filter((p) => !FIREFOX_PREF_GRANTED.has(p)) })
    : opts);
  return browser;
}

function removeHome(home) {
  try {
    rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  } catch (_) { /* a file Firefox wrote while it closed; the system cleans its temporary folder */ }
}

let engineStandIn = null;
/** withEngine('firefox', fn): runs fn with launchWebkit() launching Firefox (the F-* scenarios of run.mjs --firefox). */
export async function withEngine(name, fn) {
  const before = engineStandIn;
  engineStandIn = name;
  try {
    return await fn();
  } finally {
    engineStandIn = before;
  }
}

// Runs in every frame before any page script: no STUN server is ever configured, so WebRTC uses
// host candidates only and never sends a packet off this machine. It also counts the peer
// connections a page creates (window.__mwE2EPc), so a test can assert that none was made.
function stripIceServers() {
  const RTC = window.RTCPeerConnection;
  if (typeof RTC !== 'function' || RTC.__mwE2E) return;
  const Wrapped = function RTCPeerConnection(config, ...rest) {
    const c = Object.assign({}, config || {});
    c.iceServers = [];
    window.__mwE2EPc = (window.__mwE2EPc || 0) + 1;
    return new RTC(c, ...rest);
  };
  Wrapped.prototype = RTC.prototype;
  Object.setPrototypeOf(Wrapped, RTC);
  Object.defineProperty(Wrapped, '__mwE2E', { value: true });
  window.RTCPeerConnection = Wrapped;
}

/**
 * A visitor: one browser context (its own profile: IndexedDB, Service Worker, identity) and its
 * pages. Collects console lines, page errors and network-policy violations.
 */
export class Visitor {
  constructor(name, context, run) {
    this.name = name;
    this.context = context;
    this.run = run;
    this.pages = [];
    this.lines = [];
    this.sockets = []; // { t, url, page }: every WebSocket a page of this visitor opened
    this.announces = []; // { t, btih, event, url }: tracker announces sent over those sockets
    this.closed = false;
  }

  /**
   * open(browser, name, run, { serviceWorkers, javaScriptEnabled, initScripts })
   * initScripts: functions (or { content }) added with context.addInitScript after the ICE wrapper.
   */
  static async open(browser, name, run, { serviceWorkers = 'allow', javaScriptEnabled = true, initScripts = [], contextOptions = {} } = {}) {
    // contextOptions (code review round 1): device emulation, e.g. { viewport, isMobile, hasTouch, deviceScaleFactor }.
    const context = await browser.newContext(Object.assign({ viewport: { width: 1100, height: 800 }, serviceWorkers, javaScriptEnabled }, contextOptions));
    const v = new Visitor(name, context, run);
    await context.addInitScript(stripIceServers);
    for (const s of initScripts) await context.addInitScript(s);
    context.on('request', (req) => {
      const url = req.url();
      if (!isLocalUrl(url)) run.violation(name + ' requested ' + url);
    });
    context.on('page', (page) => v._watch(page));
    return v;
  }

  note(line) {
    this.lines.push(new Date().toISOString().slice(11, 23) + ' ' + line);
    if (this.lines.length > 400) this.lines.splice(0, this.lines.length - 400);
  }

  _watch(page) {
    if (page.__mwWatched) return;
    page.__mwWatched = true;
    this.pages.push(page);
    page.on('console', (m) => this.note('console.' + m.type() + ': ' + m.text()));
    page.on('pageerror', (e) => this.note('pageerror: ' + ((e && e.message) || e)));
    page.on('websocket', (ws) => {
      const url = ws.url();
      if (!isLocalUrl(url)) this.run.violation(this.name + ' opened a WebSocket to ' + url);
      if (this.sockets.length < 500) this.sockets.push({ t: Date.now(), url, page });
      ws.on('framesent', (frame) => this._frame(frame, url));
    });
    page.on('close', () => {
      const i = this.pages.indexOf(page);
      if (i >= 0) this.pages.splice(i, 1);
    });
  }

  // A tracker announce sent by this visitor: { action: 'announce', info_hash: <20-byte binary string> }.
  _frame(frame, url) {
    const payload = frame && frame.payload;
    if (typeof payload !== 'string' || payload.indexOf('"announce"') < 0) return;
    let msg = null;
    try {
      msg = JSON.parse(payload);
    } catch (_) {
      return;
    }
    if (!msg || msg.action !== 'announce' || typeof msg.info_hash !== 'string') return;
    let btih = '';
    for (let i = 0; i < msg.info_hash.length; i++) btih += (msg.info_hash.charCodeAt(i) & 0xff).toString(16).padStart(2, '0');
    if (this.announces.length > 5000) this.announces.splice(0, 1000);
    this.announces.push({ t: Date.now(), btih, event: msg.event || 'update', url });
  }

  async newPage() {
    const page = await this.context.newPage();
    this._watch(page);
    return page;
  }

  async close() {
    if (this.closed) return;
    this.closed = true;
    try {
      await this.context.close();
    } catch (_) { /* already gone */ }
  }

  /** The last console/page-error lines and each page's loader log, for a failure report. */
  async report(max = 60) {
    const out = ['--- ' + this.name + ': last ' + Math.min(max, this.lines.length) + ' console lines'];
    for (const l of this.lines.slice(-max)) out.push('  ' + l);
    for (const page of this.pages) {
      let info = null;
      try {
        info = await withTimeout(page.evaluate(() => (window.__mwShell ? window.__mwShell.inspect() : (window.__mwDropin && window.__mwDropin.inspect ? Object.assign({ dropin: true }, window.__mwDropin.inspect()) : null))), 3000, 'inspect');
        if (info && info.dropin && info.logs) {
          info.log = info.logs;
          delete info.logs;
        }
      } catch (_) {
        info = null;
      }
      out.push('--- ' + this.name + ' page ' + page.url());
      if (info) {
        const { log, ...rest } = info;
        out.push('  state ' + JSON.stringify(rest));
        for (const l of (log || []).slice(-40)) out.push('  log ' + l);
      } else {
        out.push('  (no loader state)');
      }
      try {
        const frame = siteFrame(page);
        if (frame) out.push('  frame ' + frame.url() + ' title=' + JSON.stringify(await withTimeout(frame.title(), 2000, 'title')));
      } catch (_) { /* detached */ }
    }
    for (const w of this.context.serviceWorkers()) {
      try {
        const st = await withTimeout(w.evaluate(() => (self.mw && self.mw.inspect ? self.mw.inspect() : null)), 3000, 'sw inspect');
        if (st) delete st.precache;
        out.push('--- ' + this.name + ' service worker ' + w.url() + ' ' + JSON.stringify(st));
      } catch (_) { /* stopped */ }
    }
    return out.join('\n');
  }
}

/**
 * Stops every Service Worker of the visitor's browser (Chromium DevTools protocol), like the
 * browser does with an idle worker: its in-memory state (verified pieces, indexes) is gone and the
 * next request starts a fresh instance.
 */
export async function stopServiceWorkers(visitor, page) {
  const cdp = await visitor.context.newCDPSession(page);
  try {
    await cdp.send('ServiceWorker.enable');
    await cdp.send('ServiceWorker.stopAllWorkers');
  } finally {
    await cdp.detach().catch(() => {});
  }
}

/** The site iframe of a shell page (the first child frame), or null. */
export function siteFrame(page) {
  const main = page.mainFrame();
  return page.frames().find((f) => f.parentFrame() === main) || null;
}

/**
 * clickShellButton(page, re, { scope, timeoutMs, label }) → true: clicks the visible shell button whose
 * whole text matches re with the mouse (Playwright: a trusted click). Since v0.2.1 (A4) the loader's
 * consent and identity buttons ignore clicks a script makes (event.isTrusted === false), so the tests
 * click the way a visitor does. scope: the CSS selector of the buttons to consider.
 */
export async function clickShellButton(page, re, { scope = 'button', timeoutMs = 15000, label = 'button ' + re } = {}) {
  const button = page.locator(scope).filter({ hasText: re }).filter({ visible: true }).first();
  return waitUntil(async () => {
    if ((await button.count()) === 0) return false;
    await button.click({ timeout: 2000 });
    return true;
  }, { timeoutMs, label });
}

/** Clicks the first-run card's "Share and load" (v0.2.1 C1; or the gate's Load) when it is shown. → true when clicked. */
export async function acceptConsent(page, { timeoutMs = 15000 } = {}) {
  return clickShellButton(page, CONSENT_ACCEPT_RE, { scope: '.mw-notice button, .mw-gate button', timeoutMs, label: 'consent notice' });
}

/** The loader's state (window.__mwShell.inspect()), or null. */
export async function shellState(page) {
  try {
    return await withTimeout(page.evaluate(() => (window.__mwShell ? window.__mwShell.inspect() : null)), 5000, 'inspect');
  } catch (_) {
    return null;
  }
}

/**
 * waitForSite(page, { timeoutMs }) → { ms, frameTitle, h1 }: the site frame shows the example
 * (h1 "Peer Guestbook" and a complete document). Fails at once when the loader shows an error
 * card or boot stopped; records Service Worker placeholder pages it saw on the way.
 */
export async function waitForSite(page, { timeoutMs = 30000, since = Date.now(), label = 'site rendered', h1 = /^Peer Guestbook/ } = {}) {
  const seen = new Set();
  const res = await waitUntil(async () => {
    const s = await page.evaluate(() => {
      const boot = window.__mwBoot || null;
      const errBox = document.querySelector('.mw-boot-error');
      const errCard = document.querySelector('.mw-error:not([hidden])');
      const f = document.querySelector('#mw-site iframe');
      let doc = null;
      try {
        doc = f && f.contentDocument;
      } catch (_) {
        doc = null;
      }
      const h1 = doc && doc.querySelector('h1');
      return {
        stage: boot && boot.stage,
        bootError: errBox ? errBox.textContent.replace(/\s+/g, ' ').trim() : null,
        errorCard: errCard ? errCard.textContent.replace(/\s+/g, ' ').trim() : null,
        frameTitle: doc ? doc.title : null,
        ready: doc ? doc.readyState : null,
        h1: h1 ? h1.textContent.replace(/\s+/g, ' ').trim() : null,
      };
    });
    if (s.bootError) throw new StepError('boot stopped: ' + s.bootError);
    if (s.errorCard) throw new StepError('the loader shows an error: ' + s.errorCard.slice(0, 300));
    if (s.frameTitle && PLACEHOLDER_TITLES.indexOf(s.frameTitle) >= 0) seen.add(s.frameTitle);
    if (s.h1 && h1.test(s.h1) && s.ready === 'complete') return s;
    return null;
  }, { timeoutMs, stepMs: 100, label: label + (seen.size ? ' (the frame showed: ' + Array.from(seen).join(', ') + ')' : '') }).catch((err) => {
    if (seen.size && err instanceof StepError && !/frame showed/.test(err.message)) err.message += ' (the frame showed: ' + Array.from(seen).join(', ') + ')';
    throw err;
  });
  return Object.assign({ ms: Date.now() - since, placeholders: Array.from(seen) }, res);
}

/** Runs fn inside the site frame (a same-origin child of the shell). */
export async function inFrame(page, fn, arg) {
  const frame = siteFrame(page);
  if (!frame) throw new StepError('no site frame');
  return frame.evaluate(fn, arg);
}

/** mw.site.info() from inside the site frame (through the SDK and the Bridge). */
export async function siteInfo(page) {
  return inFrame(page, async () => {
    const mod = await import('/_mw/sdk.js');
    const mw = mod.default;
    return mw.site.info();
  });
}

/** The guestbook entries the example page shows: [{ h, author, msg }] newest first. */
export async function guestbookEntries(page) {
  return inFrame(page, () => Array.from(document.querySelectorAll('#entries li')).map((li) => ({
    h: li.getAttribute('data-h'),
    author: li.getAttribute('data-author'),
    msg: (li.querySelector('.msg') || {}).textContent || '',
  })));
}

/**
 * Posts a guestbook message through the example's form; resolves when the page says it posted. v0.3: a guest's post
 * signs in first (the example calls mw.auth.signIn() inside the click; a site that writes as a guest gets the
 * loader's Sign in card instead, R 2.4.1): either way the identity origin's popup opens and signInPopup answers it.
 */
export async function postMessage(page, text, { timeoutMs = 30000 } = {}) {
  const frame = siteFrame(page);
  if (!frame) throw new StepError('no site frame');
  await frame.waitForSelector('#post-form fieldset:not([disabled]) #msg', { timeout: timeoutMs });
  const toasts = () => frame.evaluate(() => Array.from(document.querySelectorAll('#toasts .toast')).map((n) => ({ text: n.textContent, kind: n.className })));
  const seen = (await toasts()).length;
  const popups = [];
  const onPopup = (p) => popups.push(p);
  page.context().on('page', onPopup);
  try {
    await frame.fill('#msg', text);
    await frame.click('#post-btn');
    let answered = false;
    // Only toasts that appear after the click count; the page shows "Posted. ..." or an error toast.
    await waitUntil(async () => {
      const fresh = (await toasts()).slice(seen);
      const err = fresh.find((t) => /\berror\b/.test(t.kind));
      if (err) throw new StepError('posting failed: ' + err.text);
      if (fresh.some((t) => /^Posted\./.test(t.text))) return true;
      if (!answered && !popups.length && await clickLoaderCard(page, 'Sign in')) return false;
      if (!answered && popups.length) {
        answered = true;
        await signInPopup(popups[0], { timeoutMs });
      }
      return false;
    }, { timeoutMs: timeoutMs * 2, label: 'post "' + text + '"' });
  } finally {
    page.context().off('page', onPopup);
  }
}

/** Clicks a button of the open loader card (closed shadow root) with a real mouse event. -> true when clicked. */
export async function clickLoaderCard(page, label) {
  const rect = await page.evaluate((l) => (window.__mwShell && typeof window.__mwShell.rectOf === 'function' ? window.__mwShell.rectOf(l) : null), label).catch(() => null);
  if (!rect || !(rect.width > 0) || !(rect.height > 0)) return false;
  await sleep(300); // the card ignores clicks in its first 250 ms (ui.js)
  await page.mouse.click(rect.x + rect.width / 2, rect.y + rect.height / 2);
  return true;
}

/**
 * dismissKitCard(page) -> true when the loader's "Save your recovery kit" card was on screen and "Later" was pressed. Code review
 * v0.3 (round 2): the loader offers that card once per page after the first meaningful action (a post, a message, an upload: R 2.2.6),
 * and every later loader card waits behind it, so a step that waits for another card answers it first.
 */
export async function dismissKitCard(page) {
  const rect = (l) => page.evaluate((x) => (window.__mwShell && typeof window.__mwShell.rectOf === 'function' ? window.__mwShell.rectOf(x) : null), l).catch(() => null);
  const kit = await rect(UI_TEXT.en.kitButton);
  if (!kit || !(kit.width > 0)) return false;
  return clickLoaderCard(page, UI_TEXT.en.later);
}

const exactText = (label) => new RegExp('^' + String(label).replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '$');

/**
 * signInPopup(popup) -> true: the identity origin's sign-in popup (src/idp/idp.js) for a visitor with no identity
 * yet: "Create my identity", then "For this visit only" (no passkey, nothing kept at the identity origin; the site
 * gets working keys in memory). Each button ignores presses in its first MIN_PRESS_MS (cards.js), so it is clicked
 * again until its card goes away. Resolves when the popup closed itself with the answer.
 */
export async function signInPopup(popup, { timeoutMs = 30000 } = {}) {
  const closed = new Promise((resolve) => popup.once('close', () => resolve(true)));
  await popup.waitForLoadState('domcontentloaded', { timeout: timeoutMs }).catch(() => {});
  for (const label of [IDP_STRINGS.en.continueNew, IDP_STRINGS.en.unlockVisit]) {
    const button = popup.locator('main.mw-idp button').filter({ hasText: exactText(label) });
    await waitUntil(async () => {
      if (popup.isClosed()) return true;
      if ((await button.count().catch(() => 0)) === 0) return false;
      await sleep(MIN_PRESS_MS + 100);
      await button.first().click({ timeout: 2000 }).catch(() => {});
      await sleep(150);
      return popup.isClosed() || (await button.count().catch(() => 0)) === 0;
    }, { timeoutMs, label: 'identity origin: ' + label });
  }
  await withTimeout(closed, timeoutMs, 'the identity popup closes with the answer');
  return true;
}

// ---------------------------------------------------------------------------------------------
// helpers for scenarios 8 to 14 (integration-2)
// ---------------------------------------------------------------------------------------------

/**
 * hubPointer(stack) → record text: the published site's pointer signed again for the hub-by-magnet
 * scope "btih:<hex>" (ARCHITECTURE section 4). publish.mjs signs hostnames only; a hub link carries
 * a record signed for its btih, so its tracker list stays the signed local one.
 */
export async function hubPointer(stack, { seq = null } = {}) {
  const identity = await loadOwnerKey(stack.owner.file);
  const rec = stack.pub.record;
  const base = Object.assign({}, rec, { seq: seq === null ? Number(rec.seq) : seq, sig: null });
  const signed = await signPointer(base, 'btih:' + rec.btih, identity.privateKey);
  return signed.raw;
}

/**
 * staticRoute(dir, { pass }) → a gate route that answers GET/HEAD from the files under dir (a plain
 * static host: index.html for directories, 404 otherwise) and leaves the paths for which
 * pass(pathname) is true to the dev server behind the gate.
 */
export function staticRoute(dir, { pass = () => false } = {}) {
  const root = resolve(dir);
  return (req, res) => {
    let pathname;
    try {
      pathname = decodeURIComponent(new URL(req.url, 'http://gate.invalid').pathname);
    } catch (_) {
      return false;
    }
    if (pass(pathname)) return false;
    if (req.method !== 'GET' && req.method !== 'HEAD') return false;
    let file = resolve(root, '.' + pathname);
    if (file !== root && !file.startsWith(root + sep)) return false;
    try {
      if (statSync(file).isDirectory()) file = join(file, 'index.html');
    } catch (_) { /* not found below */ }
    let size = -1;
    try {
      const st = statSync(file);
      if (st.isFile()) size = st.size;
    } catch (_) {
      size = -1;
    }
    if (size < 0) {
      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-cache', 'x-e2e-plain-host': '1' });
      res.end(req.method === 'HEAD' ? undefined : 'Not found\n');
      return true;
    }
    res.writeHead(200, { 'content-type': mimeFor(file), 'content-length': String(size), 'cache-control': 'no-cache', 'x-e2e-plain-host': '1' });
    if (req.method === 'HEAD') res.end();
    else createReadStream(file).pipe(res);
    return true;
  };
}

/** gateState(page) → { visible, title, text, buttons: [label], details: { term: value } } of the shell gate. */
export async function gateState(page) {
  return page.evaluate(() => {
    const box = document.querySelector('.mw-gate');
    if (!box || box.hidden || box.offsetParent === null) return { visible: false };
    const details = {};
    const terms = box.querySelectorAll('dl dt');
    for (const dt of Array.from(terms)) {
      const dd = dt.nextElementSibling;
      details[(dt.textContent || '').trim()] = dd ? (dd.textContent || '').trim() : '';
    }
    return {
      visible: true,
      title: ((box.querySelector('h2') || {}).textContent || '').trim(),
      text: (box.textContent || '').replace(/\s+/g, ' ').trim(),
      buttons: Array.from(box.querySelectorAll('button')).map((b) => (b.textContent || '').trim()),
      details,
    };
  });
}

/** Clicks (with the mouse: a trusted click, v0.2.1 A4) the visible shell-gate button whose label matches re. → true when clicked. */
export async function clickGateButton(page, re) {
  const button = page.locator('.mw-gate button').filter({ hasText: re }).filter({ visible: true }).first();
  if ((await button.count()) === 0) return false;
  await button.click({ timeout: 5000 });
  return true;
}

/** storedSites(page) → the btih keys of IndexedDB mw-sites.sites on the page's origin. */
export async function storedSites(page) {
  return page.evaluate(async () => {
    const names = indexedDB.databases ? (await indexedDB.databases()).map((d) => d.name) : ['mw-sites'];
    if (names.indexOf('mw-sites') < 0) return [];
    const db = await new Promise((res, rej) => { const r = indexedDB.open('mw-sites'); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
    try {
      if (!db.objectStoreNames.contains('sites')) return [];
      return await new Promise((res, rej) => {
        const tx = db.transaction('sites', 'readonly');
        const q = tx.objectStore('sites').getAllKeys();
        q.onsuccess = () => res(q.result.map(String).sort());
        q.onerror = () => rej(q.error);
      });
    } finally {
      db.close();
    }
  });
}

/** Deletes the four native Uint8Array base64/hex methods and AbortSignal.timeout before any script. */
export function deleteNativeEncodings() {
  try { delete Uint8Array.prototype.toHex; } catch (_) { /* ignore */ }
  try { delete Uint8Array.prototype.toBase64; } catch (_) { /* ignore */ }
  try { delete Uint8Array.fromHex; } catch (_) { /* ignore */ }
  try { delete Uint8Array.fromBase64; } catch (_) { /* ignore */ }
  try { delete Uint8Array.prototype.setFromHex; } catch (_) { /* ignore */ }
  try { delete Uint8Array.prototype.setFromBase64; } catch (_) { /* ignore */ }
  try { if (typeof AbortSignal === 'function') delete AbortSignal.timeout; } catch (_) { /* ignore */ }
  window.__mwE2ENativeDeleted = {
    toHex: typeof Uint8Array.prototype.toHex,
    toBase64: typeof Uint8Array.prototype.toBase64,
    fromHex: typeof Uint8Array.fromHex,
    fromBase64: typeof Uint8Array.fromBase64,
    timeout: typeof AbortSignal === 'function' ? typeof AbortSignal.timeout : 'n/a',
  };
}
