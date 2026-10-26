#!/usr/bin/env node
// test/e2e/run.mjs: end-to-end scenarios of ARCHITECTURE section 12 (1 to 10 and 12 to 14), in
// Playwright Chromium (the playwright library, not @playwright/test), plus Playwright WebKit for the
// parts marked WebKit. Everything runs on 127.0.0.1 (docs/DEV-NETWORK.md): see test/e2e/lib.mjs for
// the stack, the local-only launch flags and the network-policy guard. WebKit only ever loads
// http://127.0.0.1 URLs with consent pending (no tracker, no WebRTC).
//
//   node test/e2e/run.mjs [--headed] [--keep] [--only 1,2,7] [--webkit] [--firefox]
//
// --firefox adds the Firefox lane (test/e2e/scenarios-firefox.mjs): F7, F-SI, F-MD, E-CL-1F and DOOR-GUEST-F (the
// --webkit scenarios in Playwright Firefox) and F:<id> (Chromium scenarios in a Firefox context). Firefox launches with
// the loopback proxy and prefs of test/e2e/browser-args.mjs (docs/DEV-NETWORK.md). An id in FIREFOX_HELD (none since the
// R 5.3 integrator; docs/deviations/firefox.md) is left out of --firefox and runs only when --only names it.
//
// --webkit adds W7: scenario 7's cold start in Playwright WebKit (consent pending, so the page uses
// HTTP to 127.0.0.1 only: no tracker, no WebRTC). It settles DESIGN-REVIEW section 6's open question
// "first-visit iframe control in WebKit" for this engine build.
//
// Scenario 11 (a peer declaring an oversized message) runs as PEER-11 (v0.2.1 B5): a hostile page writes a
// 0x7FFFFFFF length prefix (MALICIOUS_MESSAGE_LENGTH in ./peer-scenarios.mjs; 0xFFFFFFFF would be read as
// a keep-alive by the stock parser) onto a real WebRTC wire. The v0.2.1 network scenarios PEER-* live in
// ./peer-scenarios.mjs (network agent).
//
// Run order 7, 1, 2, 3, 4, 5, 6, 8, 14, 12, 10, 9, (W7,) 13: the cold start needs a swarm nobody has
// joined yet; 2 to 6 build on the visitors 1 and 2 leave open; 8 and later are self-contained (each
// opens its own visitors, 12 and 13 close everyone first); 13 publishes a new version, so it is last.
//
// Scenarios:
//   1 shell renders the example from a seeder tab (heading, CSS, image, fetch, MP4 range)
//   2 a second visitor appends a guestbook entry; the first sees it within 10 s with an equal root
//   3 seeder closed, reload renders from cache; a third visitor downloads from the second alone;
//     a flipped byte in IndexedDB leads to deleteSite and a fresh download
//   4 a moderator tombstone from a browser that never held owner.jwk hides the entry in all tabs
//   5 an offline reload (host down, browser offline) renders the shell and the site
//   6 per-domain simulation with a page-tag pointer, signed and unsigned, and no DoH
//   7 cold start with no seeder through xs + ws within 3 s, source 'webseed'
//   8 hub gate: a shared-origin hub link opens no WebSocket and no RTCPeerConnection before the click
//   9 kill switch: shell (plain host + self-unregistering worker) and drop-in, no reload loop
//  10 drop-in fixture (examples/existing-site-dropin/EXPECTED.md): JS-off parity, second view from
//     IndexedDB, a redeploy without version mixing, location.pathname, a foreign worker untouched,
//     the integrated foreign worker
//  12 uploads off: peer download, web-seed download and two-way gossip complete; the choke lock holds
//  13 publish seq + 1: update found, the old version stops seeding, is deleted and never announced
//  14 WebKit and Chromium complete a download with the polyfills (native methods deleted); a context
//     with serviceWorkers: 'block' renders styled in limited mode with mw.ready() resolving
// v0.3 (test/e2e/scenarios-v03.mjs, V03-DESIGN-REVIEW Part 4.2, wave 1 lanes): E-SI-1 to E-SI-5 (server sign-in,
// identity origin stand-in), E-CH-6M (media gates), E-MD-1, E-MD-2, E-MD-10, E-MD-7, E-MD-8, E-MD-9 (private media
// through the worker route), E-FI-3 (file downloads); with --webkit also W-SI and W-MD.
// v0.3 reconciliation: every post (2, 4, 12, PEER-RV) signs in first at a real identity origin (tools/build-idp.mjs, served on a
// second loopback port and named by the pointer's idp=; test/e2e/lib.mjs postMessage and signInPopup), scenario 2's follower tab
// posts through its engine tab's sign-in (R 2.4.1) and scenario 4 confirms the loader's MF-27 card.
// v0.3 C2 (integrator): E-CL-3, E-CL-1, E-CL-2 (calls, test/e2e/scenarios-calls.mjs; --webkit adds E-CL-1W), E-PS-1 to E-PS-4 and
// E-ZS-1 (seeding and zero-setup, test/e2e/scenarios-c2.mjs), DOOR-DOWN, DOOR-HASH, DOOR-GUEST (doors, test/e2e/scenarios-doors.mjs;
// --webkit adds DOOR-GUEST-W).
// Each step has its own timeout (at most 60 s) and the whole run a watchdog. Output: one PASS or
// FAIL line per scenario; on failure the console, page errors and loader log of every open visitor.
// Exit code 0 only when every selected scenario passed and no request left 127.0.0.1.

import { readFileSync, copyFileSync, cpSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import http from 'node:http';

import {
  setupStack, launchChromium, launchWebkit, Visitor, acceptConsent, waitForSite, siteInfo, inFrame, guestbookEntries,
  postMessage, shellState, withTimeout, waitUntil, StepError, siteFrame, stopServiceWorkers, SITE_NAME, CLIP_BYTES,
  sleep, hubPointer, gateState, clickGateButton, staticRoute, storedSites, deleteNativeEncodings, ROOT, clickLoaderCard,
} from './lib.mjs';
import { STRINGS, UI_TEXT } from '../../src/loader/strings.js';

const LOADER_TEXT = UI_TEXT.en;
import { CONFIG } from '../../src/loader/config.js';
import { rendezvousInfoHash } from '../../src/loader/torrent.js';
import { peerScenarios, PEER_ORDER } from './peer-scenarios.mjs';
import { formatScenarios, FORMAT_ORDER } from './scenarios-formats.mjs';
import { servingScenarios, SERVING_ORDER } from './scenarios-serving.mjs';
import { v03Scenarios, V03_ORDER, V03_WEBKIT_ORDER } from './scenarios-v03.mjs';
import { socialScenarios, SOCIAL_ORDER } from './scenarios-social.mjs';
import { dropinV03Scenarios, DROPIN_V03_ORDER } from './scenarios-dropin-v03.mjs';
import { identityScenarios, IDENTITY_ORDER } from './scenarios-identity.mjs';
import { membersScenarios, MEMBERS_ORDER } from './scenarios-members.mjs';
import { hardeningScenarios, HARDENING_ORDER } from './scenarios-hardening.mjs';
import { callsScenarios, CALLS_ORDER, CALLS_WEBKIT_ORDER } from './scenarios-calls.mjs';
import { seedScenarios, SEED_ORDER } from './scenarios-c2.mjs';
import { doorsScenarios, DOORS_ORDER, DOORS_WEBKIT_ORDER } from './scenarios-doors.mjs';
import { firefoxScenarios, FIREFOX_ORDER, FIREFOX_HELD } from './scenarios-firefox.mjs';
import { a11yScenarios, A11Y_ORDER } from './scenarios-a11y.mjs';
import { publish } from '../../tools/publish.mjs';
import { createDevServer } from '../../tools/dev-server.mjs';
import { acceptConsent as liveAcceptConsent } from '../../tools/live.mjs';
import { stage } from '../fixtures/existing-site-dropin/stage.mjs';
import { createHost } from '../fixtures/existing-site-dropin/host.mjs';

const argv = process.argv.slice(2);
const flag = (name) => argv.includes(name);
const optValue = (name) => {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : null;
};
const HEADED = flag('--headed');
const KEEP = flag('--keep');
const ONLY = String(optValue('--only') || process.env.MW_E2E_ONLY || '').split(',').map((s) => s.trim().toUpperCase()).filter(Boolean)
  .map((s) => (/^\d+$/.test(s) ? Number(s) : s));
const STEP_MS = 60000;
// Firefox lane: --firefox runs the whole Chromium suite plus its own scenarios (about 130 s more on 2026-10-22,
// with other runs sharing the machine), so its watchdog is longer. R 5.3 integrator: the rows lanes brought the default
// run past 20 minutes when the three suites run at once (the watchdog stopped the Chromium and WebKit runs at 1,200 s on
// 2026-10-24), so the watchdog is 45 minutes, and 60 with --firefox.
const TOTAL_MS = Number(process.env.MW_E2E_TOTAL_MS) || (45 + (flag('--firefox') ? 15 : 0)) * 60 * 1000;
const T0 = Date.now();

function out(line) {
  process.stdout.write(line + '\n');
}
function elapsed() {
  return ((Date.now() - T0) / 1000).toFixed(1).padStart(6) + 's';
}

const run = {
  violations: [],
  violation(text) {
    if (this.violations.length < 50) this.violations.push(text);
  },
};

// ---------------------------------------------------------------------------------------------
// scenario helpers
// ---------------------------------------------------------------------------------------------

function assert(cond, message) {
  if (!cond) throw new StepError(message);
}

// Code review round 1 (F40): wall-clock targets are measurements; a loaded runner may miss them, so a
// scenario fails only past a generous bound and reports the target as met or missed.
function timingNote(ms, targetMs) {
  return ms <= targetMs ? 'target ' + targetMs + ' ms met' : 'target ' + targetMs + ' ms MISSED';
}

function makeCtx(stack, browser) {
  const visitors = new Map();
  const ctx = {
    stack,
    browser,
    origin: stack.origin,
    btih: stack.pub.btih,
    ledgerId: stack.pub.ledgerId,
    visitors,
    shared: {},
    closers: [], // run at the end of the run (fixture hosts)
    async visitor(name, opts) {
      const old = visitors.get(name);
      if (old && !old.closed) return old;
      const v = await Visitor.open(browser, name, run, opts);
      visitors.set(name, v);
      return v;
    },
    async closeVisitor(name) {
      const v = visitors.get(name);
      if (v) await v.close();
      visitors.delete(name);
    },
    /** Closes every open visitor (a scenario that needs to know exactly who is online). */
    async closeAll() {
      for (const name of Array.from(visitors.keys())) await ctx.closeVisitor(name);
      ctx.shared.pageA = null;
      ctx.shared.pageB = null;
      ctx.shared.pageC = null;
    },
    /** Opens the site in a new page of visitor `name`; returns { page, rendered }. */
    async openSite(name, { consent = true, timeoutMs = 30000, url = stack.origin } = {}) {
      const v = await ctx.visitor(name);
      const page = await v.newPage();
      const t0 = Date.now();
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 20000 });
      if (consent) await acceptConsent(page, { timeoutMs: 20000 });
      const rendered = await waitForSite(page, { timeoutMs, since: t0, label: name + ': site rendered' });
      return { page, rendered, visitor: v };
    },
  };
  return ctx;
}

/** step(label, fn, ms): one bounded step of a scenario, logged with its duration. */
function stepper(id) {
  return async (label, fn, ms = STEP_MS) => {
    const t = Date.now();
    try {
      const v = await withTimeout(Promise.resolve().then(fn), Math.min(ms, STEP_MS), '[' + id + '] ' + label);
      out(elapsed() + '   [' + id + '] ok   ' + label + ' (' + (Date.now() - t) + ' ms)');
      return v;
    } catch (err) {
      out(elapsed() + '   [' + id + '] FAIL ' + label + ' (' + (Date.now() - t) + ' ms): ' + ((err && err.message) || err));
      throw err;
    }
  };
}

async function frameChecks(page) {
  return inFrame(page, async (clipBytes) => {
    const r = {};
    r.h1 = (document.querySelector('h1') || {}).textContent;
    r.cssRadius = getComputedStyle(document.documentElement).getPropertyValue('--radius').trim();
    const img = document.querySelector('img.logo');
    if (img && !img.complete) await new Promise((res) => { img.onload = img.onerror = res; setTimeout(res, 5000); });
    r.imgWidth = img ? img.naturalWidth : -1;
    const slot = document.querySelector('[data-about="version"]');
    for (let i = 0; i < 50 && slot && slot.textContent === '...'; i++) await new Promise((res) => setTimeout(res, 100));
    r.aboutVersion = slot ? slot.textContent : null;
    const res = await fetch('/data/about.json');
    r.fetchStatus = res.status;
    r.fetchJson = await res.json().then((j) => typeof j === 'object').catch(() => false);
    const range = await fetch('/media/clip.mp4', { headers: { Range: 'bytes=0-1' } });
    r.rangeStatus = range.status;
    r.contentRange = range.headers.get('content-range');
    r.rangeBytes = (await range.arrayBuffer()).byteLength;
    const suffix = await fetch('/media/clip.mp4', { headers: { Range: 'bytes=-10' } });
    r.suffixStatus = suffix.status;
    r.suffixRange = suffix.headers.get('content-range');
    r.pathname = location.pathname;
    r.clipBytes = clipBytes;
    return r;
  }, CLIP_BYTES);
}

function checkFrame(r) {
  assert(/^Peer Guestbook/.test(String(r.h1 || '').trim()), 'heading is ' + JSON.stringify(r.h1));
  assert(r.cssRadius === '14px', 'the stylesheet did not apply (--radius = ' + JSON.stringify(r.cssRadius) + ')');
  assert(r.imgWidth > 0, 'the image did not load (naturalWidth ' + r.imgWidth + ')');
  assert(r.fetchStatus === 200 && r.fetchJson, "fetch('/data/about.json') answered " + r.fetchStatus);
  assert(r.aboutVersion && r.aboutVersion !== '...', 'the page did not fill data-about from about.json');
  assert(r.rangeStatus === 206 && r.contentRange === 'bytes 0-1/' + CLIP_BYTES && r.rangeBytes === 2, 'MP4 Range bytes=0-1 gave ' + r.rangeStatus + ' ' + r.contentRange + ' (' + r.rangeBytes + ' bytes)');
  assert(r.suffixStatus === 206 && r.suffixRange === 'bytes ' + (CLIP_BYTES - 10) + '-' + (CLIP_BYTES - 1) + '/' + CLIP_BYTES, 'MP4 suffix Range gave ' + r.suffixStatus + ' ' + r.suffixRange);
}

const blockSiteFiles = (stack) => (method, url) => url.startsWith(stack.siteFilesPrefix);

/**
 * dropinSite(ctx, label, { variant, version, plain, seq, genesis }) → { host, pub, src, outDir }
 * The existing-site fixture (examples/existing-site-dropin) staged, published with --dropin for scope
 * 127.0.0.1 and the local tracker, and served by the fixture's static host on its own port (its own
 * origin). plain: the site before it migrated (no publish, no runtime).
 */
async function dropinSite(ctx, label, { variant = 'main', version = 1, plain = false, seq = null, genesis = null, scope = '127.0.0.1' } = {}) {
  const base = join(ctx.stack.runDir, 'dropin-' + label);
  const src = stage(variant, join(base, 'src'), { version, plain });
  if (plain) {
    const host = await createHost({ root: src.dir });
    ctx.closers.push(() => host.close());
    return { host, pub: null, src, outDir: null };
  }
  const outDir = join(base, 'out');
  const pub = await publish({
    dir: src.dir, name: 'existing-site', scope, key: ctx.stack.owner.file, dropin: true, dist: ctx.stack.dist,
    out: outDir, tr: [ctx.stack.tracker.url], exp: 30, seq, genesis, quiet: true,
  });
  const host = await createHost({ root: join(outDir, 'site') });
  ctx.closers.push(() => host.close());
  return { host, pub, src, outDir };
}

/** window.__mwDropin.inspect() of a drop-in page, or null. */
async function dropinState(page) {
  try {
    return await withTimeout(page.evaluate(() => (window.__mwDropin && window.__mwDropin.inspect ? window.__mwDropin.inspect() : null)), 5000, 'dropin inspect');
  } catch (_) {
    return null;
  }
}

/** Registrations, controller and Cache Storage names of a page's origin. */
async function swFootprint(page) {
  return page.evaluate(async () => ({
    regs: navigator.serviceWorker ? (await navigator.serviceWorker.getRegistrations()).map((r) => (r.active || r.waiting || r.installing || {}).scriptURL || '?') : [],
    controlled: !!(navigator.serviceWorker && navigator.serviceWorker.controller),
    caches: typeof caches === 'object' ? await caches.keys() : [],
  }));
}

