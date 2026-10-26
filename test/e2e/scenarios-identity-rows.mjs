// test/e2e/scenarios-identity-rows.mjs: the open identity rows of the test plan's end-to-end table (V03-DESIGN-REVIEW Part
// 4.2; docs/deviations/integration-v03.md, "The test plan's end-to-end rows"), driven in Chromium with the real identity
// origin (tools/build-idp.mjs on its own loopback port), the real loader and the guestbook example.
//
//   E-ID-3   restore at the identity origin: the 12 words give the same public key on the site, and the record the
//            original identity kept is not readable after a phrase-only restore; the backup file gives the same key and
//            the record back; the check code and "Found 1 post" are shown
//   E-ID-3b  a mistyped phrase that passes the checksum: another check code, and "No posts found for these words"
//   E-ID-8   a look-alike origin serving the victim's signed pointer (the victim's ledger id): the card warns "not one of
//            this site's addresses" and the key is the look-alike's own; a second identity origin on another loopback
//            port cannot answer for the site's pinned identity origin
//   E-ID-11  window.open stubbed to return null: the loader's Sign in card, then "Continue in this tab", the redirect
//            round trip through the identity origin and /_mw/idp-return signs in
//   E-ID-13  forced fallbacks by init scripts: no PublicKeyCredential (no passkey button, a passphrase), PRF off (a
//            virtual authenticator without PRF: the noPrf line, then a passphrase), getClientCapabilities deleted (the
//            passkey is offered and works with one ceremony)
//   E-ID-14  device link between two identity-origin contexts, the QR payloads typed into the code field: the SAS
//            matches and the new device gets the identity (same key on the site); a key substituted in the middle of
//            QR 2 gives another SAS and "They differ" sends nothing; a substituted reveal is refused (linkCommitBad)
//   E-ID-15  redress: site code covers the loader's in-page Sign in card with an overlay, or restyles the card's host:
//            the card is cancelled with the redress notice and a click there does nothing; the untouched card acts; no
//            high-risk control (phrase, same identity, link, restore) and no input exist in the in-page card
//
// The identity origin is http://127.0.0.1:<port> (the e2e stack's); E-ID-13 opens one on http://localhost:<port>
// (WebAuthn needs a domain RP ID; chromiumArgs() keeps localhost on loopback). Nothing leaves loopback.

import { join } from 'node:path';
import { webcrypto } from 'node:crypto';

import { waitUntil, sleep, withTimeout, StepError, siteFrame, waitForSite, acceptConsent, clickLoaderCard, dismissKitCard } from './lib.mjs';
import { driveIdp, pressCard } from './idp-driver.mjs';
import { buildIdp } from '../../tools/build-idp.mjs';
import { publish } from '../../tools/publish.mjs';
import { createDevServer } from '../../tools/dev-server.mjs';
import { startIdpServer } from '../fixtures/idp/serve.mjs';
import { ROOT } from '../../tools/lib.mjs';
import { UI_TEXT } from '../../src/loader/strings.js';
import { t as idpText } from '../../src/idp/strings.js';
import { phraseToRoot } from '../../src/identity/derive.js';
import { BIP39_ENGLISH } from '../../src/identity/bip39-english.js';
import { b64url } from '../../src/chain/canonical.js';

// E-ID-3B is the review's E-ID-3b (run.mjs upper-cases --only ids).
export const IDENTITY_ROWS_ORDER = ['E-ID-3', 'E-ID-3B', 'E-ID-8', 'E-ID-11', 'E-ID-13', 'E-ID-14', 'E-ID-15'];

const L = (key, params) => idpText(key, params, 'en');
const U = UI_TEXT.en;
const CARD = 'main.mw-idp section.mw-card';
const PASS_A = 'loopback identity passphrase';
const PASS_B = 'loopback restore passphrase two';
const PASS_C = 'loopback restore passphrase three';
const PASS_LA = 'loopback lookalike passphrase';
const PASS_LINK_A = 'loopback device link passphrase';
const PASS_LINK_B = 'loopback new device passphrase';
const PASS_PRF = 'loopback prf fallback passphrase';
const POST_TEXT = 'A post before the restore';
const RECORD_VALUE = 'Ana from the loopback';
const GUESTBOOK = join(ROOT, 'examples', 'peer-guestbook');

const esc = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// ------------------------------------------------------------------------------------------- init scripts (serialised)
function blockPopups() {
  // E-ID-11, E-ID-15: the browser's popup blocker, as an in-app browser or a strict setting would have it.
  window.__e2eOpenCalls = 0;
  window.open = function () { window.__e2eOpenCalls++; return null; };
}
function noPublicKeyCredential() {
  try { delete window.PublicKeyCredential; } catch (_) { /* fall through */ }
  if (typeof window.PublicKeyCredential !== 'undefined') {
    try { Object.defineProperty(window, 'PublicKeyCredential', { value: undefined, configurable: true, writable: true }); } catch (_) { /* leave it */ }
  }
}
function noClientCapabilities() {
  const P = window.PublicKeyCredential;
  if (!P) return;
  try { delete P.getClientCapabilities; } catch (_) { /* fall through */ }
  if (typeof P.getClientCapabilities !== 'undefined') {
    try { Object.defineProperty(P, 'getClientCapabilities', { value: undefined, configurable: true, writable: true }); } catch (_) { /* leave it */ }
  }
}

