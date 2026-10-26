// tools/live.mjs: drive the real loader in Playwright Chromium (used by pin.mjs, snapshot.mjs,
// check-site.mjs --headless and demo.mjs). Playwright is imported lazily, so the other tools work
// without browsers. Every launch passes chromiumArgs() from test/e2e/browser-args.mjs
// (docs/DEV-NETWORK.md): local-only by default, { allowRemote: true } for the tools that are
// allowed to reach the internet (pin, check-site, snapshot <url>).
//
// Code review v0.3 (security lens, finding 16): a browser that may reach the internet renders pages and
// processes blocks, pieces and frames from any peer, so it runs with Chromium's sandbox
// (chromiumSandbox: true; Playwright's default passes --no-sandbox) and with WebRTC's mDNS
// host-candidate hiding left on (the local-only flags turn it off so two tabs on one machine can
// connect; a remote-capable run would otherwise put its private addresses in every ICE host
// candidate). MW_CHROMIUM_NO_SANDBOX=1 drops the sandbox for a host that cannot provide one (a
// container without user namespaces); the tool then says so on every launch.
//
// Nothing here is part of the unit tests: a browser is needed.

import { chromiumArgs } from '../test/e2e/browser-args.mjs';
import { STRINGS } from '../src/loader/strings.js';
import { ToolError, isLoopbackUrl } from './lib.mjs';

/**
 * allowRemoteFor(url) → boolean: whether a tool's browser for this page may reach the internet. A
 * loopback page always gets the local-only browser (code review round 1, docs/DEV-NETWORK.md: with
 * consent the shell's STUN probe and any public tracker would otherwise be contacted).
 */
export function allowRemoteFor(url) {
  return !isLoopbackUrl(url);
}

/** The Playwright chromium launcher, or a ToolError that says how to get it. */
export async function loadChromium() {
  try {
    const pw = await import('playwright');
    const chromium = pw.chromium || (pw.default && pw.default.chromium);
    if (!chromium) throw new Error('playwright has no chromium export');
    return chromium;
  } catch (err) {
    throw new ToolError('Playwright Chromium is not available (' + ((err && err.message) || err) + '). Run: npm ci && npx playwright install chromium');
  }
}

const MDNS_FEATURE = 'WebRtcHideLocalIpsWithMdns';

/**
 * launchOptions({ allowRemote, env }) → { args, chromiumSandbox, warning }: what launchBrowser passes to Playwright (see the
 * header). Local-only runs keep chromiumArgs() as they are (no sandbox: tests also run in CI containers); a remote-capable run
 * gets the sandbox and keeps mDNS candidate hiding on, unless env.MW_CHROMIUM_NO_SANDBOX is '1' (then `warning` says so).
 */
export function launchOptions({ allowRemote = false, env = process.env } = {}) {
  let args = chromiumArgs({ allowRemote });
  if (!allowRemote) return { args, chromiumSandbox: false, warning: null };
  args = args.map((a) => {
    if (!a.startsWith('--disable-features=')) return a;
    const kept = a.slice('--disable-features='.length).split(',').filter((f) => f && f !== MDNS_FEATURE);
    return kept.length ? '--disable-features=' + kept.join(',') : null;
  }).filter(Boolean);
  const off = env && env.MW_CHROMIUM_NO_SANDBOX === '1';
  return {
    args,
    chromiumSandbox: !off,
    warning: off ? 'MW_CHROMIUM_NO_SANDBOX=1: this browser reaches the internet WITHOUT the Chromium sandbox; a renderer bug in a page or a peer\'s data would run with this user\'s rights' : null,
  };
}

/**
 * launchBrowser({ headless, profileDir, allowRemote, ignoreHTTPSErrors, chromium, warn }) → { context, close() }
 * With profileDir the profile (IndexedDB, consent, identity) persists between runs. chromium: a Playwright launcher (tests);
 * warn(line): where the no-sandbox warning goes (default stderr).
 */
