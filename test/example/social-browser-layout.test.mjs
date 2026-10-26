// Browser tests for examples/social, part 4: the layout at 320, 390 and 1,024 CSS px (no sideways scroll, 44 px targets, one column then
// two), keyboard-only use, focus, landmarks and live regions, the light, dark and automatic themes, reduced motion, WCAG contrast of the
// colour pairs the page really uses, JavaScript off, a plain static host, and that nothing leaves loopback. Local-only Chromium; WebKit
// on 127.0.0.1. Run: node --test test/example/social-browser-layout.test.mjs
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { pw, setup, open, text, count, waitFor, calls, body, go } from './social-browser-lib.mjs';
import * as H from './social-helpers.mjs';
import { STATE, PRIVACY } from '../../examples/social/js/strings.js';

const now = Date.now();
const MIN = 60000;
const me = H.pubOf(1), boPub = H.pubOf(2);
const BO_POST = H.hashOf('bopost'), MINE = H.hashOf('mine1'), POST_G = H.hashOf('gpost');
const long = 'A long post with a link https://example.org/a/very/long/path/that/keeps/going/and/going/and/going/and/going/without/any/break and some text. ' + 'word '.repeat(60);
const bo = () => H.ledger(2, { name: 'Bo with a rather long display name that has to wrap properly', posts: [{ ts: now - 30 * MIN, text: long, h: BO_POST, v: { text: long, media: [{ ref: 'r1', kind: 'image', alt: 'A red door in a brick wall that is described at some length', len: 214000 }] } }],
  lists: { 'mw.prof': [H.item(H.hashOf('bop'), boPub, now - 90 * MIN, { bio: 'Bo writes about doors.', links: ['https://example.org/a/very/long/address/for/a/personal/website/that/must/wrap'], handle: 'a-rather-long-handle.example.org' })] } });
const cy = () => H.ledger(3, { name: 'Cy', posts: [{ ts: now - 60 * MIN, text: 'Cy says hi' }] });
const contacts = [{ pub: boPub, nick: 'Bo', short: H.shortIdOf(boPub) }];
const world = (extra = {}) => H.scenario({ name: 'Ada', followed: [2, 3], ledgers: [bo(), cy()], chat: { enabled: true, contacts }, lists: { 'mw.post': [H.item(MINE, me, now - 20 * MIN, { text: 'my own post' })] },
  extra: Object.assign({ pointer: 'v=mw1; btih=0123456789abcdef0123456789abcdef01234567; owner=' + me + '; chain=chain00000000000000001; seq=3; exp=1900000000; sig=' + 'S'.repeat(86),
    media: [{ id: 'm1', kind: 'image', mime: 'image/png', len: 2000, w: 10, h: 10, from: 'me', t: now - MIN, available: 'kept' }] }, extra) });
const guest = () => H.scenario({ me: 1, name: 'Ada', extra: { auth: 'guest', role: 'reader', siteId: H.ledgerId(2), owner: boPub, short: H.shortIdOf(me), me,
  home: { policy: { writers: 'owner', bits: 16, maxValueBytes: 2048, maxChainBytes: 8388608, moderators: [], banned: [] }, profiles: { [boPub]: 'Bo' }, lists: { 'mw.post': [H.item(BO_POST, boPub, now - 30 * MIN, { text: 'Hello from Bo' })] } } } });

const AUDIT = () => {
  const vis = (el) => { const r = el.getBoundingClientRect(), cs = getComputedStyle(el); return r.width > 0 && r.height > 0 && cs.visibility !== 'hidden' && cs.display !== 'none' && !el.closest('[hidden]') && !el.closest('.sr-only') && !el.closest('.skip'); };
  const small = [];
  for (const el of document.querySelectorAll('a[href], button, select, textarea, summary, input')) {
    if (!vis(el)) continue;
    const type = (el.getAttribute('type') || '').toLowerCase();
    let target = el;
    if (type === 'checkbox' || type === 'radio') target = el.closest('label') || el;
    if (el.tagName === 'A' && getComputedStyle(el).display === 'inline') continue; // a link inside a line of text
    const r = target.getBoundingClientRect();
    if (r.height < 43.5 || (r.width < 43.5 && el.tagName !== 'INPUT')) small.push((el.id ? '#' + el.id : el.tagName.toLowerCase() + '.' + el.className) + ' ' + Math.round(r.width) + 'x' + Math.round(r.height) + ' "' + (el.textContent || el.getAttribute('aria-label') || '').trim().slice(0, 20) + '"');
  }
  const wide = [];
  for (const el of document.querySelectorAll('body *')) { const r = el.getBoundingClientRect(); if (r.right > window.innerWidth + 1 && vis(el) && !el.closest('.table-wrap, .bubbles')) wide.push(el.tagName.toLowerCase() + '.' + el.className + ' right=' + Math.round(r.right)); }
  return { overflow: document.documentElement.scrollWidth - window.innerWidth, small, wide: wide.slice(0, 5), side: getComputedStyle(document.querySelector('#side')).display, cols: getComputedStyle(document.querySelector('.layout')).gridTemplateColumns };
};
const lum = (rgb) => { const [r, g, b] = rgb.map((v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); }); return 0.2126 * r + 0.7152 * g + 0.0722 * b; };
const parse = (c) => { const m = /rgba?\(([\d.]+),\s*([\d.]+),\s*([\d.]+)(?:,\s*([\d.]+))?\)/.exec(c); return m ? [Number(m[1]), Number(m[2]), Number(m[3]), m[4] === undefined ? 1 : Number(m[4])] : null; };
const ratio = (a, b) => { const la = lum(a), lb = lum(b); return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05); };

