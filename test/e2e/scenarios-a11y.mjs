// test/e2e/scenarios-a11y.mjs: accessibility rows of the v0.3 test plan (V03-DESIGN-REVIEW Part 4.2 E-ID-9 and E-SO-12, and the
// keyboard-only half of E-ID-9 as E-ID-9b), with axe-core (a development dependency since 2026-10-22; never bundled, never
// served by the project) injected into the pages of a Chromium with the local-only flags.
//
//   E-ID-9   axe-core (tags wcag2a, wcag2aa, best-practice) on the identity origin's cards (sign in, the unlock choice, the
//            passphrase, the linking choice and its confirmation, the recovery kit, the 12 words and their re-entry check, the
//            backup file, the device link, restore, its settings page, a message and an error), on the loader's own UI around
//            the guestbook (first-run notice, status bar, Settings, the identity header and the recovery kit card), and on the
//            drop-in widgets of the Example Forum (<mw-signin>, <mw-chat-panel> and the drop-in engine's cards). Fails on any
//            serious or critical violation; moderate and minor ones are listed in the result line.
//   E-ID-9B  a keyboard-only sign-in (Tab, Shift+Tab, Enter and Space; no mouse and no typing) from the guestbook through the
//            identity origin's popup and back; every control the keys reach shows a visible focus indicator.
//   E-SO-12  axe-core on examples/social's screens: the timeline (feed), a profile and its wall, a post, a group, messages,
//            alerts, media, every settings section and About, signed in as the owner of a personal page; a keyboard-only
//            post and a keyboard-only follow (R 4.2 also names a keyboard-only DM: not scripted here, see docs/deviations/a11y.md).
//
// Each axe run fails closed (a page on which axe passed no rule was not audited), and a positive control (axeControl) on the
// loader, the identity origin, the drop-in page and the social site frame proves that axe sees into the opened shadow roots
// and reports a critical violation, so a result of zero violations is a finding and not a blind spot.
//
// Every component of this project keeps its interface in a CLOSED shadow root (the loader's cards, the call UI, the drop-in
// panel, the widgets). axe cannot see into a closed root, so the visitors of these scenarios open their pages with an init
// script that makes attachShadow create open roots: the markup and styles are the same, only the test can now read them.
// Chromium only (the social hub's labels are hostnames under .localhost; WebKit runs on http://127.0.0.1 URLs only).

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

import { waitUntil, sleep, withTimeout, StepError, siteFrame, waitForSite, acceptConsent, ROOT } from './lib.mjs';
import { driveIdp, cardState, pressCard } from './idp-driver.mjs';
import { setupHubStack } from './hub-stack.mjs';
import { createDevServer } from '../../tools/dev-server.mjs';
import { publish } from '../../tools/publish.mjs';
import { stage } from '../fixtures/existing-site-dropin/stage.mjs';
import { startSigninServer } from '../fixtures/signin-server/server.mjs';
import { setCfg, readBlocksFile, writeBlocksFile } from '../../tools/ledger-admin.mjs';
import { loadOwnerKey } from '../../tools/lib.mjs';
import { MIN_PRESS_MS } from '../../src/idp/cards.js';
import { t as idpText } from '../../src/idp/strings.js';
import { STRINGS, UI_TEXT } from '../../src/loader/strings.js';
import { SETTINGS_SECTIONS } from '../../examples/social/js/config.js';

export const A11Y_ORDER = ['E-ID-9', 'E-ID-9B', 'E-SO-12'];

/** The axe-core rule tags these rows run (R 4.2: WCAG 2.x A and AA, plus axe's best practices). */
export const AXE_TAGS = Object.freeze(['wcag2a', 'wcag2aa', 'best-practice']);
/** Impacts that fail a row. */
export const FAILING_IMPACTS = Object.freeze(['serious', 'critical']);

const AXE_FILE = join(ROOT, 'node_modules', 'axe-core', 'axe.min.js');
const PASS = 'loopback accessibility passphrase';
const CARD_COOLDOWN_MS = 10500; // the identity service refuses a second card within 10 s of the last one (E_RATE)
const L = (key, params) => idpText(key, params, 'en');

let axeSource = null;
function axeText() {
  if (axeSource) return axeSource;
  if (!existsSync(AXE_FILE)) throw new StepError('axe-core is not installed (npm install: it is a development dependency, ' + AXE_FILE + ')');
  axeSource = readFileSync(AXE_FILE, 'utf8');
  return axeSource;
}

/** An init script: attachShadow makes open roots, so axe can read the components' closed interfaces (see the header). */
function openShadowRoots() {
  const native = Element.prototype.attachShadow;
  if (typeof native !== 'function' || native.__mwOpened) return;
  const opened = function attachShadow(init) { return native.call(this, Object.assign({}, init, { mode: 'open' })); };
  opened.__mwOpened = true;
  Element.prototype.attachShadow = opened;
}

/**
 * axeAudit(target, where, report, { exclude }) -> [violation]: injects axe-core into target (a Playwright page or frame) once
 * and runs it on the whole document (iframes are audited on their own), with AXE_TAGS. Every violation is recorded in report.
 */
async function axeAudit(target, where, report, { exclude = [] } = {}) {
  const has = await target.evaluate(() => Boolean(window.axe && typeof window.axe.run === 'function')).catch(() => false);
  if (!has) await target.evaluate(axeText());
  const found = await target.evaluate(async ({ tags, exclude: ex }) => {
    const context = ex.length ? { include: [['html']], exclude: ex.map((s) => [s]) } : document;
    const r = await window.axe.run(context, { runOnly: { type: 'tag', values: tags }, resultTypes: ['violations'], iframes: false, elementRef: false });
    return {
      lang: document.documentElement.getAttribute('lang'),
      url: location.origin + location.pathname,
      passes: r.passes.length,
      violations: r.violations.map((v) => ({
        id: v.id, impact: v.impact, help: v.help, count: v.nodes.length,
        nodes: v.nodes.slice(0, 4).map((n) => ({ target: n.target.map((x) => (Array.isArray(x) ? x.join(' >> ') : String(x))).join(' '), html: String(n.html || '').slice(0, 220), why: String(n.failureSummary || '').replace(/\s+/g, ' ').slice(0, 300) })),
      })),
    };
  }, { tags: AXE_TAGS, exclude });
  // Fail closed: a page on which axe passed no rule at all was not audited (an empty document, a frame that went away).
  if (!(found.passes > 0)) throw new StepError(where + ': axe-core passed no rule on ' + found.url + ', so the page was not audited');
  report.pages.push({ where, url: found.url, lang: found.lang, passes: found.passes, violations: found.violations.length });
  for (const v of found.violations) report.violations.push(Object.assign({ where }, v));
  return found.violations;
}

