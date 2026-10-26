// test/e2e/hub-stack.mjs: a subdomain hub on loopback for the v0.3 social scenarios (V03-DESIGN-REVIEW 3.1, Part 4.2
// E-SO-*), next to the main stack of ./lib.mjs (its tracker and owner key are reused).
//
//   hub      http://localhost:<port>/            the loader with <meta name="mw-hub" content="subdomain"> (tools/dev-server.mjs)
//   labels   http://<32 base32>.localhost:<port>/  every person's and group's site (Chromium answers *.localhost itself;
//                                                   test/e2e/browser-args.mjs excludes it from the resolver block)
//   IdO      http://localhost:<port2>/          a TEST build of the identity origin (tools/build-idp.mjs --test --test-psl localhost)
//
// Both the loader and the identity origin are built with the Public Suffix List addition "localhost" (build.mjs testPsl,
// build-idp --test-psl): on a hub that is not on the list persistent identity is off (R 2.17.5), and a personal page
// needs a persistent hub key. The template (examples/social) is published once with the main stack's tracker, a web
// seed on the hub and idp= the test identity origin; its pointer is signed for the hub scope btih:<template>.
// Chromium only: WebKit runs on http://127.0.0.1 URLs only (docs/DEV-NETWORK.md), and a label is a hostname.

import { join } from 'node:path';

import { build } from '../../build.mjs';
import { publish } from '../../tools/publish.mjs';
import { createDevServer } from '../../tools/dev-server.mjs';
import { buildIdp } from '../../tools/build-idp.mjs';
import { loadOwnerKey, ROOT } from '../../tools/lib.mjs';
import { signPointer, hubLabelFor, ledgerIdFor, parsePointer } from '../../src/common/pointer.js';
import { startIdpServer } from '../fixtures/idp/serve.mjs';

export const TEMPLATE_NAME = 'social-template';

/**
 * setupHubStack(stack, { log }) -> { hubUrl, hubPort, idpUrl, dist, outDir, pub, templatePointer, templateLabel,
 *   templateUrl, labelUrl(label, path), close() }
 */
export async function setupHubStack(stack, { log = () => {} } = {}) {
  const closers = [];
  const close = async () => {
    for (const fn of closers.reverse()) {
      try { await fn(); } catch (_) { /* shutting down */ }
    }
    closers.length = 0;
  };
  try {
    const dist = join(stack.runDir, 'dist-hub');
    await build({ outDir: dist, quiet: true, testPsl: ['localhost'] });
    const idpDir = join(stack.runDir, 'dist-idp-hub');
    await buildIdp({ outDir: idpDir, quiet: true, test: true, testPsl: ['localhost'] });
    const idp = await startIdpServer({ dir: idpDir, host: '127.0.0.1' });
    closers.push(() => idp.close());
    const idpUrl = 'http://localhost:' + idp.port;
    const outDir = join(stack.runDir, 'hub-publish');
    const dev = await createDevServer({ root: dist, webseed: outDir, port: 0, host: '127.0.0.1', dev: true, hub: 'subdomain', quiet: true });
    closers.push(() => dev.close());
    const hubUrl = 'http://localhost:' + dev.port + '/';
    const pub = await publish({
      dir: join(ROOT, 'examples', 'social'), name: TEMPLATE_NAME, scope: 'localhost', key: stack.owner.file, out: outDir,
      policy: 'owner', bits: 4, tr: [stack.tracker.url], ws: [hubUrl + 'ws/'], cs: hubUrl + 'ws/genesis.json', exp: 30, quiet: true, idp: idpUrl,
      spa: true, // the app's History API routes (R 3.7): every navigation gets index.html, so a deep link survives a reload
    });
    // A hub link carries the record signed for btih:<template> (ARCHITECTURE 4): sign the published record again for that scope.
    const identity = await loadOwnerKey(stack.owner.file);
    const base = Object.assign({}, pub.record, { sig: null });
    const signed = await signPointer(base, 'btih:' + pub.record.btih, identity.privateKey);
    const templatePointer = signed.raw;
    const parsed = parsePointer(templatePointer);
    const ledgerId = await ledgerIdFor(parsed.record, 'btih:' + pub.record.btih);
    const templateLabel = hubLabelFor(parsed.record, ledgerId);
    const labelUrl = (label, path = '/') => 'http://' + label + '.localhost:' + dev.port + path;
    log('hub ' + hubUrl + ' (template btih ' + pub.btih + ', label ' + templateLabel + '), identity origin ' + idpUrl);
    return {
      hubUrl, hubPort: dev.port, idpUrl, idp, dev, dist, outDir, pub, ledgerId, templatePointer, templateLabel,
      templateUrl: hubUrl + '#' + templatePointer,
      labelUrl,
      close,
    };
  } catch (err) {
    await close();
    throw err;
  }
}

