// test/e2e/scenarios-social-rows.mjs: the open end-to-end rows of the social example (V03-DESIGN-REVIEW Part 4.2, E-SO-*; the rows of
// docs/deviations/integration-v03.md R 4.2), driven against the real loader, SDK, hub follow lane and identity origin on the loopback
// subdomain hub of ./hub-stack.mjs, not the mock SDK. They build on E-SO-1 and E-SO-2 (ADA and BO, test/e2e/scenarios-social.mjs) and
// run them first when they were not run (--only). Chromium only: labels are hostnames under .localhost (docs/DEV-NETWORK.md).
//
//   E-SO-3   a comment on another person's post lives on the commenter's ledger; the author accepts it with mw.ok; a third
//            viewer, who follows only the author, sees it as accepted
//   E-SO-4   one reaction per member per target (a change of reaction is one key); counts "from people you follow"
//   E-SO-7   a group made with the tools: a join request to its moderator, the moderator's approval (allow, within the
//            moderator's daily cap), a member's post, a ban
//   E-SO-8   alerts for a reply, a mention and a follow (from the windows of followed pages) and a direct message (on the group)
//   E-SO-5   the hub lane: three contexts, 20 synthetic personal ledgers made with the tools, RECENT windows, the follow cap; the
//            merged follow feed measured (runs only when named: --only E-SO-5; it waits on defect D-1)
//   E-SO-6   (partial) a first screen from a loopback cs= recent window: a reader's first visit to a page nobody holds
//   E-SO-9   host and peers down: the app works from this device's copy; a post written then shows and survives an offline reload
//   E-SO-9B  that post goes out when the network returns and ADA signs in again (runs only when named, like E-SO-5)
//
// What each row proves and what stays open is in docs/deviations/rows-social.md.

import { socialDriver, makeSyntheticPages, makeGroupSite } from './hub-stack.mjs';
import { socialScenarios } from './scenarios-social.mjs';
import { acceptConsent, siteFrame, waitUntil, sleep, withTimeout, StepError, clickLoaderCard, dismissKitCard } from './lib.mjs';
import { driveIdp } from './idp-driver.mjs';
import { UI_TEXT } from '../../src/loader/strings.js';

// E-SO-5 waits on a loader defect (docs/deviations/rows-social.md, "Defects found" D-1): a page whose ledger opens after the hub lane
// joined never holds it, so the tool-made ledgers have no holder. It runs only when named (--only E-SO-5 or MW_E2E_ONLY).
const named = (id) => {
  const i = process.argv.indexOf('--only');
  const list = String((i >= 0 && process.argv[i + 1]) || process.env.MW_E2E_ONLY || '').toUpperCase().split(',').map((x) => x.trim());
  return list.indexOf(id) >= 0;
};
// E-SO-9B (the offline post reaching BO) is named too: it closes every other browser's pages and reloads ADA offline.
export const SOCIAL_ROWS_ORDER = ['E-SO-3', 'E-SO-4', 'E-SO-7', 'E-SO-8'].concat(named('E-SO-5') ? ['E-SO-5'] : [], ['E-SO-6', 'E-SO-9'], named('E-SO-9B') ? ['E-SO-9B'] : []);

const T = UI_TEXT.en;
const PASS = { ADA: 'ada loopback passphrase number one', BO: 'bo loopback passphrase number two', CY: 'cy loopback passphrase number three' };