/**
 * axeControl(target, where) -> the rule ids found: the positive control of these rows. It adds, inside a CLOSED shadow root
 * (opened by openShadowRoots; shadow: false puts them in the light DOM, for a page opened without that init script), a button with no name and an image with no alt text, runs axe on that host only, removes it
 * again, and throws unless axe reported both (button-name and image-alt, both critical). It proves, on the very page and
 * frame being audited, that axe-core is loaded, that it sees into the components' shadow roots, and that a critical
 * violation reaches the result: a run of zero violations is then a finding, not a blind spot.
 */
async function axeControl(target, where, { shadow = true } = {}) {
  const has = await target.evaluate(() => Boolean(window.axe && typeof window.axe.run === 'function')).catch(() => false);
  if (!has) await target.evaluate(axeText());
  const ids = await target.evaluate(async (shadow) => {
    const host = document.createElement('div');
    host.id = 'mw-a11y-control';
    const root = shadow ? host.attachShadow({ mode: 'closed' }) : host;
    const img = document.createElement('img');
    img.src = 'data:image/gif;base64,R0lGODlhAQABAAAAACw=';
    root.append(document.createElement('button'), img);
    document.body.append(host);
    try {
      if (shadow && !host.shadowRoot) return ['closed-root-not-opened'];
      const r = await window.axe.run({ include: [['#mw-a11y-control']] }, { runOnly: { type: 'rule', values: ['button-name', 'image-alt'] }, resultTypes: ['violations'], iframes: false });
      return r.violations.filter((v) => v.impact === 'critical').map((v) => v.id).sort();
    } finally {
      host.remove();
    }
  }, shadow);
  if (ids.join(',') !== 'button-name,image-alt') throw new StepError(where + ': the axe-core positive control found ' + JSON.stringify(ids) + ', not [button-name, image-alt]');
  return ids;
}

function newReport(id) {
  return { id, pages: [], violations: [], controls: [] };
}

/** finish(report, ctx) -> the result line; throws when a serious or critical violation was found. */
function finish(report, ctx, assert) {
  const bad = report.violations.filter((v) => FAILING_IMPACTS.indexOf(v.impact) >= 0);
  const minor = report.violations.filter((v) => FAILING_IMPACTS.indexOf(v.impact) < 0);
  try { writeFileSync(join(ctx.stack.runDir, 'a11y-' + report.id + '.json'), JSON.stringify(report, null, 2)); } catch (_) { /* the run directory is gone */ }
  const fmt = (v) => v.where + ': ' + v.id + ' (' + v.impact + ', ' + v.count + ') ' + v.help + ' [' + v.nodes.map((n) => n.target + ' ' + n.why).join(' | ') + ']';
  assert(bad.length === 0, bad.length + ' serious or critical axe violation(s): ' + bad.map(fmt).join(' ;; '));
  const ids = Array.from(new Set(minor.map((v) => v.id + ' (' + v.impact + ')')));
  assert(report.controls.length > 0, 'no axe-core positive control ran');
  return report.pages.length + ' screen(s) audited with axe-core (' + AXE_TAGS.join(', ') + '; positive control caught button-name and image-alt in ' + report.controls.length + ' context(s)), 0 serious or critical' + (ids.length ? '; moderate or minor: ' + ids.join(', ') : '; nothing moderate or minor');
}