// ---------------------------------------------------------------------------------------------
// Additions for the social rows lane (test/e2e/scenarios-social-rows.mjs; docs/deviations/rows-social.md)
// ---------------------------------------------------------------------------------------------
// Import declarations are hoisted, so these sit with the code that uses them.
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { createHash } from 'node:crypto';

import { keygen } from '../../tools/keygen.mjs';
import { createGenesis, appendControl, keyinfoOp, setCfg } from '../../tools/ledger-admin.mjs';
import { buildRecentSnapshot, buildSnapshot, encodeSnapshot } from '../../tools/snapshot.mjs';
import { PERSONAL_POLICY, randomChain } from '../../src/loader/personal-site.js';
import { formatPointer } from '../../src/common/pointer.js';
import { acceptConsent, siteFrame, waitUntil, sleep, withTimeout, StepError } from './lib.mjs';
import { driveIdp } from './idp-driver.mjs';

const SITE_DAYS = 30;

/** keyPair(dir, name) -> { file, identity: { privateKey, pub } } made with tools/keygen.mjs (files outside the web seed). */
async function keyPair(dir, name) {
  mkdirSync(dir, { recursive: true });
  const file = join(dir, name + '.jwk');
  await keygen({ out: file, force: true });
  return { file, identity: await loadOwnerKey(file) };
}

/** The ledger id a signed hub pointer with this owner and chain has (pointer.js ledgerIdFor: owner and chain only). */
async function hubLedgerId(owner, chain, btih) {
  const draft = parsePointer(formatPointer({ v: 'mw1', btih, owner, chain, seq: 1, exp: 2, sig: 'A'.repeat(86) }));
  if (!draft.ok) throw new Error('the pointer draft does not parse: ' + draft.detail);
  return ledgerIdFor(draft.record, 'btih:' + btih);
}

/** signHubPointer(hub, identity, fields) -> { record, raw, ledgerId, label, url }: a pointer on the template, signed for the hub scope. */
async function signHubPointer(hub, identity, fields) {
  const btih = hub.pub.record.btih;
  const seq = Math.floor(Date.now() / 1000);
  const draft = parsePointer(formatPointer(Object.assign({
    v: 'mw1', btih, owner: identity.pub, seq, exp: seq + SITE_DAYS * 86400, tr: hub.pub.record.tr, ws: hub.pub.record.ws, idp: hub.idpUrl,
  }, fields)));
  if (!draft.ok) throw new Error('the pointer draft does not parse: ' + draft.detail);
  const record = await signPointer(draft.record, 'btih:' + btih, identity.privateKey);
  const ledgerId = await ledgerIdFor(record, 'btih:' + btih);
  const label = hubLabelFor(record, ledgerId);
  return { record, raw: record.raw, ledgerId, label, url: hub.labelUrl(label, '/#' + record.raw) };
}