// ---------------------------------------------------------------------------------------------
// scenarios
// ---------------------------------------------------------------------------------------------

const SCENARIOS = {
  7: {
    title: 'cold start with no seeder through xs + ws (target 3 s), source webseed',
    async fn(ctx, step) {
      const v = await ctx.visitor('cold');
      const page = await v.newPage();
      let t0 = 0;
      const rendered = await step('first visit renders from the web seed (consent left pending)', async () => {
        t0 = Date.now();
        await page.goto(ctx.origin, { waitUntil: 'domcontentloaded', timeout: 20000 });
        return waitForSite(page, { timeoutMs: 30000, since: t0, label: 'cold start' });
      });
      const info = await step('mw.site.info() through the SDK', () => siteInfo(page));
      assert(info.source === 'webseed', 'source is ' + JSON.stringify(info.source) + ', expected webseed');
      assert(info.btih === ctx.btih, 'site.info btih ' + info.btih + ' is not the pointer btih ' + ctx.btih);
      const r = await step('heading, CSS, image, fetch and MP4 Range in the frame', () => frameChecks(page));
      checkFrame(r);
      const st = await shellState(page);
      assert(st && st.consent === 'pending', 'consent should still be pending, is ' + (st && st.consent));
      // Post-wave fix H (C1): before the choice the page opened no WebSocket and no RTCPeerConnection, the tracker
      // saw no announce, and nothing counts as passed on (WebTorrent's own counter showed 178 B of web-seed
      // protocol messages here, and the guestbook printed them as "passed on to others").
      assert(!v.sockets.length, 'a WebSocket opened before the choice: ' + v.sockets.map((s) => s.url).join(', '));
      const pcs = (await page.evaluate(() => window.__mwE2EPc || 0)) + (await inFrame(page, () => window.__mwE2EPc || 0));
      assert(pcs === 0, pcs + ' RTCPeerConnection(s) before the choice');
      assert(!ctx.stack.tracker.announces.some((a) => a.t >= t0), 'the tracker saw an announce before the choice');
      assert(st.uploaded === 0, 'progress.uploaded is ' + st.uploaded + ' before the choice');
      const transfer = await inFrame(page, () => (document.querySelector('#transfer') || {}).textContent || '');
      assert(!/passed on/.test(transfer), 'the guestbook reports bytes passed on before the choice: ' + transfer);
      ctx.shared.coldMs = rendered.ms;
      // Code review round 1 (F40): the 3 s target is recorded; only a generous bound fails the run.
      assert(rendered.ms <= 15000, 'the cold start took ' + rendered.ms + ' ms (target 3000 ms, bound 15000 ms)');
      await ctx.closeVisitor('cold');
      return 'rendered in ' + rendered.ms + ' ms from the web seed (' + timingNote(rendered.ms, 3000) + ')' + (rendered.placeholders.length ? ' (frame showed ' + rendered.placeholders.join(', ') + ' first)' : '');
    },
  },

  1: {
    title: 'shell renders the example from a seeder tab (heading, CSS, image, fetch, MP4 range)',
    async fn(ctx, step) {
      const { stack } = ctx;
      const seeder = await ctx.visitor('seeder');
      const sp = await seeder.newPage();
      const state = await step('seeder page seeds the published torrent', async () => {
        await sp.goto(ctx.origin + '_dev/seeder.html?tr=' + encodeURIComponent(stack.tracker.url), { waitUntil: 'domcontentloaded', timeout: 20000 });
        return waitUntil(() => sp.evaluate(() => (window.__seeder && (window.__seeder.ok || window.__seeder.error) ? window.__seeder : null)), { timeoutMs: 30000, label: 'seeder ready' });
      });
      assert(state.ok, 'seeder failed: ' + state.error);
      assert(state.btih === ctx.btih, 'seeder infohash ' + state.btih + ' differs from the pointer ' + ctx.btih);
      // The host refuses the web seed's file bytes from here on: the copy must come from the seeder.
      stack.gate.setBlock(blockSiteFiles(stack));
      const { page, rendered } = await step('visitor A opens the site, accepts the notice, renders from peers', () => ctx.openSite('A', { timeoutMs: 45000 }));
      const r = await step('heading, CSS, image, fetch and MP4 Range in the frame', () => frameChecks(page));
      checkFrame(r);
      assert(r.pathname === '/', 'location.pathname inside the frame is ' + r.pathname);
      const info = await step('mw.site.info() through the SDK', () => siteInfo(page));
      assert(info.source === 'peers', 'source is ' + JSON.stringify(info.source) + ', expected peers (web seed files were refused)');
      ctx.shared.pageA = page;
      return 'rendered in ' + rendered.ms + ' ms, source ' + info.source;
    },
  },

  2: {
    title: 'second visitor appends a guestbook entry; the first sees it within 10 s, equal root',
    async fn(ctx, step) {
      const { stack } = ctx;
      stack.gate.setBlock(null);
      const pageA = ctx.shared.pageA || (await ctx.openSite('A')).page;
      ctx.shared.pageA = pageA;
      const { page: pageB } = await step('visitor B opens the site', () => ctx.openSite('B'));
      ctx.shared.pageB = pageB;
      const text = 'hello from B ' + Date.now().toString(36);
      const before = await guestbookEntries(pageA);
      assert(!before.some((e) => e.msg === text), 'A shows the entry before it was posted');
      // Timed from the click: signing and proof-of-work happen in B, then gossip carries the block.
      const t = Date.now();
      const onA = waitUntil(async () => {
        const list = await guestbookEntries(pageA);
        return list.find((e) => e.msg === text) || null;
      }, { timeoutMs: 10000, stepMs: 50, label: 'entry on A within 10 s of the post' });
      onA.catch(() => {});
      await step('B posts through the guestbook form (signed, proof-of-work)', () => postMessage(pageB, text));
      const seen = await step('A shows the entry within 10 s', () => onA.then((e) => Object.assign({ ms: Date.now() - t }, e)), 15000);
      const ms = seen.ms;
      const mineB = (await guestbookEntries(pageB)).find((e) => e.msg === text);
      assert(mineB && mineB.h === seen.h, 'A and B show different blocks for the entry');
      ctx.shared.postB = { text, h: seen.h, author: seen.author };
      const roots = await step('A and B hold an equal ledger root', () => waitUntil(async () => {
        const [a, b] = await Promise.all([shellState(pageA), shellState(pageB)]);
        const ra = a && a.ledger && a.ledger.root;
        const rb = b && b.ledger && b.ledger.root;
        return ra && rb && ra === rb ? { ra, height: a.ledger.height } : null;
      }, { timeoutMs: 10000, label: 'equal root' }));
      // Code review round 1 (F26): the shell verifies ledger signatures in a worker pool (the worker URL
      // was missing, so every block verified on the main thread).
      await step('A verifies ledger blocks in a worker pool', async () => {
        const st = await shellState(pageA);
        assert(st && st.verifierPool === 'worker', 'the verifier pool runs ' + JSON.stringify(st && st.verifierPool) + ', expected worker');
      });
      // One engine per origin (5.9): a second tab of visitor A is a follower; its post goes through A's
      // engine tab and reaches B over the wire.
      const visitorA = ctx.visitors.get('A');
      const tab2 = await visitorA.newPage();
      await step('A opens a second tab (follower of A\'s engine tab)', async () => {
        const t0 = Date.now();
        await tab2.goto(ctx.origin, { waitUntil: 'domcontentloaded', timeout: 20000 });
        await waitForSite(tab2, { timeoutMs: 30000, since: t0, label: 'second tab of A' });
        const st = await waitUntil(async () => { const x = await shellState(tab2); return x && x.ledger ? x : null; }, { timeoutMs: 15000, label: 'follower ledger' });
        assert(st.leader === false && st.ledger.follower === true, 'the second tab should follow A\'s engine tab: ' + JSON.stringify({ leader: st.leader, follower: st.ledger.follower }));
      });
      // v0.3 (R 2.4.1, E-ID-2b): follower tabs never hold keys. A signs in in the engine tab (its own post opens the
      // identity origin there); the follower shows that sign-in and its post is signed by the engine tab.
      const textA = 'hello from A ' + Date.now().toString(36);
      await step('A\'s engine tab signs in at the identity origin and posts', () => postMessage(pageA, textA));
      await step('the follower tab shows the engine tab\'s sign-in (it holds no keys)', () => waitUntil(
        () => inFrame(tab2, async () => (await import('/_mw/sdk.js')).default.auth.state()).then((s) => (s === 'signed-in' ? s : null)),
        { timeoutMs: 10000, label: 'follower auth state' }));
      const text2 = 'hello from A tab 2 ' + Date.now().toString(36);
      const popupsBefore = ctx.visitors.get('A').context.pages().length;
      await step('the follower tab posts', () => postMessage(tab2, text2));
      await step('A\'s first tab and B show the follower\'s post, signed by the engine tab\'s key', () => waitUntil(async () => {
        const [a, b] = await Promise.all([guestbookEntries(pageA), guestbookEntries(pageB)]);
        const first = a.find((e) => e.msg === textA);
        const f = a.find((e) => e.msg === text2);
        if (!first || !f || !b.some((e) => e.msg === text2)) return null;
        assert(f.author === first.author, 'the follower\'s post is by ' + f.author + ', the engine tab signed in as ' + first.author);
        return true;
      }, { timeoutMs: 10000, stepMs: 100, label: 'follower post on A and B' }));
      assert(ctx.visitors.get('A').context.pages().length === popupsBefore, 'the follower tab opened no identity window');
      await tab2.close();
      return 'entry on A ' + ms + ' ms after B clicked Post; root ' + roots.ra.slice(0, 12) + '... at height ' + roots.height + '; A signed in in its engine tab and a follower tab posted through it';
    },
  },

  3: {
    title: 'seeder closed: reload renders from cache; a third visitor downloads from the second alone; a flipped byte is detected',
    async fn(ctx, step) {
      const { stack } = ctx;
      await ctx.closeVisitor('seeder');
      const pageA = ctx.shared.pageA;
      assert(pageA, 'scenario 1 did not leave visitor A open');
      const reload = await step('A reloads: renders from this device', async () => {
        const t0 = Date.now();
        await pageA.reload({ waitUntil: 'domcontentloaded', timeout: 20000 });
        return waitForSite(pageA, { timeoutMs: 20000, since: t0, label: 'reload from cache' });
      });
      const infoA = await step('A: source is cache', () => siteInfo(pageA));
      assert(infoA.source === 'cache', 'source after reload is ' + infoA.source);
      assert(reload.ms <= 10000, 'the cached render took ' + reload.ms + ' ms (target 3000 ms, bound 10000 ms)');

      await ctx.closeVisitor('A');
      ctx.shared.pageA = null;
      stack.gate.setBlock(blockSiteFiles(stack));
      const { page: pageC, rendered } = await step('visitor C downloads with only B online (web seed refused)', () => ctx.openSite('C', { timeoutMs: 45000 }));
      const infoC = await step('C: source is peers', () => siteInfo(pageC));
      assert(infoC.source === 'peers', 'source is ' + infoC.source + ', expected peers');
      checkFrame(await step('C: frame content checks', () => frameChecks(pageC)));
      stack.gate.setBlock(null);
      ctx.shared.pageC = pageC;

      // (a) While C's page is open: flip a byte of the stored copy, stop the worker (as the browser does
      // with an idle one), then follow a link inside the site. The fresh worker checks the pieces before
      // it serves, deletes the copy, tells the page (mw-site-invalid), and the page downloads the site
      // again and remounts it on the page the visitor asked for.
      const flipIn = (btih) => pageC.evaluate(async (btih) => {
        const db = await new Promise((res, rej) => { const r = indexedDB.open('mw-sites'); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
        const key = btih + '/about.html';
        const value = await new Promise((res, rej) => { const tx = db.transaction('files', 'readonly'); const g = tx.objectStore('files').get(key); g.onsuccess = () => res(g.result); g.onerror = () => rej(g.error); });
        if (!value) { db.close(); return { ok: false, reason: 'no stored about.html' }; }
        const bytes = new Uint8Array(value instanceof Blob ? await value.arrayBuffer() : value);
        bytes[100] = bytes[100] ^ 0x20;
        const next = value instanceof Blob ? new Blob([bytes], { type: value.type }) : bytes.buffer;
        await new Promise((res, rej) => { const tx = db.transaction('files', 'readwrite'); tx.objectStore('files').put(next, key); tx.oncomplete = res; tx.onerror = () => rej(tx.error); });
        db.close();
        return { ok: true };
      }, btih);
      const live = await step('in-page: flip about.html, stop the worker, follow the About link', async () => {
        const f = await flipIn(ctx.btih);
        assert(f.ok, 'could not flip a byte: ' + f.reason);
        await stopServiceWorkers(ctx.visitors.get('C'), pageC);
        const t0 = Date.now();
        // A script click: the shell's status bar overlays the top of the frame, where the nav link sits.
        await siteFrame(pageC).evaluate(() => document.querySelector('a[href="/about.html"]').click());
        const r = await waitForSite(pageC, { timeoutMs: 30000, since: t0, h1: /^About this site/, label: 'about.html after the re-download' });
        const st = await shellState(pageC);
        const log = (st && st.log ? st.log : []).join('\n');
        assert(/stored copy unusable/.test(log) && /downloading it again/.test(log), 'the page did not handle mw-site-invalid: ' + (st && st.log ? st.log.slice(-6).join(' | ') : ''));
        assert(!st.fromCache, 'the page still renders the flipped copy');
        return r;
      });

      // (b) Flip one byte of index.html in C's IndexedDB copy, then reload C.
      const flipped = await step('flip a byte of the stored index.html in IndexedDB', () => pageC.evaluate(async (btih) => {
        const db = await new Promise((res, rej) => { const r = indexedDB.open('mw-sites'); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
        const key = btih + '/index.html';
        const value = await new Promise((res, rej) => { const tx = db.transaction('files', 'readonly'); const g = tx.objectStore('files').get(key); g.onsuccess = () => res(g.result); g.onerror = () => rej(g.error); });
        if (!value) { db.close(); return { ok: false, reason: 'no stored index.html' }; }
        const bytes = new Uint8Array(value instanceof Blob ? await value.arrayBuffer() : value);
        const i = Math.min(200, bytes.length - 1);
        const before = bytes[i];
        bytes[i] = bytes[i] ^ 0x20;
        const next = value instanceof Blob ? new Blob([bytes], { type: value.type }) : bytes.buffer;
        await new Promise((res, rej) => { const tx = db.transaction('files', 'readwrite'); tx.objectStore('files').put(next, key); tx.oncomplete = res; tx.onerror = () => rej(tx.error); });
        db.close();
        return { ok: true, index: i, before, after: bytes[i], size: bytes.length };
      }, ctx.btih));
      assert(flipped.ok, 'could not flip a byte: ' + flipped.reason);
      // The worker remembers verified pieces in memory only (section 7.3); a browser stops idle
      // workers, and so does this step, so the next serve verifies the stored bytes again.
      await step('stop C\'s Service Worker (as the browser does with an idle worker)', () => stopServiceWorkers(ctx.visitors.get('C'), pageC));
      const healed = await step('C loads the site again: the bad copy is deleted and the site is fetched again', async () => {
        const t0 = Date.now();
        // A new document at the site root (the address bar shows /about.html after step (a)).
        await pageC.goto(ctx.origin, { waitUntil: 'domcontentloaded', timeout: 20000 });
        const r = await waitForSite(pageC, { timeoutMs: 45000, since: t0, label: 'site after the flipped byte' });
        const readStored = () => pageC.evaluate(async ({ btih, index, before }) => {
          const db = await new Promise((res, rej) => { const q = indexedDB.open('mw-sites'); q.onsuccess = () => res(q.result); q.onerror = () => rej(q.error); });
          const value = await new Promise((res, rej) => { const tx = db.transaction('files', 'readonly'); const g = tx.objectStore('files').get(btih + '/index.html'); g.onsuccess = () => res(g.result); g.onerror = () => rej(g.error); });
          db.close();
          if (!value) return { present: false };
          const bytes = new Uint8Array(value instanceof Blob ? await value.arrayBuffer() : value);
          return { present: true, restored: bytes[index] === before };
        }, Object.assign({ btih: ctx.btih }, flipped));
        // The good copy is saved before the site is mounted again; allow for a second round trip.
        const timeline = [];
        let stored = null;
        await waitUntil(async () => {
          stored = await readStored();
          timeline.push((Date.now() - t0) + 'ms ' + JSON.stringify(stored));
          return stored.present && stored.restored;
        }, { timeoutMs: 15000, stepMs: 100, label: 'a good copy stored again' }).catch(() => null);
        return Object.assign(r, { stored, timeline });
      });
      const st = await shellState(pageC);
      assert(healed.stored.present && healed.stored.restored, 'the stored index.html was not replaced by a good copy: ' + JSON.stringify(healed.stored) + ' timeline: ' + healed.timeline.slice(0, 5).join(', ') + ' ... ' + healed.timeline.slice(-3).join(', '));
      assert(st && !st.fromCache && st.source !== 'cache', 'C rendered the flipped copy from this device instead of fetching it again');
      const sw = ctx.visitors.get('C').context.serviceWorkers()[0];
      const swState = sw ? await sw.evaluate(() => self.mw.inspect()) : null;
      const drop = swState && (swState.drops || []).find((d) => d.btih === ctx.btih && d.reason === 'mismatch');
      assert(drop, 'the Service Worker did not record deleting the mismatching copy: ' + JSON.stringify(swState && swState.drops));
      return 'cache render ' + reload.ms + ' ms (' + timingNote(reload.ms, 3000) + '); C rendered from B in ' + rendered.ms + ' ms; flipped byte in an open page: re-downloaded and remounted on /about.html in ' + live.ms +
        ' ms; flipped byte before a reload: worker deleted the copy (' + drop.path + ' mismatch), fetched again, rendered in ' + healed.ms + ' ms';
    },
  },

  4: {
    title: 'a moderator tombstone from a browser that never held owner.jwk hides the entry in all tabs',
    async fn(ctx, step) {
      const { stack } = ctx;
      const post = ctx.shared.postB;
      assert(post, 'scenario 2 did not leave a post to remove');
      const tabs = [];
      for (const name of ['B', 'C']) {
        const v = ctx.visitors.get(name);
        const page = v && !v.closed ? v.pages[0] : null;
        if (page) tabs.push({ name, page });
      }
      const { page: pageM } = await step('visitor M opens the site and receives the post', async () => {
        const r = await ctx.openSite('M');
        await waitUntil(async () => (await guestbookEntries(r.page)).some((e) => e.h === post.h), { timeoutMs: 20000, label: 'post synced to M' });
        return r;
      });
      const modKey = readFileSync(stack.moderator.file, 'utf8');
      await step('M imports the moderator key in Settings (no owner key in any browser)', async () => {
        await pageM.click('.mw-settings-btn');
        await pageM.fill('textarea[aria-label="Moderator key"]', modKey);
        const nav = pageM.waitForNavigation({ timeout: 15000 }).catch(() => null);
        await pageM.click('button:has-text("Import moderator key")');
        await nav;
        await waitForSite(pageM, { timeoutMs: 30000, label: 'M after the key import' });
        await waitUntil(() => inFrame(pageM, () => (document.querySelector('#role-badge') || {}).textContent === 'moderator'), { timeoutMs: 20000, label: 'M has the moderator role' });
      });
      await step('M removes the post (two taps), then confirms on the loader\'s card (MF-27: another author\'s entry)', async () => {
        const frame = siteFrame(pageM);
        await waitUntil(() => inFrame(pageM, (h) => !!document.querySelector('#entries li[data-h="' + h + '"] .act-remove'), post.h), { timeoutMs: 20000, label: 'remove button' });
        const btn = frame.locator('#entries li[data-h="' + post.h + '"] .act-remove');
        await btn.click();
        await btn.click();
        // v0.3 (MF-27): db.tombstone of someone else's entry is a UI method; the loader asks in its own card.
        await waitUntil(() => clickLoaderCard(pageM, LOADER_TEXT.continue), { timeoutMs: 10000, label: 'the loader\'s "Remove this entry for everyone?" card' });
      });
      tabs.unshift({ name: 'M', page: pageM });
      // Every tab showed the post before the removal (so an empty list cannot pass for a hidden post).
      const heights = {};
      for (const t of tabs) {
        await waitUntil(async () => (await guestbookEntries(t.page)).some((e) => e.h === post.h), { timeoutMs: 15000, label: t.name + ' shows the post before the removal' });
        const st = await shellState(t.page);
        heights[t.name] = st && st.ledger ? st.ledger.height : null;
      }
      void heights;
      await step('the post disappears in every open tab', () => waitUntil(async () => {
        for (const t of tabs) {
          const list = await guestbookEntries(t.page);
          if (list.some((e) => e.h === post.h)) return null;
          const empty = await inFrame(t.page, () => { const n = document.querySelector('#entries-empty'); return n ? n.textContent : ''; });
          if (!list.length && !/No messages yet/.test(empty)) return null; // the list must have rendered
        }
        return true;
      }, { timeoutMs: 20000, stepMs: 200, label: 'post hidden in ' + tabs.map((t) => t.name).join(', ') }));
      // The removal is a tombstone block in every ledger copy, not a local filter.
      const roots = await step('every tab holds the same ledger root, including the tombstone', () => waitUntil(async () => {
        const states = await Promise.all(tabs.map((t) => shellState(t.page)));
        const rs = states.map((st) => st && st.ledger && st.ledger.root);
        return rs.every((r) => r && r === rs[0]) ? { root: rs[0], height: states[0].ledger.height } : null;
      }, { timeoutMs: 15000, label: 'equal roots' }));
      return 'hidden in ' + tabs.map((t) => t.name).join(', ') + '; equal root at height ' + roots.height;
    },
  },

  5: {
    title: 'offline reload renders the shell and the site',
    async fn(ctx, step) {
      const { stack } = ctx;
      const v = ctx.visitors.get('B') || ctx.visitors.get('C');
      assert(v && !v.closed && v.pages[0], 'no visitor with a cached copy is open');
      const page = v.pages[0];
      stack.gate.setDown(true);
      await v.context.setOffline(true);
      try {
        const r = await step('reload while the host is down and the browser is offline', async () => {
          const t0 = Date.now();
          await page.reload({ waitUntil: 'domcontentloaded', timeout: 20000 });
          return waitForSite(page, { timeoutMs: 20000, since: t0, label: 'offline render' });
        });
        const checks = await step('CSS, image and fetch still work offline', () => inFrame(page, async () => ({
          css: getComputedStyle(document.documentElement).getPropertyValue('--radius').trim(),
          img: (document.querySelector('img.logo') || {}).naturalWidth || 0,
          fetch: (await fetch('/data/about.json')).status,
        })));
        assert(checks.css === '14px' && checks.img > 0 && checks.fetch === 200, 'offline content checks: ' + JSON.stringify(checks));
        return 'rendered offline in ' + r.ms + ' ms';
      } finally {
        await v.context.setOffline(false);
        stack.gate.setDown(false);
      }
    },
  },

  6: {
    title: 'per-domain simulation with a page-tag pointer, signed and unsigned, and no DoH',
    async fn(ctx, step) {
      const { stack } = ctx;
      const anyPage = (ctx.visitors.get('B') && ctx.visitors.get('B').pages[0]) || (ctx.visitors.get('C') && ctx.visitors.get('C').pages[0]);
      let signedNote = 'signed: not checked';
      if (anyPage) {
        const st = await step('signed page tag: pointer source and signature', () => shellState(anyPage));
        assert(st && st.signed === true, 'the pointer is not reported as signed');
        assert(st.pointerSource === 'meta', 'pointer source is ' + st.pointerSource + ', expected meta (the page tag)');
        assert(st.ledgerId === ctx.ledgerId, 'ledger id ' + st.ledgerId + ' differs from publish ' + ctx.ledgerId);
        signedNote = 'signed: page tag, ledger ' + st.ledgerId;
      } else {
        const { page } = await step('signed page tag: a fresh visitor', () => ctx.openSite('S6', { consent: false }));
        const st = await shellState(page);
        assert(st && st.signed === true && st.pointerSource === 'meta', 'signed pointer state: ' + JSON.stringify(st && { signed: st.signed, source: st.pointerSource }));
        signedNote = 'signed: page tag';
      }
      const rec = stack.pub.record;
      const unsigned = ['v=mw1', 'btih=' + rec.btih, 'dn=' + SITE_NAME, ...rec.xs.map((x) => 'xs=' + x), ...rec.ws.map((w) => 'ws=' + w), ...rec.tr.map((t) => 'tr=' + t)].join('; ');
      stack.dev.setPointer(unsigned);
      try {
        // Consent stays pending: an unsigned pointer adds the public default trackers, which this
        // run must never try to reach. The web seed alone renders the site.
        const { page, rendered } = await step('unsigned page tag: a fresh visitor renders the site', () => ctx.openSite('U', { consent: false }));
        const st = await shellState(page);
        assert(st && st.signed === false, 'the unsigned pointer is reported as signed');
        assert(st.ledgerId === 'btih:' + rec.btih, 'unsigned ledger id is ' + st.ledgerId);
        const banner = await page.evaluate(() => document.body.textContent);
        assert(/unmoderated|not signed|unsigned/i.test(banner), 'no unmoderated or unsigned notice on the shell');
        const r = await step('unsigned: frame content checks', () => frameChecks(page));
        checkFrame(r);
        await ctx.closeVisitor('U');
        return signedNote + '; unsigned: rendered in ' + rendered.ms + ' ms, ledger ' + st.ledgerId + '; no DoH request (scope 127.0.0.1)';
      } finally {
        stack.dev.setPointer(stack.pub.pointer);
      }
    },
  },
};

// ---------------------------------------------------------------------------------------------
// scenarios 8 to 14 (integration-2)
// ---------------------------------------------------------------------------------------------

SCENARIOS[8] = {
  title: 'hub gate: a shared-origin hub link opens no WebSocket and no peer connection before the click',
  async fn(ctx, step) {
    const { stack } = ctx;
    // A hub link carries the record signed for "btih:<hex>", so its trackers are the signed local ones.
    const record = await hubPointer(stack);
    const trackerBase = stack.tracker.url.replace(/\/+$/, '');
    // No page tag: on a dev host a pointer fragment opens the shared-origin demo hub (section 3.3).
    stack.dev.setPointer(null);
    try {
      const v = await ctx.visitor('H');
      const page = await v.newPage();
      await page.goto(ctx.origin + '#' + record, { waitUntil: 'domcontentloaded', timeout: 20000 });
      const gate = await step('the gate shows name, infohash, trackers and publisher key', () => waitUntil(async () => {
        const g = await gateState(page);
        return g.visible ? g : null;
      }, { timeoutMs: 20000, label: 'hub gate' }));
      assert(gate.title === STRINGS.hubDetailsTitle, 'gate title ' + JSON.stringify(gate.title));
      assert(gate.buttons.indexOf(STRINGS.hubSharedLoad) >= 0, 'no "' + STRINGS.hubSharedLoad + '" button: ' + JSON.stringify(gate.buttons));
      assert(gate.details[STRINGS.hubDetailName] === SITE_NAME, 'gate name ' + JSON.stringify(gate.details));
      assert(gate.details[STRINGS.hubDetailBtih] === ctx.btih, 'gate infohash ' + gate.details[STRINGS.hubDetailBtih]);
      assert((gate.details[STRINGS.hubDetailTrackers] || '').indexOf(trackerBase) >= 0, 'gate trackers ' + gate.details[STRINGS.hubDetailTrackers]);
      assert(/^[0-9a-f]{8}$/.test(gate.details[STRINGS.hubDetailPublisher] || ''), 'gate publisher key ' + gate.details[STRINGS.hubDetailPublisher]);
      assert(gate.text.indexOf(STRINGS.hubSharedBanner) >= 0, 'the gate does not say the hub shares one origin');
      const st0 = await shellState(page);
      assert(st0 && st0.mode === 'hub-shared', 'mode is ' + (st0 && st0.mode));
      // The web seed may fill the copy meanwhile (HTTP only, section 8); nothing else may start.
      const held = await step('2 s with the gate open: no WebSocket, no RTCPeerConnection, no site frame', async () => {
        await sleep(2000);
        const pcs = await page.evaluate(() => window.__mwE2EPc || 0);
        const framed = await page.evaluate(() => !!document.querySelector('#mw-site iframe'));
        assert(v.sockets.length === 0, 'WebSockets opened before the click: ' + v.sockets.map((s) => s.url).join(', '));
        assert(pcs === 0, pcs + ' RTCPeerConnection(s) created before the click');
        assert(!framed, 'the site frame was mounted before the click');
        return { gateMs: Date.now() };
      });
      void held;
      const clickAt = Date.now();
      await step('click "' + STRINGS.hubSharedLoad + '"', async () => {
        assert(await clickGateButton(page, /^Load anyway/), 'the Load anyway button was not clickable');
      });
      const sock = await step('a WebSocket to the local tracker opens after the click', () => waitUntil(
        () => v.sockets.find((s) => s.url.replace(/\/+$/, '') === trackerBase && s.t >= clickAt) || null,
        { timeoutMs: 15000, label: 'tracker socket after the click' }));
      const rendered = await step('the site renders under /_mw/s/<btih>/ with the shared-origin banner', async () => {
        const r = await waitForSite(page, { timeoutMs: 30000, since: clickAt, label: 'hub site' });
        const frame = siteFrame(page);
        assert(frame && frame.url().indexOf('/_mw/s/' + ctx.btih + '/') >= 0, 'frame URL ' + (frame && frame.url()));
        const body = await page.evaluate(() => document.body.textContent);
        assert(body.indexOf(STRINGS.hubSharedBanner) >= 0, 'no shared-origin banner on the shell');
        return r;
      });
      return 'gate held 2 s with 0 sockets and 0 peer connections; tracker socket ' + (sock.t - clickAt) + ' ms after the click; rendered under /_mw/s/ ' + rendered.ms + ' ms after it';
    } finally {
      stack.dev.setPointer(stack.pub.pointer);
      await ctx.closeVisitor('H');
    }
  },
};

// The names boot.js records in window.__mwBoot.polyfilled (plus 'timeout' for AbortSignal.timeout).
/** readPref(page, key) → the value stored in IndexedDB mw-sites.prefs (undefined when absent). */
async function readPref(page, key) {
  return page.evaluate(async (k) => {
    const db = await new Promise((res, rej) => { const r = indexedDB.open('mw-sites'); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
    try {
      if (!db.objectStoreNames.contains('prefs')) return undefined;
      return await new Promise((res, rej) => { const tx = db.transaction('prefs', 'readonly'); const g = tx.objectStore('prefs').get(k); g.onsuccess = () => res(g.result); g.onerror = () => rej(g.error); });
    } finally {
      db.close();
    }
  }, key);
}

/**
 * Settings > "Share with other visitors" On/Off, the way a visitor does it: open Settings as soon as
 * the button exists, wait until the switch can be changed (the loader has loaded the stored
 * settings), flip it. Script clicks, because an error card may cover the bar.
 */
async function setShare(page, on) {
  await waitUntil(() => page.evaluate(() => { const b = document.querySelector('.mw-settings-btn'); if (!b) return false; b.click(); return true; }), { timeoutMs: 15000, label: 'Settings button' });
  await waitUntil(() => page.evaluate((want) => {
    const input = document.getElementById('mw-share');
    if (!input || input.offsetParent === null || input.disabled) return false;
    if (input.checked !== want) input.click();
    return input.checked === want;
  }, on), { timeoutMs: 10000, label: 'share switch' });
  await waitUntil(async () => (await readPref(page, 'uploads')) === on, { timeoutMs: 10000, label: 'uploads pref stored' });
  await page.evaluate((label) => {
    const b = Array.from(document.querySelectorAll('.mw-settings button')).find((x) => (x.textContent || '').trim() === label);
    if (b) b.click();
  }, STRINGS.settingsClose);
}

SCENARIOS[12] = {
  title: 'uploads off: download from peers, download from the web seed, and two-way gossip still complete',
  async fn(ctx, step) {
    const { stack } = ctx;
    // Who is online matters below (the choke check), so earlier visitors leave first.
    await ctx.closeAll();
    const allWs = (method, url) => url.startsWith('/ws/');
    const { page: pageP } = await step('visitor P (uploads on) loads the site and joins the swarm', () => ctx.openSite('P'));
    const vq = await ctx.visitor('Q');
    const pageQ = await vq.newPage();
    await step('visitor Q switches "Share with other visitors" off before any download', async () => {
      stack.gate.setBlock(allWs);
      await pageQ.goto(ctx.origin, { waitUntil: 'domcontentloaded', timeout: 20000 });
      await setShare(pageQ, false);
    });
    stack.gate.setBlock(blockSiteFiles(stack)); // the .torrent stays reachable, file bytes are refused
    const q = await step('Q reloads, accepts the notice and downloads the site from P with uploads off', async () => {
      const t0 = Date.now();
      await pageQ.reload({ waitUntil: 'domcontentloaded', timeout: 20000 });
      await acceptConsent(pageQ, { timeoutMs: 20000 });
      const r = await waitForSite(pageQ, { timeoutMs: 45000, since: t0, label: 'Q from peers' });
      const st = await shellState(pageQ);
      assert(st && st.uploads === false, 'Q has uploads ' + (st && st.uploads));
      const info = await siteInfo(pageQ);
      assert(info.source === 'peers', 'Q source is ' + info.source + ', expected peers');
      return r;
    });
    const fromP = 'from P ' + Date.now().toString(36);
    const tP = Date.now();
    await step('P posts; Q (uploads off) receives the entry', async () => {
      await postMessage(pageP, fromP);
      await waitUntil(async () => (await guestbookEntries(pageQ)).some((e) => e.msg === fromP), { timeoutMs: 15000, stepMs: 100, label: 'P entry on Q' });
    });
    const msP = Date.now() - tP;
    const fromQ = 'from Q ' + Date.now().toString(36);
    const tQ = Date.now();
    await step('Q posts (signed, proof-of-work); P receives the entry', async () => {
      await postMessage(pageQ, fromQ);
      await waitUntil(async () => (await guestbookEntries(pageP)).some((e) => e.msg === fromQ), { timeoutMs: 15000, stepMs: 100, label: 'Q entry on P' });
    });
    const msQ = Date.now() - tQ;
    // The choke lock holds: with P gone and the web seed's bytes refused, a newcomer connected to Q
    // gets nothing from it.
    await ctx.closeVisitor('P');
    const vx = await ctx.visitor('X');
    const pageX = await vx.newPage();
    const xs = await step('visitor X, with only Q online, connects to Q but receives no file bytes in 6 s', async () => {
      await pageX.goto(ctx.origin, { waitUntil: 'domcontentloaded', timeout: 20000 });
      await acceptConsent(pageX, { timeoutMs: 20000 });
      await waitUntil(async () => { const s = await shellState(pageX); return s && s.peers >= 1 ? s : null; }, { timeoutMs: 20000, label: 'X connected to Q' });
      await sleep(6000);
      const s = await shellState(pageX);
      assert(s && !s.mounted, 'X rendered the site with only Q (uploads off) online');
      const progress = await pageX.evaluate(() => { const p = document.querySelector('.mw-progress'); return p ? p.getAttribute('aria-valuenow') : null; });
      assert(!progress || Number(progress) === 0, 'X downloaded ' + progress + '% from Q');
      return { peers: s.peers, progress };
    });
    await ctx.closeVisitor('X');
    // Web seed with uploads off (throttleUpload(0) would stall it; the choke lock does not).
    const vq2 = await ctx.visitor('Q2');
    const pageQ2 = await vq2.newPage();
    await step('visitor Q2 switches sharing off before any download', async () => {
      stack.gate.setBlock(allWs);
      await pageQ2.goto(ctx.origin, { waitUntil: 'domcontentloaded', timeout: 20000 });
      await setShare(pageQ2, false);
    });
    stack.gate.setBlock(null);
    const q2 = await step('Q2 reloads (consent pending) and downloads the site from the web seed with uploads off', async () => {
      const t0 = Date.now();
      await pageQ2.reload({ waitUntil: 'domcontentloaded', timeout: 20000 });
      const r = await waitForSite(pageQ2, { timeoutMs: 30000, since: t0, label: 'Q2 from the web seed' });
      const st = await shellState(pageQ2);
      assert(st && st.uploads === false, 'Q2 has uploads ' + (st && st.uploads));
      const info = await siteInfo(pageQ2);
      assert(info.source === 'webseed', 'Q2 source is ' + info.source + ', expected webseed');
      return r;
    });
    await ctx.closeAll();
    return 'Q (uploads off) from P in ' + q.ms + ' ms; P to Q ' + msP + ' ms, Q to P ' + msQ + ' ms; X got 0 bytes from Q with ' + xs.peers + ' peer(s); Q2 (uploads off) from the web seed in ' + q2.ms + ' ms';
  },
};

SCENARIOS[9] = {
  title: 'kill switch: the self-unregistering worker restores host serving (shell and drop-in), with no reload loop',
  async fn(ctx, step) {
    const { stack } = ctx;
    // ---- (a) shell mode: the owner deploys the plain site and the kill-switch worker as /mw-sw.js ----
    const v = await ctx.visitor('K');
    const page = await v.newPage();
    await step('visitor K renders the site through the shell, controlled by the worker', async () => {
      const t0 = Date.now();
      await page.goto(ctx.origin, { waitUntil: 'domcontentloaded', timeout: 20000 });
      await waitForSite(page, { timeoutMs: 30000, since: t0, label: 'K renders' });
      const fp = await swFootprint(page);
      assert(fp.controlled && fp.regs.length === 1, 'K is not controlled: ' + JSON.stringify(fp));
    });
    const btihStored = (await storedSites(page)).indexOf(ctx.btih) >= 0;
    const navs = [];
    let lastDoc = null;
    page.on('framenavigated', (f) => { if (f === page.mainFrame()) navs.push({ t: Date.now(), url: f.url() }); });
    page.on('response', (r) => {
      try {
        if (r.request().isNavigationRequest() && r.frame() === page.mainFrame()) lastDoc = { status: r.status(), plain: r.headers()['x-e2e-plain-host'] === '1', fromSw: r.fromServiceWorker() };
      } catch (_) { /* detached */ }
    });
    stack.dev.killSwitch(true);
    stack.gate.setRoute(staticRoute(join(stack.outDir, SITE_NAME), { pass: (p) => p === '/mw-sw.js' || p.startsWith('/_mw/') }));
    try {
      const shell = await step('K reloads: the kill switch unregisters, clears mw-* caches and reloads K from the plain host', async () => {
        const t0 = Date.now();
        await page.reload({ waitUntil: 'domcontentloaded', timeout: 20000 });
        const fp = await waitUntil(async () => {
          const s = await page.evaluate(async () => ({
            shell: !!document.getElementById('mw-root'),
            h1: ((document.querySelector('h1') || {}).textContent || '').trim(),
            regs: navigator.serviceWorker ? (await navigator.serviceWorker.getRegistrations()).length : -1,
            controlled: !!(navigator.serviceWorker && navigator.serviceWorker.controller),
            caches: (await caches.keys()).filter((k) => k.indexOf('mw-') === 0),
          })).catch(() => null);
          return s && !s.shell && /^Peer Guestbook/.test(s.h1) && s.regs === 0 && !s.controlled && !s.caches.length ? s : null;
        }, { timeoutMs: 20000, label: 'plain host page, no worker, no mw-* caches' });
        return Object.assign(fp, { ms: Date.now() - t0 });
      });
      const settled = navs.length;
      await step('no further reload in the next 3 s', async () => {
        await sleep(3000);
        assert(navs.length === settled, 'K kept reloading: ' + navs.slice(settled).map((n) => n.url).join(', '));
      });
      assert(lastDoc && lastDoc.plain && !lastDoc.fromSw && lastDoc.status === 200, 'the last document did not come from the plain host: ' + JSON.stringify(lastDoc));
      assert(settled <= 2, 'K navigated ' + settled + ' times while settling (expected the reload and one kill-switch navigation)');
      const keptIdb = btihStored ? (await storedSites(page)).indexOf(ctx.btih) >= 0 : null;
      assert(keptIdb !== false, 'the kill switch removed the saved site from IndexedDB (it must leave IndexedDB alone)');
      ctx.shared.killShell = 'shell: plain host page after ' + settled + ' navigation(s) in ' + shell.ms + ' ms, 0 registrations, 0 mw-* caches, IndexedDB kept';
    } finally {
      stack.gate.setRoute(null);
      stack.dev.killSwitch(false);
      await ctx.closeVisitor('K');
    }

    // ---- (a2) an incomplete deploy: the kill switch while the host keeps serving the shell ----
    // The shell registers /mw-sw.js on every view; the kill switch must reload only the pages an old
    // worker controlled, or this becomes a reload loop (it did: about 80 reloads a second).
    const v2 = await ctx.visitor('K2');
    const page2 = await v2.newPage();
    await step('K2 renders through the shell; then only /mw-sw.js is swapped for the kill switch', async () => {
      const t0 = Date.now();
      await page2.goto(ctx.origin, { waitUntil: 'domcontentloaded', timeout: 20000 });
      await waitForSite(page2, { timeoutMs: 30000, since: t0, label: 'K2 renders' });
    });
    const navs2 = [];
    page2.on('framenavigated', (f) => { if (f === page2.mainFrame()) navs2.push(Date.now()); });
    stack.dev.killSwitch(true);
    try {
      await step('K2 reloads with the shell still served: at most one kill-switch reload, no loop', async () => {
        await page2.reload({ waitUntil: 'domcontentloaded', timeout: 20000 });
        await sleep(5000);
        assert(navs2.length <= 2, navs2.length + ' navigations in 5 s (reload loop)');
      });
    } finally {
      stack.dev.killSwitch(false);
      await ctx.closeVisitor('K2');
    }
    ctx.shared.killShell += '; shell kept by mistake: ' + navs2.length + ' navigation(s) in 5 s, no loop';

    // ---- (b) drop-in (examples/existing-site-dropin/EXPECTED.md check 5) ----
    const d = await step('publish the existing-site fixture with --dropin and serve it', () => dropinSite(ctx, 'kill'));
    const vd = await ctx.visitor('KD');
    const pd = await vd.newPage();
    await step('first view builds the copy; the second view is controlled', async () => {
      await pd.goto(d.host.url, { waitUntil: 'load', timeout: 20000 });
      await waitUntil(async () => { const s = await dropinState(pd); return s && s.copy ? s : null; }, { timeoutMs: 20000, label: 'first copy' });
      await pd.goto(d.host.url + 'about.html', { waitUntil: 'load', timeout: 20000 });
      await waitUntil(async () => { const s = await dropinState(pd); return s && s.copy && s.copy.fromCache ? s : null; }, { timeoutMs: 20000, label: 'second view from IndexedDB' });
      const fp = await swFootprint(pd);
      assert(fp.controlled && fp.regs.length === 1 && /\/mw-sw\.js$/.test(fp.regs[0]), 'drop-in worker not in control: ' + JSON.stringify(fp));
    });
    copyFileSync(join(ctx.stack.dist, 'mw-sw-kill.js'), join(d.outDir, 'site', 'mw-sw.js'));
    const dnavs = [];
    pd.on('framenavigated', (f) => { if (f === pd.mainFrame()) dnavs.push({ t: Date.now(), url: f.url() }); });
    const warnsBefore = vd.lines.filter((l) => /console\.warning: .*kill switch/.test(l)).length;
    const killed = await step('a page view after the kill-switch deploy: one reload, then the host serves everything', async () => {
      const t0 = Date.now();
      await pd.goto(d.host.url + 'blog/post-1.html', { waitUntil: 'load', timeout: 20000 });
      const fp = await waitUntil(async () => {
        const s = await swFootprint(pd).catch(() => null);
        return s && !s.regs.length && !s.controlled && !s.caches.length ? s : null;
      }, { timeoutMs: 20000, label: 'no registration, no controller, no caches' });
      const st = await waitUntil(async () => { const s = await dropinState(pd); return s && s.sw && s.sw.reason === 'kill-switch' ? s : null; }, { timeoutMs: 20000, label: 'inspect().sw kill-switch' });
      return { fp, sw: st.sw, ms: Date.now() - t0 };
    });
    const dsettled = dnavs.length;
    await step('no reload loop: 0 navigations in the next 5 s', async () => {
      await sleep(5000);
      assert(dnavs.length === dsettled, 'the page kept reloading: ' + dnavs.slice(dsettled).map((n) => n.url).join(', '));
    });
    assert(dsettled <= 2, dsettled + ' navigations while settling (expected the view and one kill-switch reload)');
    assert(killed.sw.mode === 'none', 'inspect().sw ' + JSON.stringify(killed.sw));
    const warns = vd.lines.filter((l) => /console\.warning: .*kill switch/.test(l)).length - warnsBefore;
    assert(warns === 1, warns + ' console warnings about the kill switch (expected 1)');
    const later = await step('a later view registers nothing and asks for /mw-sw.js once', async () => {
      d.host.clearLog();
      await pd.goto(d.host.url, { waitUntil: 'load', timeout: 20000 });
      await waitUntil(async () => { const s = await dropinState(pd); return s && s.sw && s.sw.reason === 'kill-switch' ? s : null; }, { timeoutMs: 20000, label: 'kill-switch verdict on the later view' });
      await sleep(500);
      const fp = await swFootprint(pd);
      assert(!fp.regs.length && !fp.controlled, 'a worker registered again: ' + JSON.stringify(fp));
      const swGets = d.host.requests.filter((r) => r.path === '/mw-sw.js').length;
      assert(swGets === 1, swGets + ' requests for /mw-sw.js on the later view (expected 1)');
      return swGets;
    });
    void later;
    await ctx.closeVisitor('KD');
    return ctx.shared.killShell + '; drop-in: ' + dsettled + ' navigation(s) while settling, then none in 5 s, sw ' + JSON.stringify(killed.sw) + ', one warning, a later view asks for /mw-sw.js once';
  },
};

const DROPIN_PATHS = ['/', '/about.html', '/blog/post-1.html', '/app/settings', '/nothing-here', '/old-about'];

/** One JS-off view: { status, host, text, shot, path } (status and header of the final response). */
async function jsOffView(page, url) {
  const res = await page.goto(url, { waitUntil: 'load', timeout: 20000 });
  const text = await page.evaluate(() => document.body ? document.body.innerText : '');
  const shot = await page.screenshot({ fullPage: true });
  const chain = [];
  for (let r = res && res.request(); r; r = r.redirectedFrom()) chain.unshift(r.url().replace(/^https?:\/\/[^/]+/, ''));
  return { status: res ? res.status() : 0, host: res ? res.headers()['x-fixture-host'] || null : null, text, shot, chain, path: new URL(page.url()).pathname };
}

async function fixtureState(page) {
  return page.evaluate(() => (window.__fixture ? JSON.parse(JSON.stringify(window.__fixture)) : null));
}

async function loadChunk(page) {
  await page.evaluate(() => document.getElementById('load-chunk').click());
  return waitUntil(async () => { const f = await fixtureState(page); return f && f.chunk ? f : null; }, { timeoutMs: 10000, label: 'lazy chunk' });
}

SCENARIOS[10] = {
  title: 'drop-in fixture: JS-off parity, second view from IndexedDB, a redeploy without version mixing, location.pathname, a foreign worker left alone',
  async fn(ctx, step) {
    const notes = [];
    const v1 = await step('stage and publish the fixture (--dropin), its v1 host and the plain "before" host', async () => {
      const site = await dropinSite(ctx, 'main');
      const plain = await dropinSite(ctx, 'plain', { plain: true });
      return { site, plain };
    });
    const hostA = v1.site.host;

    // (1) JavaScript off: the migrated site is what the host served before.
    const offA = await Visitor.open(ctx.browser, 'jsoffA', run, { javaScriptEnabled: false });
    const offP = await Visitor.open(ctx.browser, 'jsoffP', run, { javaScriptEnabled: false });
    ctx.visitors.set('jsoffA', offA);
    ctx.visitors.set('jsoffP', offP);
    await step('JavaScript off: status, X-Fixture-Host, text and a full-page screenshot equal the plain host for ' + DROPIN_PATHS.length + ' URLs', async () => {
      const pa = await offA.newPage();
      const pp = await offP.newPage();
      for (const path of DROPIN_PATHS) {
        const a = await jsOffView(pa, hostA.url.replace(/\/$/, '') + path);
        const p = await jsOffView(pp, v1.plain.host.url.replace(/\/$/, '') + path);
        assert(a.status === p.status, path + ': status ' + a.status + ' vs plain ' + p.status);
        assert(a.host === p.host && a.host === 'existing-site', path + ': X-Fixture-Host ' + a.host + ' vs plain ' + p.host);
        assert(a.text === p.text, path + ': the page text differs from the plain host');
        assert(a.chain.join(' > ') === p.chain.join(' > '), path + ': redirect chain ' + a.chain.join(' > ') + ' vs ' + p.chain.join(' > '));
        assert(a.shot.equals(p.shot), path + ': the full-page screenshot differs from the plain host');
      }
    });
    await ctx.closeVisitor('jsoffA');
    await ctx.closeVisitor('jsoffP');
    notes.push('JS off identical on ' + DROPIN_PATHS.length + ' URLs');

    // (2) The second page view comes from IndexedDB.
    const d1 = await ctx.visitor('D1');
    const p1 = await d1.newPage();
    const first = await step('first view of /: the copy is built from the web seed', async () => {
      await p1.goto(hostA.url, { waitUntil: 'load', timeout: 20000 });
      return waitUntil(async () => { const s = await dropinState(p1); return s && s.copy ? s : null; }, { timeoutMs: 20000, label: 'first copy' });
    });
    assert(first.source === 'webseed', 'first view source ' + first.source);
    const v1btih = first.copy.btih;
    assert(v1btih === v1.site.pub.btih, 'copy btih ' + v1btih + ' differs from the published ' + v1.site.pub.btih);
    hostA.clearLog();
    await step('second view (/about.html): served from IndexedDB, the host sees the page and /mw-sw.js only', async () => {
      await p1.goto(hostA.url + 'about.html', { waitUntil: 'load', timeout: 20000 });
      await waitUntil(async () => { const s = await dropinState(p1); return s && s.copy && s.copy.fromCache ? s : null; }, { timeoutMs: 20000, label: 'copy from cache' });
      const asked = hostA.requests.map((r) => r.path);
      const assets = asked.filter((p) => /^\/(css|js|img)\//.test(p) || p === '/data.json');
      assert(asked.indexOf('/about.html') >= 0, 'the host did not serve /about.html: ' + asked.join(', '));
      assert(!assets.length, 'the host served assets on the second view: ' + assets.join(', '));
      notes.push('second view asked the host for ' + Array.from(new Set(asked)).join(', '));
    });

    // Code review round 1 (F04): /_mw/ws/ is the engine's web-seed rewrite, never a page. A navigation to
    // it is left to the host (which has no such path), so no site file renders there with the worker's
    // headers.
    await step('a navigation to /_mw/ws/<name>/about.html is not answered by the worker', async () => {
      const probe = await d1.newPage();
      try {
        const res = await probe.goto(hostA.url + '_mw/ws/existing-site/about.html', { waitUntil: 'load', timeout: 20000 });
        const status = res ? res.status() : 0;
        const text = await probe.evaluate(() => document.body ? document.body.innerText : '');
        const aboutText = await p1.evaluate(() => document.body ? document.body.innerText.slice(0, 80) : '');
        assert(status !== 200 || text.indexOf(aboutText.slice(0, 40)) < 0, 'the worker rendered a site file at /_mw/ws/: HTTP ' + status);
        notes.push('/_mw/ws/ navigation: HTTP ' + status + ' from the host');
      } finally {
        await probe.close();
      }
    });

    // (3) Redeploy (v2, higher seq, old files kept for a while): pages never mix versions.
    await p1.goto(hostA.url, { waitUntil: 'load', timeout: 20000 });
    await waitUntil(async () => { const s = await dropinState(p1); return s && s.copy ? s : null; }, { timeoutMs: 20000, label: 'v1 home from the copy' });
    const v1Accent = await p1.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--accent').trim());
    const v2 = await step('publish v2 (seq + 1, same genesis) and redeploy it over v1, old files kept', async () => {
      const site2 = await dropinSite(ctx, 'v2', { version: 2, seq: Number(v1.site.pub.record.seq) + 1, genesis: join(v1.site.outDir, 'genesis.json') });
      hostA.redeploy(join(site2.outDir, 'site'), { keepOld: true });
      return site2;
    });
    assert(v2.pub.btih !== v1btih, 'v2 has the same infohash as v1');
    const chunk1 = await step('the open v1 page loads its lazy chunk: v1', () => loadChunk(p1));
    assert(chunk1.chunk === 'v1', 'the v1 page loaded chunk ' + chunk1.chunk);
    const p3 = await d1.newPage();
    const v2view = await step('a new page is v2: v2 chunk, data.json version 2, v2 stylesheet; it follows the v1 tab', async () => {
      await p3.goto(hostA.url, { waitUntil: 'load', timeout: 20000 });
      const f = await waitUntil(async () => { const x = await fixtureState(p3); return x && x.data ? x : null; }, { timeoutMs: 10000, label: 'v2 data.json' });
      const c = await loadChunk(p3);
      const accent = await p3.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--accent').trim());
      const st = await waitUntil(async () => { const s = await dropinState(p3); return s && s.btih ? s : null; }, { timeoutMs: 10000, label: 'v2 engine state' });
      return { data: f.data, chunk: c.chunk, accent, st };
    });
    assert(v2view.data && v2view.data.version === 2, 'the v2 page read data.json ' + JSON.stringify(v2view.data));
    assert(v2view.chunk === 'v2', 'the v2 page loaded chunk ' + v2view.chunk);
    assert(v2view.accent && v2view.accent !== v1Accent, 'the v2 page has the v1 stylesheet (accent ' + v2view.accent + ')');
    assert(v2view.st.btih === v2.pub.btih, 'the v2 page is stamped with ' + v2view.st.btih);
    assert(v2view.st.leader === false && v2view.st.copy === null, 'the v2 tab should follow the open v1 tab: ' + JSON.stringify({ leader: v2view.st.leader, copy: v2view.st.copy }));
    const v1again = await fixtureState(p1);
    assert(v1again.chunk === 'v1', 'the v1 page changed version');
    await p1.close();
    const promoted = await step('closing the v1 tab promotes the v2 tab: changed files refreshed, v2 copied, v1 deleted', async () => {
      const st = await waitUntil(async () => { const s = await dropinState(p3); return s && s.leader && s.copy && s.copy.btih === v2.pub.btih ? s : null; }, { timeoutMs: 30000, label: 'v2 tab promoted with a v2 copy' });
      const sites = await waitUntil(async () => { const list = await storedSites(p3); return list.length === 1 && list[0] === v2.pub.btih ? list : null; }, { timeoutMs: 15000, label: 'only v2 in IndexedDB' });
      return { st, sites };
    });
    assert(/refreshed \d+ changed file/.test(JSON.stringify(promoted.st.logs)), 'no "refreshed N changed file(s)" line: ' + JSON.stringify(promoted.st.logs.slice(-8)));
    notes.push('redeploy: v1 page kept v1 (chunk, stylesheet), v2 page v2, v2 follower promoted and v1 deleted');

    // (4) location.pathname everywhere, with the History-API router.
    const p4 = await d1.newPage();
    await step('location.pathname: /blog/post-1.html, a deep SPA link, pushState, reload and back', async () => {
      await p4.goto(hostA.url + 'blog/post-1.html', { waitUntil: 'load', timeout: 20000 });
      const post = await waitUntil(async () => { const f = await fixtureState(p4); return f ? f : null; }, { timeoutMs: 10000, label: 'post script' });
      const shown = await p4.evaluate(() => document.getElementById('path').textContent);
      assert(post.pathname === '/blog/post-1.html' && shown === '/blog/post-1.html', 'post pathname ' + post.pathname + ' / ' + shown);
      await p4.goto(hostA.url + 'app/items/42', { waitUntil: 'load', timeout: 20000 });
      let f = await waitUntil(async () => { const x = await fixtureState(p4); return x && x.route ? x : null; }, { timeoutMs: 10000, label: 'router' });
      assert(f.route === 'item' && f.routeId === 42, 'deep link route ' + f.route + ' ' + f.routeId);
      let loads = 0;
      const onLoad = () => { loads++; };
      p4.on('load', onLoad);
      await p4.evaluate(() => document.querySelector('a[href="/app/settings"]').click());
      f = await waitUntil(async () => { const x = await fixtureState(p4); return x && x.route === 'settings' ? x : null; }, { timeoutMs: 10000, label: 'pushState route' });
      const path = await p4.evaluate(() => location.pathname);
      assert(path === '/app/settings' && loads === 0, 'pushState gave ' + path + ' with ' + loads + ' page load(s)');
      p4.off('load', onLoad);
      await p4.reload({ waitUntil: 'load', timeout: 20000 });
      f = await waitUntil(async () => { const x = await fixtureState(p4); return x && x.route ? x : null; }, { timeoutMs: 10000, label: 'router after reload' });
      assert(f.route === 'settings' && f.pathname === '/app/settings', 'after reload ' + f.route + ' ' + f.pathname);
      await p4.goBack({ waitUntil: 'load', timeout: 20000 });
      f = await waitUntil(async () => { const x = await fixtureState(p4); return x && x.route ? x : null; }, { timeoutMs: 10000, label: 'router after back' });
      const backPath = await p4.evaluate(() => location.pathname);
      assert(backPath === '/app/items/42' && f.route === 'item' && f.routeId === 42, 'back gave ' + backPath + ' ' + f.route);
    });
    await ctx.closeVisitor('D1');

    // (5) A site with its own hand-written worker keeps it; ours never registers (3.4.4).
    const own = await step('publish the with-own-sw variant (--dropin) and serve it', () => dropinSite(ctx, 'own', { variant: 'with-own-sw' }));
    const d2 = await ctx.visitor('D2');
    const po = await d2.newPage();
    const recipe = (l) => /importScripts\('\/_mw\/sw-core\.js'\)/.test(l) && /self\.mw\.owns\(event\)/.test(l);
    const stats = [];
    for (let view = 1; view <= 3; view++) {
      await step('own worker, view ' + view + ': one registration (/sw.js), ours absent, one recipe line', async () => {
        const before = d2.lines.filter(recipe).length;
        await po.goto(own.host.url, { waitUntil: 'load', timeout: 20000 });
        await waitUntil(async () => { const s = await dropinState(po); return s && s.sw && s.sw.mode === 'foreign' ? s : null; }, { timeoutMs: 15000, label: 'foreign verdict' });
        await waitUntil(() => d2.lines.filter(recipe).length > before, { timeoutMs: 8000, label: 'recipe line' });
        await sleep(300);
        const lines = d2.lines.filter(recipe).length - before;
        assert(lines === 1, lines + ' recipe lines on view ' + view);
        const fp = await swFootprint(po);
        assert(fp.regs.length === 1 && /\/sw\.js$/.test(fp.regs[0]), 'registrations ' + JSON.stringify(fp.regs));
        const own2 = await po.evaluate(() => (window.__ownSw ? window.__ownSw.registered : null));
        assert(own2, 'the site worker did not register (__ownSw.registered ' + own2 + ')');
        await waitUntil(() => po.evaluate(() => !!navigator.serviceWorker.controller), { timeoutMs: 10000, label: 'site worker controls the page' });
        stats.push(await po.evaluate(() => fetch('/__own-sw/stats').then((r) => r.json())));
      });
    }
    assert(!own.host.requests.some((r) => r.path === '/mw-sw.js'), 'the host saw a request for /mw-sw.js');
    assert(stats[0].cssHits === 0 && stats[0].cssMisses === 0, 'stats after view 1 ' + JSON.stringify(stats[0]));
    assert(stats[1].cssMisses === 1, 'stats after view 2 ' + JSON.stringify(stats[1]));
    assert(stats[2].cssHits === 1, 'stats after view 3 ' + JSON.stringify(stats[2]));
    await ctx.closeVisitor('D2');
    notes.push('own worker kept (stats ' + stats.map((s) => s.cssHits + '/' + s.cssMisses).join(', ') + ' hits/misses), no /mw-sw.js request');

    // The same worker with the two-line integration: ours serves through it.
    const integ = await step('publish the with-own-sw-integrated variant and serve it', () => dropinSite(ctx, 'integrated', { variant: 'with-own-sw-integrated' }));
    const d3 = await ctx.visitor('D3');
    const pi = await d3.newPage();
    const st3 = await step('integrated worker: mode integrated, no recipe line, the copy came through the site worker', async () => {
      await pi.goto(integ.host.url, { waitUntil: 'load', timeout: 20000 });
      const s = await waitUntil(async () => { const x = await dropinState(pi); return x && x.sw && x.sw.mode === 'integrated' && x.copy ? x : null; }, { timeoutMs: 20000, label: 'integrated with a copy' });
      await sleep(5000);
      assert(!d3.lines.some(recipe), 'an integrated site got the recipe line');
      return s;
    });
    assert(st3.source === 'webseed', 'integrated source ' + st3.source);
    await ctx.closeVisitor('D3');
    notes.push('integrated worker: mode integrated, web seed through it, no recipe line');
    return notes.join('; ');
  },
};

SCENARIOS[13] = {
  title: 'publish seq + 1: the old version stops seeding at once, is gone from IndexedDB after the reload, and is not announced again',
  async fn(ctx, step) {
    const { stack } = ctx;
    await ctx.closeAll();
    const oldBtih = ctx.btih;
    const v = await ctx.visitor('V');
    const { page } = await step('visitor V renders the current version and announces it', async () => {
      const r = await ctx.openSite('V');
      await waitUntil(() => v.announces.some((a) => a.btih === oldBtih), { timeoutMs: 20000, label: 'old version announced' });
      return r;
    });
    const pub2 = await step('publish a changed copy with seq + 1 to the same web seed and switch the page tag', async () => {
      const dir = join(stack.runDir, 'example-v2');
      cpSync(join(ROOT, 'examples', 'peer-guestbook'), dir, { recursive: true });
      const about = JSON.parse(readFileSync(join(dir, 'data', 'about.json'), 'utf8'));
      about.version = '2.0.1-e2e';
      writeFileSync(join(dir, 'data', 'about.json'), JSON.stringify(about, null, 2) + '\n');
      const r = await publish({
        dir, name: SITE_NAME, scope: '127.0.0.1', key: stack.owner.file, out: stack.outDir, policy: 'open', bits: 4,
        tr: [stack.tracker.url], ws: [stack.origin + 'ws/'], cs: stack.origin + 'ws/genesis.json', moderator: [stack.moderator.pub],
        exp: 30, seq: Number(stack.pub.record.seq) + 1, quiet: true, idp: stack.idp.url,
      });
      stack.dev.setPointer(r.pointer);
      return r;
    });
    assert(pub2.btih !== oldBtih, 'the new version has the old infohash');
    assert(pub2.ledgerId === ctx.ledgerId, 'the new version has another ledger id: ' + pub2.ledgerId);
    const notice = await step('V reloads: "' + STRINGS.updateAvailable + '" and the old version stops seeding', async () => {
      await page.reload({ waitUntil: 'domcontentloaded', timeout: 20000 });
      await waitForSite(page, { timeoutMs: 20000, label: 'V after the publish' });
      await waitUntil(() => page.evaluate((text) => document.body.textContent.indexOf(text) >= 0, STRINGS.updateAvailable), { timeoutMs: 15000, label: 'update banner' });
      const at = Date.now();
      await sleep(2500);
      const late = v.announces.filter((a) => a.btih === oldBtih && a.t > at + 500 && a.event !== 'stopped');
      assert(!late.length, 'V still announced the old version after the update was found: ' + JSON.stringify(late.slice(0, 3)));
      return at;
    });
    void notice;
    const reloadAt = Date.now();
    const after = await step('V reloads again: the new version renders and the old one is gone from IndexedDB', async () => {
      await page.reload({ waitUntil: 'domcontentloaded', timeout: 20000 });
      await waitForSite(page, { timeoutMs: 30000, since: reloadAt, label: 'new version' });
      const info = await siteInfo(page);
      assert(info.btih === pub2.btih, 'V renders ' + info.btih + ', expected the new ' + pub2.btih);
      const version = await waitUntil(() => inFrame(page, () => { const s = document.querySelector('[data-about="version"]'); return s && s.textContent !== '...' ? s.textContent : null; }), { timeoutMs: 10000, label: 'about.json version' });
      assert(version === '2.0.1-e2e', 'the frame shows version ' + version);
      const sites = await waitUntil(async () => { const list = await storedSites(page); return list.indexOf(oldBtih) < 0 && list.indexOf(pub2.btih) >= 0 ? list : null; }, { timeoutMs: 15000, label: 'old version deleted' });
      await waitUntil(() => v.announces.some((a) => a.btih === pub2.btih && a.t >= reloadAt), { timeoutMs: 20000, label: 'new version announced' });
      await sleep(3000);
      const old = v.announces.filter((a) => a.btih === oldBtih && a.t >= reloadAt + 1000 && a.event !== 'stopped');
      assert(!old.length, 'V announced the old version after the reload: ' + JSON.stringify(old.slice(0, 3)));
      const tracked = stack.tracker.announces.filter((a) => a.btih === oldBtih && a.t >= reloadAt + 1000 && a.event !== 'stop');
      assert(!tracked.length, 'the tracker received announces for the old version after the reload: ' + tracked.length);
      return { sites, version };
    });
    // Code review round 1 (F05): two tabs across a publish. V's engine tab stays open on the current
    // version while the owner publishes again; a second tab opened afterwards finds the new record, and
    // after its reload renders the new version (from V's engine tab, or downloading it itself when that
    // tab does not answer), while the first tab stops sharing the version it shows.
    const pub3 = await step('publish a third version (seq + 2) while V\'s engine tab stays open', async () => {
      const dir = join(stack.runDir, 'example-v3');
      cpSync(join(ROOT, 'examples', 'peer-guestbook'), dir, { recursive: true });
      const about = JSON.parse(readFileSync(join(dir, 'data', 'about.json'), 'utf8'));
      about.version = '3.0.1-e2e';
      writeFileSync(join(dir, 'data', 'about.json'), JSON.stringify(about, null, 2) + '\n');
      const r = await publish({
        dir, name: SITE_NAME, scope: '127.0.0.1', key: stack.owner.file, out: stack.outDir, policy: 'open', bits: 4,
        tr: [stack.tracker.url], ws: [stack.origin + 'ws/'], cs: stack.origin + 'ws/genesis.json', moderator: [stack.moderator.pub],
        exp: 30, seq: Number(stack.pub.record.seq) + 2, quiet: true, idp: stack.idp.url,
      });
      stack.dev.setPointer(r.pointer);
      return r;
    });
    const twoTabs = await step('a second tab of V renders the third version; the first tab stops announcing the second', async () => {
      const tab2 = await v.newPage();
      const t0 = Date.now();
      await tab2.goto(ctx.origin, { waitUntil: 'domcontentloaded', timeout: 20000 });
      // The worker answers with the cached shell; its page-tag check finds the newer record and says so.
      await waitUntil(() => tab2.evaluate((text) => document.body.textContent.indexOf(text) >= 0, STRINGS.updateAvailable), { timeoutMs: 20000, label: 'update banner in the second tab' });
      const supersededAt = Date.now();
      await tab2.reload({ waitUntil: 'domcontentloaded', timeout: 20000 });
      const rendered = await waitUntil(async () => {
        const info = await siteInfo(tab2).catch(() => null);
        return info && info.btih === pub3.btih ? info : null;
      }, { timeoutMs: 45000, label: 'the second tab renders the third version' });
      await sleep(3000);
      const late = v.announces.filter((a) => a.btih === pub2.btih && a.t > supersededAt + 1500 && a.event !== 'stopped');
      assert(!late.length, 'the engine tab still announced the superseded version: ' + JSON.stringify(late.slice(0, 3)));
      return { ms: Date.now() - t0, source: rendered.source };
    });
    await ctx.closeAll();
    return 'update found on the first reload, old version not announced after it; second reload renders ' + pub2.btih.slice(0, 12) + '... (version ' + after.version + '), IndexedDB holds ' + after.sites.length + ' site(s), no announce of ' + oldBtih.slice(0, 12) + '...; two tabs across a publish: the second tab rendered ' + pub3.btih.slice(0, 12) + '... in ' + twoTabs.ms + ' ms (source ' + twoTabs.source + '), the first stopped announcing the superseded version';
  },
};

// navigator.connection reports cellular (init script): a metered visitor (examples/existing-site-dropin/EXPECTED.md check 8).
function cellularConnection() {
  const conn = { type: 'cellular', effectiveType: '4g', saveData: false, addEventListener() {}, removeEventListener() {} };
  try {
    Object.defineProperty(Navigator.prototype, 'connection', { get: () => conn, configurable: true });
  } catch (_) { /* leave it */ }
}

SCENARIOS['10B'] = {
  title: 'drop-in fixture, continued: consent before any tracker, the notice in a closed shadow root, peers for a metered visitor, fails open, offline pages',
  async fn(ctx, step) {
    const { stack } = ctx;
    const notes = [];
    const site = await step('publish the fixture (--dropin) on a fresh host', () => dropinSite(ctx, 'b'));
    const btih = site.pub.btih;
    // v0.2.1 B2: the ledger swarm is the rendezvous infohash sha1hex("mw-ledger/1/" + ledgerId), joined
    // by the drop-in engine through TorrentManager.addAnchor (the deprecated alias of addRendezvous).
    const anchor = await rendezvousInfoHash(site.pub.ledgerId);
    // Only this scenario's announces: the fixture has the example site's owner and scope (127.0.0.1),
    // so its ledger rendezvous is the same swarm the shell scenarios announced earlier.
    const since = Date.now();
    const announcesFor = (h) => stack.tracker.announces.filter((a) => a.btih === h && a.t >= since);

    // (6, 7) Nothing reaches a tracker before consent and 3 s visible; the notice is in a closed shadow root.
    const da = await ctx.visitor('DA');
    const pa = await da.newPage();
    await step('first view: the copy comes from the web seed while nothing talks to the tracker', async () => {
      await pa.goto(site.host.url, { waitUntil: 'load', timeout: 20000 });
      await waitUntil(async () => { const s = await dropinState(pa); return s && s.copy ? s : null; }, { timeoutMs: 20000, label: 'copy' });
    });
    const shown = await step('after 3 s visible: the notice, in a closed shadow root, and still no tracker contact', async () => {
      // v0.2.1 C1: the drop-in first-run card ([Share and load] [Load from host only], was [Settings] [OK]).
      const rect = await waitUntil(() => pa.evaluate((label) => window.__mwDropin.rectOf(label), STRINGS.consentShare), { timeoutMs: 10000, label: 'card "Share and load" button' });
      const closed = await pa.evaluate(() => { const host = document.querySelector('[data-mw-ui]'); return !!host && host.shadowRoot === null; });
      assert(closed, 'the notice is not in a closed shadow root');
      const refusal = await pa.evaluate((label) => window.__mwDropin.rectOf(label), STRINGS.consentHostOnly);
      assert(refusal, 'no same-layer "' + STRINGS.consentHostOnly + '" on the card (C1)');
      assert(!announcesFor(btih).length && !announcesFor(anchor).length, 'the tracker saw an announce before consent');
      assert(!da.sockets.length, 'a WebSocket opened before consent: ' + da.sockets.map((s) => s.url).join(', '));
      // Post-wave fix H: no peer connection and nothing passed on before the choice.
      const pcs = await pa.evaluate(() => window.__mwE2EPc || 0);
      assert(pcs === 0, pcs + ' RTCPeerConnection(s) before consent');
      const before = await dropinState(pa);
      assert(before && before.uploaded === 0, 'progress.uploaded is ' + (before && before.uploaded) + ' before consent');
      return rect;
    });
    const okAt = Date.now();
    await step('a real mouse click on "Share and load"; the site torrent and the ledger rendezvous swarm are announced', async () => {
      await pa.mouse.click(shown.x + shown.width / 2, shown.y + shown.height / 2);
      await waitUntil(() => announcesFor(btih).length > 0 && announcesFor(anchor).length > 0, { timeoutMs: 15000, label: 'site and rendezvous announced' });
      const st = await dropinState(pa);
      assert(st.consent === 'accepted', 'consent is ' + st.consent);
      const rec = st.consentRecord;
      assert(rec && rec.v === CONFIG.consent.version && rec.choice === 'accepted' && /^\d{4}-\d{2}-\d{2}$/.test(rec.day), 'the versioned consent record (C1): ' + JSON.stringify(rec));
    });
    notes.push('0 announces before consent, site + rendezvous ' + (Math.min(...announcesFor(btih).map((a) => a.t)) - okAt) + ' ms after "Share and load"');

    // (8) A metered visitor gets no web seed and completes the copy from DA.
    const db = await Visitor.open(ctx.browser, 'DB', run, { initScripts: [cellularConnection] });
    ctx.visitors.set('DB', db);
    const pb = await db.newPage();
    const peers = await step('a metered (cellular) visitor: web seed off, the copy comes from the first visitor after consent', async () => {
      await pb.goto(site.host.url, { waitUntil: 'load', timeout: 20000 });
      await waitUntil(async () => { const s = await dropinState(pb); return s && (s.logs || []).some((l) => /web seed off \(metered\)/.test(l)) ? s : null; }, { timeoutMs: 15000, label: 'web seed off (metered)' });
      // v0.2.1 A4: a site cannot accept; the visitor clicks "Share and load" in the loader-owned card (a real click).
      const ok = await waitUntil(() => pb.evaluate((label) => window.__mwDropin.rectOf(label), STRINGS.consentShare), { timeoutMs: 10000, label: 'metered visitor card "Share and load" button' });
      await pb.mouse.click(ok.x + ok.width / 2, ok.y + ok.height / 2);
      const s = await waitUntil(async () => { const x = await dropinState(pb); return x && x.copy ? x : null; }, { timeoutMs: 30000, label: 'copy from peers' });
      assert(s.source === 'peers', 'metered source ' + s.source);
      // v0.2.1 B2: a metered visitor with uploads off leaves the version swarm once the copy is complete; it
      // stays connected through the ledger rendezvous swarm, which it joins after a 0 to 1.5 s jitter.
      const linked = await waitUntil(async () => { const x = await dropinState(pb); return x && x.peers >= 1 ? x : null; }, { timeoutMs: 10000, label: 'metered visitor connected through the rendezvous swarm' });
      assert(linked.peers >= 1, 'metered peers ' + linked.peers);
      return linked;
    });
    notes.push('metered visitor: copy from peers (' + peers.peers + ' peer)');
    await ctx.closeVisitor('DB');
    await ctx.closeVisitor('DA');

    // (10) Fails open: a page without the stamp, and a stamp for another host.
    copyFileSync(join(site.src.dir, 'about.html'), join(site.outDir, 'site', 'unstamped.html'));
    const other = await step('publish the fixture with a stamp for another host (other.example)', () => dropinSite(ctx, 'other', { scope: 'other.example' }));
    const dc = await ctx.visitor('DC');
    const pc = await dc.newPage();
    await step('no stamp: one warning, engine off (no-stamp), the page works, mw.db.set rejects with E_IDENTITY', async () => {
      const before = dc.lines.filter((l) => /console\.warning: .*mw-pointer/.test(l)).length;
      await pc.goto(site.host.url + 'unstamped.html', { waitUntil: 'load', timeout: 20000 });
      const st = await waitUntil(async () => { const s = await dropinState(pc); return s && s.off ? s : null; }, { timeoutMs: 15000, label: 'engine off' });
      assert(st.off === 'no-stamp', 'off is ' + st.off);
      const f = await fixtureState(pc);
      assert(f && f.jsRan, 'the page script did not run');
      const err = await pc.evaluate(() => window.mw.db.set('k', 'v').then(() => null, (e) => e && e.code));
      assert(err === 'E_IDENTITY', 'mw.db.set rejected with ' + err);
      const warns = dc.lines.filter((l) => /console\.warning: .*mw-pointer/.test(l)).length - before;
      assert(warns === 1, warns + ' warnings mentioning mw-pointer');
    });
    await step('a stamp signed for another host: engine off (pointer:bad-sig), the page works', async () => {
      await pc.goto(other.host.url, { waitUntil: 'load', timeout: 20000 });
      const st = await waitUntil(async () => { const s = await dropinState(pc); return s && s.off ? s : null; }, { timeoutMs: 15000, label: 'engine off' });
      assert(st.off === 'pointer:bad-sig', 'off is ' + st.off);
      const f = await fixtureState(pc);
      assert(f && f.jsRan, 'the page script did not run');
    });
    await ctx.closeVisitor('DC');
    notes.push('fails open: no-stamp and pointer:bad-sig, pages work');

    // Offline: pages viewed under the worker keep loading; others get the worker's offline page.
    const dd = await ctx.visitor('DD');
    const pd = await dd.newPage();
    await step('view /, /about.html and /blog/post-1.html (the last two under the worker)', async () => {
      await pd.goto(site.host.url, { waitUntil: 'load', timeout: 20000 });
      await waitUntil(async () => { const s = await dropinState(pd); return s && s.copy ? s : null; }, { timeoutMs: 20000, label: 'copy' });
      for (const p of ['about.html', 'blog/post-1.html']) {
        await pd.goto(site.host.url + p, { waitUntil: 'load', timeout: 20000 });
        await waitUntil(async () => { const s = await dropinState(pd); return s && s.copy && s.copy.fromCache ? s : null; }, { timeoutMs: 20000, label: p + ' from the copy' });
      }
      await sleep(500); // the worker keeps the documents in IndexedDB after the response
    });
    site.host.down(true);
    try {
      const off = await step('host down: the visited pages load styled with their script; unvisited URLs get the offline page', async () => {
        const out = {};
        for (const p of ['/about.html', '/blog/post-1.html']) {
          const res = await pd.goto(site.host.url.replace(/\/$/, '') + p, { waitUntil: 'load', timeout: 20000 });
          const f = await waitUntil(() => fixtureState(pd), { timeoutMs: 10000, label: p + ' script' });
          const styled = await pd.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--accent').trim());
          assert(res && res.status() === 200 && f.jsRan && styled, p + ' offline: status ' + (res && res.status()) + ', script ' + (f && f.jsRan) + ', accent ' + JSON.stringify(styled));
          out[p] = res.status();
        }
        for (const p of ['/app/settings', '/never-visited.html']) {
          const res = await pd.goto(site.host.url.replace(/\/$/, '') + p, { waitUntil: 'load', timeout: 20000 });
          const title = await pd.title();
          assert(res && res.status() === 503 && /offline/i.test(title), p + ' offline: status ' + (res && res.status()) + ', title ' + JSON.stringify(title));
          out[p] = res.status();
        }
        return out;
      });
      notes.push('offline: ' + Object.keys(off).map((k) => k + ' ' + off[k]).join(', '));
    } finally {
      site.host.down(false);
      await ctx.closeVisitor('DD');
    }
    return notes.join('; ');
  },
};

const POLYFILLED = ['toHex', 'toBase64', 'fromHex', 'fromBase64', 'timeout'];

async function polyfillState(page) {
  return page.evaluate(() => ({
    polyfilled: ((window.__mwBoot || {}).polyfilled || []).slice(),
    deleted: window.__mwE2ENativeDeleted || null,
    stage: (window.__mwBoot || {}).stage || null,
  }));
}

function checkPolyfilled(p, who) {
  assert(p.deleted && p.deleted.toHex === 'undefined' && p.deleted.fromHex === 'undefined', who + ': the init script did not remove the native methods: ' + JSON.stringify(p.deleted));
  const missing = POLYFILLED.filter((name) => p.polyfilled.indexOf(name) < 0);
  assert(!missing.length, who + ': boot.js did not install ' + missing.join(', ') + ' (polyfilled: ' + JSON.stringify(p.polyfilled) + ')');
}

SCENARIOS[14] = {
  title: 'WebKit and Chromium complete a download with the polyfills; a context without Service Workers renders styled with mw.ready()',
  async fn(ctx, step) {
    const { stack } = ctx;
    const notes = [];
    // (a) WebKit, native hex/base64 removed, consent pending: HTTP to 127.0.0.1 only (docs/DEV-NETWORK.md).
    const webkit = await step('launch Playwright WebKit', () => launchWebkit({ headless: !HEADED }));
    assert(webkit, 'Playwright WebKit is not installed (npx playwright install webkit)');
    try {
      const v = await Visitor.open(webkit, 'webkit14', run, { initScripts: [deleteNativeEncodings] });
      const page = await v.newPage();
      const t0 = Date.now();
      const r = await step('WebKit without native Uint8Array hex/base64: the first visit downloads from the web seed and renders', async () => {
        await page.goto(ctx.origin, { waitUntil: 'domcontentloaded', timeout: 20000 });
        return waitForSite(page, { timeoutMs: 30000, since: t0, label: 'WebKit with polyfills' });
      });
      checkPolyfilled(await polyfillState(page), 'WebKit');
      const st = await shellState(page);
      assert(st && st.mounted && !st.degraded, 'WebKit rendered in degraded mode');
      const info = await step('WebKit: mw.site.info()', () => siteInfo(page));
      assert(info.source === 'webseed', 'WebKit source is ' + info.source);
      checkFrame(await step('WebKit: heading, CSS, image, fetch and MP4 Range', () => frameChecks(page)));
      notes.push('WebKit ' + webkit.version() + ' polyfilled, web seed, ' + r.ms + ' ms');
      await v.close();
    } finally {
      await webkit.close().catch(() => {});
    }

    // (b) Chromium, native hex/base64 removed, the copy from a peer (the web seed's file bytes refused).
    const seeder = await ctx.visitor('seed14');
    const sp = await seeder.newPage();
    const seeded = await step('a seeder page seeds the published torrent', async () => {
      await sp.goto(ctx.origin + '_dev/seeder.html?tr=' + encodeURIComponent(stack.tracker.url), { waitUntil: 'domcontentloaded', timeout: 20000 });
      return waitUntil(() => sp.evaluate(() => (window.__seeder && (window.__seeder.ok || window.__seeder.error) ? window.__seeder : null)), { timeoutMs: 30000, label: 'seeder ready' });
    });
    assert(seeded.ok, 'seeder failed: ' + seeded.error);
    stack.gate.setBlock(blockSiteFiles(stack));
    try {
      const v = await Visitor.open(ctx.browser, 'poly14', run, { initScripts: [deleteNativeEncodings] });
      ctx.visitors.set('poly14', v);
      const page = await v.newPage();
      const t0 = Date.now();
      const r = await step('Chromium without native Uint8Array hex/base64: downloads from the seeder and renders', async () => {
        await page.goto(ctx.origin, { waitUntil: 'domcontentloaded', timeout: 20000 });
        await acceptConsent(page, { timeoutMs: 20000 });
        return waitForSite(page, { timeoutMs: 45000, since: t0, label: 'Chromium with polyfills' });
      });
      checkPolyfilled(await polyfillState(page), 'Chromium');
      const info = await step('Chromium polyfilled: mw.site.info()', () => siteInfo(page));
      assert(info.source === 'peers', 'source is ' + info.source + ', expected peers');
      checkFrame(await step('Chromium polyfilled: heading, CSS, image, fetch and MP4 Range', () => frameChecks(page)));
      notes.push('Chromium polyfilled, from a peer, ' + r.ms + ' ms');
    } finally {
      stack.gate.setBlock(null);
      await ctx.closeVisitor('poly14');
      await ctx.closeVisitor('seed14');
    }

    // (c) A context that cannot register Service Workers: degraded mode (section 7.4).
    const nv = await Visitor.open(ctx.browser, 'nosw14', run, { serviceWorkers: 'block' });
    ctx.visitors.set('nosw14', nv);
    try {
      const page = await nv.newPage();
      const t0 = Date.now();
      const r = await step('serviceWorkers: block: the site renders in limited mode', async () => {
        await page.goto(ctx.origin, { waitUntil: 'domcontentloaded', timeout: 20000 });
        return waitForSite(page, { timeoutMs: 45000, since: t0, label: 'degraded render' });
      });
      const st = await shellState(page);
      assert(st && st.degraded === true && st.mounted, 'the page is not in degraded mode: ' + JSON.stringify(st && { degraded: st.degraded, mounted: st.mounted }));
      const regs = await page.evaluate(async () => (navigator.serviceWorker ? (await navigator.serviceWorker.getRegistrations()).length : -1));
      assert(regs <= 0, 'a Service Worker registered in a blocking context');
      const banner = await page.evaluate(() => document.body.textContent);
      assert(banner.indexOf(STRINGS.limitedMode) >= 0, 'no "' + STRINGS.limitedMode + '" banner');
      const styled = await step('limited mode: the stylesheet and the image apply', () => inFrame(page, async () => {
        const img = document.querySelector('img.logo');
        if (img && !img.complete) await new Promise((res) => { img.onload = img.onerror = res; setTimeout(res, 5000); });
        return {
          radius: getComputedStyle(document.documentElement).getPropertyValue('--radius').trim(),
          img: img ? img.naturalWidth : -1,
          h1: ((document.querySelector('h1') || {}).textContent || '').trim(),
        };
      }));
      assert(styled.radius === '14px', 'limited mode: the stylesheet did not apply (--radius = ' + JSON.stringify(styled.radius) + ')');
      assert(styled.img > 0, 'limited mode: the image did not load');
      const ready = await step('limited mode: mw.ready() resolves through the SDK', () => inFrame(page, async () => {
        const mod = await import('/_mw/sdk.js');
        const mw = mod.default;
        const info = await Promise.race([mw.ready(), new Promise((res) => setTimeout(() => res(null), 15000))]);
        return info ? { siteId: info.siteId, btih: info.btih, mode: info.mode, role: info.role } : null;
      }));
      assert(ready, 'mw.ready() did not resolve within 15 s');
      assert(ready.btih === ctx.btih, 'mw.ready() btih ' + ready.btih);
      // Code review round 1: the limited-mode document has the address-bar URL (written into a
      // same-origin frame, not about:srcdoc), so history routers work.
      const where = await step('limited mode: location.pathname is the address-bar path and history.pushState works', () => inFrame(page, () => {
        const before = location.pathname;
        let pushed = null;
        try {
          history.pushState({}, '', '/about-test');
          pushed = location.pathname;
          history.replaceState({}, '', before);
        } catch (err) {
          pushed = 'threw ' + err.name;
        }
        return { before, top: window.top.location.pathname, pushed };
      }));
      assert(where.before === where.top, 'limited-mode location.pathname is ' + JSON.stringify(where.before) + ', the address bar ' + JSON.stringify(where.top));
      assert(where.pushed === '/about-test', 'history.pushState in limited mode: ' + where.pushed);
      notes.push('no Service Worker: limited mode, styled, mw.ready() ' + JSON.stringify(ready) + ', pathname ' + where.before + ', ' + r.ms + ' ms');
    } finally {
      await ctx.closeVisitor('nosw14');
    }

    // Code review round 1 (§7.4): limited mode decided after boot.js fixed the normal CSP reloads once
    // into limited mode (the degraded CSP), styled, with mw.ready(): storage full, an install that
    // never settles, and a register() that fails after the 3 s probe.
    const limitedAfterReload = async (name, label, { initScripts = [], route = null, timeoutMs = 45000 } = {}) => {
      if (route) stack.gate.setRoute(route);
      const v = await Visitor.open(ctx.browser, name, run, { initScripts });
      ctx.visitors.set(name, v);
      try {
        const page = await v.newPage();
        let navigations = 0;
        page.on('framenavigated', (f) => { if (f === page.mainFrame()) navigations++; });
        const t0 = Date.now();
        const res = await step(label + ': limited mode after at most one reload, styled', async () => {
          await page.goto(ctx.origin, { waitUntil: 'domcontentloaded', timeout: 20000 });
          await waitUntil(async () => {
            const st = await shellState(page).catch(() => null);
            return st && st.mounted && st.degraded ? st : null;
          }, { timeoutMs, label: label + ' limited render' });
          return Date.now() - t0;
        });
        const styled = await inFrame(page, async () => {
          const slot = document.querySelector('[data-about]');
          for (let i = 0; i < 50 && slot && slot.textContent === '...'; i++) await new Promise((r) => setTimeout(r, 100));
          return {
            radius: getComputedStyle(document.documentElement).getPropertyValue('--radius').trim(),
            scriptRan: !!slot && slot.textContent !== '...',
          };
        });
        const csp = await page.evaluate(() => (window.__mwBoot ? window.__mwBoot.cspKind : null));
        assert(csp === 'degraded', label + ': the page runs under the ' + csp + ' CSP');
        assert(styled.radius === '14px', label + ': the stylesheet did not apply in limited mode (--radius ' + JSON.stringify(styled.radius) + ')');
        assert(styled.scriptRan, label + ': the site script did not run in limited mode');
        const ready = await inFrame(page, async () => {
          const mod = await import('/_mw/sdk.js');
          const info = await Promise.race([mod.default.ready(), new Promise((r) => setTimeout(() => r(null), 15000))]);
          return info ? info.btih : null;
        });
        assert(ready === ctx.btih, label + ': mw.ready() gave ' + ready);
        assert(navigations <= 2, label + ': ' + navigations + ' navigations (at most one reload)');
        return label + ' ' + res + ' ms, ' + (navigations - 1) + ' reload(s)';
      } finally {
        if (route) stack.gate.setRoute(null);
        await ctx.closeVisitor(name);
      }
    };
    const quota = () => {
      const put = IDBObjectStore.prototype.put;
      IDBObjectStore.prototype.put = function (...args) {
        if (this.name === 'files') throw new DOMException('The quota has been exceeded.', 'QuotaExceededError');
        return put.apply(this, args);
      };
    };
    notes.push(await limitedAfterReload('quota14', 'storage full (QuotaExceededError on every file put)', { initScripts: [quota] }));
    const swPath = (req) => String(req.url || '').split('?')[0] === '/mw-sw.js';
    notes.push(await limitedAfterReload('hang14', 'a worker whose install never settles', {
      route: (req, res) => {
        if (!swPath(req)) return false;
        res.writeHead(200, { 'content-type': 'text/javascript', 'cache-control': 'no-store' });
        res.end("self.addEventListener('install', (e) => e.waitUntil(new Promise(() => {})));\n");
        return true;
      },
      timeoutMs: 50000,
    }));
    notes.push(await limitedAfterReload('late14', 'register() fails after the 3 s probe (500 after 4 s)', {
      route: (req, res) => {
        if (!swPath(req)) return false;
        setTimeout(() => {
          res.writeHead(500, { 'content-type': 'text/plain', 'cache-control': 'no-store' });
          res.end('no worker today\n');
        }, 4000);
        return true;
      },
    }));
    return notes.join('; ');
  },
};

SCENARIOS.W7 = {
  title: 'WebKit: cold start through xs + ws (127.0.0.1 only, consent pending), source webseed',
  async fn(ctx, step) {
    const webkit = await step('launch Playwright WebKit', () => launchWebkit({ headless: !HEADED }));
    assert(webkit, 'Playwright WebKit is not installed (npx playwright install webkit)');
    try {
      const v = await Visitor.open(webkit, 'webkit', run);
      const page = await v.newPage();
      let t0 = 0;
      const rendered = await step('first visit renders from the web seed', async () => {
        t0 = Date.now();
        await page.goto(ctx.origin, { waitUntil: 'domcontentloaded', timeout: 20000 });
        return waitForSite(page, { timeoutMs: 30000, since: t0, label: 'WebKit cold start' });
      });
      const st = await shellState(page);
      assert(st && st.mounted && !st.degraded, 'WebKit rendered in degraded mode: ' + JSON.stringify(st && { degraded: st.degraded, log: st.log.slice(-5) }));
      const info = await step('mw.site.info() through the SDK', () => siteInfo(page));
      assert(info.source === 'webseed', 'source is ' + info.source);
      checkFrame(await step('heading, CSS, image, fetch and MP4 Range in the frame', () => frameChecks(page)));
      await v.close();
      return 'WebKit ' + webkit.version() + ' rendered in ' + rendered.ms + ' ms, Service Worker in control';
    } finally {
      await webkit.close().catch(() => {});
    }
  },
};

// Code review round 1 (F19): an iframe has no viewport, so the shell's meta decides the site's layout on
// phones. The shell must take the site's own: no meta (980 px), a fixed width (1024) and device-width
// (390) lay out in the frame exactly as on the plain host, in Chromium's phone emulation.
const VIEWPORT_PAGES = {
  'index.html': '<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>VP home</title></head><body><h1>VP home</h1></body></html>\n',
  'novp.html': '<!doctype html><html><head><meta charset="utf-8"><title>VP none</title></head><body><h1>VP none</h1><p>No viewport meta: the browser default applies.</p></body></html>\n',
  'wide.html': '<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=1024"><title>VP wide</title></head><body><h1>VP wide</h1></body></html>\n',
  'dw.html': '<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>VP device</title></head><body><h1>VP device</h1></body></html>\n',
};

SCENARIOS.VIEWPORT = {
  title: 'Phone viewport: the site in the shell lays out with its own viewport (none, width=1024, device-width), as on the plain host',
  async fn(ctx, step) {
    const { stack } = ctx;
    const site = await step('publish a three-page site, serve it on a second dev server and on a plain host', async () => {
      const dir = join(stack.runDir, 'viewport-site');
      mkdirSync(dir, { recursive: true });
      for (const [p, c] of Object.entries(VIEWPORT_PAGES)) writeFileSync(join(dir, p), c);
      const outDir = join(stack.runDir, 'viewport-publish');
      const dev = await createDevServer({ root: stack.dist, webseed: outDir, port: 0, host: '127.0.0.1', dev: true, quiet: true });
      ctx.closers.push(() => dev.close());
      const pub = await publish({
        dir, name: 'mw-viewport', scope: '127.0.0.1', key: stack.owner.file, out: outDir, policy: 'open', bits: 4,
        tr: [stack.tracker.url], ws: [dev.url + 'ws/'], exp: 30, quiet: true,
      });
      dev.setPointer(pub.pointer);
      const route = staticRoute(dir);
      const plain = http.createServer((req, res) => { if (!route(req, res)) { res.writeHead(404); res.end(); } });
      await new Promise((resolve) => plain.listen(0, '127.0.0.1', resolve));
      ctx.closers.push(() => new Promise((resolve) => { plain.closeAllConnections(); plain.close(() => resolve()); }));
      return { dev, plainUrl: 'http://127.0.0.1:' + plain.address().port + '/', pub };
    });
    const phone = { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 3 };
    const v = await ctx.visitor('PHONE', { contextOptions: phone });
    const page = await v.newPage();
    const pages = ['novp.html', 'wide.html', 'dw.html'];
    const plain = await step('the plain host: innerWidth of each page in phone emulation', async () => {
      const w = {};
      for (const p of pages) {
        await page.goto(site.plainUrl + p, { waitUntil: 'load', timeout: 20000 });
        w[p] = await page.evaluate(() => window.innerWidth);
      }
      assert(w['novp.html'] === 980 && w['wide.html'] === 1024 && w['dw.html'] === 390, 'unexpected plain-host widths ' + JSON.stringify(w));
      return w;
    });
    const shell = await step('the shell: the same pages in the site frame have the same innerWidth', async () => {
      const w = {};
      const metas = {};
      let first = true;
      for (const p of pages) {
        const t0 = Date.now();
        await page.goto(site.dev.url + p, { waitUntil: 'domcontentloaded', timeout: 20000 });
        if (first) {
          await acceptConsent(page, { timeoutMs: 20000 });
          // The choice is written to IndexedDB asynchronously; a top-level navigation before the write
          // commits would abort it, so wait for the stored record before leaving the page.
          await waitUntil(async () => { const rec = await readPref(page, 'consent'); return rec && rec.choice === 'accepted' ? rec : null; }, { timeoutMs: 5000, label: 'stored consent' });
        }
        first = false;
        await waitForSite(page, { timeoutMs: 30000, since: t0, label: 'shell ' + p, h1: /^VP / });
        w[p] = await waitUntil(async () => {
          const got = await inFrame(page, () => window.innerWidth);
          return got === plain[p] ? got : null;
        }, { timeoutMs: 5000, stepMs: 100, label: p + ' frame width ' + plain[p] }).catch(async () => inFrame(page, () => window.innerWidth));
        metas[p] = await page.evaluate(() => { const m = document.querySelector('meta[name="viewport"]'); return m ? m.getAttribute('content') : null; });
      }
      for (const p of pages) assert(w[p] === plain[p], p + ': frame innerWidth ' + w[p] + ', plain host ' + plain[p] + ' (shell meta ' + JSON.stringify(metas[p]) + ')');
      assert(metas['novp.html'] === 'width=980', 'the shell kept its own viewport for a site without one: ' + metas['novp.html']);
      assert(!/viewport-fit|interactive-widget/.test(String(metas['dw.html'])), 'the shell added options the site does not declare: ' + metas['dw.html']);
      return { w, metas };
    });
    // Code review round 1 (F43): a site without its own background is drawn on the page canvas colour
    // (white in light mode), not on the shell's grey: the blank area under the heading matches the plain host.
    await step('light mode: the blank area of a page without a background looks as on the plain host', async () => {
      const clip = { x: 0, y: 140, width: 390, height: 160 };
      const inShell = await page.screenshot({ clip });
      if (process.env.MW_E2E_SHOTS) {
        const dbg = await page.evaluate(() => ({ consent: window.__mwShell ? window.__mwShell.inspect().consent : null, notice: Array.from(document.querySelectorAll('.mw-notice')).map((n) => ({ hidden: n.hidden, text: n.textContent.slice(0, 60) })), log: window.__mwShell ? window.__mwShell.inspect().log.slice(-12) : null }));
        writeFileSync(join(process.env.MW_E2E_SHOTS, 'viewport-debug.json'), JSON.stringify(dbg, null, 2));
        writeFileSync(join(process.env.MW_E2E_SHOTS, 'viewport-shell.png'), inShell);
        writeFileSync(join(process.env.MW_E2E_SHOTS, 'viewport-shell-full.png'), await page.screenshot());
      }
      await page.goto(site.plainUrl + 'dw.html', { waitUntil: 'load', timeout: 20000 });
      const direct = await page.screenshot({ clip });
      if (process.env.MW_E2E_SHOTS) writeFileSync(join(process.env.MW_E2E_SHOTS, 'viewport-plain.png'), direct);
      assert(inShell.equals(direct), 'the frame background differs from the plain host (' + inShell.length + ' vs ' + direct.length + ' bytes of PNG)');
    });
    await ctx.closeVisitor('PHONE');
    return 'frame innerWidth ' + pages.map((p) => p + ' ' + shell.w[p]).join(', ') + ' equals the plain host';
  },
};

// Code review round 1 (F02): importing the stock WebTorrent bundle deleted the origin's OPFS "chunks"
// directory (and installed a File System Access polyfill on the page's globals). The build patches both
// out; a file the site keeps there must survive the shell and the drop-in runtime.
async function writeOpfsKeep(page) {
  return page.evaluate(async () => {
    const root = await navigator.storage.getDirectory();
    const dir = await root.getDirectoryHandle('chunks', { create: true });
    const fh = await dir.getFileHandle('keep.txt', { create: true });
    const w = await fh.createWritable();
    await w.write('kept by the site');
    await w.close();
    return true;
  });
}

async function readOpfsKeep(page) {
  return page.evaluate(async () => {
    try {
      const root = await navigator.storage.getDirectory();
      const dir = await root.getDirectoryHandle('chunks');
      const fh = await dir.getFileHandle('keep.txt');
      return await (await fh.getFile()).text();
    } catch (err) {
      return 'missing (' + (err && err.name) + ')';
    }
  });
}

SCENARIOS.OPFS = {
  title: 'OPFS: a file the site keeps in /chunks survives the shell and the drop-in runtime; tools/live.mjs gives consent on a drop-in page',
  async fn(ctx, step) {
    const notes = [];
    // Shell: write before the loader ever ran on this origin (an SVG document of the origin), then render.
    const v = await ctx.visitor('OPFS-S');
    const page = await v.newPage();
    await step('shell origin: the site keeps chunks/keep.txt in OPFS', async () => {
      await page.goto(ctx.origin + '_mw/icons/icon.svg', { waitUntil: 'load', timeout: 20000 });
      assert(await writeOpfsKeep(page), 'could not write to OPFS');
    });
    await step('the shell renders the site (the WebTorrent bundle is loaded)', async () => {
      const t0 = Date.now();
      await page.goto(ctx.origin, { waitUntil: 'domcontentloaded', timeout: 20000 });
      await acceptConsent(page, { timeoutMs: 20000 });
      await waitForSite(page, { timeoutMs: 30000, since: t0, label: 'OPFS shell' });
      await waitUntil(async () => { const st = await shellState(page); return st && st.mounted ? st : null; }, { timeoutMs: 10000, label: 'mounted' });
    });
    const shellKeep = await step('chunks/keep.txt is still there', async () => {
      const text = await readOpfsKeep(page);
      assert(text === 'kept by the site', 'after the shell ran: ' + text);
      // The bundle's File System Access polyfill (createWritable through a blob: Worker) is patched out;
      // in Chromium the method is native anyway, so this only guards against a regression that replaces it.
      const native = await page.evaluate(() => typeof FileSystemFileHandle !== 'function' || /\[native code\]/.test(String(FileSystemFileHandle.prototype.createWritable)));
      assert(native, 'FileSystemFileHandle.prototype.createWritable was replaced on the page globals');
      return text;
    });
    notes.push('shell: ' + JSON.stringify(shellKeep));
    await ctx.closeVisitor('OPFS-S');
    // Drop-in: the same on the fixture host, where /_mw/mw.js imports the bundle for the copy.
    const d = await step('publish the existing-site fixture (--dropin) on a fresh host', () => dropinSite(ctx, 'opfs'));
    const dv = await ctx.visitor('OPFS-D');
    const dp = await dv.newPage();
    await step('drop-in origin: the site keeps chunks/keep.txt in OPFS', async () => {
      await dp.goto(d.host.url + 'css/app.css', { waitUntil: 'load', timeout: 20000 }).catch(() => dp.goto(d.host.url + 'robots.txt', { waitUntil: 'load', timeout: 20000 }));
      assert(await writeOpfsKeep(dp), 'could not write to OPFS');
    });
    await step('a drop-in page view builds its copy (the bundle is loaded)', async () => {
      await dp.goto(d.host.url, { waitUntil: 'load', timeout: 20000 });
      await waitUntil(async () => { const s = await dropinState(dp); return s && s.copy ? s : null; }, { timeoutMs: 30000, label: 'drop-in copy' });
    });
    const dropKeep = await step('chunks/keep.txt is still there', async () => {
      const text = await readOpfsKeep(dp);
      assert(text === 'kept by the site', 'after the drop-in runtime ran: ' + text);
      return text;
    });
    notes.push('drop-in: ' + JSON.stringify(dropKeep));
    // Code review round 1 (F29, F53): pin.mjs gives consent on drop-in pages through tools/live.mjs, with a
    // real mouse click on the panel's card (closed shadow root; script clicks are ignored).
    await step('tools/live.mjs acceptConsent clicks the drop-in card and the choice is stored', async () => {
      assert(await liveAcceptConsent(dp, { timeoutMs: 20000 }), 'acceptConsent found no card to click');
      const st = await waitUntil(async () => { const s = await dropinState(dp); return s && s.consent === 'accepted' ? s : null; }, { timeoutMs: 10000, label: 'drop-in consent accepted' });
      assert(st.consent === 'accepted', 'consent is ' + st.consent);
    });
    notes.push('live.mjs accepted the drop-in card');
    await ctx.closeVisitor('OPFS-D');
    return notes.join('; ');
  },
};

// 13 publishes a new version for the origin, so it runs last.
// v0.2.1 network scenarios (test/e2e/peer-scenarios.mjs): PEER-CONSENT, PEER-11, PEER-RV, PEER-BLIP, PEER-WS.
Object.assign(SCENARIOS, peerScenarios({ run, assert }));
// v0.2.1 serving-publishing scenarios (test/e2e/scenarios-serving.mjs): SW-INSTALL, PUBLISH-WS.
Object.assign(SCENARIOS, servingScenarios());
// v0.2.1 format scenarios (test/e2e/scenarios-formats.mjs): FMT-SDK, FMT-WITHDRAW (restores the pointer).
Object.assign(SCENARIOS, formatScenarios({ assert }));
// v0.3 wave 1 scenarios (test/e2e/scenarios-v03.mjs, V03-DESIGN-REVIEW Part 4.2): E-SI-1 to 5, E-CH-6M, E-MD-1, 2, 10,
// 7, 8, 9, E-FI-3; with --webkit also W-SI and W-MD. Self-contained (their own servers and contexts), before 13.
Object.assign(SCENARIOS, v03Scenarios({ assert, run, headed: HEADED }));
// v0.3 final integration (test/e2e/scenarios-social.mjs): the social example on a loopback subdomain hub through the real
// loader, SDK and identity origin (E-SO-1, E-SO-2, E-SO-11). Chromium only.
Object.assign(SCENARIOS, socialScenarios({ assert }));
// v0.3 final integration (test/e2e/scenarios-dropin-v03.mjs): the Example Forum's widgets with the real identity origin, drop-in
// engine and chat lane (E-SI-1W: EXPECTED.md checks 11, 13 to 15, 17; E-CH-R: checks 18 and 19).
Object.assign(SCENARIOS, dropinV03Scenarios({ assert }));
// v0.3 final integration (test/e2e/scenarios-identity.mjs): E-ID-1 (passkey, virtual authenticator), 2, 2b, 5, 6, 7, 10.
Object.assign(SCENARIOS, identityScenarios({ assert }));
// v0.3 final integration (test/e2e/scenarios-members.mjs): chat, files and private media between members of one site
// (E-CH-1, E-CH-8, E-CH-6, E-FI-1, E-FI-2, E-MD-4, E-MD-3).
Object.assign(SCENARIOS, membersScenarios({ assert }));
// v0.3 final integration (test/e2e/scenarios-hardening.mjs): E-HD-1, a hostile mw_chain1 peer (HELLO with d = 2^53 - 1).
Object.assign(SCENARIOS, hardeningScenarios({ assert, run }));
// v0.3 C2 (test/e2e/scenarios-calls.mjs, SEEDING-AND-ZERO-SETUP-DESIGN 3.5 "End-to-end"): E-CL-3, E-CL-1, E-CL-2 in a Chromium
// of their own with both fake-media flags; with --webkit also E-CL-1W (one WebKit browser per participant).
Object.assign(SCENARIOS, callsScenarios({ run, assert, headed: HEADED }));
// v0.3 C2 (test/e2e/scenarios-c2.mjs, SEEDING-AND-ZERO-SETUP-DESIGN section 5): E-PS-1 (hand-off to a pin node, receipt, label),
// E-PS-2 (lying bitfields stay "reported"), E-PS-3 (the month cap stops K and E, not H), E-PS-4 (dock mode's Wake Lock taken
// and released) and E-ZS-1 (no DoH query for a nip.io name). Each publishes a site of its own.
Object.assign(SCENARIOS, seedScenarios({ run, assert, headed: HEADED }));
// v0.3 C2 doors (test/e2e/scenarios-doors.mjs, research/v03/S4-doors.md; the doors lane's request 7): DOOR-DOWN, DOOR-HASH,
// DOOR-GUEST on static doors on 127.0.0.1; with --webkit also DOOR-GUEST-W.
Object.assign(SCENARIOS, doorsScenarios({ run, assert, headed: HEADED }));
// v0.3 accessibility lane (test/e2e/scenarios-a11y.mjs, R 4.2 E-ID-9 and E-SO-12): axe-core on the identity origin, the loader's UI,
// the drop-in widgets and the social example; E-ID-9B, a keyboard-only sign-in. Self-contained, Chromium only.
Object.assign(SCENARIOS, a11yScenarios({ assert }));
// Firefox lane (test/e2e/scenarios-firefox.mjs, docs/deviations/firefox.md): with --firefox the F-* variants of the --webkit
// scenarios and the F:<id> scenarios in a Firefox context. Registered last: it wraps the entries above.
// selected: read when an F:<id> ends (ORDER is complete by then), so the Firefox browser closes after the last one.
Object.assign(SCENARIOS, firefoxScenarios({
  SCENARIOS, makeCtx, out, headed: HEADED, selected: () => ORDER.filter((id) => !ONLY.length || ONLY.includes(id)),
}));
const FIREFOX_RUN = flag('--firefox');
const WEBKIT_RUN = flag('--webkit');
const ORDER = [7, 1, 2, 3, 4, 5, 6, 8, 14, 12, 10, '10B', 9, 'VIEWPORT', 'OPFS'].concat(SERVING_ORDER).concat(PEER_ORDER).concat(FORMAT_ORDER)
  .concat(WEBKIT_RUN || ONLY.includes('W7') ? ['W7'] : [])
  .concat(V03_ORDER)
  .concat(V03_WEBKIT_ORDER.filter((id) => WEBKIT_RUN || ONLY.includes(id)))
  .concat(DROPIN_V03_ORDER)
  .concat(SOCIAL_ORDER)
  .concat(IDENTITY_ORDER)
  .concat(MEMBERS_ORDER)
  .concat(CALLS_ORDER)
  .concat(SEED_ORDER)
  .concat(DOORS_ORDER)
  .concat(DOORS_WEBKIT_ORDER.filter((id) => WEBKIT_RUN || ONLY.includes(id)))
  .concat(CALLS_WEBKIT_ORDER.filter((id) => WEBKIT_RUN || ONLY.includes(id)))
  .concat(HARDENING_ORDER)
  .concat(A11Y_ORDER)
  .concat(FIREFOX_ORDER.filter((id) => (FIREFOX_RUN && !FIREFOX_HELD[id]) || ONLY.includes(id)))
  .concat([13]);
// Files and media rows lane (test/e2e/scenarios-media-rows.mjs, R 4.2 E-FI-5, E-FI-6, E-MD-3B, E-MD-5R, E-MD-6; Chromium only), before 13.
{ const r = await import('./scenarios-media-rows.mjs'); Object.assign(SCENARIOS, r.mediaRowsScenarios({ assert, run })); ORDER.splice(ORDER.indexOf(13), 0, ...r.MEDIA_ROWS_ORDER); }
// Identity rows lane (test/e2e/scenarios-identity-rows.mjs, R 4.2 E-ID-3, 3b, 8, 11, 13, 14, 15; Chromium only), before 13.
{ const r = await import('./scenarios-identity-rows.mjs'); Object.assign(SCENARIOS, r.identityRowsScenarios({ assert })); ORDER.splice(ORDER.indexOf(13), 0, ...r.IDENTITY_ROWS_ORDER); }
// Chat rows lane (test/e2e/scenarios-chat-rows.mjs, R 4.2 E-CH-2, 3, 4, 5, 7, 9, 10, 11, 12; a chat lab over real wires; Chromium only), before 13.
{ const r = await import('./scenarios-chat-rows.mjs'); Object.assign(SCENARIOS, r.chatRowsScenarios({ assert, run })); ORDER.splice(ORDER.indexOf(13), 0, ...r.CHAT_ROWS_ORDER); }
// Social rows lane (test/e2e/scenarios-social-rows.mjs, R 4.2 E-SO-3 to E-SO-9 on the loopback subdomain hub; Chromium only), before 13.
{ const r = await import('./scenarios-social-rows.mjs'); Object.assign(SCENARIOS, r.socialRowsScenarios({ assert })); ORDER.splice(ORDER.indexOf(13), 0, ...r.SOCIAL_ROWS_ORDER); }

// ---------------------------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------------------------

async function main() {
  const watchdog = setTimeout(() => {
    out('e2e: stopped by the watchdog after ' + TOTAL_MS + ' ms');
    process.exit(2);
  }, TOTAL_MS);
  const selected = ORDER.filter((id) => !ONLY.length || ONLY.includes(id));
  out('felinar e2e: scenarios ' + selected.join(', ') + ' (Playwright Chromium' + (selected.some((id) => /^W/.test(String(id))) ? ' and WebKit' : '') + (selected.some((id) => FIREFOX_ORDER.includes(id)) ? ' and Firefox' : '') + ', local-only)');
  let stack = null;
  let browser = null;
  let ctx = null;
  const results = new Map();
  try {
    stack = await withTimeout(setupStack({ log: (l) => out(elapsed() + ' setup: ' + l), keep: KEEP }), 60000, 'setup');
    browser = await withTimeout(launchChromium({ headless: !HEADED }), 60000, 'browser launch');
    out(elapsed() + ' setup: chromium ' + browser.version());
    ctx = makeCtx(stack, browser);
    for (const id of selected) {
      const sc = SCENARIOS[id];
      out(elapsed() + ' scenario ' + id + ': ' + sc.title);
      const t = Date.now();
      try {
        const detail = await sc.fn(ctx, stepper(id));
        results.set(id, { ok: true, detail, ms: Date.now() - t });
        out(elapsed() + ' PASS ' + id + ' ' + sc.title + (detail ? ' (' + detail + ')' : ''));
      } catch (err) {
        results.set(id, { ok: false, detail: (err && err.message) || String(err), ms: Date.now() - t });
        out(elapsed() + ' FAIL ' + id + ' ' + sc.title + ': ' + ((err && err.message) || err));
        if (!(err instanceof StepError) && err && err.stack) out(err.stack.split('\n').slice(0, 6).join('\n'));
        for (const v of ctx.visitors.values()) {
          if (v.closed) continue;
          try {
            out(await withTimeout(v.report(), 15000, 'report ' + v.name));
          } catch (e) {
            out('--- ' + v.name + ': no report (' + e.message + ')');
          }
        }
        // Later scenarios build on earlier state; a broken gate state must not leak.
        stack.gate.setBlock(null);
        stack.gate.setDown(false);
      }
    }
  } catch (err) {
    out('e2e: setup failed: ' + ((err && err.stack) || err));
    results.set(0, { ok: false, detail: 'setup failed' });
  } finally {
    if (browser) await withTimeout(browser.close(), 20000, 'browser close').catch(() => {});
    if (ctx) {
      for (const fn of ctx.closers.reverse()) await withTimeout(Promise.resolve().then(fn), 10000, 'closer').catch(() => {});
    }
    if (stack) await withTimeout(stack.close(), 20000, 'stack close').catch(() => {});
    clearTimeout(watchdog);
  }
  out('');
  out('summary:');
  let failed = 0;
  for (const id of ORDER) {
    if (!results.has(id)) continue;
    const r = results.get(id);
    if (!r.ok) failed++;
    out('  ' + (r.ok ? 'PASS' : 'FAIL') + ' ' + id + ' ' + SCENARIOS[id].title + ' [' + (r.ms / 1000).toFixed(1) + ' s]');
  }
  if (results.has(0)) failed++;
  if (run.violations.length) {
    failed++;
    out('  FAIL network policy: requests left 127.0.0.1:');
    for (const v of run.violations) out('    ' + v);
  } else {
    out('  PASS network policy: every request stayed on 127.0.0.1');
  }
  out((failed ? 'FAILED' : 'OK') + ': ' + (results.size - (results.has(0) ? 1 : 0) - [...results.values()].filter((r) => !r.ok).length) + ' passed, ' + [...results.values()].filter((r) => !r.ok).length + ' failed, total ' + elapsed().trim());
  process.exit(failed ? 1 : 0);
}

// C2 integrator: a waiter a failed step left behind (a popup or event promise nobody awaits any more) must not end the whole
// run with an unhandled rejection before the failing step is reported; it is logged and the run goes on.
process.on('unhandledRejection', (err) => {
  out(elapsed() + ' note: a promise a scenario left behind rejected: ' + String((err && err.message) || err).split('\n')[0]);
});

main();