export async function launchBrowser({
  headless = true, profileDir = null, allowRemote = false, ignoreHTTPSErrors = false, viewport = { width: 1100, height: 800 }, chromium = null,
  warn = (line) => process.stderr.write(line + '\n'),
} = {}) {
  const launcher = chromium || (await loadChromium());
  const opts = launchOptions({ allowRemote });
  const { args, chromiumSandbox } = opts;
  if (opts.warning && typeof warn === 'function') warn(opts.warning);
  if (profileDir) {
    const context = await launcher.launchPersistentContext(profileDir, { headless, args, ignoreHTTPSErrors, viewport, chromiumSandbox });
    return { context, browser: context.browser(), close: () => context.close() };
  }
  const browser = await launcher.launch({ headless, args, chromiumSandbox });
  const context = await browser.newContext({ ignoreHTTPSErrors, viewport });
  return { context, browser, close: () => browser.close() };
}

/**
 * The labels of the buttons that give consent: "Share and load" on the v0.2.1 first-run card (C1), "Load" on
 * the gate, "OK" on the v0.2 notice. "Load from host only" is never among them.
 */
export const CONSENT_ACCEPT_LABELS = Object.freeze([STRINGS.consentShare, STRINGS.gateLoad, STRINGS.noticeOk]);
export const CONSENT_ACCEPT_RE = new RegExp('^(' + CONSENT_ACCEPT_LABELS.map((l) => l.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|') + ')$');

// Drop-in pages: the card lives in a closed shadow root that locators cannot reach; the public handle
// window.__mwDropin.rectOf(label) gives the button's rectangle (code review round 1).
function dropinButtonRect(labels) {
  const h = window.__mwDropin;
  if (!h || typeof h.rectOf !== 'function') return null;
  for (const label of labels) {
    const r = h.rectOf(label);
    if (r && r.width > 0 && r.height > 0) return r;
  }
  return null;
}

function dropinConsent() {
  const h = window.__mwDropin;
  try {
    return h && typeof h.inspect === 'function' ? h.inspect().consent : null;
  } catch (_) {
    return null;
  }
}

/**
 * Clicks the consent button when it is on screen. → boolean. A real mouse click through Playwright: since
 * v0.2.1 (A4) the loader ignores clicks a script makes (event.isTrusted === false), so el.click() inside
 * the page would do nothing. Shell pages: the card or gate in the light DOM. Drop-in pages: the card in
 * its closed shadow root, clicked at the centre of the rectangle __mwDropin.rectOf() reports; true only
 * once inspect().consent says 'accepted'.
 */
export async function acceptConsent(page, { timeoutMs = 20000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  const button = page.locator('.mw-notice button, .mw-gate button').filter({ hasText: CONSENT_ACCEPT_RE }).filter({ visible: true }).first();
  while (Date.now() < deadline) {
    try {
      if ((await button.count()) > 0) {
        await button.click({ timeout: 2000 });
        return true;
      }
      const rect = await page.evaluate(dropinButtonRect, CONSENT_ACCEPT_LABELS);
      if (rect) {
        await page.mouse.click(rect.x + rect.width / 2, rect.y + rect.height / 2);
        for (let i = 0; i < 10; i++) {
          if ((await page.evaluate(dropinConsent)) === 'accepted') return true;
          await new Promise((r) => setTimeout(r, 200));
        }
      } else if ((await page.evaluate(dropinConsent)) === 'accepted') {
        return true; // a stored choice: nothing to click
      }
    } catch (_) { /* the page navigated or re-rendered the card: look again */ }
    await new Promise((r) => setTimeout(r, 500));
  }
  return false;
}

// Runs inside the page. Returns plain data only.
function pageProbe() {
  const text = (sel) => {
    const el = document.querySelector(sel);
    return el ? String(el.textContent || '').replace(/\s+/g, ' ').trim() : null;
  };
  const boot = window.__mwBoot || null;
  const frame = document.querySelector('#mw-site iframe');
  let frameReady = false;
  let frameTitle = null;
  let frameChildren = 0;
  try {
    const doc = frame && frame.contentDocument;
    if (doc) {
      frameReady = doc.readyState === 'complete' && Boolean(doc.body) && doc.body.childElementCount > 0;
      frameTitle = doc.title || null;
      frameChildren = doc.body ? doc.body.childElementCount : 0;
    }
  } catch (_) { /* cross-origin frame: not ready */ }
  const err = document.querySelector('.mw-boot-error, .mw-error-card, .mw-error');
  return {
    bootStage: boot ? boot.stage : null,
    bootOk: boot ? boot.ok : null,
    degraded: boot ? boot.degraded : null,
    error: err ? String(err.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 400) : null,
    status: text('.mw-status'),
    peers: text('.mw-peers'),
    source: text('.mw-source'),
    ledger: text('.mw-ledger'),
    pointer: text('.mw-pointer'),
    identity: text('.mw-identity'),
    hasFrame: Boolean(frame),
    frameReady,
    frameTitle,
    frameChildren,
    hasMw: typeof window.mw === 'object' && window.mw !== null,
    readyState: document.readyState,
    title: document.title,
    url: location.href,
  };
}

/** readLoaderStatus(page) → what the status bar says right now (see pageProbe). */
export async function readLoaderStatus(page) {
  return page.evaluate(pageProbe);
}

/** One line for a log: "peers 3 | Ledger: 12 entries, in sync with 3 peers | source: ..." */
export function formatStatus(s) {
  if (!s) return 'no page';
  const bits = [];
  if (s.error) bits.push('ERROR ' + s.error);
  if (s.status) bits.push(s.status);
  if (s.peers) bits.push(s.peers);
  if (s.ledger) bits.push(s.ledger);
  if (s.source) bits.push(s.source);
  if (s.pointer) bits.push(s.pointer);
  if (!bits.length) bits.push(s.hasFrame ? (s.frameReady ? 'site rendered' : 'loading') : 'loading');
  return bits.join(' | ');
}

/**
 * The titles of the placeholder pages the Service Worker answers a navigation with when it cannot
 * serve the site yet (src/sw/core.js PAGES): a frame that shows one has not rendered the site.
 */
export const PLACEHOLDER_TITLES = Object.freeze([
  "This site isn't ready yet", "You're offline", 'Saved files were removed', 'Something went wrong',
]);

/**
 * waitForSiteRendered(page, { timeoutMs }) → { ok, detail, status }
 * Shell mode: the site frame is loaded and shows the site (not one of the Service Worker's placeholder pages). Drop-in or plain pages: the page has loaded
 * and, when /_mw/mw.js is present, window.mw resolves ready(). A boot error card fails at once.
 */
export async function waitForSiteRendered(page, { timeoutMs = 45000, signal = null } = {}) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < deadline) {
    if (signal && signal.aborted) return { ok: false, detail: 'aborted', status: last };
    last = await readLoaderStatus(page).catch(() => null);
    if (last) {
      if (last.bootStage === 'stopped' || (last.error && /could not|cannot|must|requires|failed/i.test(last.error))) {
        return { ok: false, detail: 'the loader stopped: ' + (last.error || last.status || last.bootStage), status: last };
      }
      if (last.hasFrame && last.frameReady && PLACEHOLDER_TITLES.indexOf(last.frameTitle) < 0) {
        return { ok: true, detail: 'the site frame rendered' + (last.frameTitle ? ' ("' + last.frameTitle + '")' : ''), status: last };
      }
      if (!last.hasFrame && last.readyState === 'complete' && last.bootStage === null) {
        if (!last.hasMw) return { ok: true, detail: 'the page loaded (no felinar runtime on it)', status: last };
        const ready = await page.evaluate(() => Promise.race([
          window.mw.ready().then(() => true, () => false),
          new Promise((r) => setTimeout(() => r(false), 4000)),
        ])).catch(() => false);
        if (ready) return { ok: true, detail: 'the page loaded and mw.ready() resolved', status: last };
      }
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  const placeholder = last && last.hasFrame && PLACEHOLDER_TITLES.indexOf(last.frameTitle) >= 0 ? ' (the frame still shows "' + last.frameTitle + '")' : '';
  return { ok: false, detail: 'timed out after ' + timeoutMs + ' ms' + placeholder + '; last state: ' + formatStatus(last), status: last };
}

/**
 * readLedgerBlocks(page) → [{ database, blocks: [Block] }]: every site-ledger database of the page's
 * origin (IndexedDB "mw-chain-<ledger id>", object store "blocks"), read in the page.
 */
/**
 * readLedgerBlocks(page) → [{ database, blocks, checkpoint }]: every mw-chain-* database of the page's origin, its stored blocks
 * and, when the copy pruned to a checkpoint (code review v0.3: every copy does), the stored checkpoint row { h, snap, S, depths }
 * that stands for the covered blocks (null otherwise). buildSnapshot({ blocks, checkpoint }) writes both.
 */
export async function readLedgerBlocks(page) {
  return page.evaluate(async () => {
    if (!indexedDB.databases) return [];
    const dbs = (await indexedDB.databases()).map((d) => d.name).filter((n) => typeof n === 'string' && n.indexOf('mw-chain-') === 0);
    const out = [];
    for (const name of dbs) {
      const found = await new Promise((resolve, reject) => {
        const req = indexedDB.open(name);
        req.onerror = () => reject(req.error);
        req.onsuccess = () => {
          const db = req.result;
          if (!db.objectStoreNames.contains('blocks')) {
            db.close();
            resolve({ blocks: [], checkpoint: null });
            return;
          }
          const stores = db.objectStoreNames.contains('meta') ? ['blocks', 'meta'] : ['blocks'];
          const tx = db.transaction(stores, 'readonly');
          const all = tx.objectStore('blocks').getAll();
          const cp = stores.length > 1 ? tx.objectStore('meta').get('checkpoint') : null;
          tx.oncomplete = () => {
            db.close();
            const row = cp ? cp.result : null;
            resolve({ blocks: all.result || [], checkpoint: row && typeof row === 'object' && row.S ? row : null });
          };
          tx.onerror = () => {
            db.close();
            reject(tx.error);
          };
        };
      });
      out.push({ database: name, blocks: found.blocks, checkpoint: found.checkpoint });
    }
    return out;
  });
}

/**
 * pickLedgerDatabase(found, dbName) → { database, blocks } | null: the ledger database of a page
 * (from readLedgerBlocks), the one named dbName if given, else the only one. Throws a ToolError when
 * several are there and none is named.
 */
export function pickLedgerDatabase(found, dbName = null) {
  const list = Array.isArray(found) ? found : [];
  if (dbName) return list.find((d) => d.database === dbName) || null;
  if (list.length === 0) return null;
  if (list.length > 1) throw new ToolError('the origin holds several ledgers (' + list.map((d) => d.database).join(', ') + ') and the pointer does not say which');
  return list[0];
}

/**
 * renderWithRecovery(page, { consent, signal, log, tries = 2, timeoutMs = 30000 }) → the last waitForSiteRendered result
 * A first visit can be answered with the Service Worker's "not ready" page before the copy is complete;
 * a reload picks the finished copy up. This waits, reloads up to `tries` times, and reports what it saw.
 */
export async function renderWithRecovery(page, { consent = false, signal = null, log = () => {}, tries = 2, timeoutMs = 30000 } = {}) {
  let rendered = await waitForSiteRendered(page, { timeoutMs, signal });
  for (let i = 0; i < tries && !rendered.ok && !(signal && signal.aborted); i++) {
    log('render: not yet (' + rendered.detail + '); reloading the page');
    await page.reload({ waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {});
    if (consent) await acceptConsent(page, { timeoutMs: 8000 });
    rendered = await waitForSiteRendered(page, { timeoutMs, signal });
  }
  return rendered;
}