describe('Social in a browser, layout, access and themes', { skip: pw ? false : 'playwright is not installed' }, () => {
  let env;
  before(async () => { env = await setup(); });
  after(async () => { await env.close(); });
  const o = (path, scenario, opts) => open(env, env.chromium, path, scenario, opts);

  const ROUTES = [['home', '/', world], ['own page', '/@' + H.label(1), world], ['a person', '/@' + H.label(2), world], ['a post', '/@' + H.label(2) + '/p/' + BO_POST, world], ['settings list', '/settings', world],
    ['settings profile', '/settings/profile', world], ['settings privacy', '/settings/privacy', world], ['settings visibility', '/settings/visibility', world], ['settings invite', '/settings/invite', world],
    ['settings storage', '/settings/storage', world], ['messages', '/messages', world], ['alerts', '/notifications', world], ['media', '/media', world], ['viewer', '/media/m1', world], ['about', '/about', world],
    ['not found', '/no/such/page', world], ['a guest on a page', '/', guest]];
  for (const width of [320, 390, 1024]) {
    it('at ' + width + ' CSS px: no sideways scroll, every control 44 px, ' + (width >= 1024 ? 'two columns' : 'one column'), async () => {
      const { context, page, problems } = await o('/', world(), { width, height: 900 });
      const failures = [];
      for (const [name, path, build] of ROUTES) {
        if (build === guest) { await page.evaluate(() => {}); }
        const r = build === guest ? await o(path, build(), { width, height: 900 }) : null;
        const pg = r ? r.page : page;
        if (!r) await go(pg, path);
        await pg.waitForTimeout(350);
        const a = await pg.evaluate(AUDIT);
        if (a.overflow > 0) failures.push(name + ': scrolls sideways by ' + a.overflow + ' px ' + JSON.stringify(a.wide));
        if (a.small.length) failures.push(name + ': small targets ' + JSON.stringify(a.small.slice(0, 6)));
        if (name === 'home') {
          if (width >= 1024) { if (a.side === 'none') failures.push('home: the side column is missing at ' + width); if (a.cols.split(' ').length !== 2) failures.push('home: expected two columns, got ' + a.cols); } else if (a.side !== 'none') failures.push('home: the side column should be hidden at ' + width);
        }
        if (r) await r.context.close();
      }
      assert.deepEqual(failures, []);
      assert.deepEqual(problems, []);
      await context.close();
    });
  }

  it('keyboard only: skip link, tab to the composer, type, tab to Post and press Enter; focus is visible and moves to the heading on a new page', async () => {
    const { context, page, problems } = await o('/', world());
    await waitFor(page, () => document.querySelector('[data-composer="post"] textarea') && document.querySelectorAll('#feed article').length >= 2);
    await page.keyboard.press('Tab');
    assert.equal(await page.evaluate(() => document.activeElement.className), 'skip', 'the first stop is the skip link');
    await page.keyboard.press('Enter');
    assert.equal(await page.evaluate(() => document.activeElement.id || location.hash), 'main' === (await page.evaluate(() => document.activeElement.id)) ? 'main' : await page.evaluate(() => location.hash));
    let found = false;
    const trace = [];
    for (let i = 0; i < 40 && !found; i++) {
      await page.keyboard.press('Tab');
      const at = await page.evaluate(() => { const a = document.activeElement; return (a ? a.tagName + '#' + a.id + '.' + String(a.className).slice(0, 12) : 'nothing') + (document.hasFocus() ? '' : ' (page without focus)'); });
      trace.push(at);
      found = await page.evaluate(() => document.activeElement.matches('[data-composer="post"] textarea'));
    }
    assert.ok(found, 'the composer is reachable with Tab; the stops were ' + trace.join(' > '));
    const outline = await page.evaluate(() => { const cs = getComputedStyle(document.activeElement); return [cs.outlineStyle, parseFloat(cs.outlineWidth)]; });
    assert.equal(outline[0], 'solid');
    assert.ok(outline[1] >= 2, 'a visible focus ring of at least 2 px');
    await page.keyboard.type('typed with the keyboard');
    let atPost = false;
    for (let i = 0; i < 6 && !atPost; i++) { await page.keyboard.press('Tab'); atPost = await page.evaluate(() => document.activeElement.matches('[data-composer="post"] button[type="submit"]')); }
    assert.ok(atPost, 'Tab reaches Post');
    await page.keyboard.press('Enter');
    await waitFor(page, () => document.querySelector('#feed article .post-body').textContent === 'typed with the keyboard');
    // A new page moves focus to its heading and announces it.
    await page.focus('#main-nav a[data-nav="about"]');
    await page.keyboard.press('Enter');
    await waitFor(page, () => location.pathname === '/about' && document.activeElement.id === 'view-title');
    assert.equal(await page.evaluate(() => document.activeElement.id), 'view-title');
    await waitFor(page, () => document.querySelector('#live-polite').textContent === 'About');
    assert.deepEqual(problems, []);
    await context.close();
  });

  it('a dialog traps focus and Escape closes it and returns focus to the button that opened it', async () => {
    const { context, page, problems } = await o('/', world());
    await waitFor(page, () => document.querySelectorAll('#feed article').length >= 2);
    const card = page.locator('#feed article', { hasText: 'Cy says hi' });
    await card.locator('.menu summary').click();
    await card.locator('[data-act="report"]').focus();
    await page.keyboard.press('Enter');
    await page.waitForSelector('dialog[open]');
    assert.equal(await page.evaluate(() => document.querySelector('dialog').contains(document.activeElement)), true, 'focus is inside the dialog');
    for (let i = 0; i < 8; i++) { await page.keyboard.press('Tab'); assert.equal(await page.evaluate(() => document.querySelector('dialog').contains(document.activeElement) || document.activeElement === document.body), true, 'Tab never lands on the page behind the dialog'); }
    await page.keyboard.press('Escape');
    await waitFor(page, () => !document.querySelector('dialog'));
    assert.equal(await page.evaluate(() => document.activeElement.tagName + ' ' + document.activeElement.textContent), 'SUMMARY More', 'focus returns to the menu button that led to the dialog');
    assert.deepEqual(problems, []);
    await context.close();
  });

  it('structure: landmarks, one h1, live regions, current page in the nav, names on every control, alt on every image', async () => {
    const { context, page, problems } = await o('/', world());
    await waitFor(page, () => document.querySelectorAll('#feed article').length >= 2);
    const s = await page.evaluate(() => {
      const named = (el) => !!((el.getAttribute('aria-label') || '').trim() || (el.textContent || '').trim() || (el.id && document.querySelector('label[for="' + el.id + '"]')) || el.closest('label') || el.getAttribute('aria-labelledby'));
      return {
        h1: document.querySelectorAll('h1').length, lang: document.documentElement.lang, banner: !!document.querySelector('header'), nav: document.querySelector('nav').getAttribute('aria-label'),
        main: document.querySelectorAll('main').length, footer: !!document.querySelector('footer'), skip: document.querySelector('.skip').getAttribute('href'),
        polite: document.querySelector('#live-polite').getAttribute('aria-live'), assertive: document.querySelector('#live-assertive').getAttribute('role'),
        current: Array.from(document.querySelectorAll('#main-nav [aria-current="page"]')).map((a) => a.dataset.nav),
        unnamed: Array.from(document.querySelectorAll('button, a[href], input, select, textarea, summary')).filter((e) => !e.closest('[hidden]') && !named(e)).map((e) => e.outerHTML.slice(0, 80)),
        noAlt: Array.from(document.querySelectorAll('img')).filter((i) => !i.hasAttribute('alt')).length, article: document.querySelectorAll('#feed article').length,
        untyped: Array.from(document.querySelectorAll('button:not([type])')).length, viewport: document.querySelector('meta[name="viewport"]').content,
      };
    });
    assert.deepEqual([s.h1, s.lang, s.banner, s.nav, s.main, s.footer, s.skip, s.polite, s.assertive], [1, 'en', true, 'Main', 1, true, '#main', 'polite', 'alert']);
    assert.deepEqual(s.current, ['home']);
    assert.deepEqual(s.unnamed, []);
    assert.equal(s.noAlt, 0);
    assert.equal(s.untyped, 0);
    assert.match(s.viewport, /viewport-fit=cover/);
    assert.deepEqual(problems, []);
    await context.close();
  });

  it('themes: automatic follows the device, the toggle cycles and is remembered, a manual choice beats the device', async () => {
    const BG = { light: 'rgb(244, 246, 248)', dark: 'rgb(15, 20, 26)' };
    let r = await o('/about', world(), { context: { colorScheme: 'dark' } });
    assert.equal(await r.page.evaluate(() => getComputedStyle(document.body).backgroundColor), BG.dark, 'automatic + dark device');
    assert.equal(await text(r.page, '#theme-toggle'), 'Theme: auto');
    await r.page.click('#theme-toggle');
    assert.equal(await text(r.page, '#theme-toggle'), 'Theme: light');
    assert.equal(await r.page.evaluate(() => getComputedStyle(document.body).backgroundColor), BG.light, 'a manual light beats a dark device');
    await r.page.reload();
    await r.page.waitForSelector('#view .card');
    assert.equal(await r.page.evaluate(() => document.documentElement.getAttribute('data-theme')), 'light', 'remembered across a reload');
    await r.page.click('#theme-toggle');
    assert.equal(await text(r.page, '#theme-toggle'), 'Theme: dark');
    await r.page.click('#theme-toggle');
    assert.equal(await text(r.page, '#theme-toggle'), 'Theme: auto');
    assert.equal(await r.page.evaluate(() => document.documentElement.hasAttribute('data-theme')), false);
    assert.match(await r.page.getAttribute('#theme-toggle', 'aria-label'), /^Colour theme: automatic\. Tap to change\.$/);
    await r.context.close();
    r = await o('/about', world(), { context: { colorScheme: 'light' } });
    assert.equal(await r.page.evaluate(() => getComputedStyle(document.body).backgroundColor), BG.light);
    await r.page.evaluate(() => localStorage.setItem('social.theme', '"dark"'));
    await r.page.reload(); await r.page.waitForSelector('#view .card');
    assert.equal(await r.page.evaluate(() => getComputedStyle(document.body).backgroundColor), BG.dark, 'a manual dark beats a light device');
    await r.context.close();
  });

  it('reduced motion: transitions and animations are switched off when the device asks', async () => {
    const calm = await o('/', world(), { context: { reducedMotion: 'reduce' } });
    assert.equal(await calm.page.evaluate(() => getComputedStyle(document.querySelector('.btn')).transitionProperty), 'none');
    assert.equal(await calm.page.evaluate(() => getComputedStyle(document.querySelector('.btn')).animationName), 'none');
    await calm.context.close();
    const normal = await o('/', world(), { context: { reducedMotion: 'no-preference' } });
    assert.notEqual(await normal.page.evaluate(() => getComputedStyle(document.querySelector('.btn')).transitionProperty), 'none');
    await normal.context.close();
  });

  for (const theme of ['light', 'dark']) {
    it('contrast in the ' + theme + ' theme: every colour pair the page uses is at least 4.5 : 1 (WCAG 2.2 AA)', async () => {
      const { context, page } = await o('/', world(), { context: { colorScheme: theme } });
      await waitFor(page, () => document.querySelectorAll('#feed article').length >= 2);
      await page.evaluate((t) => { localStorage.setItem('social.theme', JSON.stringify(t)); }, theme);
      await page.reload(); await page.waitForSelector('#feed article');
      const pairs = await page.evaluate(() => {
        const bgOf = (el) => { for (let e = el; e; e = e.parentElement) { const c = getComputedStyle(e).backgroundColor; if (c && c !== 'rgba(0, 0, 0, 0)' && c !== 'transparent') return c; } return getComputedStyle(document.body).backgroundColor; };
        const add = (name, el) => ({ name, fg: getComputedStyle(el).color, bg: bgOf(el) });
        const mk = (cls, parent, tag = 'span') => { const e = document.createElement(tag); e.className = cls; e.textContent = 'x'; (parent || document.body).append(e); return e; };
        const card = document.querySelector('.card'), out = [];
        out.push(add('heading on the page', document.querySelector('#view-title')), add('text on a card', card.querySelector('label') || card), add('post text', document.querySelector('.post-body')));
        out.push(add('muted on a card', document.querySelector('.short')), add('small muted', document.querySelector('.react-note') || mk('small muted', card)));
        out.push(add('link on a card', document.querySelector('.post-body a') || (() => { const a = document.createElement('a'); a.href = '/x'; a.textContent = 'x'; card.append(a); return a; })()));
        out.push(add('primary button', document.querySelector('.btn.primary')), add('plain button', document.querySelector('.btn:not(.primary):not(.danger):not(.ghost)')), add('danger button', document.querySelector('.btn.danger') || mk('btn danger', card, 'button')));
        out.push(add('pressed tab', document.querySelector('.tab[aria-pressed="true"]')), add('nav link', document.querySelector('#main-nav a:not([aria-current])')), add('current nav link', document.querySelector('#main-nav a[aria-current="page"]')));
        out.push(add('count badge', document.querySelector('#alerts-count') || mk('count', document.querySelector('#main-nav a'))), add('error text', mk('error', card, 'p')), add('badge', mk('badge', card)), add('warning badge', mk('badge warn', card)));
        out.push(add('notice', mk('notice', card, 'div')), add('toast', mk('toast', document.querySelector('#toasts'), 'div')), add('error toast', mk('toast error', document.querySelector('#toasts'), 'div')));
        out.push(add('input text', document.querySelector('textarea')), add('muted placeholder-like hint', mk('hint', card)));
        return out;
      });
      const low = [];
      for (const p of pairs) { const fg = parse(p.fg), bg = parse(p.bg); if (!fg || !bg) { low.push(p.name + ': cannot read ' + p.fg + ' on ' + p.bg); continue; } const r = ratio(fg.slice(0, 3), bg.slice(0, 3)); if (r < 4.5) low.push(p.name + ' ' + r.toFixed(2) + ':1 (' + p.fg + ' on ' + p.bg + ')'); }
      assert.deepEqual(low, []);
      await context.close();
    });
  }

  it('JavaScript off shows only the notice; a plain static host shows the About page and says what is missing; nothing leaves loopback', async () => {
    const off = await o('/', null, { context: { javaScriptEnabled: false }, noWait: true });
    assert.equal(await off.page.locator('noscript').first().innerText(), STATE.noscript);
    assert.equal(STATE.noscript, "This site loads from other visitors' browsers and needs JavaScript.");
    assert.equal(await count(off.page, '#feed'), 0, 'nothing of the social content is readable');
    await off.context.close();
    const plain = await o('/about', null, { blockSdk: true });
    assert.equal(await plain.page.locator('#standalone').isVisible(), true);
    assert.equal(await text(plain.page, '#standalone-why'), 'The loader SDK at /_mw/sdk.js is not served here.');
    assert.equal(await count(plain.page, '.ceiling tbody tr'), 8);
    assert.deepEqual(await plain.page.$$eval('.ceiling tbody th', (n) => n.map((x) => x.textContent)), [
      'Chronological feed of people you follow', 'Ranked or algorithmic feed, trending', 'Search across everyone', 'Replies and mentions from people you do not follow when you are offline',
      'Global follower counts, like counts', 'Spam fighting across the hub', 'Push notifications when the page is closed', 'Durability for phone-only members']);
    assert.ok((await body(plain.page)).includes(PRIVACY.whatOthersSee));
    assert.match(await text(plain.page, '#about-follow-cap'), /^You can follow up to 250 people on a phone and 1,000 on a computer\. This device: 1,000 \(a chosen limit/);
    await go(plain.page, '/');
    await plain.page.waitForSelector('#view .state');
    assert.equal(await text(plain.page, '#view .state p'), STATE.standalone);
    assert.deepEqual(plain.problems, []);
    await plain.context.close();
    // Nothing but 127.0.0.1 was asked for while a member used the app.
    const { context, page } = await o('/', world());
    const hosts = new Set();
    page.on('request', (rq) => { try { hosts.add(new URL(rq.url()).hostname); } catch (e) { /* data: urls */ } });
    for (const p of ['/', '/@' + H.label(2), '/settings/invite', '/media', '/about', '/messages']) await go(page, p);
    assert.deepEqual(Array.from(hosts).filter((h) => h && h !== '127.0.0.1'), []);
    await context.close();
  });

  it('WebKit lays the page out without sideways scroll at 390 px', async (t) => {
    if (!env.webkit) return t.skip('WebKit is not installed for Playwright');
    const { context, page } = await open(env, env.webkit, '/', world(), { width: 390, height: 844 });
    for (const p of ['/', '/settings/invite', '/@' + H.label(2), '/about']) {
      await go(page, p); await page.waitForTimeout(300);
      const a = await page.evaluate(AUDIT);
      assert.equal(a.overflow <= 0, true, p + ' scrolls sideways by ' + a.overflow);
    }
    await context.close();
  });
});
