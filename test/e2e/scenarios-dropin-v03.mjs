// test/e2e/scenarios-dropin-v03.mjs: the drop-in widgets of an existing site with the real identity origin, the real drop-in
// engine and the real chat lane (V03-DESIGN-REVIEW 2.3.6, 3.8; Part 4.2 E-SI-1; examples/existing-site-dropin/EXPECTED.md
// checks 11 to 19). The examples lane wrote the Example Forum (stage('with-widgets')) and its checks contract-first and did
// not run them in a browser; E-SI-1 of wave 1 ran the widget against a stand-in identity page (scenarios-v03.mjs). Here the
// forum is published with --dropin --chain forum-chat --signin-widget --chat-panel and idp= the e2e stack's identity origin,
// chat is switched on in the ledger (ledger-admin setCfg, served at cs=), and the forum's server is the sign-in fixture.
//
//   E-SI-1W  checks 11, 13 to 15, 17: the widgets are the owner's files with their hashes; the button in a closed root signs
//            in end to end through the identity origin's popup; a replay is refused, a second click inside 10 s is E_RATE;
//            a cross-origin challenge URL is E_BAD_REQUEST before any request
//   E-SI-5W  R 4.2 E-SI-5 with the real identity origin (v0.3 code review): the forum opened through a loopback reverse proxy
//            that rewrites its pages; the identity origin signs the origin the request came from (event.origin), so the
//            proof names the proxy, and the forum's server refuses it with "origin" and mints no session
//   E-CH-R   checks 18 and 19: the chat panel's views (signed-out, off, on) and two signed-in visitors in one Lobby, with
//            nothing added to the site ledger (the room part of E-CH-1, through the drop-in SDK)
//
// Chromium with the local-only flags; every URL is http://127.0.0.1.

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { waitUntil, sleep, withTimeout, StepError } from './lib.mjs';
import { driveIdp } from './idp-driver.mjs';
import { stage } from '../fixtures/existing-site-dropin/stage.mjs';
import { startSigninServer } from '../fixtures/signin-server/server.mjs';
import { publish } from '../../tools/publish.mjs';
import { setCfg, readBlocksFile, writeBlocksFile } from '../../tools/ledger-admin.mjs';
import { loadOwnerKey } from '../../tools/lib.mjs';
import { STRINGS, UI_TEXT } from '../../src/loader/strings.js';
import { startRewritingProxy } from './scenarios-v03.mjs';

export const DROPIN_V03_ORDER = ['E-SI-1W', 'E-SI-5W', 'E-CH-R'];

const sri = (bytes) => 'sha384-' + createHash('sha384').update(bytes).digest('base64');