/**
 * makeSyntheticPages(hub, { count, posts, name, base }) -> [{ i, name, pub, ledgerId, label, url, pointer, posts: [text], blocks, cs, bytes }]
 * Personal pages made with the tools, as "Create my page" makes them (R 3.3): a key (tools/keygen.mjs), the genesis policy of the
 * personal class and a keyinfo (tools/ledger-admin.mjs createGenesis, keyinfoOp), a display name and `posts` wall posts by the owner
 * (appendControl: the owner pays no fee), the recent window for the pointer's cs= (tools/snapshot.mjs buildRecentSnapshot, plain JSON
 * on the hub's web seed under ws/<name>/), and a pointer signed by the person's key for the hub scope with the template's tr=, ws=,
 * idp= and its own cs=. Keys stay in <run>/hub-keys/<name>, outside the web seed.
 */
export async function makeSyntheticPages(hub, { count = 20, posts = 5, name = 'syn', base = Date.now() - 2 * 3600000 } = {}) {
  const btih = hub.pub.record.btih;
  const out = [];
  const webDir = join(hub.outDir, name);
  mkdirSync(webDir, { recursive: true });
  const keyDir = join(dirname(hub.outDir), 'hub-keys', name);
  for (let i = 0; i < count; i++) {
    const nn = String(i + 1).padStart(2, '0');
    const { identity } = await keyPair(keyDir, 'p' + nn);
    const recover = await keyPair(keyDir, 'p' + nn + '-recover');
    const chain = randomChain();
    const ledgerId = await hubLedgerId(identity.pub, chain, btih);
    let t = base + i * 1000;
    const genesis = await createGenesis({ identity, ledgerId, policy: Object.assign({}, PERSONAL_POLICY), now: t });
    let blocks = [genesis];
    const add = async (op, value) => { t += 60000; blocks = (await appendControl({ blocks, identity, op, value, now: t })).blocks; };
    await add(await keyinfoOp({ recoverPub: recover.identity.pub }));
    await add({ t: 'profile' }, 'Synthetic ' + nn);
    const texts = [];
    for (let j = 0; j < posts; j++) {
      const text = 'Synthetic ' + nn + ' post ' + (j + 1);
      texts.push(text);
      await add({ t: 'append', l: 'mw.post' }, { text });
    }
    const rec = await buildRecentSnapshot({ blocks, genesisOwner: identity.pub, gen: genesis.h });
    const file = join(webDir, nn + '.json');
    const data = encodeSnapshot(rec.entries, { plain: true });
    writeFileSync(file, data);
    const cs = hub.hubUrl + 'ws/' + name + '/' + nn + '.json';
    const nx = createHash('sha256').update(recover.identity.pub).digest('base64url');
    const p = await signHubPointer(hub, identity, { chain, gen: genesis.h, nx, cs });
    if (p.ledgerId !== ledgerId) throw new Error('page ' + nn + ': the ledger id of the signed pointer differs');
    out.push({ i, name: 'Synthetic ' + nn, pub: identity.pub, ledgerId, label: p.label, url: p.url, pointer: p.raw, posts: texts, blocks: blocks.length, cs, bytes: data.length });
  }
  return out;
}

/**
 * makeGroupSite(hub, { name, title, moderators, bits, chat }) -> { pub, ledgerId, label, url, pointer, cs, blocks }: a group site
 * (R 3.5 "Groups") made with the tools: its own key, a genesis with writers 'allow', the given moderators and an empty allow list
 * (tools/ledger-admin.mjs), _mw.cfg { chat } (setCfg) and the group's name, the whole ledger as the cs= snapshot (tools/snapshot.mjs),
 * and a pointer signed by the group's key for the hub scope.
 */
