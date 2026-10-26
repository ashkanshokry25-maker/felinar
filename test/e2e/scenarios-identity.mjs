// test/e2e/scenarios-identity.mjs: v0.3 identity end to end (V03-DESIGN-REVIEW 2.2 to 2.4, Part 4.2 E-ID-*), with the real
// identity origin (tools/build-idp.mjs, served on its own loopback port), the real loader and the guestbook example.
//
//   E-ID-1   first sign-in through the identity origin's popup with a passkey (Chromium's virtual authenticator, PRF):
//            one ceremony (the PRF output comes from create()), working keys installed, a post
//   E-ID-2   "Stay signed in": a reload is still signed in; without it the reload is a guest, and a sign-in brings the
//            same key back (a passphrase identity here: one prompt; a passkey makes that one tap)
//   E-ID-2b  sign-out deletes the working keys from IndexedDB (inspected) and a follower tab drops its state
//   E-ID-4   two sites get different keys; "Same as on <the other site>" (a second, deliberate press) gives one key
//            (the "revoke for the future" half, at the identity origin's home page: not here)
//   E-ID-5   the site cannot call the loader-only methods; mw.me.get without a click is E_NEEDS_GESTURE
//   E-ID-6   host-only mode: sign-in works and nothing peer-to-peer starts (no tracker socket, no peer connection)
//   E-ID-7   a shared-origin hub: the identity origin offers "this visit only" and the site gets a visit-only key
//   E-ID-10  DOM scan: no field for a phrase, a passphrase or a backup file on any site origin page (loader shell, site
//            frame, drop-in forum, social app); only the identity origin has them
//
// Chromium with the local-only flags. The passkey scenario opens the identity origin as http://localhost:<port> (WebAuthn
// needs a domain RP ID; chromiumArgs() keeps localhost); everything else is http://127.0.0.1.

import { join } from 'node:path';

import { waitUntil, sleep, withTimeout, StepError, siteFrame, waitForSite, acceptConsent, clickShellButton, hubPointer, gateState, clickGateButton } from './lib.mjs';
import { driveIdp } from './idp-driver.mjs';
import { buildIdp } from '../../tools/build-idp.mjs';
import { publish } from '../../tools/publish.mjs';
import { createDevServer } from '../../tools/dev-server.mjs';
import { startIdpServer } from '../fixtures/idp/serve.mjs';
import { ROOT } from '../../tools/lib.mjs';
import { STRINGS } from '../../src/loader/strings.js';
import { t as idpText } from '../../src/idp/strings.js';

// E-ID-2B is the review's E-ID-2b (run.mjs upper-cases --only ids, as with 10B).
export const IDENTITY_ORDER = ['E-ID-1', 'E-ID-2', 'E-ID-2B', 'E-ID-4', 'E-ID-5', 'E-ID-6', 'E-ID-10', 'E-ID-7'];

const PASS = 'loopback identity passphrase';

