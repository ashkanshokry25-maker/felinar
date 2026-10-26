// test/e2e/scenarios-members.mjs: chat, files and private media between signed-in members of one site, through the real
// loader, SDK, identity origin and the chat, files and media lanes (V03-DESIGN-REVIEW 2.7 to 2.9, Part 4.2 E-CH-*,
// E-FI-*, E-MD-*). Wave 1 drove the media and files modules from a lab page with stand-in keys (scenarios-v03.mjs); here
// a guestbook is published with _mw.cfg { chat, files, media: 'members' } (ledger-admin setCfg, served at cs=) and two or
// three visitors in their own browser contexts sign in at the identity origin and use window.mw from the site frame.
//
//   E-CH-1   direct messages between two members over mw_chat1, and the delivered state
//   E-CH-8   no chat data in any ledger block (every block of every mw-chain-* store of both members, scanned)
//   E-CH-6   host-only refuses chat.enable, files.share and media.upload with E_HOST_ONLY, with no card and no socket
//   E-FI-1   a public file: shared with the upload card; premoderation (code review v0.3, round 2): its new author lists
//            it as pending, the other member neither lists nor fetches it until the owner accepts it offline (ledger-admin
//            listed, served at cs= and passed on by a new visitor); then listed, fetched by another member after the offer
//            card, previewed (a text preview is text the loader read); removed by its owner: gone from the list (the _deny/
//            half of the row: not here)
//   E-FI-2   a private file: only the recipient can fetch and preview it; it is not listed for the site
//   E-MD-4   private media: a member uploads an MP4, shares it with another (grant in a sealed message); the recipient
//            plays it through /_mw/media/<sid> with a seek (206)
//   E-MD-3   a third member who was not given the item has no route for it and cannot open it
//   E-MD-5   revoke: the uploader takes the recipient's access back (a revoke message); the recipient's open() is
//            E_REVOKED and the item is gone from its list (the reencrypt half: not here)
//
// Chromium with the local-only flags; every URL is http://127.0.0.1. Playwright runs page.evaluate with a user gesture,
// which the loader counts as the click a UI method needs: each UI call below is made inside one evaluate, and the
// loader's card is then pressed with a real mouse click (window.__mwShell.rectOf).

import { join } from 'node:path';
import { cpSync, mkdirSync } from 'node:fs';

import { waitUntil, sleep, withTimeout, StepError, siteFrame, waitForSite, acceptConsent, clickShellButton, clickLoaderCard, dismissKitCard, ROOT } from './lib.mjs';
import { driveIdp } from './idp-driver.mjs';
import { publish } from '../../tools/publish.mjs';
import { createDevServer } from '../../tools/dev-server.mjs';
import { setCfg, readBlocksFile, writeBlocksFile, acceptListing } from '../../tools/ledger-admin.mjs';
import { loadOwnerKey } from '../../tools/lib.mjs';
import { STRINGS, UI_TEXT } from '../../src/loader/strings.js';
import { makeFixtures, hasFfmpeg } from '../fixtures/media/make-fixtures.mjs';

export const MEMBERS_ORDER = ['E-CH-1', 'E-CH-8', 'E-CH-6', 'E-FI-1', 'E-FI-2', 'E-MD-4', 'E-MD-3', 'E-MD-5'];