/** identityRowsScenarios({ assert }) -> { id: { title, fn(ctx, step) } } for test/e2e/run.mjs. */
export function identityRowsScenarios({ assert }) {
  const S = {};

  // ------------------------------------------------------------------------------------------- site helpers
  async function authState(page) {
    const f = siteFrame(page);
    if (!f) return null;
    return f.evaluate(() => ({ auth: document.documentElement.dataset.auth || null, text: (document.querySelector('#auth-state') || {}).textContent || '' })).catch(() => null);
  }

  async function sdkReady(page) {
    return siteFrame(page).evaluate(async () => (await import('/_mw/sdk.js')).default.ready());
  }

  async function openGuestbook(ctx, name, { url = ctx.stack.origin, visitorOpts } = {}) {
    const v = await ctx.visitor(name, visitorOpts);
    const page = await v.newPage();
    const t0 = Date.now();
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 20000 });
    await acceptConsent(page, { timeoutMs: 20000 });
    await waitForSite(page, { timeoutMs: 30000, since: t0, label: name + ': site rendered' });
    await waitUntil(async () => { const a = await authState(page); return a && a.auth ? a : null; }, { timeoutMs: 15000, label: name + ': the sign-in bar' });
    return { v, page };
  }

  /** Clicks the guestbook's Sign in and answers the identity origin's popup with plan (test/e2e/idp-driver.mjs). */
  async function signIn(page, plan, { onPopup = null } = {}) {
    const f = siteFrame(page);
    const popupPromise = page.context().waitForEvent('page', { timeout: 20000 });
    await f.click('#sign-in');
    const popup = await popupPromise;
    const extra = onPopup ? await onPopup(popup) : null;
    const drive = await withTimeout(driveIdp(popup, plan), 60000, 'identity origin');
    const st = await waitUntil(async () => { const a = await authState(page); return a && a.auth === 'signed-in' ? a : null; }, { timeoutMs: 20000, label: 'signed in' });
    return { drive, st, extra, popup, at: Date.now() };
  }

  async function postEntry(page, text) {
    const f = siteFrame(page);
    await f.waitForSelector('#post-form fieldset:not([disabled]) #msg', { timeout: 20000 });
    await f.fill('#msg', text);
    await f.click('#post-btn');
    await waitUntil(() => f.evaluate((t) => Array.from(document.querySelectorAll('#entries li .msg')).some((n) => n.textContent === t), text), { timeoutMs: 30000, label: 'the entry "' + text + '" shows' });
  }

  async function waitEntry(page, text) {
    await waitUntil(() => siteFrame(page).evaluate((t) => Array.from(document.querySelectorAll('#entries li .msg')).some((n) => n.textContent === t), text).catch(() => false),
      { timeoutMs: 30000, label: 'the entry "' + text + '" reached this visitor' });
  }

  /**
   * meGet(page, plan) -> the value of the private record field "display": mw.me.get from a real click on a button the
   * test adds to the site frame (the first read per session is a UI method: the identity origin's "Allow" card, then
   * the unlock), the popup answered with plan.
   */
  async function meGet(page, plan) {
    const f = siteFrame(page);
    await f.evaluate(async () => {
      window.__e2eMw = (await import('/_mw/sdk.js')).default;
      window.__e2eMe = null;
      if (document.getElementById('e2e-me-get')) return;
      const b = document.createElement('button');
      b.id = 'e2e-me-get';
      b.type = 'button';
      b.textContent = 'Read my record (test)';
      b.setAttribute('style', 'position:fixed;left:8px;top:8px;z-index:2147483000');
      b.addEventListener('click', () => {
        window.__e2eMe = { pending: true };
        window.__e2eMw.me.get('display').then((value) => { window.__e2eMe = { value }; }, (e) => { window.__e2eMe = { code: (e && e.code) || 'error', message: e && e.message }; });
      });
      document.body.appendChild(b);
    });
    const popupPromise = page.context().waitForEvent('page', { timeout: 20000 });
    await f.click('#e2e-me-get');
    const popup = await popupPromise;
    const drive = await withTimeout(driveIdp(popup, plan), 60000, 'identity origin (record)');
    const r = await waitUntil(async () => { const x = await f.evaluate(() => window.__e2eMe); return x && !x.pending ? x : null; }, { timeoutMs: 20000, label: 'me.get answered' });
    if (r.code) throw new StepError('me.get failed: ' + r.code + ' ' + (r.message || '') + ' (cards: ' + drive.cards.join(' | ') + ')');
    return { value: r.value, cards: drive.cards };
  }

  // ------------------------------------------------------------------------------------------- identity page helpers
  /**
   * nextCard(page, title) -> the card state once a card this helper has not taken yet shows the title (a string, exactly,
   * or a RegExp); a busy card is skipped. The card is marked as taken (data-e2e-seen) only when it matches.
   */
  async function nextCard(page, title, { timeoutMs = 30000 } = {}) {
    const m = title instanceof RegExp ? { re: title.source, flags: title.flags } : { re: '^' + esc(title) + '$', flags: '' };
    let last = '(none)';
    try {
      return await waitUntil(async () => {
        const st = await page.evaluate(({ re, flags, sel }) => {
          const card = document.querySelector(sel);
          if (!card || card.querySelector('.mw-busy')) return { wait: true };
          const h1 = card.querySelector('h1');
          const t = h1 ? h1.textContent.replace(/\s+/g, ' ').trim() : '';
          if (card.hasAttribute('data-e2e-seen') || !new RegExp(re, flags).test(t)) return { other: t + (card.hasAttribute('data-e2e-seen') ? ' (taken)' : '') };
          card.setAttribute('data-e2e-seen', String(Date.now()));
          return {
            title: t,
            seenAt: Number(card.getAttribute('data-e2e-seen')),
            buttons: Array.from(card.querySelectorAll('button')).map((b) => ({ text: b.textContent.replace(/\s+/g, ' ').trim(), cls: b.className })),
            text: card.textContent.replace(/\s+/g, ' ').trim(),
            errors: Array.from(card.querySelectorAll('.mw-error')).map((e) => e.textContent.trim()).filter(Boolean),
            code: (card.querySelector('.mw-code-text') || {}).textContent || '',
            sas: (card.querySelector('[data-mw-sas]') || { getAttribute: () => '' }).getAttribute('data-mw-sas') || '',
            scan: Boolean(card.querySelector('input[name="code"]')),
          };
        }, Object.assign({ sel: CARD }, m)).catch(() => null);
        if (st && st.other !== undefined) last = st.other;
        return st && st.title !== undefined ? st : null;
      }, { timeoutMs, stepMs: 120, label: 'identity page card "' + title + '"' });
    } catch (err) {
      if (err instanceof StepError) err.message += ' (on screen: ' + last + ')';
      throw err;
    }
  }

  async function fillCard(page, selector, value) {
    await page.locator(CARD + ' ' + selector).first().fill(value);
  }

  /** unlockHome(page, pass): the identity page's passphrase card for an existing identity. */
  async function unlockHome(page, pass) {
    const st = await nextCard(page, L('continuePassphrase'));
    await fillCard(page, 'input[name="passphrase"]', pass);
    await pressCard(page, L('cont'), st);
  }

  /** readKit(v, pass) -> { words, code }: the recovery kit at the identity page (#kit), the 3-word re-entry answered. */
  async function readKit(ctx, v, pass) {
    const p = await v.newPage();
    try {
      await p.goto(ctx.stack.idp.url + '/#kit', { waitUntil: 'load', timeout: 20000 });
      await unlockHome(p, pass);
      let st = await nextCard(p, L('kitTitle'));
      await pressCard(p, L('kitNow'), st);
      st = await nextCard(p, L('showPhraseTitle'));
      const words = await p.evaluate((sel) => Array.from(document.querySelectorAll(sel + ' ol.mw-words li')).map((li) => li.textContent.trim()), CARD);
      const m = /Identity check code: ([a-z2-7]{8})/.exec(st.text);
      assert(words.length === 12, 'the kit shows ' + words.length + ' words');
      assert(m, 'no check code on the kit: ' + st.text.slice(0, 200));
      await pressCard(p, L('cont'), st);
      st = await nextCard(p, L('reentryTitle'));
      const names = await p.evaluate((sel) => Array.from(document.querySelectorAll(sel + ' input[name^="word"]')).map((i) => i.getAttribute('name')), CARD);
      for (const name of names) await fillCard(p, 'input[name="' + name + '"]', words[Number(name.slice(4)) - 1]);
      await pressCard(p, L('cont'), st);
      st = await nextCard(p, '');
      assert(st.text.indexOf(L('reentryDone')) >= 0, 'after the re-entry: ' + st.text.slice(0, 200));
      await pressCard(p, L('close'), st);
      await nextCard(p, L('settingsTitle'));
      return { words, code: m[1] };
    } finally {
      await p.close().catch(() => {});
    }
  }

  /** makeBackupFile(v, pass) -> { text, pass }: a backup file made at the identity page (#backup), its text copied. */
  async function makeBackupFile(ctx, v, pass) {
    const p = await v.newPage();
    try {
      await p.goto(ctx.stack.idp.url + '/#backup', { waitUntil: 'load', timeout: 20000 });
      await unlockHome(p, pass);
      let st = await nextCard(p, L('backupTitle'));
      const gen = await p.evaluate((sel) => (document.querySelector(sel + ' p.mw-code') || {}).textContent || '', CARD);
      const prefix = L('backupPassphrase', { pass: '' });
      assert(gen.startsWith(prefix), 'no generated passphrase: ' + gen);
      const filePass = gen.slice(prefix.length).trim();
      await pressCard(p, L('backupSave'), st);
      st = await nextCard(p, L('backupSaveTitle'), { timeoutMs: 45000 });
      await pressCard(p, L('backupCopy'), st);
      const text = await p.locator(CARD + ' textarea[name="backup-text"]').inputValue();
      let head = null;
      try { head = JSON.parse(text); } catch (_) { head = null; }
      assert(head && head.type === 'mw-identity' && head.v === 3 && typeof head.ct === 'string', 'the backup text: ' + text.slice(0, 120));
      await pressCard(p, L('backupSaved'), st);
      await nextCard(p, L('settingsTitle'));
      return { text, pass: filePass };
    } finally {
      await p.close().catch(() => {});
    }
  }

  /** mistyped(words) -> 12 words that differ from words in one word and still pass the BIP-39 checksum (about 1 in 16). */
  function mistyped(words) {
    for (let i = 3; i < 11; i++) {
      for (const w of BIP39_ENGLISH) {
        if (w === words[i]) continue;
        const copy = words.slice();
        copy[i] = w;
        try { phraseToRoot(copy); return copy; } catch (_) { /* fails the checksum: next */ }
      }
    }
    throw new StepError('no mistyped phrase passes the checksum');
  }

  async function rawP256() {
    const k = await webcrypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
    return b64url.encode(new Uint8Array(await webcrypto.subtle.exportKey('raw', k.publicKey)));
  }

  /** cardsDump(page) -> { host, text, buttons, fields }: the loader's card host and its CLOSED shadow root, read through DevTools (pierce). */
  async function cardsDump(page) {
    const cdp = await page.context().newCDPSession(page);
    try {
      const { root } = await cdp.send('DOM.getDocument', { depth: -1, pierce: true });
      let host = null;
      const find = (n) => {
        if (!n || host) return;
        const a = n.attributes || [];
        for (let i = 0; i < a.length; i += 2) if (a[i] === 'data-mw-ui-cards') { host = n; return; }
        for (const c of n.children || []) find(c);
      };
      find(root);
      if (!host) return { host: false, text: '', buttons: [], fields: [] };
      const text = [];
      const buttons = [];
      const fields = [];
      const walk = (n, acc) => {
        if (n.nodeType === 3) { text.push(n.nodeValue); if (acc) acc.push(n.nodeValue); return; }
        const name = String(n.nodeName || '').toLowerCase();
        if (name === 'input' || name === 'textarea' || name === 'select') fields.push(name);
        const mine = name === 'button' ? [] : acc;
        for (const c of n.shadowRoots || []) walk(c, mine);
        for (const c of n.children || []) walk(c, mine);
        if (name === 'button') buttons.push(mine.join('').replace(/\s+/g, ' ').trim());
      };
      walk(host, null);
      return { host: true, text: text.join(' ').replace(/\s+/g, ' ').trim(), buttons, fields };
    } finally {
      await cdp.detach().catch(() => {});
    }
  }

  const rectOf = (page, label) => page.evaluate((l) => (window.__mwShell && typeof window.__mwShell.rectOf === 'function' ? window.__mwShell.rectOf(l) : null), label).catch(() => null);
  const openCalls = (page) => page.evaluate(() => window.__e2eOpenCalls || 0);

  /** idoOrigins(ctx, v) -> the identity origin's per-origin record ({ origin: { label, keyMode, ... } }), read in its own page. */
  async function idoOrigins(ctx, v) {
    const p = await v.newPage();
    try {
      await p.goto(ctx.stack.idp.url + '/', { waitUntil: 'load', timeout: 20000 });
      return await p.evaluate(() => new Promise((resolve, reject) => {
        const r = indexedDB.open('mw-idp');
        r.onerror = () => reject(r.error);
        r.onsuccess = () => {
          const db = r.result;
          const q = db.transaction('kv', 'readonly').objectStore('kv').get('state');
          q.onsuccess = () => { db.close(); resolve((q.result && q.result.origins) || {}); };
          q.onerror = () => { db.close(); reject(q.error); };
        };
      }));
    } finally {
      await p.close().catch(() => {});
    }
  }

  // ------------------------------------------------------------------------------------------- the original identity (E-ID-3, 3b)
  /**
   * original(ctx, step) -> { pub, words, code, backup }: visitor RA signs in with a new passphrase identity, posts an entry,
   * keeps a private record field (read once through the identity origin, so its vault holds it), then reads the recovery
   * kit and makes a backup file at the identity page. Shared by E-ID-3 and E-ID-3b (made once per run).
   */
  async function original(ctx, step) {
    if (ctx.shared.rowsOriginal) return ctx.shared.rowsOriginal;
    const { v, page } = await step('visitor RA opens the guestbook and signs in with a new passphrase identity', async () => {
      const o = await openGuestbook(ctx, 'RA');
      await signIn(o.page, { unlock: 'passphrase', passphrase: PASS_A });
      return o;
    });
    const pub = (await sdkReady(page)).identity.pub;
    await step('RA posts an entry', async () => {
      await postEntry(page, POST_TEXT);
      await sleep(400);
      await dismissKitCard(page).catch(() => false);
    });
    await step('RA keeps a private record field (me.set) and reads it once in a click (the identity origin\'s "Allow" card): the vault takes the copy', async () => {
      await siteFrame(page).evaluate(async (val) => { await (await import('/_mw/sdk.js')).default.me.set('display', val); }, RECORD_VALUE);
      await sleep(400);
      await dismissKitCard(page).catch(() => false);
      const r = await meGet(page, { passphrase: PASS_A });
      assert(r.value === RECORD_VALUE, 'me.get on the original identity: ' + JSON.stringify(r.value));
      assert(r.cards.indexOf(L('allow')) >= 0, 'no "Allow" card at the identity origin: ' + r.cards.join(' | '));
    });
    const kit = await step('RA opens the identity page at #kit: the 12 words, the check code, the 3-word re-entry', () => readKit(ctx, v, PASS_A));
    const backup = await step('RA makes a backup file at the identity page (#backup, the generated 6-word passphrase, "Copy the text instead")', () => makeBackupFile(ctx, v, PASS_A));
    ctx.shared.rowsOriginal = { pub, words: kit.words, code: kit.code, backup, page };
    return ctx.shared.rowsOriginal;
  }

  // ------------------------------------------------------------------------------------------- E-ID-3
  S['E-ID-3'] = {
    title: 'restore at the identity origin: the 12 words give the same key and not the old record; the backup file gives the same key and the record',
    async fn(ctx, step) {
      const A = await original(ctx, step);
      const site = new URL(ctx.stack.origin).host;
      const { page: pb } = await step('visitor RB (a fresh profile) opens the guestbook and sees RA\'s entry', async () => {
        const o = await openGuestbook(ctx, 'RB');
        await waitEntry(o.page, POST_TEXT);
        return o;
      });
      const seen = { code: null, found: null };
      const restoredCard = (st) => {
        if (st.title !== L('restored')) return undefined;
        const m = /Identity check code: ([a-z2-7]{8})/.exec(st.text);
        if (m) seen.code = m[1];
        else seen.found = st.text;
        return undefined; // the driver answers (Continue)
      };
      await step('Sign in > "Restore an identity" > the 12 words: the check code card, a passphrase for this device, then the post count', () => signIn(pb, { restore: { words: A.words }, unlock: 'passphrase', passphrase: PASS_B, onCard: restoredCard }));
      assert(seen.code === A.code, 'check code after the phrase restore ' + seen.code + ', on the kit ' + A.code);
      assert(seen.found && seen.found.indexOf(L('foundOnePost', { site })) >= 0, 'no "' + L('foundOnePost', { site }) + '" card: ' + seen.found);
      const keyB = (await sdkReady(pb)).identity.pub;
      assert(keyB === A.pub, 'the phrase restore gives ' + keyB + ', the original key is ' + A.pub);
      const recB = await step('me.get after the phrase restore: the record the original identity kept is not readable (its key was random, in the vault)', () => meGet(pb, { passphrase: PASS_B }));
      assert(recB.value === null, 'a phrase-only restore read the old record: ' + JSON.stringify(recB.value));

      const { page: pc } = await step('visitor RC (a fresh profile) opens the guestbook', () => openGuestbook(ctx, 'RC'));
      await step('Sign in > "Restore an identity" > the backup file and its passphrase, then a passphrase for this device', () => signIn(pc, {
        restore: { file: true }, unlock: 'passphrase', passphrase: PASS_C,
        onCard: async (st, { popup }) => {
          if (st.title !== L('restoreTitle')) return undefined;
          await popup.locator(CARD + ' input[name="backup"]').setInputFiles({ name: 'magnet-web-identity-backup.json', mimeType: 'application/json', buffer: Buffer.from(A.backup.text) });
          await popup.locator(CARD + ' input[name="filepass"]').fill(A.backup.pass);
          await pressCard(popup, L('restoreFile'), st);
          return 'handled';
        },
      }));
      const keyC = (await sdkReady(pc)).identity.pub;
      assert(keyC === A.pub, 'the file restore gives ' + keyC + ', the original key is ' + A.pub);
      const recC = await step('me.get after the file restore: the record is back', () => meGet(pc, { passphrase: PASS_C }));
      assert(recC.value === RECORD_VALUE, 'the file restore read ' + JSON.stringify(recC.value));
      return 'phrase: same key, check code ' + seen.code + ', "' + seen.found.slice(seen.found.indexOf('Found'), seen.found.indexOf('Found') + 22) + '...", record null; file: same key, record back';
    },
  };

  // ------------------------------------------------------------------------------------------- E-ID-3b
  S['E-ID-3B'] = {
    title: 'E-ID-3b: a mistyped phrase that passes the checksum: another check code, and "No posts found for these words"',
    async fn(ctx, step) {
      const A = await original(ctx, step);
      const site = new URL(ctx.stack.origin).host;
      const typo = mistyped(A.words);
      const changed = typo.findIndex((w, i) => w !== A.words[i]);
      const { page: pd } = await step('visitor RD (a fresh profile) opens the guestbook and sees RA\'s entry', async () => {
        const o = await openGuestbook(ctx, 'RD');
        await waitEntry(o.page, POST_TEXT);
        return o;
      });
      const seen = { code: null, none: null };
      await step('Restore with word ' + (changed + 1) + ' mistyped (it passes the checksum), this visit only: the check code, then the post count', () => signIn(pd, {
        restore: { words: typo }, unlock: 'visit',
        onCard: async (st, { popup }) => {
          if (st.title !== L('restored')) return undefined;
          const m = /Identity check code: ([a-z2-7]{8})/.exec(st.text);
          if (m) { seen.code = m[1]; return undefined; }
          seen.none = st.text;
          await pressCard(popup, L('continueAnyway'), st);
          return 'handled';
        },
      }));
      assert(seen.code && seen.code !== A.code, 'the mistyped phrase shows check code ' + seen.code + ' (the kit says ' + A.code + ')');
      assert(seen.none && seen.none.indexOf(L('noPosts', { site })) >= 0, 'no "' + L('noPosts', { site }) + '": ' + seen.none);
      const keyD = (await sdkReady(pd)).identity.pub;
      assert(keyD !== A.pub, 'the mistyped phrase gave the original key');
      return 'check code ' + seen.code + ' (kit ' + A.code + '); "' + L('noPosts', { site }) + '"; another key';
    },
  };

  // ------------------------------------------------------------------------------------------- E-ID-8
  /** The victim site (its own origin listed in org=) and a look-alike origin serving the same signed pointer. */
  async function lookalike(ctx, step) {
    if (ctx.shared.rowsLookalike) return ctx.shared.rowsLookalike;
    const { stack } = ctx;
    const r = await step('a victim guestbook whose pointer lists its own origin in org=, and a look-alike origin on another loopback port serving that same pointer', async () => {
      const outDir = join(stack.runDir, 'la-publish');
      const victim = await createDevServer({ root: stack.dist, webseed: outDir, port: 0, host: '127.0.0.1', dev: true, quiet: true });
      ctx.closers.push(() => victim.close());
      const victimOrigin = new URL(victim.url).origin;
      const pub = await publish({
        dir: GUESTBOOK, name: 'la-guestbook', scope: '127.0.0.1', key: stack.owner.file, out: outDir, policy: 'open', bits: 4,
        tr: [stack.tracker.url], ws: [victim.url + 'ws/'], cs: victim.url + 'ws/genesis.json', exp: 30, quiet: true, idp: stack.idp.url, org: [victimOrigin],
      });
      victim.setPointer(pub.pointer);
      const look = await createDevServer({ root: stack.dist, webseed: outDir, port: 0, host: '127.0.0.1', dev: true, quiet: true });
      ctx.closers.push(() => look.close());
      look.setPointer(pub.pointer);
      return { victim, victimOrigin, look, lookOrigin: new URL(look.url).origin, pub };
    });
    ctx.shared.rowsLookalike = r;
    return r;
  }

  S['E-ID-8'] = {
    title: 'a look-alike origin with the victim\'s ledger id gets its own key and the warning; another identity origin cannot answer for the pinned one',
    async fn(ctx, step) {
      const site = await lookalike(ctx, step);
      const cardOf = (into) => (st) => { if (!into.card && st.title.startsWith(L('signInTo'))) into.card = st; return undefined; };
      const onV = {};
      const { v, page: pv } = await step('visitor LA opens the victim site and signs in (a new passphrase identity)', async () => {
        const o = await openGuestbook(ctx, 'LA', { url: site.victim.url });
        await signIn(o.page, { unlock: 'passphrase', passphrase: PASS_LA, onCard: cardOf(onV) });
        return o;
      });
      const victimInfo = (await sdkReady(pv)).identity;
      assert(onV.card && onV.card.text.indexOf(L('notListed')) < 0, 'the victim\'s own card warns: ' + (onV.card && onV.card.text.slice(0, 300)));

      const onL = {};
      const pl = await v.newPage();
      await step('LA opens the look-alike origin (the victim\'s pointer, so the victim\'s ledger id) and signs in', async () => {
        const t0 = Date.now();
        await pl.goto(site.look.url, { waitUntil: 'domcontentloaded', timeout: 20000 });
        await acceptConsent(pl, { timeoutMs: 20000 });
        await waitForSite(pl, { timeoutMs: 30000, since: t0, label: 'look-alike rendered' });
        const ledgerId = await pl.evaluate(() => (window.__mwShell ? window.__mwShell.inspect().ledgerId : null));
        assert(ledgerId === site.pub.ledgerId, 'the look-alike serves ledger ' + ledgerId + ', the victim ' + site.pub.ledgerId);
        await waitUntil(async () => { const a = await authState(pl); return a && a.auth ? a : null; }, { timeoutMs: 15000, label: 'look-alike sign-in bar' });
        await signIn(pl, { passphrase: PASS_LA, onCard: cardOf(onL) });
      });
      const lookInfo = (await sdkReady(pl)).identity;
      assert(onL.card && onL.card.text.indexOf(L('notListed')) >= 0, 'the look-alike\'s card does not say "' + L('notListed') + '": ' + (onL.card && onL.card.text.slice(0, 300)));
      assert(onL.card.text.indexOf(site.lookOrigin) >= 0, 'the card does not name the browser-reported origin ' + site.lookOrigin);
      assert(lookInfo.pub !== victimInfo.pub, 'the look-alike got the victim\'s key');
      const modes = await step('the identity page\'s own record of the two origins (its IndexedDB, read at the identity origin)', () => idoOrigins(ctx, v));
      const mv = modes[site.victimOrigin] || {};
      const ml = modes[site.lookOrigin] || {};
      assert(mv.keyMode === 'ledger' && mv.label === 'l|' + site.pub.ledgerId, 'the victim origin: ' + JSON.stringify(mv));
      assert(ml.keyMode === 'pairwise' && ml.label === 'o|' + site.lookOrigin, 'the look-alike origin: ' + JSON.stringify(ml));
      await pl.close().catch(() => {});

      // A second identity origin (another loopback port, the same build) posts "ready" and a forged answer to the victim's
      // page while its real sign-in runs: the client listens only to the window it opened at the pinned identity origin.
      const fake = await step('a second identity origin on another loopback port', async () => {
        const s = await startIdpServer({ dir: join(ctx.stack.runDir, 'dist-idp'), host: '127.0.0.1' });
        ctx.closers.push(() => s.close());
        return s;
      });
      await pv.close().catch(() => {});
      const pv2 = await v.newPage();
      const forged = await step('a new victim tab (a guest), a window of the other identity origin opened by it, then Sign in: the forged "ready" and answer are ignored', async () => {
        const t0 = Date.now();
        await pv2.goto(site.victim.url, { waitUntil: 'domcontentloaded', timeout: 20000 });
        await waitForSite(pv2, { timeoutMs: 30000, since: t0, label: 'victim tab' });
        await waitUntil(async () => { const a = await authState(pv2); return a && a.auth === 'guest' ? a : null; }, { timeoutMs: 15000, label: 'a guest in the new tab' });
        const fakePagePromise = pv2.context().waitForEvent('page', { timeout: 15000 });
        await pv2.evaluate((u) => { window.__e2eFake = window.open(u + '/signin', 'mw-e2e-fake', 'popup,width=400,height=600'); }, fake.url);
        const fp = await fakePagePromise;
        await fp.waitForLoadState('load').catch(() => {});
        await fp.evaluate(() => { window.__e2eMsgs = 0; window.addEventListener('message', () => { window.__e2eMsgs++; }); });
        const popupPromise = pv2.context().waitForEvent('page', { timeout: 20000 });
        await siteFrame(pv2).click('#sign-in');
        const popup = await popupPromise;
        await fp.evaluate(() => {
          for (let i = 0; i < 5; i++) window.opener.postMessage({ v: 1, t: 'mw-idp-ready', build: 'forged' }, '*');
          window.opener.postMessage({ v: 1, t: 'mw-signin-res', requestId: 'AAAAAAAAAAAAAAAAAAAAAA', ok: false, code: 'E_USER_CANCELLED' }, '*');
        });
        const drive = await withTimeout(driveIdp(popup, { passphrase: PASS_LA }), 60000, 'identity origin');
        await waitUntil(async () => { const a = await authState(pv2); return a && a.auth === 'signed-in' ? a : null; }, { timeoutMs: 20000, label: 'signed in through the pinned identity origin' });
        const fakeState = await fp.evaluate((sel) => ({ msgs: window.__e2eMsgs, card: Boolean(document.querySelector(sel)), origin: location.origin }), CARD);
        await fp.close().catch(() => {});
        return { drive, fakeState };
      });
      const again = (await sdkReady(pv2)).identity;
      assert(again.pub === victimInfo.pub, 'the sign-in after the forged messages gave ' + again.pub + ', the victim key is ' + victimInfo.pub);
      assert(forged.fakeState.msgs === 0 && !forged.fakeState.card, 'the other identity origin received a request or drew a card: ' + JSON.stringify(forged.fakeState));
      return 'victim ' + site.victimOrigin + ' ledger key (l|<ledger id>) ' + victimInfo.short + ' without the warning; look-alike ' + site.lookOrigin + ' (same ledger id) pairwise key (o|<origin>) ' + lookInfo.short + ' with "' + L('notListed') + '"; ' + fake.url + ' got 0 messages';
    },
  };

  // ------------------------------------------------------------------------------------------- E-ID-11
  S['E-ID-11'] = {
    title: 'popup blocked (window.open returns null): the loader\'s Sign in card, "Continue in this tab", the redirect round trip signs in',
    async fn(ctx, step) {
      const { page } = await step('visitor PB (window.open stubbed to return null in every frame) opens the guestbook', () => openGuestbook(ctx, 'PB', { visitorOpts: { initScripts: [blockPopups] } }));
      await step('Sign in on the site: no window opens, the loader\'s own Sign in card appears', async () => {
        await siteFrame(page).click('#sign-in');
        await waitUntil(() => rectOf(page, U.signInButton).then((r) => (r && r.width > 0 ? r : null)), { timeoutMs: 15000, label: 'the loader\'s Sign in card' });
      });
      const calls = await step('the card\'s Sign in (a real click): blocked again, so "Continue in this tab"', async () => {
        assert(await clickLoaderCard(page, U.signInButton), 'could not click the card');
        await waitUntil(() => rectOf(page, U.continueHere).then((r) => (r && r.width > 0 ? r : null)), { timeoutMs: 15000, label: 'the "Continue in this tab" card' });
        return openCalls(page);
      });
      assert(calls >= 2, 'window.open was called ' + calls + ' time(s): the site click and the card click both try it');
      const drive = await step('"Continue in this tab": the tab goes to the identity origin, which answers back through /_mw/idp-return', async () => {
        assert(await clickLoaderCard(page, U.continueHere), 'could not click "Continue in this tab"');
        await waitUntil(async () => page.url().startsWith(ctx.stack.idp.url + '/signin'), { timeoutMs: 15000, label: 'the tab is at the identity origin' });
        const siteOrigin = new URL(ctx.stack.origin).origin;
        const d = await withTimeout(driveIdp(page, { unlock: 'visit' }, { until: async () => { try { return new URL(page.url()).origin === siteOrigin; } catch (_) { return false; } } }), 60000, 'identity origin (redirect)');
        return d;
      });
      const st = await step('back on the site: signed in, the address is the site\'s own again', async () => {
        await waitForSite(page, { timeoutMs: 30000, label: 'site after the redirect' });
        const a = await waitUntil(async () => { const x = await authState(page); return x && x.auth === 'signed-in' ? x : null; }, { timeoutMs: 20000, label: 'signed in after the redirect' });
        assert(page.url().indexOf('/_mw/idp-return') < 0 && page.url().indexOf('#') < 0, 'the address still carries the answer: ' + page.url());
        return a;
      });
      void st;
      const info = await sdkReady(page);
      assert(info.auth === 'signed-in' && info.identity && /^p256:/.test(info.identity.pub), 'ready() ' + JSON.stringify(info.identity));
      return 'window.open called ' + calls + ' times (null); redirect cards ' + drive.cards.join(' > ') + '; signed in as ' + info.identity.short;
    },
  };

  // ------------------------------------------------------------------------------------------- E-ID-13
  /** A guestbook whose pointer names an identity origin on http://localhost (WebAuthn needs a domain RP ID). */
  async function passkeySite(ctx, step) {
    if (ctx.shared.pkSite) return ctx.shared.pkSite;
    const { stack } = ctx;
    const r = await step('a guestbook whose pointer names an identity origin on http://localhost', async () => {
      const idpDir = join(stack.runDir, 'dist-idp-localhost');
      await buildIdp({ outDir: idpDir, quiet: true });
      const idp = await startIdpServer({ dir: idpDir, host: '127.0.0.1' });
      ctx.closers.push(() => idp.close());
      const idpUrl = 'http://localhost:' + idp.port;
      const outDir = join(stack.runDir, 'pk-publish');
      const dev = await createDevServer({ root: stack.dist, webseed: outDir, port: 0, host: '127.0.0.1', dev: true, quiet: true });
      ctx.closers.push(() => dev.close());
      const pub = await publish({
        dir: GUESTBOOK, name: 'pk-guestbook', scope: '127.0.0.1', key: stack.owner.file, out: outDir, policy: 'open', bits: 4,
        tr: [stack.tracker.url], ws: [dev.url + 'ws/'], cs: dev.url + 'ws/genesis.json', exp: 30, quiet: true, idp: idpUrl,
      });
      dev.setPointer(pub.pointer);
      return { dev, pub, idpUrl, url: dev.url };
    });
    ctx.shared.pkSite = r;
    return r;
  }

  async function authenticator(popup, { prf }) {
    const ceremonies = { added: 0, asserted: 0 };
    const cdp = await popup.context().newCDPSession(popup);
    await cdp.send('WebAuthn.enable');
    cdp.on('WebAuthn.credentialAdded', () => { ceremonies.added++; });
    cdp.on('WebAuthn.credentialAsserted', () => { ceremonies.asserted++; });
    await cdp.send('WebAuthn.addVirtualAuthenticator', { options: { protocol: 'ctap2', transport: 'internal', hasResidentKey: true, hasUserVerification: true, isUserVerified: true, hasPrf: prf, automaticPresenceSimulation: true } });
    return ceremonies;
  }

  S['E-ID-13'] = {
    title: 'forced fallbacks: no PublicKeyCredential, PRF off, getClientCapabilities absent (init scripts and a virtual authenticator)',
    async fn(ctx, step) {
      const site = await passkeySite(ctx, step);
      const notes = [];
      const chooseOf = (into) => (st) => { if (st.title === L('chooseUnlockTitle')) into.choose = st; return undefined; };

      // 1. No PublicKeyCredential: no passkey button, the noPrf line on the choice card, a passphrase identity.
      const a = {};
      const { page: p1 } = await step('visitor FB1 (PublicKeyCredential deleted by an init script) opens the guestbook', () => openGuestbook(ctx, 'FB1', { url: site.url, visitorOpts: { initScripts: [noPublicKeyCredential] } }));
      await step('Sign in: the unlock choice has no passkey button and says why; a passphrase', () => signIn(p1, { unlock: 'passphrase', passphrase: PASS_PRF, onCard: chooseOf(a) }, {
        onPopup: async (popup) => {
          await popup.waitForLoadState('domcontentloaded').catch(() => {});
          a.pkc = await popup.evaluate(() => typeof window.PublicKeyCredential).catch(() => 'unknown');
        },
      }));
      assert(a.pkc === 'undefined', 'PublicKeyCredential in the popup: ' + a.pkc);
      assert(a.choose && !a.choose.buttons.some((b) => b.text === L('unlockPasskey')), 'a passkey button without PublicKeyCredential: ' + JSON.stringify(a.choose && a.choose.buttons));
      assert(a.choose.text.indexOf(L('noPrf')) >= 0, 'the choice card does not say "' + L('noPrf') + '"');
      const i1 = (await sdkReady(p1)).identity;
      assert(i1 && /^p256:/.test(i1.pub), 'no key after the passphrase fallback');
      notes.push('no PublicKeyCredential: no passkey button, passphrase, key ' + i1.short);

      // 2. PRF off: a virtual authenticator without PRF. The passkey is made, gives no PRF output, and the identity page says
      // so and asks for a passphrase in the same window.
      const b = {};
      let cer2 = null;
      const { page: p2 } = await step('visitor FB2 opens the guestbook', () => openGuestbook(ctx, 'FB2', { url: site.url }));
      const r2 = await step('Sign in with a virtual authenticator WITHOUT PRF: "With a passkey" leads to the noPrf message and a passphrase', () => signIn(p2, {
        unlock: 'passkey', passphrase: PASS_PRF,
        onCard: async (st, { popup }) => {
          if (st.title !== L('chooseUnlockTitle')) return undefined;
          b.choose = st;
          if (st.buttons.some((x) => x.text === L('unlockPasskey'))) return undefined; // the driver presses it
          b.noButton = true;
          await pressCard(popup, L('unlockPassphrase'), st);
          return 'handled';
        },
      }, { onPopup: async (popup) => { cer2 = await authenticator(popup, { prf: false }); } }));
      if (b.noButton) {
        assert(b.choose.text.indexOf(L('noPrf')) >= 0, 'PRF reported off, but the choice card does not say so');
        notes.push('PRF off: the browser reported it, no passkey button, the noPrf line, passphrase');
      } else {
        assert(r2.drive.messages.some((m) => m.indexOf(L('noPrf')) >= 0 && m.indexOf(L('passkeyCleanup')) >= 0), 'no noPrf message with the clean-up line: ' + JSON.stringify(r2.drive.messages));
        assert(r2.drive.cards.indexOf(L('unlockPassphrase')) >= 0, 'no passphrase card after the PRF failure: ' + r2.drive.cards.join(' | '));
        assert(cer2 && cer2.added === 1, 'passkey ceremonies ' + JSON.stringify(cer2));
        notes.push('PRF off: passkey made (1 create), no PRF output, the noPrf and clean-up lines, passphrase');
      }
      const i2 = (await sdkReady(p2)).identity;
      assert(i2 && /^p256:/.test(i2.pub), 'no key after the PRF fallback');

      // 3. getClientCapabilities absent: PRF is unknown before create(), so the passkey is offered; with PRF it works.
      const c = {};
      let cer3 = null;
      const { page: p3 } = await step('visitor FB3 (PublicKeyCredential.getClientCapabilities deleted) opens the guestbook', () => openGuestbook(ctx, 'FB3', { url: site.url, visitorOpts: { initScripts: [noClientCapabilities] } }));
      await step('Sign in with a PRF authenticator: the passkey is offered without the capability query, one ceremony', () => signIn(p3, { unlock: 'passkey', onCard: chooseOf(c) }, {
        onPopup: async (popup) => {
          await popup.waitForLoadState('domcontentloaded').catch(() => {});
          c.caps = await popup.evaluate(() => (window.PublicKeyCredential ? typeof window.PublicKeyCredential.getClientCapabilities : 'no PublicKeyCredential')).catch(() => 'unknown');
          cer3 = await authenticator(popup, { prf: true });
        },
      }));
      assert(c.caps === 'undefined', 'getClientCapabilities in the popup: ' + c.caps);
      assert(c.choose && c.choose.buttons.some((x) => x.text === L('unlockPasskey')), 'no passkey button when the capability is unknown');
      assert(cer3 && cer3.added === 1 && cer3.asserted === 0, 'ceremonies ' + JSON.stringify(cer3));
      const i3 = (await sdkReady(p3)).identity;
      assert(i3 && /^p256:/.test(i3.pub) && i3.mode === 'private', 'ready() ' + JSON.stringify(i3));
      notes.push('no getClientCapabilities: passkey offered, 1 create with PRF, key ' + i3.short);
      return notes.join('; ');
    },
  };

  // ------------------------------------------------------------------------------------------- E-ID-14
  S['E-ID-14'] = {
    title: 'device link between two identity-origin contexts with injected QR payloads: SAS match moves the identity; a substituted key is caught',
    async fn(ctx, step) {
      const idp = ctx.stack.idp.url;
      const { v: va, page: ga } = await step('visitor LKA (the old device) signs in on the guestbook with a new passphrase identity', async () => {
        const o = await openGuestbook(ctx, 'LKA');
        await signIn(o.page, { unlock: 'passphrase', passphrase: PASS_LINK_A });
        return o;
      });
      const keyA = (await sdkReady(ga)).identity.pub;
      const vb = await ctx.visitor('LKB');

      const linked = await step('B opens "Link a device" (QR 1); A unlocks, takes QR 1, shows QR 2; B takes QR 2, shows QR 3 and the number; A takes QR 3: both numbers match', async () => {
        const b = await vb.newPage();
        await b.goto(idp + '/#link', { waitUntil: 'load', timeout: 20000 });
        let sb = await nextCard(b, L('linkTitle'));
        const qr1 = sb.code;
        assert(/^mwlink:2:c:/.test(qr1), 'QR 1 ' + qr1.slice(0, 20));
        const a = await va.newPage();
        await a.goto(idp + '/#link', { waitUntil: 'load', timeout: 20000 });
        await unlockHome(a, PASS_LINK_A);
        let sa = await nextCard(a, L('linkTitle'));
        assert(sa.scan, 'A did not open the scan card first');
        await fillCard(a, 'input[name="code"]', qr1);
        await pressCard(a, L('cont'), sa);
        sa = await nextCard(a, L('linkTitle'));
        const qr2 = sa.code;
        assert(/^mwlink:2:a:/.test(qr2), 'QR 2 ' + qr2.slice(0, 20));
        await pressCard(a, L('cont'), sa);
        const aScan3 = await nextCard(a, L('linkTitle'));
        await pressCard(b, L('cont'), sb);
        sb = await nextCard(b, L('linkTitle'));
        await fillCard(b, 'input[name="code"]', qr2);
        await pressCard(b, L('cont'), sb);
        sb = await nextCard(b, L('linkTitle'));
        const qr3 = sb.code;
        const sasB = sb.sas;
        assert(/^mwlink:2:b:/.test(qr3) && /^\d{6}$/.test(sasB), 'QR 3 ' + qr3.slice(0, 20) + ', number ' + sasB);
        await pressCard(b, L('cont'), sb);
        const bScan4 = await nextCard(b, L('linkTitle'));
        await fillCard(a, 'input[name="code"]', qr3);
        await pressCard(a, L('cont'), aScan3);
        sa = await nextCard(a, L('linkTitle'));
        assert(sa.sas === sasB, 'A shows ' + sa.sas + ', B shows ' + sasB);
        assert(sa.buttons.some((x) => x.text === L('linkSasMatch')) && sa.buttons.some((x) => x.text === L('linkSasDiffer')), 'no match / differ buttons');
        assert(!/mwlink:2:s:/.test(sa.text), 'a ciphertext code before the person confirmed');
        await pressCard(a, L('linkSasMatch'), sa);
        sa = await nextCard(a, L('linkTitle'));
        // The identity code and the vault parts cycle on A's screen: read them as B's camera would, one by one.
        const codes = new Map();
        let n = null;
        await waitUntil(async () => {
          const c = await a.evaluate((sel) => (document.querySelector(sel + ' .mw-code-text') || {}).textContent || '', CARD);
          if (/^mwlink:2:s:/.test(c)) codes.set('s', c);
          const m = /^mwlink:2:v:(\d+):(\d+):/.exec(c);
          if (m) { codes.set('v' + m[1], c); n = Number(m[2]); }
          return codes.has('s') && n !== null && codes.size === n + 1;
        }, { timeoutMs: 30000, stepMs: 150, label: 'the identity code and every vault part on A' });
        return { a, b, sasB, sa, bScan4, codes, n };
      });
      const done = await step('B takes the identity code and the ' + 'vault parts, chooses a passphrase: "This device now has your identity"', async () => {
        const { a, b, codes, n } = linked;
        await fillCard(b, 'input[name="code"]', codes.get('s'));
        await pressCard(b, L('cont'), linked.bScan4);
        for (let i = 0; i < n; i++) {
          const sb = await nextCard(b, L('linkTitle'));
          await fillCard(b, 'input[name="code"]', codes.get('v' + i));
          await pressCard(b, L('cont'), sb);
        }
        let sb = await nextCard(b, L('chooseUnlockTitle'));
        await pressCard(b, L('unlockPassphrase'), sb);
        sb = await nextCard(b, L('unlockPassphrase'));
        await fillCard(b, 'input[name="passphrase"]', PASS_LINK_B);
        await fillCard(b, 'input[name="passphrase2"]', PASS_LINK_B);
        await pressCard(b, L('cont'), sb);
        sb = await nextCard(b, '', { timeoutMs: 45000 });
        assert(sb.text.indexOf(L('linkDone')) >= 0, 'B after the link: ' + sb.text.slice(0, 200));
        await pressCard(b, L('close'), sb);
        await pressCard(a, L('close'), linked.sa);
        const sa = await nextCard(a, '');
        assert(sa.text.indexOf(L('linkSent')) >= 0, 'A after the link: ' + sa.text.slice(0, 200));
        await pressCard(a, L('close'), sa);
        await a.close().catch(() => {});
        await b.close().catch(() => {});
        return n;
      });
      const keyB = await step('B signs in on the guestbook with its own passphrase: the same key as A', async () => {
        const { page } = await openGuestbook(ctx, 'LKB');
        await signIn(page, { passphrase: PASS_LINK_B });
        return (await sdkReady(page)).identity.pub;
      });
      assert(keyB === keyA, 'B has ' + keyB + ' after the link, A ' + keyA);

      // A key substituted in the middle of QR 2 (an attacker's eA'): the new device computes another number, the person sees
      // "They differ" on A, and A sends nothing.
      const vc = await ctx.visitor('LKC');
      const mitm = await step('a third device C; QR 2 replaced by an attacker\'s key on its way to C: the numbers differ, "They differ" ends the link with nothing sent', async () => {
        const c = await vc.newPage();
        await c.goto(idp + '/#link', { waitUntil: 'load', timeout: 20000 });
        let sc = await nextCard(c, L('linkTitle'));
        const qr1 = sc.code;
        const a = await va.newPage();
        await a.goto(idp + '/#link', { waitUntil: 'load', timeout: 20000 });
        await unlockHome(a, PASS_LINK_A);
        let sa = await nextCard(a, L('linkTitle'));
        await fillCard(a, 'input[name="code"]', qr1);
        await pressCard(a, L('cont'), sa);
        sa = await nextCard(a, L('linkTitle'));
        await pressCard(a, L('cont'), sa);
        const aScan = await nextCard(a, L('linkTitle'));
        await pressCard(c, L('cont'), sc);
        sc = await nextCard(c, L('linkTitle'));
        await fillCard(c, 'input[name="code"]', 'mwlink:2:a:' + await rawP256());
        await pressCard(c, L('cont'), sc);
        sc = await nextCard(c, L('linkTitle'));
        const sasC = sc.sas;
        await fillCard(a, 'input[name="code"]', sc.code);
        await pressCard(a, L('cont'), aScan);
        sa = await nextCard(a, L('linkTitle'));
        const sasA = sa.sas;
        assert(/^\d{6}$/.test(sasA) && /^\d{6}$/.test(sasC), 'numbers ' + sasA + ' / ' + sasC);
        assert(sasA !== sasC, 'the substituted key gave the same number on both devices (' + sasA + ')');
        await pressCard(a, L('linkSasDiffer'), sa);
        const after = await nextCard(a, /.*/);
        assert(after.title === L('settingsTitle'), 'after "They differ" A shows "' + after.title + '": ' + after.text.slice(0, 200));
        assert(!/mwlink:2:s:/.test(after.text), 'A showed the identity code');
        await a.close().catch(() => {});
        await c.close().catch(() => {});
        return { sasA, sasC };
      });
      const reveal = await step('a substituted reveal (another key than the one C committed to in QR 1): A refuses it', async () => {
        const c = await vc.newPage();
        await c.goto(idp + '/#link', { waitUntil: 'load', timeout: 20000 });
        const sc = await nextCard(c, L('linkTitle'));
        const a = await va.newPage();
        await a.goto(idp + '/#link', { waitUntil: 'load', timeout: 20000 });
        await unlockHome(a, PASS_LINK_A);
        let sa = await nextCard(a, L('linkTitle'));
        await fillCard(a, 'input[name="code"]', sc.code);
        await pressCard(a, L('cont'), sa);
        sa = await nextCard(a, L('linkTitle'));
        await pressCard(a, L('cont'), sa);
        sa = await nextCard(a, L('linkTitle'));
        await fillCard(a, 'input[name="code"]', 'mwlink:2:b:' + await rawP256());
        await pressCard(a, L('cont'), sa);
        const err = await nextCard(a, '');
        assert(err.errors.join(' ').indexOf(L('linkCommitBad')) >= 0, 'A after a substituted reveal: ' + err.text.slice(0, 200));
        await a.close().catch(() => {});
        await c.close().catch(() => {});
        return err.errors.join(' ');
      });
      return 'linked (SAS ' + linked.sasB + ', ' + done + ' vault part(s)), B key = A key; QR 2 substituted: ' + mitm.sasA + ' vs ' + mitm.sasC + ', nothing sent; substituted reveal: "' + reveal + '"';
    },
  };

  // ------------------------------------------------------------------------------------------- E-ID-15
  S['E-ID-15'] = {
    title: 'redress: site code covers or restyles the loader\'s in-page card: cancelled, a click there does nothing; no high-risk control in-page',
    async fn(ctx, step) {
      const { page } = await step('visitor RX (window.open returns null, so Sign in takes the loader\'s in-page card) opens the guestbook', () => openGuestbook(ctx, 'RX', { visitorOpts: { initScripts: [blockPopups] } }));
      const f = siteFrame(page);
      const showCard = async () => {
        await f.click('#sign-in');
        const r = await waitUntil(() => rectOf(page, U.signInButton).then((x) => (x && x.width > 0 ? x : null)), { timeoutMs: 15000, label: 'the loader\'s Sign in card' });
        await sleep(400); // past the card's 250 ms first-visible window, so a click would count
        return r;
      };
      const first = await step('Sign in on the site: the loader\'s in-page Sign in card; read through DevTools, its closed root has no field and no high-risk control', async () => {
        const r = await showCard();
        const d = await cardsDump(page);
        assert(d.host, 'no loader card host');
        assert(d.fields.length === 0, 'the in-page card has fields: ' + d.fields.join(', '));
        const highRisk = [L('restoreTitle'), L('restorePhrase'), L('restoreFile'), L('linkThisNew'), L('linkThisOld'), L('sameConfirm'), L('kitNow'), L('showPhraseTitle'), L('unlockPasskey')];
        const offered = d.buttons.filter((b) => highRisk.indexOf(b) >= 0 || /^Same as on /.test(b));
        assert(offered.length === 0, 'high-risk controls in the page: ' + offered.join(', '));
        assert(d.buttons.indexOf(U.signInButton) >= 0, 'the card buttons: ' + d.buttons.join(', '));
        return { r, buttons: d.buttons };
      });
      const before1 = await openCalls(page);
      await step('site code adds an overlay over the card (z-index above it): the card is cancelled with the redress notice; a click there does nothing', async () => {
        await f.evaluate((r) => {
          const d = parent.document.createElement('div');
          d.id = 'e2e-overlay';
          d.textContent = 'Click here to win';
          d.setAttribute('style', 'position:fixed;left:' + (r.x - 40) + 'px;top:' + (r.y - 20) + 'px;width:' + (r.width + 80) + 'px;height:' + (r.height + 40) + 'px;z-index:2147483647;background:rgba(255,255,255,.96);color:#000');
          parent.document.body.appendChild(d);
        }, first.r);
        await waitUntil(() => rectOf(page, U.signInButton).then((x) => !x), { timeoutMs: 5000, label: 'the card closes' });
        const d = await cardsDump(page);
        assert(d.text.indexOf(U.redressCancelled) >= 0, 'no redress notice: ' + d.text.slice(0, 200));
        await page.mouse.click(first.r.x + first.r.width / 2, first.r.y + first.r.height / 2);
        await sleep(800);
        assert(await openCalls(page) === before1, 'the covered card acted');
        const a = await authState(page);
        assert(a && a.auth === 'guest', 'auth ' + JSON.stringify(a));
        await f.evaluate(() => { const d = parent.document.getElementById('e2e-overlay'); if (d) d.remove(); });
      });
      const second = await step('Sign in again; site code shrinks the card\'s host (a style change): cancelled; a click there does nothing', async () => {
        await sleep(600);
        const r = await showCard();
        const before = await openCalls(page);
        await f.evaluate(() => {
          const host = parent.document.querySelector('[data-mw-ui-cards]');
          host.style.setProperty('transform', 'scale(0.2)', 'important');
          host.style.setProperty('opacity', '0.05', 'important');
        });
        await waitUntil(() => rectOf(page, U.signInButton).then((x) => !x), { timeoutMs: 5000, label: 'the card closes' });
        const d = await cardsDump(page);
        assert(d.text.indexOf(U.redressCancelled) >= 0, 'no redress notice: ' + d.text.slice(0, 200));
        await page.mouse.click(r.x + r.width / 2, r.y + r.height / 2);
        await sleep(800);
        assert(await openCalls(page) === before, 'the restyled card acted');
        await f.evaluate(() => {
          const host = parent.document.querySelector('[data-mw-ui-cards]');
          if (host) { host.style.removeProperty('transform'); host.style.removeProperty('opacity'); }
        });
        return r;
      });
      void second;
      await step('control: Sign in again and leave the card alone: its Sign in acts (window.open called, then "Continue in this tab")', async () => {
        await sleep(600);
        await showCard();
        const before = await openCalls(page);
        assert(await clickLoaderCard(page, U.signInButton), 'could not click the card');
        await waitUntil(() => rectOf(page, U.continueHere).then((x) => (x && x.width > 0 ? x : null)), { timeoutMs: 15000, label: '"Continue in this tab"' });
        assert(await openCalls(page) === before + 1, 'the untouched card did not try to open the identity window');
        await clickLoaderCard(page, U.cancel);
      });
      return 'card buttons ' + first.buttons.join(' / ') + '; overlay and restyle both cancelled with "' + U.redressCancelled + '"; the untouched card acted';
    },
  };

  return S;
}

export { StepError };