/** dropinV03Scenarios({ assert }) -> { id: { title, fn(ctx, step) } } for test/e2e/run.mjs. */
export function dropinV03Scenarios({ assert }) {
  const S = {};
  const T = UI_TEXT.en;

  /** The forum, published once per run: { url, server, outDir, pub, dist }. */
  async function forum(ctx, step) {
    if (ctx.shared.forum) return ctx.shared.forum;
    const { stack } = ctx;
    const f = await step('stage the Example Forum, publish it (--dropin --chain forum-chat --signin-widget --chat-panel, idp= the identity origin), turn chat on in the ledger (--chat open, served at cs=)', async () => {
      const base = join(stack.runDir, 'forum');
      const trackerHost = new URL(stack.tracker.url).host;
      const site = stage('with-widgets', join(base, 'src'), { widgets: { dist: stack.dist, tracker: trackerHost, stun: '127.0.0.1' } });
      const outDir = join(base, 'out');
      const opts = {
        dir: site.dir, name: 'forum', scope: '127.0.0.1', key: stack.owner.file, chain: 'forum-chat', signinWidget: true, signinStatement: 'Sign in to Example Forum',
        chatPanel: true, tracker: [stack.tracker.url], stun: ['stun:127.0.0.1:3478'], tr: [stack.tracker.url], ws: [], dropin: true, dist: stack.dist,
        out: outDir, idp: stack.idp.url, exp: 30, quiet: true,
      };
      await publish(opts);
      // The forum's own server serves the published site (pages, runtime, widgets) and the two sign-in routes.
      const server = await startSigninServer({ port: 0, staticDir: join(outDir, 'site') });
      ctx.closers.push(() => server.close());
      // "ledger-admin cfg --chat open" on the genesis, then a second publish that names the snapshot (cs=).
      const identity = await loadOwnerKey(stack.owner.file);
      // open, not members: the forum's visitors read its ledger and never write to it, and members lets only writers chat.
      const cfg = await setCfg({ blocks: readBlocksFile(join(outDir, 'genesis.json')), identity, set: { chat: 'open' } });
      await sleep(1100); // seq is the Unix time in seconds: the second publish must be a later second
      const pub = await publish(Object.assign({}, opts, { cs: server.url + '/forum-genesis.json' }));
      writeBlocksFile(join(outDir, 'site', 'forum-genesis.json'), cfg.blocks);
      return { url: server.url, server, outDir, pub, cfg: cfg.cfg };
    });
    ctx.shared.forum = f;
    return f;
  }

  async function dropin(page) {
    return page.evaluate(() => (window.__mwDropin && window.__mwDropin.inspect ? window.__mwDropin.inspect() : null)).catch(() => null);
  }

  /** Opens the forum in a new page of visitor name and answers the drop-in first-run card with "Share and load". */
  async function openForum(ctx, name, f, { requests = null } = {}) {
    const v = await ctx.visitor(name);
    const page = await v.newPage();
    if (requests) page.on('request', (r) => requests.push(r.url()));
    await page.goto(f.url + '/', { waitUntil: 'load', timeout: 20000 });
    const rect = await waitUntil(() => page.evaluate((label) => (window.__mwDropin ? window.__mwDropin.rectOf(label) : null), STRINGS.consentShare), { timeoutMs: 15000, label: name + ': the first-run card' });
    await sleep(300);
    await page.mouse.click(rect.x + rect.width / 2, rect.y + rect.height / 2);
    await waitUntil(async () => { const s = await dropin(page); return s && s.consent === 'accepted' ? s : null; }, { timeoutMs: 15000, label: name + ': consent accepted' });
    return { v, page };
  }

  async function clickSignin(page) {
    const box = await page.locator('mw-signin').boundingBox();
    assert(box && box.width > 20 && box.height > 20, 'the sign-in element has no box: ' + JSON.stringify(box));
    await sleep(300);
    await page.mouse.click(box.x + 16, box.y + 14); // the button sits at the top left of the element
  }

  async function forumState(page) {
    return page.evaluate(() => Object.assign({}, window.__forum, { events: (window.__forum.events || []).slice(), status: document.querySelector('#signin-status').textContent }));
  }

  // ------------------------------------------------------------------------------------------- E-SI-1W
  S['E-SI-1W'] = {
    title: 'EXPECTED.md checks 11, 13 to 15, 17: the forum\'s own widget files with their hashes; <mw-signin> signs in through the real identity origin; the cooldown and cross-origin URLs refused (the replay half of 15 is E-SI-2)',
    async fn(ctx, step) {
      const f = await forum(ctx, step);
      const requests = [];
      const { page } = await step('visitor F1 opens the forum and chooses "Share and load" on the drop-in card', () => openForum(ctx, 'F1', f, { requests }));
      const hashes = await step('check 11: the page\'s script tags carry the sha384 of the widget files it serves, fetched from its own origin only', async () => {
        const tags = await page.evaluate(() => Array.from(document.querySelectorAll('script[src^="/_mw/"][integrity]')).map((s) => ({ src: s.getAttribute('src'), integrity: s.getAttribute('integrity') })));
        const want = {
          '/_mw/signin.js': sri(readFileSync(join(f.outDir, 'site', '_mw', 'signin.js'))),
          '/_mw/chat-panel.js': sri(readFileSync(join(f.outDir, 'site', '_mw', 'chat-panel.js'))),
        };
        for (const src of Object.keys(want)) {
          const tag = tags.find((t) => t.src === src);
          assert(tag && tag.integrity === want[src], src + ': integrity ' + (tag && tag.integrity) + ', file ' + want[src]);
          assert(readFileSync(join(f.outDir, 'site', '_mw', src.slice(5))).equals(readFileSync(join(ctx.stack.dist, '_mw', src.slice(5)))), src + ' is not byte for byte the built file');
        }
        const defined = await page.evaluate(() => ({ signin: Boolean(customElements.get('mw-signin')), panel: Boolean(customElements.get('mw-chat-panel')) }));
        assert(defined.signin && defined.panel, 'the widgets did not define their elements: ' + JSON.stringify(defined));
        const widgetLoads = requests.filter((u) => /\/_mw\/(signin|chat-panel)\.js$/.test(u));
        assert(widgetLoads.length >= 2 && widgetLoads.every((u) => u.startsWith(f.url + '/')), 'widget requests ' + JSON.stringify(widgetLoads));
        return want;
      });
      await step('check 13: the button lives in a closed shadow root', async () => {
        const open = await page.evaluate(() => document.querySelector('mw-signin').shadowRoot);
        assert(open === null, 'mw-signin has an open shadow root');
      });
      const signed = await step('check 14: one click, the identity origin\'s popup names the forum and its statement, the proof text is posted, 200, a session', async () => {
        const popupPromise = page.context().waitForEvent('page', { timeout: 20000 });
        await clickSignin(page);
        const popup = await popupPromise;
        assert(popup.url().startsWith(ctx.stack.idp.url + '/signin'), 'the popup is not the identity origin: ' + popup.url());
        let card = null;
        const drive = await withTimeout(driveIdp(popup, { unlock: 'visit', onCard: (st) => { if (!card && /^Sign in to /.test(st.title)) card = st; } }), 60000, 'identity origin');
        assert(card && card.text.indexOf(f.url) >= 0 && card.text.indexOf('"Sign in to Example Forum"') >= 0, 'the card did not name the forum and its statement: ' + (card && card.text.slice(0, 300)));
        const st = await waitUntil(async () => { const s = await forumState(page); return s.events.indexOf('signed-in') >= 0 || s.error ? s : null; }, { timeoutMs: 15000, label: 'the widget reports' });
        assert(JSON.stringify(st.events) === JSON.stringify(['pending', 'signed-in']), 'events ' + JSON.stringify(st.events) + ' error ' + st.error);
        assert(/^p256:/.test(String(st.pub)) && st.keyMode === 'pairwise', 'pub ' + st.pub + ', keyMode ' + st.keyMode);
        assert(/^Signed in as p256:/.test(st.status), 'status line ' + JSON.stringify(st.status));
        const sessions = Array.from(f.server.sessions.values());
        assert(sessions.some((x) => x.pub === st.pub), 'the server holds no session for ' + st.pub);
        const cookies = await page.context().cookies(f.url);
        assert(cookies.some((c) => c.name === 'mw_session' && c.httpOnly), 'no HttpOnly mw_session cookie');
        return { st, cards: drive.cards };
      });
      await step('check 15: a second click inside 10 s is E_RATE and sends nothing', async () => {
        const before = f.server.sessions.size;
        await clickSignin(page);
        const st = await waitUntil(async () => { const s = await forumState(page); return s.events.length > 2 ? s : null; }, { timeoutMs: 5000, label: 'second click reported' });
        assert(st.events[st.events.length - 1] === 'error:E_RATE', 'events ' + JSON.stringify(st.events));
        assert(f.server.sessions.size === before, 'a new session was made');
      });
      await step('check 17: a cross-origin challenge-url ends in E_BAD_REQUEST with no request to any other origin', async () => {
        await sleep(10200); // past the widget's 10 s cooldown
        const n = requests.length;
        await page.evaluate(() => document.querySelector('mw-signin').setAttribute('challenge-url', 'http://127.0.0.1:1/challenge'));
        await clickSignin(page);
        const st = await waitUntil(async () => { const s = await forumState(page); return s.events[s.events.length - 1] === 'error:E_BAD_REQUEST' ? s : null; }, { timeoutMs: 5000, label: 'E_BAD_REQUEST' });
        assert(!requests.slice(n).some((u) => u.startsWith('http://127.0.0.1:1/')), 'a request went to the other origin');
        await page.evaluate(() => document.querySelector('mw-signin').setAttribute('challenge-url', '/auth/mw/challenge'));
        return st.events.length;
      });
      return 'signed in as ' + String(signed.st.pub).slice(0, 18) + '... (cards: ' + signed.cards.join(' > ') + '); widgets ' + Object.values(hashes).map((h) => h.slice(0, 15)).join(', ');
    },
  };

  // ------------------------------------------------------------------------------------------- E-SI-5W
  // E-SI-5 of scenarios-v03.mjs signs with a stand-in that uses the proxy origin by construction, so it never shows that the identity
  // origin takes the origin from the browser. Here the identity origin itself signs, and the proof is read off the wire.
  S['E-SI-5W'] = {
    title: 'R 4.2 E-SI-5 with the real identity origin: the forum through a rewriting reverse proxy; the proof the identity origin signs names the proxy origin, and the forum\'s server refuses it with "origin"',
    async fn(ctx, step) {
      const f = await forum(ctx, step);
      const proxy = await step('a reverse proxy in front of the forum that rewrites its pages (another loopback port)', async () => {
        const p = await startRewritingProxy(f.url);
        ctx.closers.push(() => p.close());
        return p;
      });
      const sessionsBefore = f.server.sessions.size;
      const { page } = await step('visitor F5 opens the forum through the proxy and chooses "Share and load" on the drop-in card', () => openForum(ctx, 'F5', { url: proxy.url }));
      await step('the page came through the proxy and was rewritten on the way', async () => {
        const mark = await page.evaluate(() => { const m = document.querySelector('meta[name="x-rewritten"]'); return m && m.content; });
        assert(mark === 'e2e reverse proxy', 'the page did not come through the proxy');
        assert(proxy.stats.rewritten >= 1, 'no page was rewritten');
      });
      const out = await step('one click: the identity origin signs for the page that opened it, the widget posts the proof through the proxy, 401 "origin"', async () => {
        const popupPromise = page.context().waitForEvent('page', { timeout: 20000 });
        await clickSignin(page);
        const popup = await popupPromise;
        assert(popup.url().startsWith(ctx.stack.idp.url + '/signin'), 'the popup is not the identity origin: ' + popup.url());
        let card = null;
        await withTimeout(driveIdp(popup, { unlock: 'visit', onCard: (st) => { if (!card && /^Sign in to /.test(st.title)) card = st; } }), 60000, 'identity origin');
        // The proof and the forum's answer, as they crossed the proxy.
        const post = await waitUntil(() => proxy.stats.posts.find((x) => x.path === '/auth/mw/verify' && x.done) || null, { timeoutMs: 30000, label: 'the proof posted through the proxy' });
        const json = (bufs) => { try { return JSON.parse(Buffer.concat(bufs).toString('utf8')); } catch (_) { return null; } };
        const st = await waitUntil(async () => { const s = await forumState(page); return s.signedIn || s.events.some((e) => e.indexOf('error') === 0) ? s : null; }, { timeoutMs: 15000, label: 'the widget reports' });
        return { proof: json(post.request), status: post.status, body: json(post.response), st, card };
      });
      assert(out.card && out.card.text.indexOf(proxy.url) >= 0, 'the identity origin\'s card did not name the proxy origin: ' + (out.card && out.card.text.slice(0, 300)));
      const c = out.proof && out.proof.c;
      assert(c && c.origin === proxy.url && c.domain === new URL(proxy.url).host, 'the proof names ' + JSON.stringify(c && { origin: c.origin, domain: c.domain }) + ', not the proxy ' + proxy.url);
      assert(c.origin !== f.url && c.idp === new URL(ctx.stack.idp.url).origin, 'origin ' + c.origin + ', idp ' + c.idp);
      assert(out.status === 401 && out.body && out.body.reason === 'origin', 'the forum answered ' + out.status + ' ' + JSON.stringify(out.body));
      assert(!out.st.signedIn && out.st.events[out.st.events.length - 1] === 'error:E_DENIED', 'the widget reported ' + JSON.stringify(out.st.events));
      assert(f.server.sessions.size === sessionsBefore, 'the forum minted a session');
      return 'the proof names ' + c.origin + ' (the forum is ' + f.url + '): refused, origin; ' + proxy.stats.forwarded + ' requests forwarded, ' + proxy.stats.rewritten + ' pages rewritten';
    },
  };

  // ------------------------------------------------------------------------------------------- E-CH-R
  async function panel(page) {
    return page.evaluate(() => { const p = document.querySelector('mw-chat-panel'); return p ? { view: p.view, lobby: p.lobby.slice(), note: p._note || '' } : null; });
  }

  // card: a button of the loader-owned card the drop-in engine shows (window.__mwDropin.rectOf), else one inside the panel.
  async function pressPanel(page, label, { card = false } = {}) {
    const rect = await waitUntil(() => page.evaluate(([l, c]) => { if (c) return window.__mwDropin ? window.__mwDropin.rectOf(l) : null; const p = document.querySelector('mw-chat-panel'); return p ? p.rectOf(l) : null; }, [label, card]), { timeoutMs: 15000, label: (card ? 'card' : 'panel') + ' button "' + label + '"' });
    await sleep(700); // loader cards ignore presses while they settle (src/widget/redress.js minimum visible time)
    await page.mouse.click(rect.x + rect.width / 2, rect.y + rect.height / 2);
  }

  async function panelTo(page, view, label) {
    let last = null;
    return waitUntil(async () => {
      const p = await panel(page);
      last = p;
      if (p && p.view !== view) await page.evaluate(() => document.querySelector('mw-chat-panel').refresh()).catch(() => {});
      return p && p.view === view ? p : null;
    }, { timeoutMs: 20000, label }).catch(async (err) => {
      const st = await dropin(page);
      const cards = await page.evaluate(async (labels) => {
        let chat = null;
        try { chat = await Promise.race([window.mw.chat.state(), new Promise((r) => setTimeout(() => r('timeout'), 2000))]); } catch (e) { chat = 'error ' + (e && e.code); }
        return { engine: labels.map((l) => [l, Boolean(window.__mwDropin && window.__mwDropin.rectOf(l))]), chat };
      }, [T.chatTurnOn, STRINGS.consentShare, 'OK', 'Allow', 'Continue']).catch((e) => 'eval ' + e.message);
      throw new StepError(err.message + ' (panel ' + JSON.stringify(last) + '; engine cards ' + JSON.stringify(cards) + '; log ' + JSON.stringify(st && (st.logs || st.log || []).slice(-12)) + ')');
    });
  }

  /** A visitor signs in from the panel's own button (the drop-in identity), then turns chat on through the loader's card. */
  async function chatOn(ctx, step, name, f) {
    const { page } = await step(name + ' opens the forum and chooses "Share and load"', () => openForum(ctx, name, f));
    await step(name + ': the panel is \'signed-out\' for a guest, with a Sign in button', () => panelTo(page, 'signed-out', 'signed-out view'));
    await step(name + ' signs in from the panel (mw.auth.signIn through the drop-in engine and the identity origin): the panel is \'off\'', async () => {
      const popupPromise = page.context().waitForEvent('page', { timeout: 20000 });
      await pressPanel(page, T.signInButton);
      const popup = await popupPromise;
      await withTimeout(driveIdp(popup, { unlock: 'visit' }), 60000, 'identity origin');
      await panelTo(page, 'off', 'off view');
    });
    await step(name + ' presses "Turn on chat": mw.chat.enable() shows the loader\'s one consent card (tracker and STUN), Continue: the panel is \'on\'', async () => {
      await pressPanel(page, T.chatTurnOn);
      await pressPanel(page, T.continue, { card: true });
      await panelTo(page, 'on', 'on view');
    });
    return page;
  }

  S['E-CH-R'] = {
    title: 'EXPECTED.md checks 18 and 19: the chat panel\'s views (signed-out, off, on) and two signed-in visitors in one Lobby over the chat lane, nothing written to the site ledger',
    async fn(ctx, step) {
      const f = await forum(ctx, step);
      await ctx.closeVisitor('F1');
      const pa = await chatOn(ctx, step, 'C1', f);
      const pb = await chatOn(ctx, step, 'C2', f);
      const heightBefore = await pa.evaluate(async () => (await window.mw.ready()).height);
      const line = 'Hello <b>x</b> from C1';
      await step('C1 types a line in the Lobby (a real click in the panel): it reaches C2\'s Lobby as text', async () => {
        await pressPanel(pa, T.chatMessage);
        await pa.keyboard.type(line);
        await pressPanel(pa, T.chatSend);
        const got = await waitUntil(async () => {
          const p = await panel(pb);
          return p && p.lobby.some((l) => l.endsWith(': ' + line)) ? p : null;
        }, { timeoutMs: 30000, label: 'the line at C2' }).catch(async (err) => { throw new StepError(err.message + ' (C2 panel ' + JSON.stringify(await panel(pb)) + ')'); });
        const seen = got.lobby.find((l) => l.endsWith(': ' + line));
        assert(!seen.startsWith('?:'), 'UX-6: the sender shows as "?" in the Lobby: ' + seen);
        return got;
      });
      await step('nothing was added to the site ledger by the chat (the room lives on the chat lane only)', async () => {
        const after = await pa.evaluate(async () => (await window.mw.ready()).height);
        assert(after === heightBefore, 'the ledger grew from ' + heightBefore + ' to ' + after);
      });
      return 'two visitors in one Lobby; ledger height ' + heightBefore + ' unchanged';
    },
  };

  return S;
}