/** a11yScenarios({ assert }) -> { id: { title, fn(ctx, step) } } for test/e2e/run.mjs. */
export function a11yScenarios({ assert }) {
  const S = {};

  // ------------------------------------------------------------------------------------------- helpers
  async function authState(page) {
    const f = siteFrame(page);
    if (!f) return null;
    return f.evaluate(() => ({ auth: document.documentElement.dataset.auth || null })).catch(() => null);
  }

  async function openGuestbook(ctx, name, url) {
    const v = await ctx.visitor(name, { initScripts: [openShadowRoots] });
    const page = await v.newPage();
    await page.goto(url || ctx.stack.origin, { waitUntil: 'domcontentloaded', timeout: 20000 });
    return { v, page };
  }

  async function waitAuth(page, want, label) {
    return waitUntil(async () => { const a = await authState(page); return a && (want ? a.auth === want : a.auth) ? a : null; }, { timeoutMs: 20000, label });
  }

  /** A guestbook on another loopback origin with the e2e stack's identity origin (the linking choice needs a second site). */
  async function secondSite(ctx, step) {
    if (ctx.shared.a11ySecond) return ctx.shared.a11ySecond;
    const { stack } = ctx;
    const r = await step('a second guestbook on another loopback origin, with the same identity origin', async () => {
      const outDir = join(stack.runDir, 'a11y2-publish');
      const dev = await createDevServer({ root: stack.dist, webseed: outDir, port: 0, host: '127.0.0.1', dev: true, quiet: true });
      ctx.closers.push(() => dev.close());
      const pub = await publish({
        dir: join(ROOT, 'examples', 'peer-guestbook'), name: 'a11y2-guestbook', scope: '127.0.0.1', key: stack.owner.file, out: outDir, policy: 'open', bits: 4,
        tr: [stack.tracker.url], ws: [dev.url + 'ws/'], cs: dev.url + 'ws/genesis.json', exp: 30, quiet: true, idp: stack.idp.url,
      });
      dev.setPointer(pub.pointer);
      return { dev, url: dev.url };
    });
    ctx.shared.a11ySecond = r;
    return r;
  }

  /** The Example Forum with its widgets (as scenarios-dropin-v03.mjs publishes it), unless that run already made it. */
  async function forum(ctx, step) {
    if (ctx.shared.forum) return ctx.shared.forum;
    const { stack } = ctx;
    const f = await step('stage and publish the Example Forum with <mw-signin> and <mw-chat-panel>, chat open in its ledger', async () => {
      const base = join(stack.runDir, 'a11y-forum');
      const trackerHost = new URL(stack.tracker.url).host;
      const site = stage('with-widgets', join(base, 'src'), { widgets: { dist: stack.dist, tracker: trackerHost, stun: '127.0.0.1' } });
      const outDir = join(base, 'out');
      const opts = {
        dir: site.dir, name: 'forum', scope: '127.0.0.1', key: stack.owner.file, chain: 'forum-chat', signinWidget: true, signinStatement: 'Sign in to Example Forum',
        chatPanel: true, tracker: [stack.tracker.url], stun: ['stun:127.0.0.1:3478'], tr: [stack.tracker.url], ws: [], dropin: true, dist: stack.dist,
        out: outDir, idp: stack.idp.url, exp: 30, quiet: true,
      };
      await publish(opts);
      const server = await startSigninServer({ port: 0, staticDir: join(outDir, 'site') });
      ctx.closers.push(() => server.close());
      const identity = await loadOwnerKey(stack.owner.file);
      const cfg = await setCfg({ blocks: readBlocksFile(join(outDir, 'genesis.json')), identity, set: { chat: 'open' } });
      await sleep(1100); // seq is the Unix time in seconds: the second publish must be a later second
      const pub = await publish(Object.assign({}, opts, { cs: server.url + '/forum-genesis.json' }));
      writeBlocksFile(join(outDir, 'site', 'forum-genesis.json'), cfg.blocks);
      return { url: server.url, server, outDir, pub, cfg: cfg.cfg };
    });
    ctx.shared.forum = f;
    return f;
  }

  /** Answers the identity origin's cards like driveIdp and audits every card the first time its title is seen. */
  function auditingPlan(report, popup, plan, prefix) {
    const seen = new Set();
    return Object.assign({}, plan, {
      async onCard(st) {
        const key = st.title || st.text.slice(0, 40);
        if (!seen.has(key)) {
          seen.add(key);
          await axeAudit(popup, prefix + ' "' + key + '"', report);
        }
        return plan.onCard ? plan.onCard(st) : undefined;
      },
    });
  }

  /** Waits for a fresh card on an identity origin page and returns its state (the driver's view of it). */
  async function nextCard(page, { title = null, label = 'a card' } = {}) {
    return waitUntil(async () => {
      const st = await cardState(page).catch(() => null);
      if (!st || st.none || st.busy) return null;
      if (title && (typeof title === 'string' ? st.title !== title : !title.test(st.title))) return null;
      return st;
    }, { timeoutMs: 30000, label: 'identity origin: ' + label });
  }

  async function fillCard(page, name, value) {
    await page.locator('main.mw-idp section.mw-card [name="' + name + '"]').first().fill(value);
  }

  /** Opens the identity origin's home page with an intent (#kit, #backup, #link, #restore or none) in a new page of v. */
  async function idoHome(v, idpUrl, intent = '') {
    const p = await v.newPage();
    await p.goto(idpUrl + '/' + (intent ? '#' + intent : ''), { waitUntil: 'domcontentloaded', timeout: 20000 });
    return p;
  }

  // ------------------------------------------------------------------------------------------- E-ID-9
  S['E-ID-9'] = {
    title: 'axe-core on the identity origin\'s cards, the loader\'s UI and prompts, and the drop-in widgets: no serious or critical violation (wcag2a, wcag2aa, best-practice)',
    async fn(ctx, step) {
      const report = newReport('E-ID-9');
      const kbStops = []; // controls of the components with closed roots, reached with Tab: each must show a focus ring
      const idpUrl = ctx.stack.idp.url;
      const { v, page } = await openGuestbook(ctx, 'AX-ID');
      await step('the loader\'s first-run notice (the guestbook, a fresh visitor)', async () => {
        await waitUntil(() => page.locator('.mw-notice button').filter({ visible: true }).count().then((n) => n > 0), { timeoutMs: 20000, label: 'the first-run notice' });
        await axeAudit(page, 'loader: first-run notice', report);
        report.controls.push('loader: ' + (await axeControl(page, 'loader')).join('+'));
      });
      await step('"Share and load": the status bar over the site, and the loader\'s Settings dialog', async () => {
        const t0 = Date.now();
        await acceptConsent(page, { timeoutMs: 20000 });
        await waitForSite(page, { timeoutMs: 30000, since: t0, label: 'AX-ID: site rendered' });
        await waitAuth(page, null, 'the sign-in bar');
        await axeAudit(page, 'loader: status bar', report);
        const settings = page.locator('#mw-bar button.mw-settings-btn').first();
        if (await settings.count()) {
          await settings.click();
          await waitUntil(() => page.evaluate(() => { const d = document.querySelector('.mw-dialog.mw-settings'); return Boolean(d && !d.hidden); }), { timeoutMs: 5000, label: 'the Settings dialog' });
          await axeAudit(page, 'loader: Settings dialog', report);
          await page.keyboard.press('Escape');
          await sleep(200);
          const still = await page.evaluate(() => { const d = document.querySelector('.mw-dialog.mw-settings'); return Boolean(d && !d.hidden); });
          if (still) await page.locator('.mw-dialog.mw-settings button').filter({ hasText: /^(Close|Done)$/ }).first().click().catch(() => {});
        }
      });
      const first = await step('Sign in from the site: every card of the identity origin (a new passphrase identity) is audited before it is answered', async () => {
        const popupPromise = page.context().waitForEvent('page', { timeout: 20000 });
        await siteFrame(page).click('#sign-in');
        const popup = await popupPromise;
        const drive = await withTimeout(driveIdp(popup, auditingPlan(report, popup, { unlock: 'passphrase', passphrase: PASS }, 'identity origin (sign in):')), 60000, 'identity origin');
        await waitAuth(page, 'signed-in', 'signed in');
        return { at: Date.now(), cards: drive.cards };
      });
      await step('the loader\'s identity header after the sign-in, and its recovery kit card after the first post', async () => {
        await sleep(300);
        await axeAudit(page, 'loader: signed in (identity header)', report);
        const f = siteFrame(page);
        await f.waitForSelector('#post-form fieldset:not([disabled]) #msg', { timeout: 20000 });
        await f.fill('#msg', 'An accessible post');
        await f.click('#post-btn');
        await waitUntil(() => f.evaluate(() => Array.from(document.querySelectorAll('#entries li .msg')).some((n) => n.textContent === 'An accessible post')), { timeoutMs: 30000, label: 'the post shows' });
        const kit = await waitUntil(() => page.evaluate((l) => (window.__mwShell && window.__mwShell.rectOf ? window.__mwShell.rectOf(l) : null), UI_TEXT.en.kitButton), { timeoutMs: 10000, label: 'the recovery kit card' }).catch(() => null);
        if (kit) {
          await axeAudit(page, 'loader: recovery kit card', report);
          // The card's own buttons, with the keyboard: Tab to "Later" (its focus ring is checked), Enter.
          await page.bringToFront();
          await tabTo(page, (s) => s.frame === 'top' && s.label === UI_TEXT.en.later, { stops: kbStops, where: 'loader: recovery kit card', max: 80 });
          await page.keyboard.press('Enter');
          await waitUntil(() => page.evaluate((l) => !(window.__mwShell && window.__mwShell.rectOf && window.__mwShell.rectOf(l)), UI_TEXT.en.kitButton), { timeoutMs: 5000, label: 'the kit card answered from the keyboard' });
        }
      });
      const second = await secondSite(ctx, step);
      await step('site B: the sign-in card with the linking choice ("Private to this site" / "Same as on ..."), then its confirmation card', async () => {
        const pb = await v.newPage();
        const t0 = Date.now();
        await pb.goto(second.url, { waitUntil: 'domcontentloaded', timeout: 20000 });
        await acceptConsent(pb, { timeoutMs: 20000 });
        await waitForSite(pb, { timeoutMs: 30000, since: t0, label: 'site B' });
        await waitAuth(pb, null, 'site B sign-in bar');
        await sleep(Math.max(0, first.at + CARD_COOLDOWN_MS - Date.now()));
        const popupPromise = pb.context().waitForEvent('page', { timeout: 20000 });
        await siteFrame(pb).click('#sign-in');
        const popup = await popupPromise;
        const originA = new URL(ctx.stack.origin).origin;
        await withTimeout(driveIdp(popup, auditingPlan(report, popup, { passphrase: PASS, same: originA }, 'identity origin (linking):')), 60000, 'identity origin');
        await waitAuth(pb, 'signed-in', 'signed in on B');
        await pb.close();
      });
      await step('the identity origin\'s home page (settings) for a person with an identity', async () => {
        const p = await idoHome(v, idpUrl);
        await nextCard(p, { title: L('settingsTitle'), label: 'settings' });
        await axeAudit(p, 'identity origin: settings (an identity)', report);
        report.controls.push('identity origin: ' + (await axeControl(p, 'identity origin')).join('+'));
        await p.close();
      });
      await step('#kit: the passphrase, the busy card, the recovery kit, the 12 words, the re-entry check (a wrong word, then right), done', async () => {
        const p = await idoHome(v, idpUrl, 'kit');
        let st = await nextCard(p, { title: L('continuePassphrase'), label: 'unlock with the passphrase' });
        await axeAudit(p, 'identity origin: unlock with the passphrase', report);
        await fillCard(p, 'passphrase', PASS);
        await pressCard(p, L('cont'), st);
        const busy = await waitUntil(() => p.evaluate(() => Boolean(document.querySelector('main.mw-idp .mw-busy'))), { timeoutMs: 3000, stepMs: 20, label: 'busy' }).catch(() => false);
        if (busy) await axeAudit(p, 'identity origin: busy (stretching the passphrase)', report);
        st = await nextCard(p, { title: L('kitTitle'), label: 'recovery kit' });
        await axeAudit(p, 'identity origin: recovery kit', report);
        await pressCard(p, L('kitNow'), st);
        st = await nextCard(p, { title: L('showPhraseTitle'), label: 'the 12 words' });
        await axeAudit(p, 'identity origin: the 12 words', report);
        const words = await p.evaluate(() => Array.from(document.querySelectorAll('main.mw-idp ol.mw-words li')).map((li) => li.textContent.trim()));
        assert(words.length === 12, 'the 12-word card shows ' + words.length + ' words');
        await pressCard(p, L('cont'), st);
        st = await nextCard(p, { title: L('reentryTitle'), label: 're-entry check' });
        const names = await p.evaluate(() => Array.from(document.querySelectorAll('main.mw-idp section.mw-card input[name^="word"]')).map((i) => i.getAttribute('name')));
        for (const n of names) await fillCard(p, n, 'wrong');
        await pressCard(p, L('cont'), st);
        await waitUntil(() => p.evaluate(() => (document.querySelector('main.mw-idp .mw-error') || {}).textContent || null), { timeoutMs: 5000, label: 'the re-entry error' });
        await axeAudit(p, 'identity origin: re-entry check with its error', report);
        for (const n of names) await fillCard(p, n, words[Number(n.slice(4)) - 1]);
        await pressCard(p, L('cont'), st);
        st = await nextCard(p, { title: /^$/, label: 'the done message' }).catch(() => null);
        if (st) {
          await axeAudit(p, 'identity origin: message (no title)', report);
          await pressCard(p, L('close'), st);
        }
        await p.close();
      });
      await step('#backup: the backup file card (a weak passphrase refused, with its error), then the save card', async () => {
        const p = await idoHome(v, idpUrl, 'backup');
        let st = await nextCard(p, { title: L('continuePassphrase'), label: 'unlock with the passphrase' });
        await fillCard(p, 'passphrase', PASS);
        await pressCard(p, L('cont'), st);
        st = await nextCard(p, { title: L('backupTitle'), label: 'backup file' });
        await axeAudit(p, 'identity origin: backup file', report);
        await fillCard(p, 'own', 'weak');
        await pressCard(p, L('backupSave'), st);
        st = await waitUntil(async () => { const s = await cardState(p); return s && !s.none && s.title === L('backupTitle') && s.errors.length ? s : null; }, { timeoutMs: 10000, label: 'the weak passphrase refused' });
        await axeAudit(p, 'identity origin: backup file with its error', report);
        await pressCard(p, L('backupSave'), st);
        st = await nextCard(p, { title: L('backupSaveTitle'), label: 'save the backup' });
        await axeAudit(p, 'identity origin: save the backup', report);
        await pressCard(p, L('backupCopy'), st);
        await sleep(200);
        await axeAudit(p, 'identity origin: save the backup (the text shown)', report);
        await pressCard(p, L('kitLater'), st);
        await p.close();
      }, 60000);
      await step('#link on a device with the identity: the scan card (no camera here: the typed-code fallback)', async () => {
        const p = await idoHome(v, idpUrl, 'link');
        let st = await nextCard(p, { title: L('continuePassphrase'), label: 'unlock with the passphrase' });
        await fillCard(p, 'passphrase', PASS);
        await pressCard(p, L('cont'), st);
        st = await nextCard(p, { title: L('linkTitle'), label: 'scan a code' });
        await sleep(500);
        await axeAudit(p, 'identity origin: device link, scan a code', report);
        await pressCard(p, L('cancel'), st);
        await p.close();
      });
      const fresh = await ctx.visitor('AX-ID-NEW', { initScripts: [openShadowRoots] });
      await step('a device with no identity: settings, restore (an unknown phrase refused, with its error), the device link\'s code', async () => {
        let p = await idoHome(fresh, idpUrl);
        await nextCard(p, { title: L('settingsTitle'), label: 'settings (no identity)' });
        await axeAudit(p, 'identity origin: settings (no identity)', report);
        await p.close();
        p = await idoHome(fresh, idpUrl, 'restore');
        let st = await nextCard(p, { title: L('restoreTitle'), label: 'restore' });
        await axeAudit(p, 'identity origin: restore', report);
        await fillCard(p, 'phrase', 'these are not twelve words of any list at all here now');
        await pressCard(p, L('restorePhrase'), st);
        st = await waitUntil(async () => { const s = await cardState(p); return s && !s.none && s.title === L('restoreTitle') && s.errors.length ? s : null; }, { timeoutMs: 10000, label: 'the phrase refused' });
        await axeAudit(p, 'identity origin: restore with its error', report);
        await pressCard(p, L('cancel'), st);
        await p.close();
        p = await idoHome(fresh, idpUrl, 'link');
        st = await nextCard(p, { title: L('linkTitle'), label: 'show a code' });
        await axeAudit(p, 'identity origin: device link, show a code (QR)', report);
        await pressCard(p, L('cancel'), st);
        await p.close();
      });
      await step('in French (a browser set to fr-FR): the identity origin\'s page says lang="fr", and its cards are audited again', async () => {
        const fr = await ctx.visitor('AX-ID-FR', { initScripts: [openShadowRoots], contextOptions: { locale: 'fr-FR' } });
        const p = await idoHome(fr, idpUrl, 'restore');
        const st = await nextCard(p, { title: idpText('restoreTitle', null, 'fr'), label: 'restore (fr)' });
        const langs = await p.evaluate(() => ({ html: document.documentElement.getAttribute('lang'), main: (document.querySelector('main.mw-idp') || {}).lang || null }));
        assert(langs.html === 'fr' && langs.main === 'fr', 'the French cards are marked ' + JSON.stringify(langs));
        await axeAudit(p, 'identity origin (fr): restore', report);
        await pressCard(p, idpText('cancel', null, 'fr'), st);
        await nextCard(p, { title: idpText('settingsTitle', null, 'fr'), label: 'settings (fr)' });
        await axeAudit(p, 'identity origin (fr): settings (no identity)', report);
        await p.close();
        await ctx.closeVisitor('AX-ID-FR');
      });
      await step('an error card: /signin opened by hand (no site opened it)', async () => {
        const p = await fresh.newPage();
        await p.goto(idpUrl + '/signin', { waitUntil: 'domcontentloaded', timeout: 20000 });
        await nextCard(p, { label: 'the message' });
        await axeAudit(p, 'identity origin: /signin with no site (message)', report);
        await p.close();
      });
      const f = await forum(ctx, step);
      await step('the Example Forum: the drop-in engine\'s first-run card, <mw-signin> and <mw-chat-panel> (signed out)', async () => {
        const fp = await v.newPage();
        await fp.goto(f.url + '/', { waitUntil: 'load', timeout: 20000 });
        await waitUntil(() => fp.evaluate((l) => (window.__mwDropin ? window.__mwDropin.rectOf(l) : null), STRINGS.consentShare), { timeoutMs: 15000, label: 'the drop-in first-run card' });
        await axeAudit(fp, 'drop-in: first-run card and the forum page', report);
        report.controls.push('drop-in page: ' + (await axeControl(fp, 'drop-in page')).join('+'));
        await fp.bringToFront();
        await tabTo(fp, (s) => s.label === STRINGS.consentShare, { stops: kbStops, where: 'drop-in: first-run card', max: 80 });
        await sleep(300);
        await fp.keyboard.press('Enter');
        await waitUntil(() => fp.evaluate(() => (window.__mwDropin && window.__mwDropin.inspect().consent === 'accepted') || null), { timeoutMs: 15000, label: 'consent accepted' });
        await waitUntil(() => fp.evaluate(() => { const p = document.querySelector('mw-chat-panel'); return p && p.view === 'signed-out' ? true : (p && p.refresh && p.refresh(), null); }), { timeoutMs: 20000, label: 'the chat panel\'s signed-out view' });
        await axeAudit(fp, 'drop-in: <mw-signin> and <mw-chat-panel> (signed out)', report);
        await tabTo(fp, (s) => s.label === UI_TEXT.en.signinWithMagnet, { stops: kbStops, where: 'drop-in: <mw-signin>', max: 80 });
        await tabTo(fp, (s) => s.label === UI_TEXT.en.signInButton, { stops: kbStops, where: 'drop-in: <mw-chat-panel>', max: 80 });
        await fp.close();
      });
      try { writeFileSync(join(ctx.stack.runDir, 'a11y-E-ID-9-keyboard.json'), JSON.stringify(kbStops, null, 2)); } catch (_) { /* the run directory is gone */ }
      const ringless = kbStops.filter((s) => !s.visible && !s.media);
      assert(ringless.length === 0, 'controls with no visible focus indicator: ' + ringless.map((s) => s.where + ': ' + s.tag + ' "' + s.label + '" (' + s.style + ')').join('; '));
      return finish(report, ctx, assert) + '; ' + kbStops.length + ' keyboard focus stops on the loader card and the drop-in components, all with a visible indicator';
    },
  };

  // ------------------------------------------------------------------------------------------- E-ID-9B
  // The focused control of a page: the frame that holds focus (the site frame when the top document's active element is its
  // iframe), through open shadow roots; whether it shows a focus indicator (an outline or a box shadow, as computed).
  const FOCUS = () => {
    let a = document.activeElement;
    while (a && a.shadowRoot && a.shadowRoot.activeElement) a = a.shadowRoot.activeElement;
    if (!a || a === document.body || a === document.documentElement) return { none: true };
    if (a.tagName === 'IFRAME') return { iframe: true };
    const cs = getComputedStyle(a);
    const outline = cs.outlineStyle !== 'none' && parseFloat(cs.outlineWidth) > 0 && cs.outlineColor !== 'rgba(0, 0, 0, 0)' && cs.outlineColor !== 'transparent';
    const ring = Boolean(cs.boxShadow && cs.boxShadow !== 'none');
    const label = (a.getAttribute('aria-label') || (a.labels && a.labels[0] && a.labels[0].textContent) || a.textContent || a.getAttribute('name') || '').replace(/\s+/g, ' ').trim().slice(0, 80);
    const media = (a.tagName === 'VIDEO' || a.tagName === 'AUDIO') && a.controls === true;
    return { tag: a.tagName.toLowerCase(), type: a.getAttribute('type') || '', label, checked: a.checked === true, visible: outline || ring, media, style: cs.outlineStyle + ' ' + cs.outlineWidth + ' ' + cs.outlineColor + (ring ? ' / ' + cs.boxShadow : '') };
  };

  async function focused(page) {
    const top = await page.evaluate(FOCUS);
    if (!top.iframe) return Object.assign({ frame: 'top' }, top);
    const f = siteFrame(page);
    const inner = f ? await f.evaluate(FOCUS).catch(() => ({ none: true })) : { none: true };
    return Object.assign({ frame: 'site' }, inner);
  }

  /**
   * tabTo(page, want, { max, stops, where }) -> the focus state: presses Tab (Shift+Tab with back) until the focused control
   * matches want(state); every stop is recorded in stops with whether it showed a focus indicator.
   */
  async function tabTo(page, want, { max = 60, stops, where, back = false } = {}) {
    for (let i = 0; i < max; i++) {
      await page.keyboard.press(back ? 'Shift+Tab' : 'Tab');
      await sleep(60);
      const st = await focused(page);
      if (st.none || st.iframe) continue;
      stops.push(Object.assign({ where }, st));
      if (want(st)) return st;
    }
    throw new StepError(where + ': ' + max + ' presses of Tab did not reach the control (stops: ' + stops.filter((s) => s.where === where).map((s) => s.tag + ' "' + s.label + '"').join(', ') + ')');
  }

  S['E-ID-9B'] = {
    title: 'E-ID-9b: a keyboard-only sign-in (Tab, Shift+Tab, Enter, Space; no mouse) from a site through the identity origin and back, with a visible focus indicator on every control reached',
    async fn(ctx, step) {
      const stops = [];
      const { page } = await openGuestbook(ctx, 'AX-KB');
      const exact = (text) => (st) => st.label === text;
      await step('the first-run notice: Tab to "' + STRINGS.consentShare + '", Enter', async () => {
        await waitUntil(() => page.locator('.mw-notice button').filter({ visible: true }).count().then((n) => n > 0), { timeoutMs: 20000, label: 'the first-run notice' });
        await page.bringToFront();
        const t0 = Date.now();
        await tabTo(page, exact(STRINGS.consentShare), { stops, where: 'loader notice' });
        await page.keyboard.press('Enter');
        await waitForSite(page, { timeoutMs: 30000, since: t0, label: 'AX-KB: site rendered' });
        await waitAuth(page, null, 'the sign-in bar');
      });
      const popup = await step('Tab into the site frame to its "Sign in" button, Enter: the identity origin\'s window opens', async () => {
        const popupPromise = page.context().waitForEvent('page', { timeout: 20000 });
        await tabTo(page, (st) => st.frame === 'site' && /^Sign in$/.test(st.label), { stops, where: 'site' });
        await page.keyboard.press('Enter');
        return popupPromise;
      });
      const cards = [];
      await step('the sign-in card: Tab to "Stay signed in", Space twice (on, off), Shift+Tab back to "' + L('continueNew') + '", Enter', async () => {
        await popup.waitForLoadState('domcontentloaded', { timeout: 20000 }).catch(() => {});
        await popup.bringToFront();
        const st = await nextCard(popup, { title: /^Sign in to /, label: 'sign-in card' });
        cards.push(st.title);
        await sleep(MIN_PRESS_MS + 150);
        const box = await tabTo(popup, (s) => s.type === 'checkbox' && s.label === L('staySignedIn'), { stops, where: 'identity origin: sign in' });
        assert(box.checked === false, 'the "Stay signed in" box starts checked');
        await popup.keyboard.press('Space');
        assert((await focused(popup)).checked === true, 'Space did not check "Stay signed in"');
        await popup.keyboard.press('Space');
        assert((await focused(popup)).checked === false, 'Space did not uncheck "Stay signed in"');
        await tabTo(popup, exact(L('continueNew')), { stops, where: 'identity origin: sign in', back: true });
        await popup.keyboard.press('Enter');
      });
      await step('the unlock choice: Tab to "' + L('unlockVisit') + '", Space: the window closes and the site is signed in', async () => {
        const st = await nextCard(popup, { title: L('chooseUnlockTitle'), label: 'unlock choice' });
        cards.push(st.title);
        await sleep(MIN_PRESS_MS + 150);
        const closed = new Promise((resolve) => popup.once('close', () => resolve(true)));
        await tabTo(popup, exact(L('unlockVisit')), { stops, where: 'identity origin: unlock choice' });
        await popup.keyboard.press('Space');
        await withTimeout(closed, 20000, 'the identity window closes with the answer');
        await page.bringToFront();
        await waitAuth(page, 'signed-in', 'signed in');
      });
      const info = await siteFrame(page).evaluate(async () => (await import('/_mw/sdk.js')).default.ready());
      assert(info.auth === 'signed-in' && info.identity && /^p256:/.test(info.identity.pub), 'ready() ' + JSON.stringify(info.identity));
      try { writeFileSync(join(ctx.stack.runDir, 'a11y-E-ID-9B.json'), JSON.stringify({ stops, cards }, null, 2)); } catch (_) { /* the run directory is gone */ }
      // A <video> or <audio> with native controls is skipped: the browser draws the focus ring on its own controls inside the
      // element, which getComputedStyle of the element does not show (the guestbook's clip, not on the sign-in path).
      const hidden = stops.filter((s) => !s.visible && !s.media);
      assert(hidden.length === 0, 'controls with no visible focus indicator: ' + hidden.map((s) => s.where + ': ' + s.tag + ' "' + s.label + '" (' + s.style + ')').join('; '));
      return 'signed in as ' + info.identity.short + ' with the keyboard alone (cards: ' + cards.join(' > ') + '); ' + stops.length + ' focus stops, all with a visible indicator';
    },
  };

  // ------------------------------------------------------------------------------------------- E-SO-12
  /** The social app in the site frame once it has drawn a route: { title, path, signIn }. */
  async function appState(page, { timeoutMs = 30000, label = 'the social app', until = null } = {}) {
    return waitUntil(async () => {
      const f = siteFrame(page);
      if (!f) return null;
      const s = await f.evaluate(() => {
        const c = window.__social && window.__social.ctx;
        if (!c || !c.route || !c.data || !document.querySelector('#view').children.length) return null;
        return { title: document.querySelector('#view-title').textContent, signIn: document.querySelector('#sign-in').textContent, path: location.pathname, chip: document.querySelector('#identity-chip').hidden ? '' : document.querySelector('#identity-chip').textContent };
      }).catch(() => null);
      if (!s) return null;
      return !until || until(s) ? s : null;
    }, { timeoutMs, label });
  }

  async function socialSignIn(page, plan) {
    const popupPromise = page.context().waitForEvent('page', { timeout: 30000 });
    await siteFrame(page).click('#sign-in');
    const popup = await popupPromise;
    await withTimeout(driveIdp(popup, plan), 60000, 'identity origin (sign in)');
    await appState(page, { label: 'signed in', until: (s) => s.signIn === 'Sign out' && Boolean(s.chip) });
    return Date.now();
  }

  /**
   * ownPage(ctx, step) -> { page, label, hub }: the owner of a personal page on the loopback hub (the run's hub when the social
   * scenarios made one), signed in: the same sign-up (R 3.3) as scenarios-social.mjs signUp(), in a visitor of its own (with
   * openShadowRoots, and a browser that knows no other page, so the keyboard follow below always starts from "Page not found").
   */
  async function ownPage(ctx, step) {
    let hub = ctx.shared.hub;
    if (!hub) {
      hub = await step('the loopback subdomain hub with the social template (scenarios-social.mjs did not run)', () => setupHubStack(ctx.stack));
      ctx.closers.push(() => hub.close());
      ctx.shared.hub = hub;
    }
    const v = await ctx.visitor('AX-SO', { initScripts: [openShadowRoots] });
    const plan = { unlock: 'passphrase', passphrase: 'accessibility social passphrase number three', hub: true };
    const page = await step('AX-SO opens the hub link and signs in at the identity origin (a passphrase identity, one identity on the hub)', async () => {
      const p = await v.newPage();
      await p.goto(hub.templateUrl, { waitUntil: 'domcontentloaded', timeout: 20000 });
      await acceptConsent(p, { timeoutMs: 20000 });
      await appState(p, { label: 'the template page' });
      p.__a11yAt = await socialSignIn(p, plan);
      return p;
    });
    await step('AX-SO taps "Create my page": the identity origin confirms and the new page opens', async () => {
      const wait = page.__a11yAt + CARD_COOLDOWN_MS - Date.now();
      if (wait > 0) await sleep(wait);
      const before = page.url();
      const popupPromise = page.context().waitForEvent('page', { timeout: 30000 });
      await siteFrame(page).click('#create-page');
      const popup = await popupPromise;
      await withTimeout(driveIdp(popup, plan), 60000, 'identity origin (create my page)');
      await waitUntil(async () => {
        if (page.url() !== before && !page.url().includes(hub.templateLabel)) return true;
        const fr = siteFrame(page);
        const href = fr ? await fr.evaluate(() => { const a = document.querySelector('#open-top'); return a ? a.getAttribute('href') : null; }).catch(() => null) : null;
        if (href) await fr.click('#open-top');
        return false;
      }, { timeoutMs: 20000, label: 'the new page opens' });
    });
    const label = await step('AX-SO signs in on the new page as its owner', async () => {
      await acceptConsent(page, { timeoutMs: 20000 });
      await appState(page, { label: 'own page' });
      await socialSignIn(page, plan);
      const info = await siteFrame(page).evaluate(async () => (await import('/_mw/sdk.js')).default.ready());
      assert(info.role === 'owner', 'role ' + info.role);
      return new URL(page.url()).hostname.split('.')[0];
    });
    return { page, label, hub };
  }

  /** Moves the app to path (its own router, as a click on a link does) and waits until the route has drawn. */
  async function goTo(page, path) {
    await siteFrame(page).evaluate((p) => window.__social.ctx.go(p), path);
    await appState(page, { label: 'the route ' + path, until: (s) => s.path === path }).catch(async (err) => {
      const f = siteFrame(page);
      const seen = f ? await f.evaluate(() => ({ path: location.pathname, view: (document.querySelector('#view') || {}).childElementCount, title: (document.querySelector('#view-title') || {}).textContent, route: Boolean(window.__social && window.__social.ctx && window.__social.ctx.route), data: Boolean(window.__social && window.__social.ctx && window.__social.ctx.data) })).catch((e) => String(e)) : 'no site frame';
      throw new StepError(err.message + ' (the app shows ' + JSON.stringify(seen) + ')');
    });
    await sleep(500); // views fill their lists after the first draw
  }

  S['E-SO-12'] = {
    title: 'axe-core on every screen of the social example (timeline, profile and wall, a post, a group, messages, alerts, media, each settings section, About, an unknown profile; light and dark), a keyboard-only post and follow: no serious or critical violation',
    async fn(ctx, step) {
      const report = newReport('E-SO-12');
      const own = await ownPage(ctx, step);
      const { page, label } = own;
      const f = () => siteFrame(page);
      await step('the timeline (feed) and the hub page\'s loader around it', async () => {
        await goTo(page, '/');
        await axeAudit(f(), 'social: timeline', report);
        report.controls.push('social site frame: ' + (await axeControl(f(), 'social site frame')).join('+'));
        await axeAudit(page, 'social: the loader around the hub page', report);
      });
      const posted = await step('a keyboard-only post: Tab to the composer, type, Tab to "Post", Enter', async () => {
        await page.bringToFront();
        const text = 'A keyboard-only post';
        const stops = [];
        await tabTo(page, (st) => st.frame === 'site' && st.tag === 'textarea', { stops, where: 'social composer', max: 80 });
        await page.keyboard.type(text);
        await tabTo(page, (st) => st.frame === 'site' && st.tag === 'button' && /^Post$/.test(st.label), { stops, where: 'social composer' });
        await page.keyboard.press('Enter');
        await waitUntil(() => f().evaluate((t) => Array.from(document.querySelectorAll('#feed article, #wall article')).some((a) => a.textContent.indexOf(t) >= 0), text), { timeoutMs: 30000, label: 'the post is shown' });
        const hidden = stops.filter((s) => !s.visible && !s.media);
        assert(hidden.length === 0, 'no visible focus indicator on: ' + hidden.map((s) => s.tag + ' "' + s.label + '" (' + s.style + ')').join('; '));
        await sleep(400);
        await axeAudit(f(), 'social: timeline with a post', report);
        return { text, stops: stops.length };
      });
      const paths = [
        ['/@' + label, 'profile and wall'],
        ['/g/' + label, 'group (this page shown as a group)'],
        ['/messages', 'messages'],
        ['/notifications', 'alerts'],
        ['/media', 'media'],
        ['/settings', 'settings'],
      ].concat(SETTINGS_SECTIONS.map((s) => ['/settings/' + s, 'settings: ' + s])).concat([['/about', 'about'], ['/no/such/page', 'not found']]);
      for (const [path, name] of paths) {
        await step('screen ' + path, async () => {
          if (path === '/no/such/page') {
            await siteFrame(page).evaluate((p) => window.__social.ctx.go(p), path);
            await appState(page, { label: 'not found', until: (s) => s.path === path });
            await sleep(300);
          } else {
            await goTo(page, path);
          }
          await axeAudit(f(), 'social: ' + name, report);
        });
      }
      const followed = await step('a keyboard-only follow: the template page\'s profile, not yet known here ("Page not found" with "Follow by link"): Tab to the field, type its link, Tab to "Follow", Enter', async () => {
        const hub = own.hub;
        const path = '/@' + hub.templateLabel;
        await siteFrame(page).evaluate((p) => window.__social.ctx.go(p), path);
        await appState(page, { label: 'the unknown profile', until: (s) => s.path === path });
        await sleep(300);
        await axeAudit(f(), 'social: an unknown profile (follow by link)', report);
        await page.bringToFront();
        const stops = [];
        await tabTo(page, (st) => st.frame === 'site' && st.tag === 'input' && st.label === 'Follow by link', { stops, where: 'social follow', max: 80 });
        await page.keyboard.type(hub.templateUrl);
        await tabTo(page, (st) => st.frame === 'site' && st.tag === 'button' && /^Follow$/.test(st.label), { stops, where: 'social follow' });
        await page.keyboard.press('Enter');
        await waitUntil(() => f().evaluate((id) => window.__social.ctx.data.isFollowing(id) || null, hub.ledgerId), { timeoutMs: 30000, label: 'the template page is followed' });
        // The form's handler ends with ctx.go(the profile), after the public follow list is written: the view's title then has
        // the focus. Wait for that, or a later navigation of this scenario races with it.
        await waitUntil(() => f().evaluate(() => (document.activeElement && document.activeElement.id === 'view-title') || null), { timeoutMs: 30000, label: 'the follow form finished (focus on the view title)' });
        const hidden = stops.filter((s) => !s.visible && !s.media);
        assert(hidden.length === 0, 'no visible focus indicator on: ' + hidden.map((s) => s.tag + ' "' + s.label + '" (' + s.style + ')').join('; '));
        return { stops: stops.length };
      });
      await step('a post page (from the timeline\'s link to the post)', async () => {
        await goTo(page, '/');
        const href = await f().evaluate(() => { const a = document.querySelector('#feed article a[data-act="comments"]'); return a ? a.getAttribute('href') : null; });
        assert(href, 'no link to a post on the timeline');
        await goTo(page, href);
        await axeAudit(f(), 'social: a post', report);
      });
      await step('dark colour scheme: the timeline, the profile and settings', async () => {
        await page.emulateMedia({ colorScheme: 'dark' });
        try {
          for (const [path, name] of [['/', 'timeline'], ['/@' + label, 'profile and wall'], ['/settings', 'settings']]) {
            await goTo(page, path);
            await axeAudit(f(), 'social (dark): ' + name, report);
          }
        } finally {
          await page.emulateMedia({ colorScheme: null });
        }
      });
      return 'a page of its own ' + label + '; keyboard post with ' + posted.stops + ' focus stops, keyboard follow with ' + followed.stops + '; ' + finish(report, ctx, assert);
    },
  };

  return S;
}

export { StepError };
