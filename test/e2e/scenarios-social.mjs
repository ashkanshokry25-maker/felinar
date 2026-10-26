// test/e2e/scenarios-social.mjs: the social example (examples/social) through the real loader, SDK and identity origin on a
// loopback subdomain hub (V03-DESIGN-REVIEW Part 3 and Part 4.2, E-SO-*). The examples lane built the template contract-first
// against a mock of the SDK (test/example/mock-sdk.js); these scenarios run it against the landed code: the hub root
// redirect, consent on every label, the identity origin's cards (a passphrase identity, so the same person signs in on
// several origins), "Create my page" (the genesis travels in the link), the owner's own wall, and following by link over
// the hub follow lane (mw_chain2 on the hub's own tracker).
//
// Chromium only (labels are hostnames under .localhost; WebKit runs on http://127.0.0.1 URLs only, docs/DEV-NETWORK.md).
// Run by test/e2e/run.mjs after the v0.3 wave 1 scenarios; the hub stack is ./hub-stack.mjs.
//
//   E-SO-1   sign-up creates a personal site in the browser (genesis, pointer, keyinfo); the owner posts on their own wall
//            without a fee
//   E-SO-2   follow by link; the timeline merges two ledgers; the "new posts" indicator
//   E-SO-11  a deep link (/@<label>/p/<h>) reloads to the same post

import { setupHubStack } from './hub-stack.mjs';
import { acceptConsent, siteFrame, waitUntil, sleep, withTimeout, StepError } from './lib.mjs';
import { driveIdp } from './idp-driver.mjs';
import { parsePointer } from '../../src/common/pointer.js';

export const SOCIAL_ORDER = ['E-SO-1', 'E-SO-2', 'E-SO-11'];

const CARD_COOLDOWN_MS = 10500; // the identity service refuses a second card within 10 s of the last one (E_RATE, R 2.3.9)