/** socialRowsScenarios({ assert }) -> { id: { title, fn(ctx, step) } } for test/e2e/run.mjs. */
export function socialRowsScenarios({ assert }) {
  const S = {};
  const D = socialDriver({ assert });
  const base = socialScenarios({ assert });

  /** ADA and BO as E-SO-1 and E-SO-2 leave them (E-SO-2: BO follows ADA). */
  async function adaBo(ctx, step) {
    // A scenario between E-SO-2 and these rows may close every visitor (E-HD-1's ctx.closeAll()): then ADA and BO are made
    // again, and CY with them, since CY follows ADA (docs/deviations/firefox.md, "For the integrator"). A visitor whose pages
    // were closed on purpose but whose browser context lives (E-SO-9 before E-SO-9B) keeps its identity and is not made again.
    const gone = (p) => !p || !p.page || (p.page.isClosed() && (!p.visitor || p.visitor.closed === true || !p.visitor.context));
    if (gone(ctx.shared.ada)) { ctx.shared.ada = null; ctx.shared.bo = null; ctx.shared.cy = null; }
    if (gone(ctx.shared.bo)) { ctx.shared.bo = null; ctx.shared.cy = null; }
    if (!ctx.shared.ada) await base['E-SO-1'].fn(ctx, step);
    if (!ctx.shared.bo) await base['E-SO-2'].fn(ctx, step);
    const add = (p, name) => Object.assign(p, { plan: p.plan || { unlock: 'passphrase', passphrase: PASS[name], hub: true } });
    // E-SO-1 and E-SO-2 keep no short id; the SDK gives it (ready().identity.short, the first 8 hex of the key's hash).
    for (const p of [ctx.shared.ada, ctx.shared.bo]) if (!p.short) p.short = ((await D.sdkInfo(p.page)).identity || {}).short;
    return { ada: add(ctx.shared.ada, 'ADA'), bo: add(ctx.shared.bo, 'BO') };
  }

  async function cyOf(ctx, step) {
    if (ctx.shared.cy && ctx.shared.cy.page && !ctx.shared.cy.page.isClosed()) return ctx.shared.cy;
    const cy = await D.signUp(ctx, step, 'CY', PASS.CY);
    ctx.shared.cy = cy;
    return cy;
  }

  const app = (page, fn, arg) => siteFrame(page).evaluate(fn, arg);
  const go = (page, href) => app(page, (h) => window.__social.ctx.go(h), href);

  /** followByLink(page, link, label): the person opens /@<label>, which this browser does not hold, and follows by the link (the form). */
  async function followByLink(page, link, label) {
    await go(page, '/@' + label);
    const f = siteFrame(page);
    const how = await waitUntil(async () => {
      if (await f.locator('#follow-link').count()) return 'form';
      if (await f.locator('#follow').count()) return 'button';
      return null;
    }, { timeoutMs: 15000, label: 'the follow form or button on /@' + label.slice(0, 8) });
    if (how === 'form') {
      await f.fill('#follow-link', link);
      await tap(page, f.locator('form:has(#follow-link) button[type="submit"]').first());
    } else {
      await tap(page, f.locator('#follow'));
    }
    await waitUntil(async () => {
      const r = await app(page, (l) => { const d = window.__social.ctx.data; const id = d.idOfLabel(l); return id ? d.isFollowing(id) : false; }, label);
      return r || null;
    }, { timeoutMs: 20000, label: 'following ' + label.slice(0, 8) });
  }

  /**
   * tap(page, locator): a click in the site frame. The loader's recovery-kit card (R 2.2.6, after the first meaningful action) covers
   * the page until "Later" is pressed, so it is dismissed first; any other loader card is named in the error.
   */
  async function tap(page, loc, { timeoutMs = 30000 } = {}) {
    const end = Date.now() + timeoutMs;
    let last = null;
    while (Date.now() < end) {
      await dismissKitCard(page).catch(() => false);
      try { await loc.click({ timeout: 3000 }); return; } catch (err) { last = err; }
    }
    const cards = await page.evaluate(() => { const c = document.querySelector('[data-mw-ui-cards]'); if (!c) return null; const r = c.shadowRoot || c; return r.textContent.replace(/\s+/g, ' ').trim().slice(0, 200); }).catch(() => null);
    throw new StepError('click: ' + String((last && last.message) || '').split('\n')[0] + ' (loader cards: ' + JSON.stringify(cards) + ')');
  }

  /** The item of the timeline model with this text: { l, h, key } or null. */
  const itemOf = (page, text) => app(page, (t) => {
    const it = window.__social.ctx.data.timeline({}).find((x) => x.text === t);
    return it ? { l: it.l, h: it.h, key: it.key } : null;
  }, text);

  /** answerCard(page, label): waits for the loader card with that button and presses it until it goes away (the kit card first). */
  async function answerCard(page, label, { timeoutMs = 30000 } = {}) {
    const rect = (l) => page.evaluate((x) => (window.__mwShell ? window.__mwShell.rectOf(x) : null), l).catch(() => null);
    await waitUntil(async () => {
      const r = await rect(label);
      if (r && r.width > 0) return r;
      await dismissKitCard(page);
      return null;
    }, { timeoutMs, label: 'the loader card "' + label + '"' });
    await waitUntil(async () => {
      await clickLoaderCard(page, label);
      await sleep(300);
      return !(await rect(label));
    }, { timeoutMs: 10000, label: 'pressing "' + label + '"' });
  }

  /** withCards(page, fn, arg, labels): fn runs in the site frame (a gesture); the loader cards named by labels are pressed in order. */
  async function withCards(page, fn, arg, labels, { timeoutMs = 45000 } = {}) {
    const running = siteFrame(page).evaluate(fn, arg).then((v) => ({ v }), (e) => ({ e: (e && e.message) || String(e) }));
    let settled = null;
    running.then((r) => { settled = r; });
    for (const label of labels) {
      await waitUntil(async () => {
        if (settled) return true;
        const r = await page.evaluate((l) => (window.__mwShell ? window.__mwShell.rectOf(l) : null), label).catch(() => null);
        if (r && r.width > 0) return r;
        await dismissKitCard(page);
        return null;
      }, { timeoutMs, label: 'the loader card "' + label + '"' });
      if (settled) break;
      await waitUntil(async () => {
        if (settled) return true;
        await clickLoaderCard(page, label);
        await sleep(300);
        return !(await page.evaluate((l) => (window.__mwShell ? window.__mwShell.rectOf(l) : null), label).catch(() => null));
      }, { timeoutMs: 10000, label: 'pressing "' + label + '"' });
    }
    const r = await withTimeout(running, timeoutMs, 'the call');
    if (r.e) throw new StepError(r.e);
    return r.v;
  }

  // ------------------------------------------------------------------------------------------- E-SO-3
  S['E-SO-3'] = {
    title: 'a comment lives on the commenter\'s ledger; the author accepts it with mw.ok; a third viewer sees it (social example, real loader)',
    async fn(ctx, step) {
      const { ada, bo } = await adaBo(ctx, step);
      await step('ADA follows BO by his link (/@<BO\'s label>, "Follow by link"): her page now holds BO\'s window', () => followByLink(ada.page, bo.url, bo.label));
      const target = await step('BO opens ADA\'s "Hello from Ada" from his timeline', async () => {
        const it = await waitUntil(() => itemOf(bo.page, 'Hello from Ada'), { timeoutMs: 20000, label: 'ADA\'s post at BO' });
        await go(bo.page, '/@' + ada.label + '/p/' + it.h);
        await siteFrame(bo.page).waitForSelector('#comment-text', { timeout: 15000 });
        return it;
      });
      await step('BO comments "Nice post, Ada": the comment is an mw.c item on BO\'s own ledger, aimed at ADA\'s post', async () => {
        const f = siteFrame(bo.page);
        await f.fill('#comment-text', 'Nice post, Ada');
        await tap(bo.page, f.locator('#comment-send'));
        const c = await waitUntil(() => app(bo.page, () => {
          const d = window.__social.ctx.data;
          const own = d.own();
          const x = own && own.comments.find((k) => k.text === 'Nice post, Ada');
          return x ? { l: x.l, h: x.h, target: x.target } : null;
        }), { timeoutMs: 30000, label: 'the comment on BO\'s ledger' });
        assert(c.l === bo.ledgerId, 'the comment is on ' + c.l + ', not BO\'s ledger ' + bo.ledgerId);
        assert(c.target.l === ada.ledgerId && c.target.h === target.h, 'target ' + JSON.stringify(c.target));
        ctx.shared.comment = c;
      });
      const c = ctx.shared.comment;
      const t0 = Date.now();
      const ok = await step('ADA\'s page finds the reply in BO\'s window, her wall setting ("people I follow") accepts it, and mw.ok on her ledger lists it', () => waitUntil(() => app(ada.page, (ref) => {
        const own = window.__social.ctx.data.own();
        return own && own.oks.has(ref.l + '/' + ref.h) ? { oks: own.oks.size } : null;
      }, c), { timeoutMs: 45000, label: 'the mw.ok item at ADA' }).catch(async (err) => {
        const st = await app(ada.page, () => ({ notices: window.__social.ctx.data.notices(), queue: window.__social.ctx.data.wallQueue() })).catch(() => null);
        throw new StepError(err.message + ' (ADA: ' + JSON.stringify(st) + ')');
      }));
      const acceptMs = Date.now() - t0;
      const cy = await cyOf(ctx, step);
      await step('CY, a third member, follows ADA (only ADA) by her link on his empty timeline', async () => {
        const f = siteFrame(cy.page);
        await tap(cy.page, f.locator('#feed-empty button', { hasText: /^Follow by link$/ }).first());
        await f.fill('#follow-link', ada.url);
        await tap(cy.page, f.locator('#follow-form button[type="submit"]'));
        await waitUntil(() => itemOf(cy.page, 'Hello from Ada'), { timeoutMs: 45000, label: 'ADA\'s post at CY' });
      });
      const seen = await step('CY opens ADA\'s post: the comment loads from BO\'s ledger (its pointer from ADA\'s follow item) and shows as accepted', async () => {
        await go(cy.page, '/@' + ada.label + '/p/' + target.h);
        return waitUntil(() => app(cy.page, () => {
          const box = Array.from(document.querySelectorAll('#thread-list .comment')).find((n) => n.textContent.indexOf('Nice post, Ada') >= 0);
          if (!box) return null;
          return { waiting: !!box.querySelector('.badge.warn'), heading: document.querySelector('#thread h2').textContent };
        }), { timeoutMs: 45000, label: 'the comment at CY' }).catch(async (err) => {
          const t = await app(cy.page, () => document.querySelector('#thread') && document.querySelector('#thread').textContent.replace(/\s+/g, ' ').slice(0, 300)).catch(() => null);
          throw new StepError(err.message + ' (CY\'s thread: ' + JSON.stringify(t) + ')');
        });
      });
      assert(!seen.waiting, 'CY sees the comment as waiting for the author');
      assert(/Comments \(1\)/.test(seen.heading), 'heading ' + seen.heading);
      await go(cy.page, '/');
      return 'comment ' + c.h.slice(0, 12) + ' on BO\'s ledger; ADA\'s mw.ok in ' + acceptMs + ' ms (' + ok.oks + ' accepted refs); CY sees "' + seen.heading + '", accepted';
    },
  };

  // ------------------------------------------------------------------------------------------- E-SO-4
  /** The reaction bar of a post in the feed of a page: { counts: { r: n }, note, mine }. */
  const barOf = (page, text) => app(page, (t) => {
    const art = Array.from(document.querySelectorAll('#feed article')).find((a) => (a.querySelector('.post-body') || {}).textContent === t);
    if (!art) return null;
    const counts = {};
    let mine = null;
    for (const b of art.querySelectorAll('button[data-react]')) {
      const m = /(\d+)$/.exec(b.textContent.trim());
      counts[b.getAttribute('data-react')] = m ? Number(m[1]) : 0;
      if (b.getAttribute('aria-pressed') === 'true') mine = b.getAttribute('data-react');
    }
    const note = art.querySelector('.react-note');
    return { counts, mine, note: note ? note.textContent : '' };
  }, text);

  S['E-SO-4'] = {
    title: 'one reaction per member per target; counts "from people you follow"',
    async fn(ctx, step) {
      const { ada, bo } = await adaBo(ctx, step);
      const cy = await cyOf(ctx, step);
      // E-SO-4 builds on E-SO-3's follows (ADA follows BO, CY follows only ADA). Run without E-SO-3 (--only E-SO-1,E-SO-2,E-SO-4),
      // or with a CY made again by cyOf, they are missing, so they are made here by link; a follow already in place is kept.
      const follows = (page, label) => app(page, (l) => { const d = window.__social.ctx.data; const id = d.idOfLabel(l); return !!(id && d.isFollowing(id)); }, label);
      if (!(await follows(ada.page, bo.label))) {
        await step('ADA follows BO by his link (E-SO-3 did not run in this selection)', () => followByLink(ada.page, bo.url, bo.label));
      }
      if (!(await follows(cy.page, ada.label))) {
        await step('CY follows ADA (only ADA) by her link (E-SO-3 did not run in this selection)', async () => {
          await followByLink(cy.page, ada.url, ada.label);
          await go(cy.page, '/');
          await waitUntil(() => itemOf(cy.page, 'Hello from Ada'), { timeoutMs: 45000, label: 'ADA\'s post at CY' });
        });
      }
      const react = async (r) => {
        const f = siteFrame(bo.page);
        const art = f.locator('#feed article', { has: f.locator('.post-body', { hasText: /^Hello from Ada$/ }) }).first();
        await tap(bo.page, art.locator('button[data-react="' + r + '"]'));
        await waitUntil(async () => { const b = await barOf(bo.page, 'Hello from Ada'); return b && b.mine === r ? b : null; }, { timeoutMs: 30000, label: 'BO\'s reaction ' + r });
      };
      await go(bo.page, '/');
      await waitUntil(() => barOf(bo.page, 'Hello from Ada'), { timeoutMs: 20000, label: 'ADA\'s post in BO\'s feed' });
      const target = await itemOf(bo.page, 'Hello from Ada');
      assert(target, 'ADA\'s post is not in BO\'s timeline');
      const key = 're/' + target.l + '/' + target.h;
      await step('BO reacts "heart" to ADA\'s post from his timeline (a key on his own ledger: re/<ADA\'s ledger>/<h>)', () => react('heart'));
      await step('BO changes it to "laugh": the same key, so still one reaction', () => react('laugh'));
      const keys = await step('BO\'s ledger holds exactly one reaction key for the post, with "laugh"', async () => {
        const kv = await D.sdk(bo.page, async () => {
          const mw = (await import('/_mw/sdk.js')).default;
          const snap = await new Promise((resolve) => { let off = null; off = mw.db.subscribe((x) => { if (x) { setTimeout(() => off && off(), 0); resolve(x); } }); });
          return snap && snap.kv ? snap.kv : {};
        });
        const re = Object.keys(kv).filter((k) => k.startsWith('re/'));
        const v = kv[key] && typeof kv[key] === 'object' && 'v' in kv[key] ? kv[key].v : kv[key];
        assert(re.length === 1 && re[0] === key, 'reaction keys ' + JSON.stringify(re));
        assert(v && v.r === 'laugh', 'value ' + JSON.stringify(kv[key]));
        return re;
      });
      const before = await step('CY, who follows ADA but not BO, does not count BO\'s reaction', async () => {
        await go(cy.page, '/');
        return waitUntil(() => barOf(cy.page, 'Hello from Ada'), { timeoutMs: 20000, label: 'the post at CY' });
      });
      assert(before.counts.laugh === 0, 'CY counts ' + JSON.stringify(before.counts) + ' before following BO');
      await step('CY follows BO by his link', () => followByLink(cy.page, bo.url, bo.label));
      const after = await step('CY now counts one "laugh", labelled "from people you follow"', async () => {
        await go(cy.page, '/');
        return waitUntil(async () => { const b = await barOf(cy.page, 'Hello from Ada'); return b && b.counts.laugh === 1 ? b : null; }, { timeoutMs: 45000, label: 'one laugh at CY' })
          .catch(async (err) => { throw new StepError(err.message + ' (bar ' + JSON.stringify(await barOf(cy.page, 'Hello from Ada')) + ')'); });
      });
      assert(after.counts.heart === 0 && /1 from people you follow/.test(after.note), 'CY bar ' + JSON.stringify(after));
      const atAda = await step('ADA, who follows BO, also counts one', () => waitUntil(async () => { await go(ada.page, '/'); const b = await barOf(ada.page, 'Hello from Ada'); return b && b.counts.laugh === 1 ? b : null; }, { timeoutMs: 30000, label: 'one laugh at ADA' }));
      return 'key ' + keys[0].slice(0, 20) + '...; CY before following BO ' + JSON.stringify(before.counts) + ', after "' + after.note + '"; ADA "' + atAda.note + '"';
    },
  };

  // ------------------------------------------------------------------------------------------- E-SO-7
  /** A member on a group's own address: opens it, signs in with their hub identity, turns chat on (one loader card). */
  async function onGroup(ctx, step, who, name, group) {
    return step(name + ' opens the group\'s address, signs in (the same hub key) and turns messages on', async () => {
      const page = await who.visitor.newPage();
      await page.goto(group.url, { waitUntil: 'domcontentloaded', timeout: 20000 });
      await acceptConsent(page, { timeoutMs: 20000 });
      await D.appState(page, { label: name + ': the group', until: (s) => /Invite-only group/.test(s.view) });
      await sleep(D.CARD_COOLDOWN_MS);
      await D.signIn(page, who.plan);
      const info = await D.sdkInfo(page);
      const on = await withCards(page, async () => {
        const mw = (await import('/_mw/sdk.js')).default;
        window.__rows = { messages: [] };
        mw.chat.on('message', (x) => window.__rows.messages.push(x));
        try { await mw.chat.enable(); } catch (e) { return { err: e.code || e.message }; }
        return mw.chat.state();
      }, null, [T.continue]);
      assert(on && on.state === 'on', name + ': chat ' + JSON.stringify(on));
      return { page, info };
    });
  }

  S['E-SO-7'] = {
    title: 'a group: join request, moderator approval within the cap, a member\'s post, a ban',
    async fn(ctx, step) {
      const { ada, bo } = await adaBo(ctx, step);
      const hub = await D.hubOf(ctx, step);
      const group = await step('the tools make a group site: its own key, writers "allow", ADA as its moderator, messages open (ledger-admin, snapshot)', () => makeGroupSite(hub, { name: 'group7', title: 'Loopback group', moderators: [ada.pub], chat: 'open' }));
      ctx.shared.group = group;
      const a = await onGroup(ctx, step, ada, 'ADA', group);
      assert(a.info.role === 'moderator', 'ADA\'s role on the group is ' + a.info.role);
      const b = await onGroup(ctx, step, bo, 'BO', group);
      assert(b.info.role === 'reader', 'BO\'s role on the group is ' + b.info.role);
      ctx.shared.groupPages = { ada: a.page, bo: b.page };
      // Precondition (docs/deviations/rows-social.md): a direct message from a key that is not a contact is a message request, off by
      // default, and an accepted request drops a grant; so the two add each other as contacts first.
      await step('ADA and BO add each other as contacts on the group (precondition: a stranger\'s join request is not delivered, see the deviations note)', async () => {
        for (const [x, y] of [[a.page, bo], [b.page, ada]]) {
          const r = await D.sdk(x, async (p) => { const mw = (await import('/_mw/sdk.js')).default; try { return await mw.chat.contacts.add(p.pub, { nick: p.nick }); } catch (e) { return { err: e.code || e.message }; } }, { pub: y.pub, nick: y === bo ? 'BO' : 'ADA' });
          if (r && r.err) throw new StepError('contacts.add: ' + r.err);
        }
      });
      const t0 = Date.now();
      const sent = await step('BO taps "Ask to join": a join grant goes to ADA\'s chat key (retried while her key is on its way)', () => waitUntil(async () => {
        const f = siteFrame(b.page);
        const line = await f.evaluate(() => (document.querySelector('#group-role') || {}).textContent || '');
        if (/^Request sent/.test(line)) return line;
        if (await f.locator('#ask-join').count()) await tap(b.page, f.locator('#ask-join'));
        await sleep(1500);
        return null;
      }, { timeoutMs: 45000, stepMs: 500, label: 'the request sent' }));
      const queued = await step('ADA\'s moderation panel lists "join from <BO\'s short id>" (mw.mod.queue)', () => waitUntil(() => app(a.page, () => {
        const li = Array.from(document.querySelectorAll('#mod-panel li')).find((n) => /^join from /.test(n.textContent));
        return li ? li.textContent : null;
      }), { timeoutMs: 30000, label: 'the join request at ADA' }));
      const queuedMs = Date.now() - t0;
      await step('ADA accepts it (a click, then the loader\'s moderator card): an allow block within her daily cap', async () => {
        const f = siteFrame(a.page);
        await tap(a.page, f.locator('#mod-panel li', { hasText: /^join from / }).first().locator('button[data-decision="accept"]'));
        await answerCard(a.page, T.modConfirm);
      });
      const member = await step('BO\'s role becomes writer when the allow block reaches him; the page says "You\'re in." and offers the composer', async () => {
        await waitUntil(async () => (await D.sdkInfo(b.page)).role === 'writer' || null, { timeoutMs: 45000, label: 'BO a writer' });
        await app(b.page, () => window.__social.ctx.data.refresh());
        return waitUntil(() => app(b.page, () => {
          const role = (document.querySelector('#group-role') || {}).textContent || '';
          return /^You're in\.$/.test(role) && document.querySelector('[data-composer="post"]') ? role : null;
        }), { timeoutMs: 20000, label: '"You\'re in." at BO' });
      });
      // mw.db.snapshot is a Bridge method only (docs/SDK.md: used by db.subscribe); a site reads the snapshot through db.subscribe.
      const policy = await D.sdk(a.page, async () => { const mw = (await import('/_mw/sdk.js')).default; const s = await new Promise((resolve) => { let off = null; off = mw.db.subscribe((x) => { if (x) { setTimeout(() => off && off(), 0); resolve(x); } }); }); return s && s.policy; });
      // The snapshot names the allow list's size (state.js snapshot: allowCount), not its keys; BO's role above is the membership proof.
      assert(policy && policy.allowCount >= 1, 'allowCount ' + JSON.stringify(policy && policy.allowCount));
      assert(!policy.modAllowPerDay || policy.modAllowPerDay >= 1, 'modAllowPerDay ' + policy.modAllowPerDay);
      await step('BO posts "Hello group from Bo" in the group (the group\'s fee); ADA sees it', async () => {
        await D.post(b.page, 'Hello group from Bo');
        await waitUntil(() => app(a.page, () => Array.from(document.querySelectorAll('#group-feed .post-body')).some((n) => n.textContent === 'Hello group from Bo')), { timeoutMs: 30000, label: 'BO\'s group post at ADA' });
      });
      await step('ADA bans BO (the loader\'s moderator card): his post is removed for ADA and for BO', async () => {
        const r = await withCards(a.page, async (pub) => { const mw = (await import('/_mw/sdk.js')).default; try { return await mw.mod.ban(pub); } catch (e) { return { err: e.code || e.message }; } }, bo.pub, [T.modConfirm]);
        if (r && r.err) throw new StepError('mod.ban: ' + r.err);
        for (const [page, who] of [[a.page, 'ADA'], [b.page, 'BO']]) {
          await waitUntil(() => app(page, () => !Array.from(document.querySelectorAll('#group-feed .post-body')).some((n) => n.textContent === 'Hello group from Bo')), { timeoutMs: 30000, label: 'the post gone at ' + who });
        }
        await waitUntil(async () => (await D.sdkInfo(b.page)).role === 'reader' || null, { timeoutMs: 20000, label: 'BO a reader again' });
      });
      return 'request "' + sent + '"; queued at ADA after ' + queuedMs + ' ms ("' + queued.slice(0, 30) + '"); BO "' + member + '"; allowCount ' + policy.allowCount + ' (modAllowPerDay ' + (policy.modAllowPerDay || 'default 20') + '); post, then ban';
    },
  };

  // ------------------------------------------------------------------------------------------- E-SO-8
  S['E-SO-8'] = {
    title: 'alerts for a reply, a mention and a follow (from followed windows) and a direct message (on the group)',
    async fn(ctx, step) {
      const { ada, bo } = await adaBo(ctx, step);
      assert(ctx.shared.comment, 'E-SO-3 did not run (the reply)');
      const gp = ctx.shared.groupPages;
      // The short id the template shows for ADA and its "Mention someone" picker inserts (ids.js shortIdOf, 8 hex), as BO's page knows it.
      const adaShort = await waitUntil(() => app(bo.page, (l) => window.__social.ctx.data.shortOwner(l) || null, ada.ledgerId), { timeoutMs: 20000, label: 'ADA\'s short id at BO' });
      await step('BO posts "Hi @' + adaShort + ', see you at the group" on his own wall (a mention by the short id the app shows for ADA)', async () => {
        await go(bo.page, '/');
        await D.post(bo.page, 'Hi @' + adaShort + ', see you at the group');
        // What BO's page resolved the mention to (data.js addPost: ledgerForShort over the views it holds).
        ctx.shared.mentionAt = await app(bo.page, (x) => { const d = window.__social.ctx.data; return { short: x.short, ledger: d.ledgerForShort(x.short), identityShort: x.idShort }; }, { short: adaShort, idShort: ada.short }).catch((e) => String(e));
      });
      const alerts = await step('ADA\'s Alerts list a reply, a mention and a follow, each from BO', async () => {
        await go(ada.page, '/notifications');
        return waitUntil(() => app(ada.page, (boLedger) => {
          const items = Array.from(document.querySelectorAll('#alerts li')).map((li) => ({ k: li.getAttribute('data-kind'), text: li.textContent.replace(/\s+/g, ' ').trim() }));
          const kinds = new Set(items.map((x) => x.k));
          void boLedger;
          return kinds.has('reply') && kinds.has('mention') && kinds.has('follow') ? items : null;
        }, bo.ledgerId), { timeoutMs: 45000, label: 'reply, mention and follow alerts at ADA' }).catch(async (err) => {
          const items = await app(ada.page, () => Array.from(document.querySelectorAll('#alerts li')).map((li) => li.getAttribute('data-kind') + ': ' + li.textContent.trim())).catch(() => null);
          throw new StepError(err.message + ' (alerts ' + JSON.stringify(items) + '; the mention at BO ' + JSON.stringify(ctx.shared.mentionAt) + ')');
        });
      });
      let dm = 'not run (E-SO-7 did not leave the group pages)';
      if (gp) {
        await step('on the group, BO sends ADA a direct message', () => waitUntil(async () => {
          const r = await D.sdk(gp.bo, async (pub) => { const mw = (await import('/_mw/sdk.js')).default; try { return await mw.chat.dm.send(pub, { text: 'A direct message for Ada' }); } catch (e) { return { err: e.code || e.message }; } }, ada.pub);
          if (r && r.err === 'E_NO_CHAT_KEY') return null;
          if (r && r.err) throw new StepError('dm.send: ' + r.err);
          return r;
        }, { timeoutMs: 30000, stepMs: 1000, label: 'dm.send' }));
        const unread = await step('ADA\'s Alerts on the group page show "New messages" from BO', async () => {
          await go(gp.ada, '/notifications');
          return waitUntil(() => app(gp.ada, () => { const n = document.querySelector('#unread-messages'); return n ? n.textContent.replace(/\s+/g, ' ').trim() : null; }), { timeoutMs: 30000, label: 'the unread message at ADA' });
        });
        dm = '"' + unread + '"';
      }
      const kinds = Array.from(new Set(alerts.map((x) => x.k)));
      return 'home alerts ' + JSON.stringify(kinds) + ' (' + alerts.length + ' items); group: ' + dm;
    },
  };

  // ------------------------------------------------------------------------------------------- E-SO-5
  S['E-SO-5'] = {
    title: 'the hub lane: three contexts, 20 synthetic personal ledgers (tools), RECENT windows, the follow cap, the merged feed measured',
    async fn(ctx, step) {
      await adaBo(ctx, step);
      const hub = await D.hubOf(ctx, step);
      const cy = await cyOf(ctx, step);
      const t0 = Date.now();
      const pages = await step('the tools make 20 personal pages: keygen, ledger-admin (genesis, keyinfo, name, 5 posts), snapshot (cs= recent windows), signed pointers', () => makeSyntheticPages(hub, { count: 20, posts: 5, name: 'syn5' }));
      const makeMs = Date.now() - t0;
      // Two seeder contexts open ten pages each: each page loads its ledger from its cs= window (nobody else has it) and holds it on the lane.
      const seeders = { 'SEED-A': await ctx.visitor('SEED-A'), 'SEED-B': await ctx.visitor('SEED-B') };
      const open = [];
      for (const p of pages) {
        const v = p.i < 10 ? seeders['SEED-A'] : seeders['SEED-B'];
        const r = await step((p.i < 10 ? 'SEED-A' : 'SEED-B') + ' opens ' + p.name + ': its ledger from its cs= window, held on the hub lane', async () => {
          const page = await v.newPage();
          const s0 = Date.now();
          await page.goto(p.url, { waitUntil: 'domcontentloaded', timeout: 20000 });
          await acceptConsent(page, { timeoutMs: 20000 });
          let last = null;
          const st = await waitUntil(async () => {
            const x = await page.evaluate(() => (window.__mwShell ? window.__mwShell.inspect() : null)).catch(() => null);
            if (x) last = { ledgerId: x.ledgerId, ledger: x.ledger, lane: x.hubLane && { joined: x.hubLane.joined, held: x.hubLane.held, stats: x.hubLane.stats }, log: (x.log || []).slice(-12) };
            if (!x || !x.ledger || x.ledger.height < 8 || !x.hubLane || !x.hubLane.joined || x.hubLane.held.indexOf(x.ledgerId) < 0) return null;
            return { height: x.ledger.height, snap: x.log.some((l) => /snapshot: \d+ blocks offered/.test(l)) };
          }, { timeoutMs: 40000, label: p.name + ' held' }).catch((err) => { throw new StepError(err.message + ' (' + JSON.stringify(last) + ')'); });
          return { page, ms: Date.now() - s0, st };
        });
        assert(r.st.snap, p.name + ': the ledger did not come from the cs= snapshot');
        open.push(r);
      }
      const seedMs = open.map((r) => r.ms).sort((x, y) => x - y);
      // The follower: CY on his own page (the third context) follows all 20 through mw.hub.follow and the app subscribes to them.
      const want = pages.reduce((n, p) => n + p.posts.length, 0);
      let maxActive = 0;
      const f0 = Date.now();
      const followed = await step('CY follows the 20 pages by their pointers (mw.hub.follow): the cap is 1,000 on a computer', async () => {
        await go(cy.page, '/');
        const res = await D.sdk(cy.page, async (ptrs) => {
          const mw = (await import('/_mw/sdk.js')).default;
          const out = [];
          for (const p of ptrs) { try { out.push(await mw.hub.follow(p)); } catch (e) { out.push({ err: e.code || e.message }); } }
          await window.__social.ctx.data.syncFollowed();
          return { out, cap: window.__social.ctx.data.followCap() };
        }, pages.map((p) => p.pointer));
        const errs = res.out.filter((x) => x.err);
        assert(!errs.length, 'follow errors ' + JSON.stringify(errs.slice(0, 3)));
        assert(res.out.every((x) => x.cap === 1000), 'cap ' + JSON.stringify(res.out[0]));
        return res;
      });
      let firstMs = null;
      const merged = await step('CY\'s merged timeline holds all 100 synthetic posts (RECENT windows over the hub lane, at most 4 ledgers syncing at once)', () => waitUntil(async () => {
        const lane = await cy.page.evaluate(() => window.__mwShell.inspect().hubLane).catch(() => null);
        if (lane && lane.stats) maxActive = Math.max(maxActive, lane.stats.active || 0);
        const n = await app(cy.page, () => window.__social.ctx.data.timeline({}).filter((it) => /^Synthetic \d\d post \d$/.test(it.text)).length);
        if (n > 0 && firstMs === null) firstMs = Date.now() - f0;
        return n >= want ? { n, lane } : null;
      }, { timeoutMs: 58000, stepMs: 250, label: 'all synthetic posts at CY' }).catch(async (err) => {
        const lane = await cy.page.evaluate(() => window.__mwShell.inspect().hubLane).catch(() => null);
        const n = await app(cy.page, () => window.__social.ctx.data.timeline({}).filter((it) => /^Synthetic/.test(it.text)).length).catch(() => null);
        throw new StepError(err.message + ' (' + n + ' of ' + want + '; lane stats ' + JSON.stringify(lane && lane.stats) + ')');
      }));
      const allMs = Date.now() - f0;
      const order = await step('the feed shows the model\'s order (time, hash), newest first, and the follow line counts the follows', async () => {
        const r = await app(cy.page, () => {
          const d = window.__social.ctx.data;
          const model = d.timeline({}).slice(0, 30).map((it) => it.text);
          const shown = Array.from(document.querySelectorAll('#feed article .post-body')).map((n) => n.textContent).slice(0, model.length);
          return { model, shown, cap: d.followCap().text };
        });
        return r;
      });
      assert(merged.lane.stats.recentDone >= 20, 'RECENT windows done: ' + merged.lane.stats.recentDone);
      assert(maxActive <= 4, 'at most 4 ledgers sync at once, saw ' + maxActive);
      assert(/^You follow \d+ of 1,000 on this computer$/.test(order.cap), order.cap);
      ctx.shared.synthetic = { pages, seeders: Object.keys(seeders) };
      return 'made 20 ledgers in ' + makeMs + ' ms; seeder pages held in ' + seedMs[0] + ' to ' + seedMs[seedMs.length - 1] + ' ms; CY: first synthetic post after ' + firstMs + ' ms, all ' + merged.n +
        ' after ' + allMs + ' ms; RECENT asked ' + merged.lane.stats.recentAsked + ', done ' + merged.lane.stats.recentDone + ', at most ' + maxActive + ' active; "' + order.cap + '"; ' + followed.out.length + ' follows';
    },
  };

  // ------------------------------------------------------------------------------------------- E-SO-6 (partial)
  S['E-SO-6'] = {
    title: '(partial) the first screen of a page from its loopback cs= recent window, nobody else holding it',
    async fn(ctx, step) {
      const hub = await D.hubOf(ctx, step);
      const [p] = await step('the tools make one more personal page with 12 posts and its cs= recent window; no browser holds it', () => makeSyntheticPages(hub, { count: 1, posts: 12, name: 'syn6' }));
      const v = await ctx.visitor('READER');
      const r = await step('a reader opens its link: the first screen shows the newest posts from the window (signed out)', async () => {
        const page = await v.newPage();
        const t0 = Date.now();
        await page.goto(p.url, { waitUntil: 'domcontentloaded', timeout: 20000 });
        await acceptConsent(page, { timeoutMs: 20000 });
        const shown = await waitUntil(() => app(page, () => {
          const t = Array.from(document.querySelectorAll('#feed article .post-body, #wall article .post-body')).map((n) => n.textContent);
          return t.length ? t : null;
        }).catch(() => null), { timeoutMs: 30000, label: 'posts on the first screen' });
        const ms = Date.now() - t0;
        const log = await D.shellLog(page);
        return { page, shown, ms, snap: log.find((l) => /snapshot: \d+ blocks offered/.test(l)) || null };
      });
      assert(r.snap, 'the shell log names no cs= snapshot');
      assert(r.shown[0] === 'Synthetic 01 post 12', 'newest first: ' + JSON.stringify(r.shown.slice(0, 3)));
      await ctx.closeVisitor('READER');
      return 'first screen in ' + r.ms + ' ms with ' + r.shown.length + ' posts (newest "' + r.shown[0] + '"); ' + r.snap.replace(/^\S+\s/, '') + '. Not built: a member\'s merged first screen from followed pages\' cs= windows (see the deviations note)';
    },
  };

  // ------------------------------------------------------------------------------------------- E-SO-9
  S['E-SO-9'] = {
    title: 'host and peers down: the app works from this device\'s copy; a post written then shows at once and survives an offline reload',
    async fn(ctx, step) {
      const { ada, bo } = await adaBo(ctx, step);
      const v = ada.visitor;
      await go(ada.page, '/');
      // Peers down: Playwright's offline mode blocks new requests but does not cut a WebRTC channel that is already open, so every other
      // browser closes its pages (their storage stays). Host down: ADA's browser is offline (the hub, its web seed, tracker and IdO).
      const closed = await step('peers down: every other browser closes its pages (BO\'s storage stays); host down: ADA\'s browser goes offline', async () => {
        let n = 0;
        for (const w of ctx.visitors.values()) {
          if (w === v || !w.context) continue;
          for (const pg of w.context.pages()) { await pg.close().catch(() => {}); n++; }
        }
        await v.context.setOffline(true);
        return n;
      });
      let line = '';
      let reload;
      try {
        await step('ADA posts "Written while offline": it shows on her page at once, with the line saying it is this device\'s copy', async () => {
          await D.post(ada.page, 'Written while offline').catch(async (err) => {
            const view = await app(ada.page, () => document.body.textContent.replace(/\s+/g, ' ').slice(0, 200) + ' | notes: ' + Array.from(document.querySelectorAll('[role="status"], [role="alert"], .note, .toast')).map((x) => x.textContent.trim()).filter(Boolean).join(' / ')).catch(() => null);
            // A direct write from the site frame, with a deadline: does the loader take a write with no host and no peer?
            const probe = await app(ada.page, async () => {
              const mw = (await import('/_mw/sdk.js')).default;
              const t0 = Date.now();
              const r = await Promise.race([mw.db.append('mw.post', { text: 'probe while offline' }).then((x) => ({ ok: x }), (e) => ({ err: e.code || e.message })), new Promise((res) => setTimeout(() => res({ pending: true }), 8000))]);
              const d = window.__social.ctx.data;
              const model = d.timeline({}).map((it) => it.text).filter((t) => /offline/.test(t || ''));
              const feed = Array.from(document.querySelectorAll('#feed article .post-body')).map((x) => x.textContent).slice(0, 5);
              const nb = document.querySelector('.new-posts');
              return Object.assign(r, { ms: Date.now() - t0, online: navigator.onLine, model, feed, path: location.pathname, own: d.own() ? { posts: (d.own().posts || []).length } : null, newPosts: nb ? { hidden: nb.hidden, text: nb.textContent } : null, title: (document.querySelector('#view-title') || {}).textContent || '' });
            }).catch((e) => String(e));
            const shell = await ada.page.evaluate(() => { const x = window.__mwShell && window.__mwShell.inspect(); return x ? { ledger: x.ledger, leader: x.leader, consent: x.consent } : null; }).catch(() => null);
            const log = (await D.shellLog(ada.page)).slice(-8);
            throw new StepError(err.message + ' (view ' + JSON.stringify(view) + '; direct db.append ' + JSON.stringify(probe) + '; shell ' + JSON.stringify(shell) + '; log ' + JSON.stringify(log) + ')');
          });
          line = await waitUntil(() => app(ada.page, () => { const t = document.querySelector('#sync-line').textContent; return /^Showing what this device has\. Last updated \d/.test(t) ? t : null; }), { timeoutMs: 15000, label: 'the offline line' });
        });
        reload = await step('still offline, ADA reloads: the shell and the app come from this device, with her posts and the offline line', async () => {
          await ada.page.reload({ waitUntil: 'domcontentloaded', timeout: 20000 });
          await D.appState(ada.page, { label: 'the app offline', timeoutMs: 30000 });
          return waitUntil(() => app(ada.page, () => {
            const posts = Array.from(document.querySelectorAll('#feed article .post-body, #wall article .post-body')).map((n) => n.textContent);
            const t = document.querySelector('#sync-line').textContent;
            return posts.indexOf('Written while offline') >= 0 && /^Showing what this device has/.test(t) ? { posts: posts.length, line: t } : null;
          }), { timeoutMs: 30000, label: 'own posts and the offline line after the reload' });
        });
      } finally {
        await v.context.setOffline(false);
      }
      ctx.shared.offline = { at: Date.now(), closed, line, posts: reload.posts };
      return closed + ' other pages closed; offline line "' + line + '"; offline reload shows ' + reload.posts + ' posts, among them the one written offline';
    },
  };

  // E-SO-9B: the second half of E-SO-9 (writes go out when the network returns). D-1 (a ledger opened after the lane joined was never
  // held) is fixed in holdOwnLedger; what kept it failing after that was the harness: the offline reload signs ADA out (this visit
  // only), and since STALK-3 a signed-out page holds nothing, so ADA signs in again once online. Still runs only when named.
  S['E-SO-9B'] = {
    title: 'the post written offline goes out when the network returns and its author signs in again (rows-social.md D-1)',
    async fn(ctx, step) {
      if (!ctx.shared.offline) await S['E-SO-9'].fn(ctx, step);
      const { ada, bo } = await adaBo(ctx, step);
      const t0 = ctx.shared.offline.at;
      // ADA signed in for this visit only (the plan's "Stay signed in" is off, idp-driver.mjs), so the offline reload of E-SO-9 left her
      // page signed out: a reader, which holds nothing on the hub lane (STALK-3, holdOwnLedger in src/loader/app.js). Back online she
      // signs in again, as a person does, and her page holds her own ledger with the post written offline.
      await step('ADA is back online and signs in again on her page (her offline reload kept no sign-in): her page holds her own ledger', async () => {
        const st = await D.appState(ada.page, { label: 'ADA\'s page back online' });
        if (st.signIn !== 'Sign out') await D.signIn(ada.page, ada.plan);
        const info = await D.sdkInfo(ada.page);
        assert(info.role === 'owner', 'ADA: role ' + info.role + ' after signing in again');
        await waitUntil(() => ada.page.evaluate((id) => { const h = window.__mwShell.inspect().hubLane; return h && Array.isArray(h.held) && h.held.indexOf(id) >= 0 ? true : null; }, ada.ledgerId).catch(() => null), { timeoutMs: 20000, label: 'ADA\'s own ledger held on the hub lane' });
      });
      const page = await step('BO opens his page again (his follows are on his device)', async () => {
        const pg = await bo.visitor.newPage();
        await pg.goto(bo.url, { waitUntil: 'domcontentloaded', timeout: 20000 });
        await acceptConsent(pg, { timeoutMs: 20000 }).catch(() => {});
        const st = await D.appState(pg, { label: 'BO\'s page again' });
        if (st.signIn !== 'Sign out') await D.signIn(pg, bo.plan);
        return pg;
      });
      bo.page = page;
      await step('the post written offline reaches BO over the hub lane', () => waitUntil(async () => {
        const has = await app(page, () => window.__social.ctx.data.timeline({}).some((it) => it.text === 'Written while offline')).catch(() => false);
        return has || null;
      }, { timeoutMs: 58000, label: 'the offline post at BO' }).catch(async (err) => {
        const lane = async (pg) => JSON.stringify(await pg.evaluate(() => window.__mwShell.inspect().hubLane.stats).catch(() => null));
        const held = await ada.page.evaluate(() => window.__mwShell.inspect().hubLane.held).catch(() => null);
        throw new StepError(err.message + ' (ADA holds ' + JSON.stringify(held) + ' on the lane, D-1 when empty; ADA lane ' + await lane(ada.page) + '; BO lane ' + await lane(page) + ')');
      }));
      const lateMs = Date.now() - t0;
      return 'the post reached BO ' + lateMs + ' ms after the network returned (BO\'s page opened, signed in and synced in that time)';
    },
  };

  return S;
}

export { StepError, driveIdp };