/** membersScenarios({ assert }) -> { id: { title, fn(ctx, step) } } for test/e2e/run.mjs. */
export function membersScenarios({ assert }) {
  const S = {};
  const T = UI_TEXT.en;

  // ------------------------------------------------------------------------------------------- the members site
  async function site(ctx, step) {
    if (ctx.shared.members) return ctx.shared.members;
    const { stack } = ctx;
    const m = await step('a guestbook for members: chat, files and media on (_mw.cfg members, served at cs=), the site\'s own tracker and STUN', async () => {
      const outDir = join(stack.runDir, 'members-publish');
      const dev = await createDevServer({ root: stack.dist, webseed: outDir, port: 0, host: '127.0.0.1', dev: true, quiet: true });
      ctx.closers.push(() => dev.close());
      const pub = await publish({
        // C2 integrator: a ledger of its own (chain), so this site's _mw.cfg does not merge with the main site's or the calls site's
        // (one owner key on scope 127.0.0.1 gave every such site the same ledger id).
        dir: join(ROOT, 'examples', 'peer-guestbook'), name: 'members-guestbook', scope: '127.0.0.1', chain: 'e2e-members', key: stack.owner.file, out: outDir, policy: 'open', bits: 4,
        tr: [stack.tracker.url], ws: [dev.url + 'ws/'], cs: dev.url + 'ws/genesis.json', exp: 30, quiet: true, idp: stack.idp.url,
        tracker: [stack.tracker.url], stun: ['stun:127.0.0.1:3478'], chat: true, files: true, media: true,
      });
      const identity = await loadOwnerKey(stack.owner.file);
      const cfg = await setCfg({ blocks: readBlocksFile(join(outDir, 'genesis.json')), identity, set: { chat: 'members', files: 'members', media: 'members' } });
      writeBlocksFile(join(outDir, 'genesis.json'), cfg.blocks);
      dev.setPointer(pub.pointer);
      return { dev, pub, outDir, url: dev.url, cfg: cfg.cfg };
    });
    ctx.shared.members = m;
    return m;
  }

  async function sdk(page, fn, arg) {
    const r = await siteFrame(page).evaluate(fn, arg);
    return r;
  }

  /** Runs fn in the site frame (an evaluate: a user gesture) and presses the loader cards named by labels, in order. */
  async function withCards(page, fn, arg, labels, { timeoutMs = 45000 } = {}) {
    const f = siteFrame(page);
    const running = f.evaluate(fn, arg).then((v) => ({ v }), (e) => ({ e: (e && e.message) || String(e) }));
    let settled = null;
    running.then((r) => { settled = r; });
    for (const label of labels) {
      await waitUntil(async () => {
        if (settled) return true;
        const r = await page.evaluate((l) => (window.__mwShell ? window.__mwShell.rectOf(l) : null), label).catch(() => null);
        if (r && r.width > 0) return r;
        await dismissKitCard(page); // the recovery kit card of the page's first meaningful action queues every later card
        return null;
      }, { timeoutMs, label: 'the loader card "' + label + '"' });
      if (settled) break;
      await waitUntil(async () => {
        if (settled) return true;
        await clickLoaderCard(page, label);
        await sleep(300);
        const still = await page.evaluate((l) => (window.__mwShell ? window.__mwShell.rectOf(l) : null), label).catch(() => null);
        return !still;
      }, { timeoutMs: 10000, label: 'pressing "' + label + '"' });
    }
    const r = await withTimeout(running, timeoutMs, 'the call');
    if (r.e) throw new StepError(r.e);
    return r.v;
  }

  /** answerCard(page, label): waits for the loader's card with that button and presses it until it goes away. */
  async function answerCard(page, label, { timeoutMs = 30000 } = {}) {
    await waitUntil(async () => {
      const r = await page.evaluate((l) => (window.__mwShell ? window.__mwShell.rectOf(l) : null), label).catch(() => null);
      if (r && r.width > 0) return r;
      await dismissKitCard(page);
      return null;
    }, { timeoutMs, label: 'the loader card "' + label + '"' });
    await waitUntil(async () => {
      await clickLoaderCard(page, label);
      await sleep(300);
      return !(await page.evaluate((l) => (window.__mwShell ? window.__mwShell.rectOf(l) : null), label).catch(() => null));
    }, { timeoutMs: 10000, label: 'pressing "' + label + '"' });
  }

  /** A member: opens the site, "Share and load", signs in (this visit only) and turns chat on (the loader's card). */
  async function member(ctx, step, name, m, { chat = true } = {}) {
    if (ctx.shared['member:' + name]) return ctx.shared['member:' + name];
    const r = await step(name + ' opens the members site, signs in at the identity origin' + (chat ? ' and turns chat on (one loader card)' : ''), async () => {
      const v = await ctx.visitor(name);
      const page = await v.newPage();
      await page.goto(m.url, { waitUntil: 'domcontentloaded', timeout: 20000 });
      await acceptConsent(page, { timeoutMs: 20000 });
      await waitForSite(page, { timeoutMs: 30000, label: name + ': site' });
      const f = siteFrame(page);
      await f.waitForSelector('#sign-in:not([hidden])', { timeout: 15000 });
      const popupPromise = page.context().waitForEvent('page', { timeout: 20000 });
      await f.click('#sign-in');
      const popup = await popupPromise;
      await withTimeout(driveIdp(popup, { unlock: 'visit' }), 60000, 'identity origin');
      await waitUntil(() => f.evaluate(() => document.documentElement.dataset.auth === 'signed-in'), { timeoutMs: 20000, label: name + ': signed in' });
      const info = await sdk(page, async () => (await import('/_mw/sdk.js')).default.ready());
      if (chat) {
        const on = await withCards(page, async () => {
          const mw = (await import('/_mw/sdk.js')).default;
          window.__mwE2E = { messages: [], deliveries: [], rooms: [] };
          mw.chat.on('message', (x) => window.__mwE2E.messages.push(x));
          mw.chat.on('delivery', (x) => window.__mwE2E.deliveries.push(x));
          try { await mw.chat.enable(); } catch (e) { return { err: e.code || e.message }; }
          return mw.chat.state();
        }, null, [T.continue]);
        assert(on && on.state === 'on', name + ': chat ' + JSON.stringify(on));
      }
      return { v, page, pub: info.identity.pub, short: info.identity.short, info };
    });
    ctx.shared['member:' + name] = r;
    return r;
  }

  /** Each member adds the others as contacts (a first message from a stranger is a request, off by default). */
  async function contacts(a, b) {
    for (const [x, y] of [[a, b], [b, a]]) {
      const r = await sdk(x.page, async (p) => {
        const mw = (await import('/_mw/sdk.js')).default;
        try { return await mw.chat.contacts.add(p.pub, { nick: p.nick }); } catch (e) { return { err: e.code || e.message }; }
      }, { pub: y.pub, nick: y.short });
      if (r && r.err) throw new StepError('contacts.add: ' + r.err);
    }
  }

  // ------------------------------------------------------------------------------------------- E-CH-1
  S['E-CH-1'] = {
    title: 'direct messages between two members over the chat lane (mw_chat1), and the delivered state',
    async fn(ctx, step) {
      const m = await site(ctx, step);
      const a = await member(ctx, step, 'MA', m);
      const b = await member(ctx, step, 'MB', m);
      await step('MA and MB add each other as contacts', () => contacts(a, b));
      const sent = await step('MA sends "hello MB" (retried while MB\'s chat key is still on its way: E_NO_CHAT_KEY)', () => waitUntil(async () => {
        const r = await sdk(a.page, async (p) => {
          const mw = (await import('/_mw/sdk.js')).default;
          try { return await mw.chat.dm.send(p.pub, { text: 'hello MB' }); } catch (e) { return { err: e.code || e.message }; }
        }, { pub: b.pub });
        if (r && r.err === 'E_NO_CHAT_KEY') return null;
        if (r && r.err) throw new StepError('dm.send: ' + r.err);
        return r;
      }, { timeoutMs: 30000, stepMs: 1000, label: 'dm.send' }));
      const got = await step('MB receives it, from MA\'s key, as text', () => waitUntil(() => sdk(b.page, () => window.__mwE2E.messages.slice()).then((list) => list.find((x) => x.text === 'hello MB') || null), { timeoutMs: 30000, label: 'the message at MB' }));
      assert(got.from === a.pub, 'from ' + got.from + ', MA is ' + a.pub);
      const delivered = await step('MA sees the delivered state', () => waitUntil(async () => {
        const d = await sdk(a.page, () => window.__mwE2E.deliveries.slice());
        return d.find((x) => x.id === sent.id && x.state === 'delivered') || null;
      }, { timeoutMs: 30000, label: 'delivered' }).catch(async (err) => {
        const d = await sdk(a.page, () => window.__mwE2E.deliveries.slice());
        throw new StepError(err.message + ' (send ' + JSON.stringify(sent) + ', deliveries ' + JSON.stringify(d) + ')');
      }));
      // Code review v0.3 (round 2, loader-sw #18): the first meaningful action of a page brings the loader's kit card once.
      await step('MA\'s first message brings the loader\'s "Save your recovery kit" card once (R 2.2.6); "Later" closes it', async () => {
        const rect = (l) => a.page.evaluate((x) => (window.__mwShell ? window.__mwShell.rectOf(x) : null), l).catch(() => null);
        await waitUntil(async () => { const r = await rect(T.kitButton); return r && r.width > 0 ? r : null; }, { timeoutMs: 15000, label: 'the kit card at MA' });
        await waitUntil(async () => {
          await clickLoaderCard(a.page, T.later);
          await sleep(300);
          return !(await rect(T.kitButton));
        }, { timeoutMs: 10000, label: 'pressing "Later"' });
      });
      ctx.shared.dmText = 'hello MB';
      return 'sent ' + sent.state + ', then ' + delivered.state + '; the kit card came once and "Later" closed it';
    },
  };

  // ------------------------------------------------------------------------------------------- E-CH-8
  S['E-CH-8'] = {
    title: 'no chat data in any ledger block: every block of every mw-chain-* store of both members, scanned for the message, its id and the chat keys',
    async fn(ctx, step) {
      const a = ctx.shared['member:MA'];
      const b = ctx.shared['member:MB'];
      assert(a && b && ctx.shared.dmText, 'E-CH-1 did not run');
      const scan = async (page) => page.evaluate(async () => {
        const out = { stores: 0, blocks: 0, texts: [] };
        const names = (await indexedDB.databases()).map((d) => d.name).filter((n) => /^mw-chain-/.test(n));
        for (const name of names) {
          const db = await new Promise((res, rej) => { const r = indexedDB.open(name); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
          try {
            if (!db.objectStoreNames.contains('blocks')) continue;
            out.stores++;
            const all = await new Promise((res, rej) => { const q = db.transaction('blocks', 'readonly').objectStore('blocks').getAll(); q.onsuccess = () => res(q.result); q.onerror = () => rej(q.error); });
            out.blocks += all.length;
            for (const b of all) out.texts.push(JSON.stringify(b));
          } finally { db.close(); }
        }
        return out;
      });
      const res = await step('scan both members\' stored ledger blocks', async () => ({ a: await scan(a.page), b: await scan(b.page) }));
      const chatState = await sdk(a.page, async () => (await (await import('/_mw/sdk.js')).default.chat.state()));
      const needles = [ctx.shared.dmText, 'mw.ck', chatState && chatState.chatKey ? String(chatState.chatKey).slice(5, 40) : null].filter(Boolean);
      for (const who of ['a', 'b']) {
        assert(res[who].blocks > 0, who + ': no blocks were scanned');
        for (const n of needles) assert(!res[who].texts.some((t) => t.indexOf(n) >= 0), who + ': a ledger block holds "' + n + '"');
      }
      return 'MA ' + res.a.blocks + ' block(s) in ' + res.a.stores + ' store(s), MB ' + res.b.blocks + ' in ' + res.b.stores + ': no message text, no chat key';
    },
  };

  // ------------------------------------------------------------------------------------------- E-CH-6
  S['E-CH-6'] = {
    title: 'host-only refuses chat.enable, files.share and media.upload with E_HOST_ONLY, with no card and no socket',
    async fn(ctx, step) {
      const m = await site(ctx, step);
      const v = await ctx.visitor('MH');
      const page = await v.newPage();
      await step('MH chooses "Load from host only" and signs in', async () => {
        await page.goto(m.url, { waitUntil: 'domcontentloaded', timeout: 20000 });
        await clickShellButton(page, new RegExp('^' + STRINGS.consentHostOnly + '$'), { scope: '.mw-notice button, .mw-gate button', timeoutMs: 20000 });
        await waitForSite(page, { timeoutMs: 30000, label: 'MH site' });
        const f = siteFrame(page);
        await f.waitForSelector('#sign-in:not([hidden])', { timeout: 15000 });
        const popupPromise = page.context().waitForEvent('page', { timeout: 20000 });
        await f.click('#sign-in');
        await withTimeout(driveIdp(await popupPromise, { unlock: 'visit' }), 60000, 'identity origin');
        await waitUntil(() => f.evaluate(() => document.documentElement.dataset.auth === 'signed-in'), { timeoutMs: 20000, label: 'MH signed in' });
      });
      const codes = await step('the three calls, each inside a gesture: E_HOST_ONLY before any card', () => sdk(page, async () => {
        const mw = (await import('/_mw/sdk.js')).default;
        const code = async (fn) => { try { await fn(); return 'resolved'; } catch (e) { return e.code || e.message; } };
        return {
          chat: await code(() => mw.chat.enable()),
          files: await code(() => mw.files.share(new File(['hello'], 'note.txt', { type: 'text/plain' }), { public: true })),
          media: await code(() => mw.media.upload(new File([new Uint8Array(64)], 'clip.mp4', { type: 'video/mp4' }))),
        };
      }));
      assert(codes.chat === 'E_HOST_ONLY' && codes.files === 'E_HOST_ONLY' && codes.media === 'E_HOST_ONLY', JSON.stringify(codes));
      const card = await page.evaluate((l) => window.__mwShell.rectOf(l), T.continue);
      assert(!card, 'a loader card is open');
      const pcs = await page.evaluate(() => window.__mwE2EPc || 0);
      assert(v.sockets.length === 0 && pcs === 0, 'sockets ' + v.sockets.length + ', peer connections ' + pcs);
      return JSON.stringify(codes) + ', no card, 0 sockets';
    },
  };

  // ------------------------------------------------------------------------------------------- E-FI-1
  S['E-FI-1'] = {
    title: 'a public file: the upload card, premoderated (pending for its new author, hidden from others) until the owner accepts it, then listed, fetched by another member after the offer card, previewed; removed by its owner: gone from the list',
    async fn(ctx, step) {
      const m = await site(ctx, step);
      const a = await member(ctx, step, 'MA', m);
      const b = await member(ctx, step, 'MB', m);
      const shared = await step('MA shares note.txt publicly (files.share, the upload card: Continue)', () => withCards(a.page, async () => {
        const mw = (await import('/_mw/sdk.js')).default;
        try { return await mw.files.share(new File(['a public note from MA'], 'note.txt', { type: 'text/plain' }), { public: true }); } catch (e) { return { err: e.code || e.message }; }
      }, null, [T.continue]));
      assert(shared && shared.ref && !shared.err, 'share ' + JSON.stringify(shared));
      // Code review v0.3 (round 2): premoderation (R 2.17.1, MF-53). MA's key is new to the site, so its first public listing is
      // listed only for MA (pending) until a moderator or the owner accepts it; MB neither lists nor fetches it before that.
      await step('premoderation: MA lists its own first public file as pending; MB does not list it, and a fetch is refused', async () => {
        const mine = await waitUntil(async () => {
          const list = await sdk(a.page, async () => (await (await import('/_mw/sdk.js')).default.files.list()));
          return Array.isArray(list) ? list.find((f) => f.ref === shared.ref) || null : null;
        }, { timeoutMs: 15000, label: 'MA lists its own file' });
        assert(mine.mine === true && mine.pending === true, 'MA\'s own item ' + JSON.stringify(mine));
        await sleep(3000); // time for the listing to reach MB over gossip
        const list = await sdk(b.page, async () => (await (await import('/_mw/sdk.js')).default.files.list()));
        assert(Array.isArray(list) && !list.find((f) => f.ref === shared.ref), 'MB lists a listing that waits for a moderator: ' + JSON.stringify(list));
        const r = await sdk(b.page, async (ref) => {
          const mw = (await import('/_mw/sdk.js')).default;
          try { await mw.files.fetch(ref); return { ok: true }; } catch (e) { return { err: e.code || e.message }; }
        }, shared.ref);
        assert(r && r.err === 'E_POLICY', 'MB fetched a pending listing: ' + JSON.stringify(r));
      });
      await step('the owner accepts it offline (ledger-admin listed into the host\'s snapshot); a new visitor MO loads the snapshot and passes the block on', async () => {
        const identity = await loadOwnerKey(ctx.stack.owner.file);
        const file = join(m.outDir, 'genesis.json');
        const res = await acceptListing({ blocks: readBlocksFile(file), identity, ih: shared.ref, author: a.pub }); // MAL53-1: bound to the author
        writeBlocksFile(file, res.blocks);
        const mo = await ctx.visitor('MO');
        const page = await mo.newPage();
        await page.goto(m.url, { waitUntil: 'domcontentloaded', timeout: 20000 });
        await acceptConsent(page, { timeoutMs: 20000 });
        await waitForSite(page, { timeoutMs: 30000, label: 'MO: site' });
      });
      await step('MB sees it in files.list() once the acceptance arrived', () => waitUntil(async () => {
        const list = await sdk(b.page, async () => (await (await import('/_mw/sdk.js')).default.files.list()));
        return Array.isArray(list) && list.find((f) => f.ref === shared.ref && !f.pending) ? list : null;
      }, { timeoutMs: 30000, label: 'listed at MB' }));
      const text = await step('MB fetches it (the offer card: Accept) and previews it: the loader returns the text', async () => {
        const r = await withCards(b.page, async (ref) => {
          const mw = (await import('/_mw/sdk.js')).default;
          try { await mw.files.fetch(ref); } catch (e) { return { err: e.code || e.message, message: e.message, reason: e.reason || null }; }
          return { ok: true };
        }, shared.ref, [T.accept]);
        assert(r && r.ok, 'fetch ' + JSON.stringify(r));
        // A text preview comes back as text (src/files/preview.js render): the loader read it, the page shows it as text.
        return sdk(b.page, async (ref) => {
          const mw = (await import('/_mw/sdk.js')).default;
          const p = await mw.files.preview(ref);
          return { kind: p.kind, text: p.text, url: p.url || null };
        }, shared.ref);
      });
      assert(text.kind === 'text' && text.text === 'a public note from MA' && !text.url, 'preview ' + JSON.stringify(text));
      await step('MA removes it (files.remove, the confirm card): MB\'s list drops it', async () => {
        const r = await withCards(a.page, async (ref) => {
          const mw = (await import('/_mw/sdk.js')).default;
          try { return await mw.files.remove(ref); } catch (e) { return { err: e.code || e.message }; }
        }, shared.ref, [T.continue]);
        assert(!(r && r.err), 'remove ' + JSON.stringify(r));
        await waitUntil(async () => {
          const list = await sdk(b.page, async () => (await (await import('/_mw/sdk.js')).default.files.list()));
          return Array.isArray(list) && !list.find((f) => f.ref === shared.ref);
        }, { timeoutMs: 30000, label: 'gone from MB\'s list' });
      });
      return 'shared ' + shared.ref.slice(0, 24) + '..., pending until the owner accepted it, then fetched and previewed as text, removed';
    },
  };

  // ------------------------------------------------------------------------------------------- E-FI-2
  S['E-FI-2'] = {
    title: 'a private file: only the recipient fetches and previews it; it is not listed for the site',
    async fn(ctx, step) {
      const m = await site(ctx, step);
      const a = await member(ctx, step, 'MA', m);
      const b = await member(ctx, step, 'MB', m);
      const shared = await step('MA shares secret.txt with MB only (files.share({ to: [MB] }), the upload card: Continue)', () => withCards(a.page, async (pub) => {
        const mw = (await import('/_mw/sdk.js')).default;
        try { return await mw.files.share(new File(['for MB only'], 'secret.txt', { type: 'text/plain' }), { to: [pub] }); } catch (e) { return { err: e.code || e.message }; }
      }, b.pub, [T.continue]));
      assert(shared && shared.ref && !shared.err, 'share ' + JSON.stringify(shared));
      const listed = await sdk(a.page, async () => (await (await import('/_mw/sdk.js')).default.files.list()));
      assert(!listed.find((f) => f.ref === shared.ref), 'a private file is listed for the site');
      const got = await step('MB has it in files.received(), fetches it (Accept) and previews the plain text', async () => {
        // A private file travels under a random name (src/files/names.js): it is found by its ref.
        const rec = await waitUntil(async () => {
          const list = await sdk(b.page, async () => (await (await import('/_mw/sdk.js')).default.files.received()));
          return Array.isArray(list) ? list.find((f) => f.ref === shared.ref) || null : null;
        }, { timeoutMs: 30000, label: 'received at MB' }).catch(async (err) => {
          const dbg = {
            share: shared,
            aDeliveries: await sdk(a.page, () => window.__mwE2E.deliveries.slice(-6)),
            bMessages: await sdk(b.page, () => window.__mwE2E.messages.map((x) => ({ text: x.text, grant: x.grant }))),
            bReceived: await sdk(b.page, async () => (await (await import('/_mw/sdk.js')).default.files.received())),
          };
          throw new StepError(err.message + ' ' + JSON.stringify(dbg));
        });
        const r = await withCards(b.page, async (ref) => {
          const mw = (await import('/_mw/sdk.js')).default;
          try { await mw.files.fetch(ref); } catch (e) { return { err: e.code || e.message }; }
          const p = await mw.files.preview(ref);
          return { kind: p.kind, text: p.text };
        }, rec.ref, [T.accept]);
        return r;
      });
      assert(got && got.kind === 'text' && got.text === 'for MB only', 'MB got ' + JSON.stringify(got));
      return 'received and decrypted by the recipient only';
    },
  };

  // ------------------------------------------------------------------------------------------- E-MD-4 and E-MD-3
  async function mediaFixture(ctx, m) {
    if (ctx.shared.membersFx) return ctx.shared.membersFx;
    assert(hasFfmpeg(), 'ffmpeg is not on PATH (needed for the media fixtures)');
    const fxDir = join(m.outDir, 'e2e-fx');
    mkdirSync(fxDir, { recursive: true });
    const made = await makeFixtures(fxDir, { only: ['moovAtEnd'] });
    ctx.shared.membersFx = { made, path: '/ws/e2e-fx/' + made.moovAtEnd.split('/').pop() };
    return ctx.shared.membersFx;
  }

  S['E-MD-4'] = {
    title: 'private media: MA uploads an MP4 and shares it with MB (a grant in a sealed message); MB plays it through /_mw/media/<sid> with a seek',
    async fn(ctx, step) {
      const m = await site(ctx, step);
      const a = await member(ctx, step, 'MA', m);
      const b = await member(ctx, step, 'MB', m);
      const fx = await mediaFixture(ctx, m);
      const up = await step('MA uploads the clip (media.upload, the upload card: Continue)', () => withCards(a.page, async (path) => {
        const mw = (await import('/_mw/sdk.js')).default;
        const bytes = await (await fetch(path)).arrayBuffer();
        try { return await mw.media.upload(new File([bytes], 'holiday.mp4', { type: 'video/mp4' })); } catch (e) { return { err: e.code || e.message }; }
      }, fx.path, [T.continue], { timeoutMs: 60000 }));
      assert(up && up.id && !up.err, 'upload ' + JSON.stringify(up));
      const sh = await step('MA shares it with MB (media.share, the share card: Continue)', () => withCards(a.page, async (p) => {
        const mw = (await import('/_mw/sdk.js')).default;
        try { return await mw.media.share(p.id, { to: [p.pub] }); } catch (e) { return { err: e.code || e.message }; }
      }, { id: up.id, pub: b.pub }, [T.continue]));
      assert(sh && !sh.err, 'share ' + JSON.stringify(sh));
      await step('MB gets the loader\'s offer card (never auto-accepted, MAL A8) and accepts it', () => answerCard(b.page, T.accept));
      const item = await step('MB has the item in media.list({ from: "received" })', () => waitUntil(async () => {
        const list = await sdk(b.page, async () => (await (await import('/_mw/sdk.js')).default.media.list({ from: 'received' })));
        return Array.isArray(list) && list.length ? list[0] : null;
      }, { timeoutMs: 30000, label: 'received at MB' }).catch(async (err) => {
        const dbg = {
          share: sh,
          aDeliveries: await sdk(a.page, () => window.__mwE2E.deliveries.slice(-6)),
          bMessages: await sdk(b.page, () => window.__mwE2E.messages.map((x) => ({ from: x.from && x.from.slice(0, 12), text: x.text, grant: x.grant }))),
          aLog: (await a.page.evaluate(() => window.__mwShell.inspect().log.slice(-8))),
          bLog: (await b.page.evaluate(() => window.__mwShell.inspect().log.slice(-8))),
        };
        throw new StepError(err.message + ' ' + JSON.stringify(dbg));
      }));
      const played = await step('MB opens it and plays it in a <video>: 206 from the worker, a seek, HAVE_CURRENT_DATA', async () => {
        const r = await withCards(b.page, async (id) => {
          const mw = (await import('/_mw/sdk.js')).default;
          let o;
          try { o = await mw.media.open(id); } catch (e) { return { err: e.code || e.message }; }
          const range = await fetch(o.url, { headers: { Range: 'bytes=0-15' } });
          const v = document.createElement('video');
          v.muted = true; v.preload = 'auto'; v.src = o.url;
          document.body.appendChild(v);
          await new Promise((res, rej) => { v.onloadeddata = res; v.onerror = () => rej(new Error('video error ' + (v.error && v.error.code))); setTimeout(() => rej(new Error('no loadeddata')), 20000); });
          const seekTo = Math.max(0.5, (v.duration || 2) / 2);
          v.currentTime = seekTo;
          await new Promise((res, rej) => { v.onseeked = res; setTimeout(() => rej(new Error('no seeked')), 20000); });
          return { url: o.url, status: range.status, ready: v.readyState, duration: v.duration, at: v.currentTime };
        }, item.id, [], { timeoutMs: 60000 });
        return r;
      });
      assert(played && !played.err && played.status === 206 && played.ready >= 2 && played.url.indexOf('/_mw/media/') === 0, 'playback ' + JSON.stringify(played));
      ctx.shared.mediaItem = { id: up.id, recipientId: item.id };
      return 'uploaded ' + up.id.slice(0, 12) + '..., shared, played by MB (206, readyState ' + played.ready + ' after a seek to ' + played.at.toFixed(1) + ' s)';
    },
  };

  S['E-MD-3'] = {
    title: 'a third member who was not given the item has no route for it and cannot open it',
    async fn(ctx, step) {
      const m = await site(ctx, step);
      assert(ctx.shared.mediaItem, 'E-MD-4 did not run');
      const c = await member(ctx, step, 'MC', m);
      const r = await step('MC: media.list() has nothing, media.open(<the id MB got>) is refused', () => sdk(c.page, async (id) => {
        const mw = (await import('/_mw/sdk.js')).default;
        const list = await mw.media.list({ from: 'all' });
        let code = null;
        try { await mw.media.open(id); code = 'opened'; } catch (e) { code = e.code || e.message; }
        return { listed: list.length, code };
      }, ctx.shared.mediaItem.recipientId));
      assert(r.listed === 0 && r.code !== 'opened', 'MC ' + JSON.stringify(r));
      return 'MC lists ' + r.listed + ' item(s); open: ' + r.code;
    },
  };

  S['E-MD-5'] = {
    title: 'revoke: the uploader takes the recipient\'s access back; the recipient\'s loader drops the key, open() is E_REVOKED and the item leaves its list',
    async fn(ctx, step) {
      const m = await site(ctx, step);
      assert(ctx.shared.mediaItem, 'E-MD-4 did not run');
      const a = await member(ctx, step, 'MA', m);
      const b = await member(ctx, step, 'MB', m);
      const r = await step('MA revokes MB (media.revoke, the confirm card: Continue)', () => withCards(a.page, async (p) => {
        const mw = (await import('/_mw/sdk.js')).default;
        try { return await mw.media.revoke(p.id, { from: [p.pub] }); } catch (e) { return { err: e.code || e.message }; }
      }, { id: ctx.shared.mediaItem.id, pub: b.pub }, [T.continue]));
      assert(r && !r.err && Array.isArray(r.revoked) && r.revoked.indexOf(b.pub) >= 0, 'revoke ' + JSON.stringify(r));
      const after = await step('MB: the item leaves media.list() and media.open() is E_REVOKED', () => waitUntil(async () => {
        const x = await sdk(b.page, async (id) => {
          const mw = (await import('/_mw/sdk.js')).default;
          const list = await mw.media.list({ from: 'received' });
          let code = null;
          try { await mw.media.open(id); code = 'opened'; } catch (e) { code = e.code || e.message; }
          return { listed: list.filter((i) => i.id === id).length, code };
        }, ctx.shared.mediaItem.recipientId);
        return x.listed === 0 && x.code === 'E_REVOKED' ? x : null;
      }, { timeoutMs: 30000, label: 'revoked at MB' }).catch(async (err) => {
        const x = await sdk(b.page, async (id) => { const mw = (await import('/_mw/sdk.js')).default; let c = null; try { await mw.media.open(id); c = 'opened'; } catch (e) { c = e.code; } return { list: await mw.media.list({ from: 'all' }), code: c }; }, ctx.shared.mediaItem.recipientId);
        throw new StepError(err.message + ' ' + JSON.stringify(x));
      }));
      return 'revoked; MB: ' + JSON.stringify(after);
    },
  };

  return S;
}