/** socialScenarios({ assert }) -> { id: { title, fn(ctx, step) } } for test/e2e/run.mjs. */
export function socialScenarios({ assert }) {
  const S = {};

  async function hubOf(ctx, step) {
    if (ctx.shared.hub) return ctx.shared.hub;
    const hub = await step('the loopback subdomain hub: loader and identity origin built with the PSL addition "localhost", the template published', () => setupHubStack(ctx.stack));
    ctx.closers.push(() => hub.close());
    ctx.shared.hub = hub;
    return hub;
  }

  /** The social app in the site frame, once it has drawn a route with its data layer: { title, signIn, view }. */
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
          view: document.querySelector('#view').textContent.replace(/\s+/g, ' ').slice(0, 600),
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

  async function sdkInfo(page) {
    return siteFrame(page).evaluate(async () => (await import('/_mw/sdk.js')).default.ready());
  }

  /** Opens url in a new page of the visitor, answers the first-run card, waits for the app. */
  async function openApp(ctx, visitor, url, { label }) {
    const page = await visitor.newPage();
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 20000 });
    await acceptConsent(page, { timeoutMs: 20000 });
    const app = await appState(page, { label });
    return { page, app };
  }

  /** Clicks the app's Sign in (a real click in the site frame) and answers the identity origin's popup. */
  async function signIn(page, plan) {
    const f = siteFrame(page);
    const popupPromise = page.context().waitForEvent('page', { timeout: 30000 });
    await f.click('#sign-in');
    const popup = await popupPromise;
    const drive = await withTimeout(driveIdp(popup, plan), 60000, 'identity origin (sign in)');
    const app = await appState(page, { label: 'signed in', until: (s) => s.signIn === 'Sign out' && Boolean(s.chip) });
    return { drive, app, at: Date.now() };
  }

  /**
   * signUp(ctx, name, passphrase) -> { visitor, page, pub, ledgerId, label, url, pointer, record, cards }: R 3.3 end to end.
   * The person opens the hub link, signs in (a passphrase identity with the hub identity box on), creates their page and
   * signs in again on its new origin, as its owner.
   */
  async function signUp(ctx, step, name, passphrase) {
    const hub = await hubOf(ctx, step);
    const v = await ctx.visitor(name);
    const plan = { unlock: 'passphrase', passphrase, hub: true };
    const tpl = await step(name + ' opens the hub link: the hub root sends the browser to the template\'s label, the first-run card, the app (signed out)', async () => {
      const r = await openApp(ctx, v, hub.templateUrl, { label: name + ': the template page' });
      const host = new URL(r.page.url()).hostname;
      assert(host === hub.templateLabel + '.localhost', 'the hub root did not redirect to the template label: ' + host);
      assert(r.app.signIn === 'Sign in' && !r.app.chip, 'a fresh visitor is signed in: ' + JSON.stringify(r.app));
      return r;
    });
    const page = tpl.page;
    const first = await step(name + ' signs in at the identity origin: a new identity, a passphrase, one identity on all of the hub', () => signIn(page, plan));
    assert(first.drive.cards.some((c) => /^Sign in to /.test(c)) && first.drive.cards.indexOf('With a passphrase') >= 0, name + ': the cards were ' + first.drive.cards.join(' | '));
    const created = await step(name + ' taps "Create my page": the identity origin confirms, the loader mints the ledger in the browser and opens the new address', async () => {
      const wait = first.at + CARD_COOLDOWN_MS - Date.now();
      if (wait > 0) await sleep(wait);
      const f = siteFrame(page);
      const popupPromise = page.context().waitForEvent('page', { timeout: 30000 });
      const before = page.url();
      // The first address of the new page carries the pointer and the genesis; the loader drops the fragment once it
      // has kept them, so it is recorded on the way.
      let opened = null;
      const onNav = (fr) => { if (!opened && fr === page.mainFrame() && fr.url() !== before && !fr.url().includes(hub.templateLabel)) opened = fr.url(); };
      page.on('framenavigated', onNav);
      await f.click('#create-page');
      const popup = await popupPromise;
      const drive = await withTimeout(driveIdp(popup, plan), 60000, 'identity origin (create my page)');
      assert(drive.cards.indexOf('Create my page') >= 0, name + ': no "Create my page" card: ' + drive.cards.join(' | '));
      // The app moves the top window while the tap still counts; after a slow card it offers a link to tap instead.
      await waitUntil(async () => {
        if (page.url() !== before && !page.url().includes(hub.templateLabel)) return true;
        const fr = siteFrame(page);
        const href = fr ? await fr.evaluate(() => { const a = document.querySelector('#open-top'); return a ? a.getAttribute('href') : null; }).catch(() => null) : null;
        if (href) { await fr.click('#open-top'); return false; }
        return false;
      }, { timeoutMs: 20000, label: name + ': the new page opens' });
      page.off('framenavigated', onNav);
      assert(opened && opened.indexOf('#') > 0, name + ': the new address has no fragment: ' + opened);
      return { drive, opened };
    });
    const mine = await step(name + ': the new page loads the template from the hub\'s web seed and its ledger from the genesis in the link', async () => {
      await acceptConsent(page, { timeoutMs: 20000 });
      const app = await appState(page, { label: name + ': own page' });
      const log = await shellLog(page);
      assert(log.some((l) => /genesis from the link: 2 block\(s\)/.test(l)), name + ': the genesis did not come from the link: ' + log.slice(-12).join(' | '));
      const url = new URL(page.url());
      const label = url.hostname.split('.')[0];
      assert(label !== hub.templateLabel && /^[a-z2-7]{32}$/.test(label), 'a new label was expected, got ' + url.hostname);
      return { app, label };
    });
    const owner = await step(name + ' signs in on the new origin: the same hub key, which owns the new ledger', async () => {
      const r = await signIn(page, plan);
      const info = await sdkInfo(page);
      assert(info.mode === 'hub', 'mode ' + info.mode);
      assert(info.auth === 'signed-in' && info.identity && info.identity.mode === 'hub', name + ': identity ' + JSON.stringify(info.identity));
      assert(info.role === 'owner', name + ': role ' + info.role + ' (owner ' + info.owner + ', key ' + (info.identity && info.identity.pub) + ')');
      assert(info.identity.pub === info.owner, 'the pointer owner is not the hub key');
      assert(info.height === 2, name + ': a new personal ledger holds the policy and keyinfo blocks, height ' + info.height);
      return { info, cards: r.drive.cards };
    });
    // The pointer the loader signed (the fragment of the address it opened: '#<pointer>#mwgen=<genesis>'): it repeats the
    // template's transport (tr, ws, idp) and names gen= and nx= (R 3.3).
    const hash = created.opened.slice(created.opened.indexOf('#') + 1);
    const pointerText = decodeURIComponent(hash.split('#')[0]);
    const parsedPtr = parsePointer(pointerText);
    return {
      visitor: v, page, hub, pub: owner.info.identity.pub, ledgerId: owner.info.siteId, label: mine.label,
      url: created.opened.split('#mwgen=')[0], pointer: parsedPtr.ok ? parsedPtr.record.raw : null, record: parsedPtr.ok ? parsedPtr.record : null,
      cards: { first: first.drive.cards, create: created.drive.cards, owner: owner.cards },
    };
  }

  /** Writes a post through the app's composer (a real click on Post); resolves with the time it took. */
  async function post(page, text) {
    const f = siteFrame(page);
    const area = f.locator('form[data-composer] textarea').first();
    await area.fill(text);
    const t0 = Date.now();
    await f.locator('form[data-composer] button[type="submit"]').first().click();
    await waitUntil(() => f.evaluate((t) => Array.from(document.querySelectorAll('#feed article, #wall article')).some((a) => a.textContent.indexOf(t) >= 0), text), { timeoutMs: 30000, label: 'the post "' + text + '" is shown' });
    return Date.now() - t0;
  }

  async function feedTexts(page) {
    return siteFrame(page).evaluate(() => Array.from(document.querySelectorAll('#feed article .post-body')).map((n) => n.textContent));
  }

  // ------------------------------------------------------------------------------------------- E-SO-1
  S['E-SO-1'] = {
    title: 'sign-up creates a personal site in the browser (genesis, pointer, keyinfo); the owner posts on their own wall without a fee (social example, real loader and identity origin)',
    async fn(ctx, step) {
      const ada = await signUp(ctx, step, 'ADA', 'ada loopback passphrase number one');
      ctx.shared.ada = ada;
      await step('the personal pointer: btih = the template, owner = the hub key, gen= and nx= set, and the template\'s tr=, ws= and idp= repeated', async () => {
        const r = ada.record;
        assert(r && r.signed, 'the address carries no signed pointer: ' + String(ada.url).slice(0, 160));
        assert(r.btih === ada.hub.pub.record.btih, 'btih ' + r.btih + ' is not the template ' + ada.hub.pub.record.btih);
        assert(r.owner === ada.pub, 'owner ' + r.owner);
        assert(/^[A-Za-z0-9_-]{43}$/.test(String(r.nx)) && /^[0-9a-f]{64}$/.test(String(r.gen)), 'nx ' + r.nx + ', gen ' + r.gen);
        assert(Array.isArray(r.tr) && r.tr.indexOf(ctx.stack.tracker.url) >= 0, 'tr ' + JSON.stringify(r.tr));
        assert(Array.isArray(r.ws) && r.ws.length > 0 && r.idp === ada.hub.idpUrl, 'ws ' + JSON.stringify(r.ws) + ', idp ' + r.idp);
        assert(!r.cs, 'the template\'s cs= was copied: ' + r.cs);
      });
      const policy = await step('the genesis: writers owner, the 16-bit fee for others, 8 MiB (the second genesis block is the keyinfo: height 2 above)', () => siteFrame(ada.page).evaluate(async () => {
        const mw = (await import('/_mw/sdk.js')).default;
        const snap = await new Promise((resolve) => { const off = mw.db.subscribe((x) => { resolve(x); setTimeout(() => off(), 0); }); });
        return { policy: snap.policy || null, role: snap.role || null, height: snap.height };
      }));
      assert(policy.policy, 'the snapshot has no policy: ' + JSON.stringify(policy));
      assert(policy.policy.writers === 'owner' && policy.policy.bits === 16 && policy.policy.maxChainBytes === 8 * 1024 * 1024, 'policy ' + JSON.stringify(policy.policy));
      const ms = await step('ADA posts "Hello from Ada" on her own wall (no fee: the owner is exempt on their own ledger)', () => post(ada.page, 'Hello from Ada'));
      const after = await step('the ledger grew by one block, signed by ADA', async () => {
        const info = await sdkInfo(ada.page);
        assert(info.height === 3, 'height ' + info.height);
        return info;
      });
      return 'page ' + ada.label + ' (ledger ' + ada.ledgerId + ', height ' + after.height + '), posted in ' + ms + ' ms; cards: ' + ada.cards.create.join(' > ') +
        (policy.policy ? '; policy ' + JSON.stringify(policy.policy) : '; policy not in the snapshot');
    },
  };

  // ------------------------------------------------------------------------------------------- E-SO-2
  S['E-SO-2'] = {
    title: 'follow by link; the timeline merges two ledgers over the hub follow lane; the "new posts" indicator',
    async fn(ctx, step) {
      const ada = ctx.shared.ada;
      assert(ada, 'E-SO-1 did not run');
      const bo = await signUp(ctx, step, 'BO', 'bo loopback passphrase number two');
      ctx.shared.bo = bo;
      const link = ada.url;
      await step('BO, who follows nobody yet, follows ADA by her link ("Follow by link" on the empty timeline)', async () => {
        const f = siteFrame(bo.page);
        await f.locator('#feed-empty button', { hasText: /^Follow by link$/ }).first().click();
        await f.fill('#follow-link', link);
        await f.locator('#follow-form button[type="submit"]').click();
        let note = '';
        await waitUntil(async () => {
          note = await f.evaluate(() => (document.querySelector('#follow-form [role="status"]') || {}).textContent || '');
          return /^Following/.test(note);
        }, { timeoutMs: 15000, label: 'followed' }).catch((err) => { throw new StepError(err.message + ' (the form says ' + JSON.stringify(note) + ')'); });
      });
      // Chain fixer request 11 (intermittent): on a miss, the step names both tabs' hub lane state (held, followed, the lane counters).
      const laneOf = (page) => page.evaluate(() => { const s = window.__mwShell && window.__mwShell.inspect(); return s ? { hubLane: s.hubLane || null, log: (s.log || []).filter((l) => /hub lane|ledger open/.test(l)).slice(-6) } : null; }).catch((e) => String(e));
      await step('ADA\'s post reaches BO\'s timeline over the hub follow lane (mw_chain2 on the hub tracker)', () => waitUntil(async () => (await feedTexts(bo.page)).indexOf('Hello from Ada') >= 0, { timeoutMs: 45000, label: 'ADA\'s post at BO' })
        .catch(async (err) => { throw new StepError(err.message + ' (ADA ' + JSON.stringify(await laneOf(ada.page)) + '; BO ' + JSON.stringify(await laneOf(bo.page)) + ')'); }));
      // Social fixer (round 1): each tab's hub lane has its swarm, on the tab's one TorrentManager (the miss was a lane that joined
      // while consent was pending and never started: joined, torrent false, no wire; src/loader/torrent.js _onConsentChange).
      for (const [name, p] of [['ADA', ada], ['BO', bo]]) {
        const l = await p.page.evaluate(() => window.__mwShell.inspect().hubLane);
        assert(l && l.kind === 'hub' && l.torrent && l.sameTm && l.tmCount === 1, name + '\'s hub lane: ' + JSON.stringify(l && { kind: l.kind, torrent: l.torrent, sameTm: l.sameTm, tmCount: l.tmCount, wires: l.wires }));
      }
      await step('BO posts "Hello from Bo" on his own wall', () => post(bo.page, 'Hello from Bo'));
      // Newest first by (time, hash) (R 3.5). Block times are rounded down to the minute (src/chain/block.js TS_ROUND_MS), so
      // within one minute the hash decides: the feed must show the timeline in exactly the model's order.
      await step('BO\'s timeline merges the two ledgers in (time, hash) order, newest first', () => waitUntil(async () => {
        const texts = await feedTexts(bo.page);
        if (texts.indexOf('Hello from Ada') < 0 || texts.indexOf('Hello from Bo') < 0) return null;
        const model = await siteFrame(bo.page).evaluate(() => window.__social.ctx.data.timeline({}).map((it) => it.text));
        return JSON.stringify(texts.slice(0, model.length)) === JSON.stringify(model) ? texts : null;
      }, { timeoutMs: 15000, label: 'merged timeline in (time, hash) order' }).catch(async (err) => {
        const items = await siteFrame(bo.page).evaluate(() => window.__social.ctx.data.timeline({}).map((it) => ({ text: it.text, ts: it.ts, l: it.l }))).catch(() => null);
        throw new StepError(err.message + ' (feed ' + JSON.stringify(await feedTexts(bo.page)) + ', items ' + JSON.stringify(items) + ')');
      }));
      const boTs = await siteFrame(bo.page).evaluate(() => Math.max(...window.__social.ctx.data.timeline({}).map((it) => Number(it.ts) || 0)));
      // Up to a minute: two steps of at most 31 s each (a step's own limit is 60 s).
      const nextMinute = boTs + 60000 + 500;
      for (const half of ['first', 'second']) {
        await step('wait for the next minute (' + half + ' half), so ADA\'s next post is newer than everything BO sees (block times are minute-rounded)', async () => {
          const wait = nextMinute - Date.now();
          if (wait > 0) await sleep(half === 'first' ? Math.min(wait, 31000) : wait);
          if (half === 'second') assert(Date.now() >= boTs + 60000, 'still in the minute of the newest post');
        });
      }
      await step('ADA posts again: BO sees "1 new post" instead of a feed that moves', async () => {
        await post(ada.page, 'Second post from Ada');
        const f = siteFrame(bo.page);
        await waitUntil(() => f.evaluate(() => { const b = document.querySelector('#new-posts'); return b && !b.closest('[hidden]') ? b.textContent : null; }), { timeoutMs: 30000, label: 'the new posts indicator' })
          .catch(async (err) => {
            const lane = async (pg) => JSON.stringify((await pg.evaluate(() => window.__mwShell.inspect().hubLane).catch(() => null)));
            throw new StepError(err.message + ' (ADA lane ' + await lane(ada.page) + '; BO lane ' + await lane(bo.page) + '; BO feed ' + JSON.stringify(await feedTexts(bo.page)) + ')');
          });
        const text = await f.evaluate(() => document.querySelector('#new-posts').textContent);
        assert(/^1 new post$/.test(text.trim()), 'indicator says ' + JSON.stringify(text));
        assert((await feedTexts(bo.page)).indexOf('Second post from Ada') < 0, 'the feed moved under the reader: the new post is already in it');
        await f.click('#new-posts');
        await waitUntil(async () => (await feedTexts(bo.page))[0] === 'Second post from Ada', { timeoutMs: 10000, label: 'the new post on top' });
      });
      return 'BO follows ADA; timeline ' + JSON.stringify((await feedTexts(bo.page)).slice(0, 3));
    },
  };

  // ------------------------------------------------------------------------------------------- E-SO-11
  S['E-SO-11'] = {
    title: 'a deep link to a post (/@<label>/p/<h>) reloads to the same post',
    async fn(ctx, step) {
      const ada = ctx.shared.ada;
      assert(ada, 'E-SO-1 did not run');
      const f = siteFrame(ada.page);
      const href = await step('ADA opens her first post from the timeline', async () => {
        const h = await f.evaluate(() => {
          const a = Array.from(document.querySelectorAll('#feed article a[data-act="comments"]')).find((x) => x.closest('article').textContent.indexOf('Hello from Ada') >= 0);
          return a ? a.getAttribute('href') : null;
        });
        assert(h && /^\/@[a-z2-7]{32}\/p\/[0-9a-f]{64}$/.test(h), 'no post link of the form /@<label>/p/<h>: ' + h);
        await f.click('#feed article a[data-act="comments"][href="' + h + '"]');
        await appState(ada.page, { label: 'post page', until: (s) => s.path === h });
        return h;
      });
      const after = await step('reload: the shell serves the app for the deep path and the post renders again', async () => {
        await ada.page.reload({ waitUntil: 'domcontentloaded' });
        let last = null;
        const s = await appState(ada.page, { label: 'post page after reload', until: (st) => { last = st; return st.path === href && st.view.indexOf('Hello from Ada') >= 0; } })
          .catch((err) => { throw new StepError(err.message + ' (the app shows ' + JSON.stringify(last) + ')'); });
        return s;
      });
      return 'reloaded ' + href + ' to "' + after.title + '"';
    },
  };

  return S;
}

export { StepError };