export async function makeGroupSite(hub, { name = 'group', title = 'Loopback group', moderators = [], bits = 4, chat = 'open' } = {}) {
  const btih = hub.pub.record.btih;
  const keyDir = join(dirname(hub.outDir), 'hub-keys', name);
  const { identity } = await keyPair(keyDir, 'owner');
  const chain = randomChain();
  const ledgerId = await hubLedgerId(identity.pub, chain, btih);
  let t = Date.now() - 600000;
  const genesis = await createGenesis({ identity, ledgerId, policy: { writers: 'allow', bits, moderators, allow: [], maxChainBytes: 8 * 1024 * 1024 }, now: t });
  let blocks = [genesis];
  t += 60000;
  blocks = (await setCfg({ blocks, identity, set: { chat }, now: t })).blocks;
  t += 60000;
  blocks = (await appendControl({ blocks, identity, op: { t: 'profile' }, value: title, now: t })).blocks;
  const snap = await buildSnapshot({ blocks, genesisOwner: identity.pub, gen: genesis.h });
  const webDir = join(hub.outDir, name);
  mkdirSync(webDir, { recursive: true });
  writeFileSync(join(webDir, 'ledger.json'), encodeSnapshot(snap.entries, { plain: true }));
  const cs = hub.hubUrl + 'ws/' + name + '/ledger.json';
  const p = await signHubPointer(hub, identity, { chain, gen: genesis.h, cs });
  if (p.ledgerId !== ledgerId) throw new Error('group: the ledger id of the signed pointer differs');
  return { pub: identity.pub, ledgerId, label: p.label, url: p.url, pointer: p.raw, cs, blocks: blocks.length };
}

const CARD_COOLDOWN_MS = 10500; // the identity service refuses a second card within 10 s of the last one (E_RATE, R 2.3.9)

/**
 * socialDriver({ assert }) -> the helpers test/e2e/scenarios-social.mjs keeps to itself, for other scenario files: hubOf, appState,
 * shellLog, sdkInfo, openApp, signIn, signUp, post, feedTexts, sdk (an evaluate in the site frame). The same steps and waits.
 */