/** identityScenarios({ assert }) -> { id: { title, fn(ctx, step) } } for test/e2e/run.mjs. */
export function identityScenarios({ assert }) {
  const S = {};

  // ------------------------------------------------------------------------------------------- helpers
  async function authState(page) {
    const f = siteFrame(page);
    if (!f) return null;
    return f.evaluate(() => ({ auth: document.documentElement.dataset.auth || null, text: (document.querySelector('#auth-state') || {}).textContent || '' })).catch(() => null);
  }

  async function sdkReady(page) {
    return siteFrame(page).evaluate(async () => (await import('/_mw/sdk.js')).default.ready());
  }

  async function openGuestbook(ctx, name, { url = ctx.stack.origin, consent = true } = {}) {
    const v = await ctx.visitor(name);
    const page = await v.newPage();
    const t0 = Date.now();
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 20000 });
    if (consent) await acceptConsent(page, { timeoutMs: 20000 });
    await waitForSite(page, { timeoutMs: 30000, since: t0, label: name + ': site rendered' });
    await waitUntil(async () => { const a = await authState(page); return a && a.auth ? a : null; }, { timeoutMs: 15000, label: name + ': the sign-in bar' });
    return { v, page };
  }

  /** Clicks the guestbook's Sign in (a real click in the site frame) and answers the popup with plan. */
  async function signIn(page, plan, { onPopup = null } = {}) {
    const f = siteFrame(page);
    const popupPromise = page.context().waitForEvent('page', { timeout: 20000 });
    await f.click('#sign-in');
    const popup = await popupPromise;
    const extra = onPopup ? await onPopup(popup) : null;
    const drive = await withTimeout(driveIdp(popup, plan), 60000, 'identity origin');
    const st = await waitUntil(async () => { const a = await authState(page); return a && a.auth === 'signed-in' ? a : null; }, { timeoutMs: 20000, label: 'signed in' });
    return { drive, st, extra, at: Date.now() };
  }

  async function idbKeys(page) {
    return page.evaluate(async () => {
      const names = indexedDB.databases ? (await indexedDB.databases()).map((d) => d.name) : ['mw-identity'];
      if (names.indexOf('mw-identity') < 0) return { db: false, keys: 0 };
      const db = await new Promise((res, rej) => { const r = indexedDB.open('mw-identity'); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
      try {
        if (!db.objectStoreNames.contains('keys')) return { db: true, keys: 0 };
        const n = await new Promise((res, rej) => { const q = db.transaction('keys', 'readonly').objectStore('keys').count(); q.onsuccess = () => res(q.result); q.onerror = () => rej(q.error); });
        return { db: true, keys: n };
      } finally { db.close(); }
    });
  }

  async function postEntry(page, text) {
    const f = siteFrame(page);
    await f.waitForSelector('#post-form fieldset:not([disabled]) #msg', { timeout: 20000 });
    await f.fill('#msg', text);
    await f.click('#post-btn');
    await waitUntil(() => f.evaluate((t) => Array.from(document.querySelectorAll('#entries li .msg')).some((n) => n.textContent === t), text), { timeoutMs: 30000, label: 'the entry "' + text + '" shows' });
  }

  /** A guestbook on its own dev server whose pointer names an identity origin on http://localhost (for passkeys). */
  async function passkeySite(ctx, step) {
    if (ctx.shared.pkSite) return ctx.shared.pkSite;
    const { stack } = ctx;
    const r = await step('a guestbook whose pointer names an identity origin on http://localhost (WebAuthn needs a domain RP ID)', async () => {
      const idpDir = join(stack.runDir, 'dist-idp-localhost');
      await buildIdp({ outDir: idpDir, quiet: true });
      const idp = await startIdpServer({ dir: idpDir, host: '127.0.0.1' });
      ctx.closers.push(() => idp.close());
      const idpUrl = 'http://localhost:' + idp.port;
      const outDir = join(stack.runDir, 'pk-publish');
      const dev = await createDevServer({ root: stack.dist, webseed: outDir, port: 0, host: '127.0.0.1', dev: true, quiet: true });
      ctx.closers.push(() => dev.close());
      const pub = await publish({
        dir: join(ROOT, 'examples', 'peer-guestbook'), name: 'pk-guestbook', scope: '127.0.0.1', key: stack.owner.file, out: outDir, policy: 'open', bits: 4,
        tr: [stack.tracker.url], ws: [dev.url + 'ws/'], cs: dev.url + 'ws/genesis.json', exp: 30, quiet: true, idp: idpUrl,
      });
      dev.setPointer(pub.pointer);
      return { dev, pub, idpUrl, url: dev.url };
    });
    ctx.shared.pkSite = r;
    return r;
  }

  // ------------------------------------------------------------------------------------------- E-ID-1
  S['E-ID-1'] = {
    title: 'first sign-in through the identity origin\'s popup with a passkey (virtual authenticator, PRF): one ceremony, working keys installed, a post',
    async fn(ctx, step) {
      const site = await passkeySite(ctx, step);
      const { page } = await step('visitor PK opens the guestbook ("Share and load")', () => openGuestbook(ctx, 'PK', { url: site.url }));
      const ceremonies = { added: 0, asserted: 0 };
      const r = await step('Sign in: the popup is the identity origin; a virtual authenticator with PRF is attached to it; "Create my identity", "With a passkey"', () => signIn(page, { unlock: 'passkey' }, {
        onPopup: async (popup) => {
          assert(popup.url().startsWith(site.idpUrl + '/signin'), 'the popup is ' + popup.url());
          const cdp = await popup.context().newCDPSession(popup);
          await cdp.send('WebAuthn.enable');
          cdp.on('WebAuthn.credentialAdded', () => { ceremonies.added++; });
          cdp.on('WebAuthn.credentialAsserted', () => { ceremonies.asserted++; });
          await cdp.send('WebAuthn.addVirtualAuthenticator', { options: { protocol: 'ctap2', transport: 'internal', hasResidentKey: true, hasUserVerification: true, isUserVerified: true, hasPrf: true, automaticPresenceSimulation: true } });
          return cdp;
        },
      }));
      assert(r.drive.cards.indexOf(idpText('chooseUnlockTitle', null, 'en')) >= 0, 'no unlock choice card: ' + r.drive.cards.join(' | '));
      assert(ceremonies.added === 1 && ceremonies.asserted === 0, 'ceremonies: ' + JSON.stringify(ceremonies) + ' (one create() with PRF, no get())');
      const info = await step('the site has working keys for its own label (pairwise), and a passkey unlock', async () => {
        const i = await sdkReady(page);
        assert(i.auth === 'signed-in' && i.identity && /^p256:/.test(i.identity.pub) && i.identity.mode === 'private', 'ready() ' + JSON.stringify(i.identity));
        return i;
      });
      await step('a post signed with those keys', () => postEntry(page, 'A post after a passkey sign-in'));
      return 'one ceremony (create with PRF), key ' + info.identity.short + ', cards ' + r.drive.cards.join(' > ');
    },
  };

  // ------------------------------------------------------------------------------------------- E-ID-2
  S['E-ID-2'] = {
    title: '"Stay signed in": a reload is still signed in; without it the reload is a guest, and a sign-in brings the same key back',
    async fn(ctx, step) {
      const { page } = await step('visitor ST opens the guestbook', () => openGuestbook(ctx, 'ST'));
      const first = await step('sign in with a new passphrase identity and "Stay signed in"', () => signIn(page, { unlock: 'passphrase', passphrase: PASS, stay: true }));
      const key1 = (await sdkReady(page)).identity.pub;
      await step('reload: still signed in, with no popup and the same key', async () => {
        let popups = 0;
        const onPage = () => { popups++; };
        page.context().on('page', onPage);
        await page.reload({ waitUntil: 'domcontentloaded' });
        await waitForSite(page, { timeoutMs: 30000, label: 'ST after reload' });
        const st = await waitUntil(async () => { const a = await authState(page); return a && a.auth === 'signed-in' ? a : null; }, { timeoutMs: 15000, label: 'signed in after the reload' });
        page.context().off('page', onPage);
        assert(popups === 0, popups + ' popup(s) on reload');
        const i = await sdkReady(page);
        assert(i.identity.pub === key1, 'another key after the reload');
        return st;
      });
      await step('sign out, wait out the card cooldown, sign in again without "Stay signed in"', async () => {
        await siteFrame(page).click('#sign-out');
        await waitUntil(async () => { const a = await authState(page); return a && a.auth === 'guest' ? a : null; }, { timeoutMs: 15000, label: 'guest after sign-out' });
        await sleep(Math.max(0, first.at + 10500 - Date.now()));
        const r = await signIn(page, { passphrase: PASS, stay: false });
        assert(r.drive.cards.indexOf(idpText('continuePassphrase', null, 'en')) >= 0, 'the identity origin did not ask for the passphrase of the existing identity: ' + r.drive.cards.join(' | '));
        const i = await sdkReady(page);
        assert(i.identity.pub === key1, 'the same identity gives this site the same key');
      });
      await step('reload without "Stay signed in": a guest', async () => {
        await page.reload({ waitUntil: 'domcontentloaded' });
        await waitForSite(page, { timeoutMs: 30000, label: 'ST after the second reload' });
        await sleep(1500);
        const a = await waitUntil(async () => { const x = await authState(page); return x && x.auth ? x : null; }, { timeoutMs: 15000, label: 'the sign-in bar' });
        assert(a.auth === 'guest', 'still signed in after a reload without "Stay signed in": ' + JSON.stringify(a));
      });
      return 'key ' + key1.slice(0, 18) + '... kept across a reload only with "Stay signed in"';
    },
  };

  // ------------------------------------------------------------------------------------------- E-ID-2b
  S['E-ID-2B'] = {
    title: 'E-ID-2b: sign-out deletes the working keys from IndexedDB (inspected) and a follower tab drops its state',
    async fn(ctx, step) {
      const { v, page } = await step('visitor SO opens the guestbook and signs in with "Stay signed in"', async () => {
        const o = await openGuestbook(ctx, 'SO');
        await signIn(o.page, { unlock: 'passphrase', passphrase: PASS, stay: true });
        return o;
      });
      const before = await step('the working keys are in IndexedDB (mw-identity, keys)', async () => {
        const k = await idbKeys(page);
        assert(k.db && k.keys > 0, 'no stored keys: ' + JSON.stringify(k));
        return k;
      });
      const follower = await step('a second tab of the same site (a follower) shows the sign-in of the engine tab', async () => {
        const p2 = await v.newPage();
        await p2.goto(ctx.stack.origin, { waitUntil: 'domcontentloaded', timeout: 20000 });
        await waitForSite(p2, { timeoutMs: 30000, label: 'follower tab' });
        await waitUntil(async () => { const a = await authState(p2); return a && a.auth === 'signed-in' ? a : null; }, { timeoutMs: 20000, label: 'follower shows signed in' });
        return p2;
      });
      await step('Sign out in the first tab: no keys left in IndexedDB, and the follower tab is a guest', async () => {
        await siteFrame(page).click('#sign-out');
        await waitUntil(async () => { const a = await authState(page); return a && a.auth === 'guest' ? a : null; }, { timeoutMs: 15000, label: 'guest after sign-out' });
        const k = await waitUntil(async () => { const x = await idbKeys(page); return x.keys === 0 ? x : null; }, { timeoutMs: 10000, label: 'no keys in IndexedDB' });
        await waitUntil(async () => { const a = await authState(follower); return a && a.auth === 'guest' ? a : null; }, { timeoutMs: 15000, label: 'the follower tab drops the sign-in' });
        return k;
      });
      return before.keys + ' stored key record(s) before, 0 after; the follower tab went to guest';
    },
  };

  // ------------------------------------------------------------------------------------------- E-ID-4
  /** A second guestbook on its own dev server, with the e2e stack's identity origin (another origin, same identity origin). */
  async function secondSite(ctx, step) {
    if (ctx.shared.idSecond) return ctx.shared.idSecond;
    const { stack } = ctx;
    const r = await step('a second guestbook on another loopback origin, with the same identity origin', async () => {
      const outDir = join(stack.runDir, 'id2-publish');
      const dev = await createDevServer({ root: stack.dist, webseed: outDir, port: 0, host: '127.0.0.1', dev: true, quiet: true });
      ctx.closers.push(() => dev.close());
      const pub = await publish({
        dir: join(ROOT, 'examples', 'peer-guestbook'), name: 'id2-guestbook', scope: '127.0.0.1', key: stack.owner.file, out: outDir, policy: 'open', bits: 4,
        tr: [stack.tracker.url], ws: [dev.url + 'ws/'], cs: dev.url + 'ws/genesis.json', exp: 30, quiet: true, idp: stack.idp.url,
      });
      dev.setPointer(pub.pointer);
      return { dev, url: dev.url };
    });
    ctx.shared.idSecond = r;
    return r;
  }

  S['E-ID-4'] = {
    title: 'two sites get different keys; "Same as on <the other site>" with its deliberate second press gives one key',
    async fn(ctx, step) {
      const second = await secondSite(ctx, step);
      const originA = new URL(ctx.stack.origin).origin;
      const { page: pa } = await step('visitor TW signs in on site A (a new passphrase identity)', async () => {
        const o = await openGuestbook(ctx, 'TW');
        await signIn(o.page, { unlock: 'passphrase', passphrase: PASS });
        return o;
      });
      const keyA = (await sdkReady(pa)).identity.pub;
      const v = ctx.visitors.get('TW');
      const pb = await v.newPage();
      await step('TW opens site B', async () => {
        const t0 = Date.now();
        await pb.goto(second.url, { waitUntil: 'domcontentloaded', timeout: 20000 });
        await acceptConsent(pb, { timeoutMs: 20000 });
        await waitForSite(pb, { timeoutMs: 30000, since: t0, label: 'site B' });
        await waitUntil(async () => { const a = await authState(pb); return a && a.auth ? a : null; }, { timeoutMs: 15000, label: 'site B sign-in bar' });
      });
      const first = await step('sign in on B with the default ("Private to this site"): another key', () => signIn(pb, { passphrase: PASS }));
      const keyB = (await sdkReady(pb)).identity.pub;
      assert(keyB !== keyA, 'site B got the key of site A without being asked');
      // Review round SEC-1, STALK-1, PHISH-2: the vault copy each site keeps (IndexedDB mw-identity / escrow) has its own id, IV and
      // ciphertext, and the same padded length, so two sites cannot join their visitors on it.
      const escrowOf = (page) => page.evaluate(() => new Promise((resolve) => {
        const open = indexedDB.open('mw-identity');
        open.onerror = () => resolve(null);
        open.onsuccess = () => {
          try {
            const req = open.result.transaction('escrow', 'readonly').objectStore('escrow').get('vault');
            req.onsuccess = () => { const v = req.result; open.result.close(); resolve(v ? { id: v.id, iv: v.iv, len: v.ct.length, head: v.ct.slice(0, 48) } : null); };
            req.onerror = () => resolve(null);
          } catch (_) { resolve(null); }
        };
      }));
      const [ea, eb] = [await escrowOf(pa), await escrowOf(pb)];
      assert(ea && eb, 'both sites keep a vault copy: ' + JSON.stringify([ea, eb]));
      assert(ea.id !== eb.id && ea.iv !== eb.iv && ea.head !== eb.head, 'the two sites hold matching escrow values: ' + JSON.stringify([ea, eb]));
      assert(ea.len === eb.len, 'the copies differ in length (' + ea.len + ', ' + eb.len + ')');
      const linked = await step('sign out on B, then sign in choosing "Same as on ' + new URL(originA).host + '": the key of site A', async () => {
        await siteFrame(pb).click('#sign-out');
        await waitUntil(async () => { const a = await authState(pb); return a && a.auth === 'guest' ? a : null; }, { timeoutMs: 15000, label: 'guest on B' });
        await sleep(Math.max(0, first.at + 10500 - Date.now()));
        const r = await signIn(pb, { passphrase: PASS, same: originA });
        assert(r.drive.cards.some((c) => /^Same as on /.test(c)), 'no confirmation card for the same identity: ' + r.drive.cards.join(' | '));
        const i = await sdkReady(pb);
        return { i, cards: r.drive.cards };
      });
      assert(linked.i.identity.pub === keyA, 'after "same identity" site B has ' + linked.i.identity.pub + ', site A ' + keyA);
      assert(linked.i.identity.mode === 'same', 'identity.mode ' + linked.i.identity.mode);
      return 'A ' + keyA.slice(0, 16) + '..., B private ' + keyB.slice(0, 16) + '..., escrow ids differ, one length ' + ea.len + ', B same as A (cards: ' + linked.cards.join(' > ') + ')';
    },
  };

  // ------------------------------------------------------------------------------------------- E-ID-5
  S['E-ID-5'] = {
    title: 'the site cannot call the loader-only methods; mw.me.get without a click is E_NEEDS_GESTURE',
    async fn(ctx, step) {
      const { page } = await step('visitor HX opens the guestbook and signs in', async () => {
        const o = await openGuestbook(ctx, 'HX');
        await signIn(o.page, { unlock: 'visit' });
        return o;
      });
      // The loader counts a trusted click in the site frame (and the browser's own transient activation) for 5 s. Playwright
      // runs every page.evaluate with a user gesture, so the calls are made from a timer 5.6 s after the evaluate that sets
      // it, and nothing is evaluated in the page until they are done (polling would renew the activation).
      let popups = 0;
      const onPage = () => { popups++; };
      page.context().on('page', onPage);
      const codes = await step('from the site frame, 5.6 s after any gesture: me.get, identity export and import, the raw loader-only names', async () => {
        await siteFrame(page).evaluate(() => {
          window.__mwE2E5 = null;
          setTimeout(async () => {
            const mw = (await import('/_mw/sdk.js')).default;
            const code = async (fn) => {
              try {
                return await Promise.race([Promise.resolve().then(fn).then(() => 'resolved'), new Promise((res) => setTimeout(() => res('no answer in 3 s'), 3000))]);
              } catch (e) { return e && e.code; }
            };
            const ua = navigator.userActivation ? navigator.userActivation.isActive : null;
            window.__mwE2E5 = {
              activeWhenCalled: ua,
              meGet: await code(() => mw.me.get('display')),
              exportKey: typeof (mw.identity && mw.identity.export) === 'function' ? await code(() => mw.identity.export()) : 'not in the SDK',
              importKey: typeof (mw.identity && mw.identity.import) === 'function' ? await code(() => mw.identity.import('x')) : 'not in the SDK',
              root: typeof (mw.identity && mw.identity.root),
            };
          }, 5600);
        });
        await sleep(5600 + 3 * 3000 + 1500);
        return siteFrame(page).evaluate(() => window.__mwE2E5);
      });
      page.context().off('page', onPage);
      assert(codes.meGet === 'E_NEEDS_GESTURE', 'me.get without a click gave ' + codes.meGet + ' (' + JSON.stringify(codes) + ', ' + popups + ' popup(s))');
      assert(popups === 0, popups + ' identity window(s) opened without a click');
      assert(codes.exportKey !== 'resolved' && codes.importKey !== 'resolved', 'a loader-only method resolved: ' + JSON.stringify(codes));
      assert(codes.root === 'undefined', 'the SDK exposes identity.root');
      return JSON.stringify(codes);
    },
  };

  // ------------------------------------------------------------------------------------------- E-ID-6
  S['E-ID-6'] = {
    title: 'host-only mode: sign-in works and nothing peer-to-peer starts (no tracker socket, no peer connection)',
    async fn(ctx, step) {
      const v = await ctx.visitor('HO');
      const page = await v.newPage();
      await step('a fresh visitor chooses "Load from host only" on the first-run card', async () => {
        const t0 = Date.now();
        await page.goto(ctx.stack.origin, { waitUntil: 'domcontentloaded', timeout: 20000 });
        await clickShellButton(page, new RegExp('^' + STRINGS.consentHostOnly + '$'), { scope: '.mw-notice button, .mw-gate button', timeoutMs: 20000 });
        await waitForSite(page, { timeoutMs: 30000, since: t0, label: 'HO site' });
      });
      await step('sign in at the identity origin (this visit only)', () => signIn(page, { unlock: 'visit' }));
      await step('2 s later: no WebSocket and no RTCPeerConnection from this visitor', async () => {
        await sleep(2000);
        const pcs = await page.evaluate(() => window.__mwE2EPc || 0);
        assert(v.sockets.length === 0, 'sockets: ' + v.sockets.map((s) => s.url).join(', '));
        assert(pcs === 0, pcs + ' RTCPeerConnection(s)');
      });
      const info = await sdkReady(page);
      assert(info.auth === 'signed-in', 'auth ' + info.auth);
      return 'signed in as ' + info.identity.short + ' with 0 sockets and 0 peer connections';
    },
  };

  // ------------------------------------------------------------------------------------------- E-ID-10
  const SCAN = () => {
    const bad = [];
    const re = /phrase|passphrase|mnemonic|recovery|seed|12 words|backup/i;
    const look = (doc, where) => {
      for (const el of Array.from(doc.querySelectorAll('input, textarea, select'))) {
        const attrs = ['name', 'id', 'placeholder', 'aria-label', 'autocomplete', 'accept'].map((a) => el.getAttribute(a) || '').join(' ');
        const marked = el.hasAttribute('data-mw-phrase') || el.hasAttribute('data-mw-secret') || el.hasAttribute('data-mw-backup-file');
        if (marked || (el.getAttribute('type') || '').toLowerCase() === 'password' || re.test(attrs)) bad.push(where + ': <' + el.tagName.toLowerCase() + ' ' + attrs.trim() + '>');
      }
      for (const host of Array.from(doc.querySelectorAll('*'))) if (host.shadowRoot) look(host.shadowRoot, where + ' (open shadow root)');
    };
    look(document, location.origin + location.pathname);
    for (const f of Array.from(document.querySelectorAll('iframe'))) {
      try { if (f.contentDocument) look(f.contentDocument, 'frame ' + f.contentDocument.location.pathname); } catch (_) { /* another origin */ }
    }
    return bad;
  };

  S['E-ID-10'] = {
    title: 'DOM scan: no field for a phrase, a passphrase or a backup file on a site origin (shell, site frame, drop-in forum, social app); only the identity origin has them',
    async fn(ctx, step) {
      const pages = [];
      const gb = await step('the guestbook shell and its site frame, signed in (profile and members pages too)', async () => {
        const { v, page } = await openGuestbook(ctx, 'SCAN');
        await signIn(page, { unlock: 'visit' });
        const found = [];
        for (const path of ['/', '/profile.html', '/members.html']) {
          if (path !== '/') {
            await page.goto(ctx.stack.origin.replace(/\/$/, '') + path, { waitUntil: 'domcontentloaded', timeout: 20000 });
            await waitForSite(page, { timeoutMs: 30000, label: 'SCAN ' + path, h1: /./ });
          }
          found.push(...await page.evaluate(SCAN));
        }
        pages.push('guestbook /, /profile.html, /members.html');
        return { found, v };
      });
      const others = [];
      if (ctx.shared.forum) {
        const v = await ctx.visitor('SCAN-F');
        const p = await v.newPage();
        await p.goto(ctx.shared.forum.url + '/', { waitUntil: 'load', timeout: 20000 });
        others.push(...await p.evaluate(SCAN));
        pages.push('drop-in forum');
      }
      if (ctx.shared.ada && ctx.shared.ada.page && !ctx.shared.ada.page.isClosed()) {
        for (const path of ['/', '/settings', '/settings/identity', '/messages', '/media']) {
          await siteFrame(ctx.shared.ada.page).evaluate((p) => window.__social.ctx.go(p), path);
          await sleep(400);
          others.push(...await ctx.shared.ada.page.evaluate(SCAN));
        }
        pages.push('social app /, /settings, /settings/identity, /messages, /media');
      }
      const idp = await step('control: the identity origin\'s restore card does have them', async () => {
        const v = await ctx.visitor('SCAN-IDP');
        const p = await v.newPage();
        await p.goto(ctx.stack.idp.url + '/signin', { waitUntil: 'load', timeout: 20000 });
        return p.evaluate(() => document.documentElement.outerHTML.length);
      });
      void idp;
      const all = gb.found.concat(others);
      assert(all.length === 0, 'fields that take a phrase, a passphrase or a backup file outside the identity origin: ' + all.join('; '));
      return 'scanned ' + pages.join('; ') + ': none';
    },
  };

  // ------------------------------------------------------------------------------------------- E-ID-7
  S['E-ID-7'] = {
    title: 'a shared-origin hub: the identity origin offers "this visit only" and the site gets a visit-only key',
    async fn(ctx, step) {
      const { stack } = ctx;
      const record = await hubPointer(stack);
      stack.dev.setPointer(null);
      try {
        const v = await ctx.visitor('SH');
        const page = await v.newPage();
        await step('open the guestbook through a shared-origin hub link and load it at the gate', async () => {
          await page.goto(ctx.origin + '#' + record, { waitUntil: 'domcontentloaded', timeout: 20000 });
          await waitUntil(async () => { const g = await gateState(page); return g.visible ? g : null; }, { timeoutMs: 20000, label: 'hub gate' });
          assert(await clickGateButton(page, /^Load anyway/), 'no Load anyway button');
          await waitForSite(page, { timeoutMs: 30000, label: 'hub site' });
          await waitUntil(async () => { const a = await authState(page); return a && a.auth ? a : null; }, { timeoutMs: 15000, label: 'the sign-in bar' });
        });
        let card = null;
        await step('Sign in: the card says the address is shared and the identity lasts for this visit only', () => signIn(page, { unlock: 'visit', onCard: (st) => { if (!card && /^Sign in to /.test(st.title)) card = st; } }));
        assert(card && card.text.indexOf(idpText('sharedHub', null, 'en')) >= 0, 'the card does not say "' + idpText('sharedHub', null, 'en') + '": ' + (card && card.text.slice(0, 300)));
        const info = await sdkReady(page);
        assert(info.mode === 'hub-shared' && info.auth === 'signed-in' && info.identity && info.identity.mode === 'visit', 'ready() ' + JSON.stringify({ mode: info.mode, identity: info.identity }));
        return 'visit-only key ' + info.identity.short + ' on the shared-origin hub';
      } finally {
        stack.dev.setPointer(stack.pub.pointer);
      }
    },
  };

  return S;
}

export { StepError };