export function socialDriver({ assert }) {
  async function hubOf(ctx, step) {
    if (ctx.shared.hub) return ctx.shared.hub;
    const hub = await step('the loopback subdomain hub: loader and identity origin built with the PSL addition "localhost", the template published', () => setupHubStack(ctx.stack));
    ctx.closers.push(() => hub.close());
    ctx.shared.hub = hub;
    return hub;
  }
  async function appState(page, { timeoutMs = 30000, label = 'the social app', until = null } = {}) {
    return waitUntil(async () => {
      const f = siteFrame(page);
      if (!f) return null;
      const s = await f.evaluate(() => {
        const c = window.__social && window.__social.ctx;
        if (!c || !c.route || !c.data || !document.querySelector('#view').children.length) return null;
        return {
          title: document.querySelector('#view-title').textContent,
          signIn: document.querySelector('#sign-in').textContent,
          chip: document.querySelector('#identity-chip').hidden ? '' : document.querySelector('#identity-chip').textContent,
          path: location.pathname,
          view: document.querySelector('#view').textContent.replace(/\s+/g, ' ').slice(0, 1200),
        };
      }).catch(() => null);
      if (!s) return null;
      return !until || until(s) ? s : null;
    }, { timeoutMs, label });
  }
  async function shellLog(page) {
    const st = await page.evaluate(() => (window.__mwShell ? window.__mwShell.inspect() : null)).catch(() => null);
    return st && Array.isArray(st.log) ? st.log : [];
  }
  const sdk = (page, fn, arg) => siteFrame(page).evaluate(fn, arg);
  const sdkInfo = (page) => sdk(page, async () => (await import('/_mw/sdk.js')).default.ready());
  async function openApp(ctx, visitor, url, { label }) {
    const page = await visitor.newPage();
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 20000 });
    await acceptConsent(page, { timeoutMs: 20000 });
    const app = await appState(page, { label });
    return { page, app };
  }
  async function signIn(page, plan) {
    const f = siteFrame(page);
    const popupPromise = page.context().waitForEvent('page', { timeout: 30000 });
    await f.click('#sign-in');
    const popup = await popupPromise;
    const drive = await withTimeout(driveIdp(popup, plan), 60000, 'identity origin (sign in)');
    const app = await appState(page, { label: 'signed in', until: (s) => s.signIn === 'Sign out' && Boolean(s.chip) });
    return { drive, app, at: Date.now() };
  }
  /** signUp(ctx, step, name, passphrase) -> { visitor, page, hub, pub, ledgerId, label, url, pointer, record, plan }: R 3.3 as E-SO-1 runs it. */
  async function signUp(ctx, step, name, passphrase) {
    const hub = await hubOf(ctx, step);
    const v = await ctx.visitor(name);
    const plan = { unlock: 'passphrase', passphrase, hub: true };
    const tpl = await step(name + ' opens the hub link and signs in at the identity origin (a passphrase, one identity on all of the hub)', async () => {
      const r = await openApp(ctx, v, hub.templateUrl, { label: name + ': the template page' });
      return Object.assign(r, { first: await signIn(r.page, plan) });
    });
    const page = tpl.page;
    const created = await step(name + ' taps "Create my page": the identity origin confirms, the loader mints the ledger and opens the new address', async () => {
      const wait = tpl.first.at + CARD_COOLDOWN_MS - Date.now();
      if (wait > 0) await sleep(wait);
      const f = siteFrame(page);
      const popupPromise = page.context().waitForEvent('page', { timeout: 30000 });
      const before = page.url();
      let opened = null;
      const onNav = (fr) => { if (!opened && fr === page.mainFrame() && fr.url() !== before && !fr.url().includes(hub.templateLabel)) opened = fr.url(); };
      page.on('framenavigated', onNav);
      await f.click('#create-page');
      const popup = await popupPromise;
      await withTimeout(driveIdp(popup, plan), 60000, 'identity origin (create my page)');
      await waitUntil(async () => {
        if (page.url() !== before && !page.url().includes(hub.templateLabel)) return true;
        const fr = siteFrame(page);
        const href = fr ? await fr.evaluate(() => { const a = document.querySelector('#open-top'); return a ? a.getAttribute('href') : null; }).catch(() => null) : null;
        if (href) await fr.click('#open-top');
        return false;
      }, { timeoutMs: 20000, label: name + ': the new page opens' });
      page.off('framenavigated', onNav);
      assert(opened && opened.indexOf('#') > 0, name + ': the new address has no fragment: ' + opened);
      return opened;
    });
    await step(name + ': the new page loads and ' + name + ' signs in on it as its owner', async () => {
      await acceptConsent(page, { timeoutMs: 20000 });
      await appState(page, { label: name + ': own page' });
      await signIn(page, plan);
      const info = await sdkInfo(page);
      assert(info.role === 'owner' && info.identity && info.identity.pub === info.owner, name + ': role ' + info.role);
    });
    const info = await sdkInfo(page);
    const hash = created.slice(created.indexOf('#') + 1);
    const parsed = parsePointer(decodeURIComponent(hash.split('#')[0]));
    const label = new URL(page.url()).hostname.split('.')[0];
    return {
      visitor: v, page, hub, plan, pub: info.identity.pub, short: info.identity.short, ledgerId: info.siteId, label,
      url: created.split('#mwgen=')[0], pointer: parsed.ok ? parsed.record.raw : null, record: parsed.ok ? parsed.record : null,
    };
  }
  async function post(page, text) {
    const f = siteFrame(page);
    const area = f.locator('form[data-composer] textarea').first();
    await area.fill(text);
    const t0 = Date.now();
    await f.locator('form[data-composer] button[type="submit"]').first().click();
    await waitUntil(() => f.evaluate((tx) => Array.from(document.querySelectorAll('#feed article, #wall article, #group-feed article')).some((a) => a.textContent.indexOf(tx) >= 0), text), { timeoutMs: 30000, label: 'the post "' + text + '" is shown' });
    return Date.now() - t0;
  }
  const feedTexts = (page) => siteFrame(page).evaluate(() => Array.from(document.querySelectorAll('#feed article .post-body')).map((n) => n.textContent));
  return { hubOf, appState, shellLog, sdk, sdkInfo, openApp, signIn, signUp, post, feedTexts, CARD_COOLDOWN_MS, StepError };
}
