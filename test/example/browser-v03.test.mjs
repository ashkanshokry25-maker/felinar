// Browser tests for the v0.3 pages of examples/peer-guestbook/ (V03-DESIGN-REVIEW 3.9): the guest and signed-in states, Sign in and Sign out,
// posting as a guest, the profile page (private record, recovery kit and device links, sign out) and the members area (chat Lobby and public
// file listings, both off by default). Playwright with the repository's local-only Chromium flags, plus WebKit on 127.0.0.1; the SDK is
// test/example/mock-sdk.js with a v0.3 scenario (auth: 'guest' | 'signed-in'). ASCII only.
// Run: node --test test/example/browser-v03.test.mjs   (skips when playwright is not installed)
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { startSiteServer } from './serve.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const SITE = process.env.MW_EXAMPLE_DIR ? resolve(process.env.MW_EXAMPLE_DIR) : resolve(HERE, '../../examples/peer-guestbook');
const { chromiumArgs } = await import(pathToFileURL(resolve(HERE, '../e2e/browser-args.mjs')).href);
const loaderStrings = await import(pathToFileURL(resolve(HERE, '../../src/loader/strings.js')).href);
let pw = null;
try { pw = await import('playwright'); } catch (err) { pw = null; }

// Deterministic fake keys, tagged as the v0.3 loader writes them.
function fakePub(seed) {
  const bytes = [4];
  for (let i = 1; i < 65; i++) bytes.push((seed * 131 + i * 17) & 255);
  return 'p256:' + Buffer.from(bytes).toString('base64url');
}
const ME = fakePub(1), ALICE = fakePub(2), BOB = fakePub(3), OWNER = fakePub(9);
// The guestbook's short id: the first 8 hex of sha256 over the raw key, without the 'p256:' tag (examples/peer-guestbook/js/common.js shortId).
const shortOf = (pub) => createHash('sha256').update(Buffer.from(pub.slice(pub.indexOf(':') + 1), 'base64url')).digest('hex').slice(0, 8);
const POSTS = [
  { author: ALICE, name: 'Alice', msg: 'Hello from Alice' },
  { author: BOB, msg: 'Bob was here' },
  { author: OWNER, name: 'Site owner', msg: 'Welcome, from the owner' },
];
const OPEN = { writers: 'open', bits: 16, maxValueBytes: 2048, moderators: [], banned: [] };
const base = (extra = {}) => Object.assign({ auth: 'guest', role: 'writer', owner: OWNER, height: 5, peers: 2, inSync: 2, posts: POSTS, policy: OPEN, short: 'cafe0001' }, extra);
const signedIn = (extra = {}) => base(Object.assign({ auth: 'signed-in', name: 'Ada' }, extra));
const FEATURES_OFF = { chat: false, files: false, media: false, records: false, requests: false };
const GUEST_NOTE = 'You are browsing as a guest. Posting asks you to sign in first.';
const CARD = loaderStrings.CARD_TEXT.en, REPLACED = loaderStrings.REPLACED_SENTENCES.en, ERR = loaderStrings.ERROR_TEXT.en;

describe('Peer Guestbook v0.3 in a browser', { skip: pw ? false : 'playwright is not installed' }, () => {
  let srv, chromium, webkit;
  before(async () => {
    srv = await startSiteServer({ site: SITE });
    chromium = await pw.chromium.launch({ args: chromiumArgs({ allowRemote: false }) });
    try { webkit = await pw.webkit.launch(); } catch (err) { webkit = null; }
  });
  after(async () => {
    if (chromium) await chromium.close();
    if (webkit) await webkit.close();
    if (srv) srv.server.close();
  });

  async function open(browser, path, scenario, opts = {}) {
    const context = await browser.newContext(opts.device || { viewport: { width: opts.width || 1024, height: opts.height || 900 } });
    const page = await context.newPage();
    const problems = [];
    page.on('pageerror', (e) => problems.push('pageerror: ' + e.message));
    page.on('console', (m) => { if (m.type() === 'error' && !/Failed to load resource|Importing a module script failed/.test(m.text())) problems.push('console: ' + m.text()); });
    if (scenario) await page.addInitScript((s) => { globalThis.__mwScenario = s; }, scenario);
    if (opts.blockSdk) await page.route('**/_mw/sdk.js', (route) => route.fulfill({ status: 404, contentType: 'text/plain', body: 'no loader here' }));
    const response = await page.goto(srv.base + path);
    return { context, page, problems, response };
  }
  const text = (page, sel) => page.locator(sel).first().textContent();
  const count = (page, sel) => page.locator(sel).count();
  const shown = (page, sel) => page.$eval(sel, (n) => !n.closest('[hidden]'));
  async function waitText(page, sel, expected, timeout = 5000) {
    try {
      await page.waitForFunction(([s, e]) => { const n = document.querySelector(s); return !!n && n.textContent === e; }, [sel, expected], { timeout });
    } catch (err) {
      assert.equal(await page.$eval(sel, (n) => n.textContent).catch(() => '(no ' + sel + ')'), expected, 'waiting for ' + sel);
    }
  }
  // A predicate that reads a node not drawn yet throws, and waitForFunction would give up at once: run it in a guard so "not yet" is false.
  const waitFor = (page, fn, arg, timeout = 5000) => page.waitForFunction(([src, a]) => {
    try { const r = (0, eval)('(' + src + ')')(a); return r && typeof r.then === 'function' ? r.catch(() => false) : r; } catch (err) { return false; } // eslint-disable-line no-eval
  }, [fn.toString(), arg], { timeout });
  const calls = (page, name) => page.evaluate((n) => __mwMock.calls.filter((c) => c[0] === n), name);
  const callNames = (page) => page.evaluate(() => __mwMock.calls.map((c) => c[0]));
  const tap2 = async (loc) => { await loc.click(); assert.equal(await loc.textContent(), 'Tap again to confirm'); await loc.click(); };

  // ------------------------------------------------------------------------------------------------ the guestbook page
  it('a guest reads the guestbook and sees the Sign in bar; posting asks the guest to sign in first, inside the click', async () => {
    const { context, page, problems } = await open(chromium, '/', base());
    await waitText(page, '#auth-state', 'You are browsing as a guest.');
    assert.equal(await shown(page, '#sign-in'), true);
    assert.equal(await shown(page, '#sign-out'), false);
    assert.equal(await page.evaluate(() => document.documentElement.dataset.auth), 'guest');
    await waitText(page, '#role-badge', 'guest');
    assert.equal(await text(page, '#role-line'), 'Your role on this site: guest.');
    assert.equal(await text(page, '#role-help'), 'You can read this guestbook. Posting asks you to sign in first.');
    await waitText(page, '#post-note', GUEST_NOTE);
    assert.equal(await page.$eval('#post-form fieldset', (f) => f.disabled), false, 'a guest can type: the sign-in comes with the post');
    assert.equal(await text(page, '#me-short'), '-');
    assert.equal(await text(page, '#me-copy'), 'You have no key on this site yet. Signing in gives this site a key that works only here.');
    await waitFor(page, () => document.querySelectorAll('#entries li').length === 3);
    assert.equal(await count(page, '#entries .entry.mine, #entries .act-delete, #entries .act-remove, #entries .act-ban'), 0);
    assert.equal(await shown(page, '#notice-form'), false);

    await page.fill('#msg', 'My first post');
    await page.click('#post-btn');
    await waitText(page, '#entries li:first-child .msg', 'My first post');
    assert.deepEqual((await callNames(page)).filter((n) => n === 'auth.signIn' || n === 'db.append'), ['auth.signIn', 'db.append'], 'sign in first, then the signed entry');
    await waitText(page, '#auth-state', 'Signed in as (cafe0001).');
    assert.equal(await shown(page, '#sign-in'), false);
    assert.equal(await shown(page, '#sign-out'), true);
    await waitText(page, '#role-badge', 'writer');
    await waitText(page, '#post-note', 'Each post is signed in your browser and carries a small proof-of-work fee, so posting takes a moment.');
    assert.equal(await text(page, '#entries li:first-child .tag'), 'you', 'the list is drawn again for the signed-in key');
    assert.equal(await text(page, '#me-short'), 'cafe0001');
    assert.equal(await text(page, '#me-copy'), 'It comes from a key that works only on this site. Your recovery kit and devices are on your profile page.');
    assert.equal(await count(page, '#entries .act-delete'), 1, 'and Delete appears on the visitor\'s own post');
    assert.deepEqual(problems, []);
    await context.close();
  });

  it('the header Sign in and Sign out change the page without a reload, and a sign-in in another window is followed', async () => {
    const { context, page, problems } = await open(chromium, '/', base({ name: 'Ada' }));
    await page.click('#sign-in');
    await waitText(page, '#auth-state', 'Signed in as Ada (cafe0001).');
    assert.equal((await calls(page, 'auth.signIn')).length, 1);
    await waitText(page, '#role-badge', 'writer');
    assert.equal(await page.$eval('#name', (i) => i.value), 'Ada', 'the name field follows who is signed in');
    await page.click('#sign-out');
    await waitText(page, '#auth-state', 'You are browsing as a guest.');
    assert.equal((await calls(page, 'auth.signOut')).length, 1);
    await waitText(page, '#role-badge', 'guest');
    assert.equal(await page.$eval('#name', (i) => i.value), '');
    await page.evaluate(() => __mwMock.setAuth('signed-in')); // another window of the same site signs in
    await waitText(page, '#auth-state', 'Signed in as Ada (cafe0001).');
    await waitText(page, '#role-badge', 'writer');
    assert.deepEqual(problems, []);
    await context.close();
  });

  it('a guest who sets a name signs in first; on an owner-only site a guest is a reader', async () => {
    let r = await open(chromium, '/', base({ name: 'Ada' }));
    await r.page.fill('#name', 'Ada');
    await r.page.click('#name-form button[type="submit"]');
    await waitFor(r.page, () => __mwMock.calls.some((c) => c[0] === 'identity.setName'));
    assert.deepEqual((await callNames(r.page)).filter((n) => n === 'auth.signIn' || n === 'identity.setName'), ['auth.signIn', 'identity.setName']);
    assert.deepEqual(r.problems, []);
    await r.context.close();
    r = await open(chromium, '/', base({ policy: Object.assign({}, OPEN, { writers: 'owner' }) }));
    await waitText(r.page, '#role-badge', 'reader');
    assert.equal(await r.page.$eval('#post-form fieldset', (f) => f.disabled), true);
    assert.equal(await text(r.page, '#post-note'), 'You can read this guestbook, but the owner only lets selected people post here.');
    await r.context.close();
  });

  it('a refused sign-in is told in the SDK\'s words and nothing is posted', async () => {
    // UX-15: a code the guestbook had no sentence for (E_SYNCING) gets the SDK's sentence, and a code nobody knows gets a generic line
    // that names it; the SDK's internal message ('...: E_NO_SUCH_CODE' in the mock) is never shown.
    for (const [code, kind] of [['E_POPUP_BLOCKED', 'error'], ['E_USER_CANCELLED', 'info'], ['E_SYNCING', 'error'], ['E_NO_SUCH_CODE', 'error']]) {
      const { context, page, problems } = await open(chromium, '/', base({ signInError: code }));
      await page.fill('#msg', 'will not be posted');
      await page.click('#post-btn');
      await waitFor(page, () => document.querySelector('.toast'));
      assert.equal(await text(page, '.toast'), ERR[code] || 'Something went wrong (' + code + ').', code);
      assert.equal(await page.$eval('.toast', (n) => n.classList.contains('error')), kind === 'error');
      assert.equal((await calls(page, 'db.append')).length, 0);
      assert.equal(await page.$eval('#msg', (i) => i.value), 'will not be posted', 'the text stays in the box');
      await waitText(page, '#role-badge', 'guest');
      assert.deepEqual(problems, []);
      await context.close();
    }
  });

  it('against a loader without sign-in the bar stays hidden, the guestbook works as before, and the new pages say what is missing', async () => {
    let r = await open(chromium, '/', { role: 'writer', owner: OWNER, posts: POSTS, policy: OPEN });
    await waitText(r.page, '#role-badge', 'writer');
    assert.equal(await shown(r.page, '#auth-bar'), false);
    assert.equal(await text(r.page, '#me-copy'), 'It comes from a signing key that this browser made for this site. The private key stays in this browser unless you export it in the loader\'s Settings.');
    await r.page.fill('#msg', 'old loader');
    await r.page.click('#post-btn');
    await waitText(r.page, '#entries li:first-child .msg', 'old loader');
    assert.deepEqual(r.problems, []);
    await r.context.close();
    r = await open(chromium, '/profile.html', { role: 'writer', policy: OPEN });
    await waitFor(r.page, () => !document.querySelector('#profile-old').hidden);
    assert.equal(await shown(r.page, '#profile-guest'), false);
    assert.equal(await shown(r.page, '#profile-signed'), false);
    await r.context.close();
    r = await open(chromium, '/members.html', { role: 'writer', policy: OPEN });
    await waitFor(r.page, () => !document.querySelector('#members-old').hidden);
    assert.equal(await shown(r.page, '#members-signed'), false);
    await r.context.close();
  });

  it('the new pages without the loader: a notice, no dead sign-in button, and E_NO_HOST in the page\'s own words', async () => {
    for (const path of ['/profile.html', '/members.html']) {
      let r = await open(chromium, path, null, { blockSdk: true });
      await waitFor(r.page, () => !document.querySelector('#standalone').hidden);
      assert.equal(await text(r.page, '#standalone-why'), 'The loader SDK at /_mw/sdk.js is not served here.');
      for (const id of ['#profile-guest', '#profile-signed', '#members-guest', '#members-signed']) {
        const present = await r.page.$(id);
        assert.equal(present ? await shown(r.page, id) : false, false, path + ' ' + id + ' stays hidden without the loader');
      }
      assert.equal(await shown(r.page, '#auth-bar'), false);
      await r.context.close();
      r = await open(chromium, path, { noHost: true, auth: 'guest' });
      await waitFor(r.page, () => !document.querySelector('#standalone').hidden);
      assert.equal(await text(r.page, '#standalone-why'), 'This page is not running inside the felinar loader.');
      await r.context.close();
    }
  });

  // ------------------------------------------------------------------------------------------------ the profile page
  it('profile, guest: only the sign-in card; signing in shows the identity, the record, the recovery card and sign out', async () => {
    const { context, page, problems } = await open(chromium, '/profile.html', base({ name: 'Ada' }));
    await waitFor(page, () => !document.querySelector('#profile-guest').hidden);
    assert.equal(await shown(page, '#profile-signed'), false);
    assert.match(await text(page, '#profile-guest'), /Sign in opens the felinar identity page in its own window\. This site gets a key that works only here\./);
    await page.click('#profile-sign-in');
    await waitFor(page, () => !document.querySelector('#profile-signed').hidden);
    assert.equal(await shown(page, '#profile-guest'), false);
    assert.equal(await text(page, '#pf-name'), 'Ada');
    assert.equal(await text(page, '#pf-short'), 'cafe0001');
    assert.equal(await text(page, '#auth-state'), 'Signed in as Ada (cafe0001).');
    assert.deepEqual(problems, []);
    await context.close();
  });

  it('profile: the private record is encrypted copy, opened on a tap, saved with mw.me.set, validated, and removed with two taps', async () => {
    const sc = signedIn({ me2: { display: 'Ads', links: ['https://example.org/ada'] }, features: Object.assign({}, FEATURES_OFF, { records: true }) });
    const { context, page, problems } = await open(chromium, '/profile.html', sc);
    await waitFor(page, () => !document.querySelector('#profile-signed').hidden);
    assert.equal(await text(page, '#rec-privacy'), REPLACED.profileSealed);
    assert.equal(await text(page, '#rec-readers'), REPLACED.recordReaders);
    assert.equal(await text(page, '#rec-sync-note'), CARD.syncRecord);
    assert.equal((await calls(page, 'me.get')).length, 0, 'the record is not read until the first tap (the first read of a visit opens a card)');
    assert.equal(await page.$eval('#rec-display', (i) => i.value), '');
    await page.click('#rec-load');
    await waitFor(page, () => document.querySelector('#rec-display').value === 'Ads');
    assert.equal(await page.$eval('#rec-link', (i) => i.value), 'https://example.org/ada');
    assert.equal((await calls(page, 'me.get')).length, 1);
    await page.fill('#rec-display', 'Ada the door fan');
    await page.fill('#rec-link', 'http://example.org/not-https');
    await page.click('#rec-save');
    await waitFor(page, () => document.querySelector('.toast.error'));
    assert.equal(await text(page, '.toast.error'), 'The link must be an https link of at most 200 characters.');
    assert.equal((await calls(page, 'me.set')).length, 0, 'an invalid link saves nothing');
    await page.fill('#rec-link', 'https://example.org/ada2');
    await page.click('#rec-save');
    await waitText(page, '#rec-status', 'Saved on this device.');
    assert.deepEqual((await calls(page, 'me.set')).map((c) => [c[1], c[2]]), [['display', 'Ada the door fan'], ['links', ['https://example.org/ada2']]]);
    await page.fill('#rec-display', '');
    await page.fill('#rec-link', '');
    await page.click('#rec-save');
    await waitFor(page, () => __mwMock.calls.filter((c) => c[0] === 'me.del').length === 2);
    assert.deepEqual((await calls(page, 'me.del')).map((c) => c[1]), ['display', 'links'], 'an empty field removes the field');
    await page.fill('#rec-display', 'to be erased');
    await tap2(page.locator('#rec-erase-slot .act-erase'));
    await waitFor(page, () => __mwMock.calls.some((c) => c[0] === 'me.erase'));
    await waitFor(page, () => document.querySelector('#rec-display').value === '');
    await waitFor(page, () => document.querySelector('.toast.ok') && /private data/.test(document.querySelector('.toast.ok').textContent));
    assert.deepEqual(problems, []);
    await context.close();
  });

  it('profile: syncing the record needs the owner\'s switch; a refusal is told in R 2.5.4\'s words and the box is put back', async () => {
    let r = await open(chromium, '/profile.html', signedIn({ features: FEATURES_OFF }));
    await waitFor(r.page, () => !document.querySelector('#profile-signed').hidden);
    assert.equal(await r.page.$eval('#rec-sync', (i) => i.disabled), true);
    assert.equal(await text(r.page, '#rec-sync-note'), 'The owner has not turned on synced records, so your record stays on this device.');
    await r.context.close();
    r = await open(chromium, '/profile.html', signedIn({ features: Object.assign({}, FEATURES_OFF, { records: true }), syncError: 'E_POLICY' }));
    await waitFor(r.page, () => !document.querySelector('#profile-signed').hidden);
    await r.page.click('#rec-sync'); // not check(): the page puts the box back at once
    await waitFor(r.page, () => document.querySelector('.toast.error'));
    assert.equal(await text(r.page, '.toast.error'), 'This site does not let visitors write to its ledger, so your record stays on this device.');
    assert.equal(await r.page.$eval('#rec-sync', (i) => i.checked), false);
    await r.context.close();
    r = await open(chromium, '/profile.html', signedIn({ features: Object.assign({}, FEATURES_OFF, { records: true }), syncError: 'E_POLICY', syncErrorMessage: 'This site has not turned on synced records.' }));
    await waitFor(r.page, () => !document.querySelector('#profile-signed').hidden);
    await r.page.click('#rec-sync');
    await waitFor(r.page, () => document.querySelector('.toast.error'));
    assert.equal(await text(r.page, '.toast.error'), 'This site has not turned on synced records.', 'the loader\'s own reason is shown when it gives one');
    await r.context.close();
    r = await open(chromium, '/profile.html', signedIn({ features: Object.assign({}, FEATURES_OFF, { records: true }), syncedRecord: true }));
    await waitFor(r.page, () => !document.querySelector('#profile-signed').hidden);
    await r.page.check('#rec-sync');
    await waitFor(r.page, () => document.querySelector('.toast.ok'));
    assert.deepEqual((await calls(r.page, 'me.sync')).map((c) => c[1]), [{ on: true }]);
    await r.page.fill('#rec-display', 'x');
    await r.page.click('#rec-save');
    await waitText(r.page, '#rec-status', 'Saved. An encrypted copy is on this site\'s ledger.');
    await r.context.close();
  });

  it('profile: the recovery kit and the device link open the identity page; the status rows come from backupStatus(); the page has no secret field', async () => {
    let r = await open(chromium, '/profile.html', signedIn({ backup: { kitSaved: false, fileSaved: false, passkey: true, persisted: true, legacy: false } }));
    await waitFor(r.page, () => !document.querySelector('#profile-signed').hidden);
    await waitText(r.page, '#bk-kit', 'Not yet');
    assert.equal(await text(r.page, '#bk-file'), 'Not yet');
    assert.equal(await text(r.page, '#bk-passkey'), 'Yes');
    assert.equal(await text(r.page, '#bk-persisted'), 'Yes');
    assert.equal(await shown(r.page, '#bk-legacy'), false);
    assert.equal(await text(r.page, '#bk-ios'), CARD.recoveryKitIos);
    assert.equal(await shown(r.page, '#bk-ios'), true);
    assert.match(await text(r.page, '#recovery-card p'), new RegExp(CARD.neverWords.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    await r.page.evaluate(() => { __mwMock.scenario.backup = { kitSaved: true, fileSaved: true, passkey: false, persisted: false, legacy: true }; });
    await r.page.click('#open-kit');
    await waitText(r.page, '#bk-kit', 'Yes');
    await r.page.click('#open-link');
    await waitFor(r.page, () => __mwMock.calls.filter((c) => c[0] === 'identity.openIdentity').length === 2);
    assert.equal(await text(r.page, '#bk-persisted'), 'Not yet');
    assert.equal(await shown(r.page, '#bk-legacy'), true);
    assert.equal(await shown(r.page, '#bk-ios'), false, 'the Home Screen advice goes away once the kit is saved');
    // E-ID-10: a phrase, a password or a backup file is typed only on the identity page.
    const fields = await r.page.$$eval('input, textarea, select', (n) => n.map((x) => [x.tagName, x.type, x.id, x.name]));
    for (const [tag, type, id, name] of fields) {
      assert.ok(['text', 'url', 'checkbox', 'textarea', 'select-one'].includes(type), 'field type ' + type);
      assert.doesNotMatch([id, name].join(' '), /phrase|words|passphrase|password|backup|recovery|mnemonic/i, tag + ' ' + id);
    }
    assert.deepEqual(r.problems, []);
    await r.context.close();
  });

  it('profile: Sign out deletes this site\'s keys; Remove from this device is the stronger form; nothing private stays in the page', async () => {
    const { context, page, problems } = await open(chromium, '/profile.html', signedIn({ me2: { display: 'Ads' } }));
    await waitFor(page, () => !document.querySelector('#profile-signed').hidden);
    assert.equal(await text(page, '#signout-card p'), 'Sign out deletes this site\'s keys from this browser. Signing in again takes one tap.');
    await page.click('#rec-load');
    await waitFor(page, () => document.querySelector('#rec-display').value === 'Ads');
    await page.click('#pf-sign-out');
    await waitFor(page, () => !document.querySelector('#profile-guest').hidden);
    assert.equal(await shown(page, '#profile-signed'), false);
    assert.equal(await page.$eval('#rec-display', (i) => i.value), '', 'the record is cleared from the page on sign out');
    const outs = await calls(page, 'auth.signOut');
    assert.equal(outs.length, 1);
    assert.ok(!outs[0][1] || outs[0][1].forget !== true, 'a plain sign out does not forget the device');
    await page.click('#profile-sign-in');
    await waitFor(page, () => !document.querySelector('#profile-signed').hidden);
    await page.click('#pf-forget');
    await waitFor(page, () => __mwMock.calls.filter((c) => c[0] === 'auth.signOut').length === 2);
    assert.deepEqual((await calls(page, 'auth.signOut'))[1][1], { forget: true });
    assert.deepEqual(problems, []);
    await context.close();
  });

  // ------------------------------------------------------------------------------------------------ the members area
  it('members: a guest is asked to sign in; off by default - without the owner\'s switches nothing is asked of the loader', async () => {
    let r = await open(chromium, '/members.html', base({ features: FEATURES_OFF }));
    await waitFor(r.page, () => !document.querySelector('#members-guest').hidden);
    assert.equal(await shown(r.page, '#members-signed'), false);
    await r.page.click('#members-sign-in');
    await waitFor(r.page, () => !document.querySelector('#members-signed').hidden);
    await waitText(r.page, '#chat-status', 'Messages are off on this site. The owner has not turned them on.');
    await waitText(r.page, '#files-status', 'File listings are off on this site. The owner has not turned them on.');
    assert.equal(await shown(r.page, '#chat-enable'), false);
    assert.equal(await shown(r.page, '#lobby'), false);
    assert.equal(await shown(r.page, '#files-on'), false);
    const names = await callNames(r.page);
    assert.ok(!names.some((n) => /^(chat|files)\./.test(n)), 'no chat or files call while both are off: ' + names.join());
    assert.match(await text(r.page, '#members-intro'), /They stay off until the site owner turns them on\./);
    assert.match(await text(r.page, '#members-intro details'), /ledger-admin cfg --chat members --files members/);
    assert.deepEqual(r.problems, []);
    await r.context.close();
  });

  it('members, chat: Turn on chat (a card), join the Lobby, send and receive; text from others is text; refusals are told in words', async () => {
    const sc = signedIn({ features: Object.assign({}, FEATURES_OFF, { chat: true }), chat: { enabled: false } });
    const { context, page, problems } = await open(chromium, '/members.html', sc);
    await waitText(page, '#chat-status', 'Messages are off for you. Turn on chat to talk with other members.');
    assert.equal(await text(page, '#chat-enable'), 'Turn on chat');
    assert.match(await text(page, '#chat-consent'), /They see your IP address and when you are active\./);
    assert.equal((await calls(page, 'chat.enable')).length, 0, 'nothing connects before the tap');
    await page.click('#chat-enable');
    await waitText(page, '#chat-status', 'Chat is on. You are in the Lobby.');
    assert.equal(await shown(page, '#lobby'), true);
    assert.equal(await shown(page, '#chat-enable'), false);
    assert.equal(await text(page, '#lobby-note'), CARD.rooms, 'the sentence comes from the join answer');
    assert.equal(await text(page, '#lobby-empty'), 'No messages yet.');
    const evil = '<img src=x onerror="window.__xss=1">hello & bye';
    await page.fill('#lobby-msg', evil);
    await page.click('#lobby-send');
    await waitFor(page, () => document.querySelectorAll('#lobby-log li').length === 1);
    assert.deepEqual((await calls(page, 'chat.room.send')).map((c) => [c[1], c[2]]), [['Lobby', { text: evil }]]);
    assert.equal(await text(page, '#lobby-log li .msg'), evil, 'the loader does not echo a room message to its sender, so the page shows it once');
    assert.equal(await text(page, '#lobby-log li .who'), 'Ada (cafe0001)', 'UX-16: the short id stands beside a chosen name');
    assert.equal(await page.$eval('#lobby-log li', (li) => li.classList.contains('mine')), true);
    assert.equal(await shown(page, '#lobby-empty'), false);
    assert.equal(await page.$eval('#lobby-msg', (i) => i.value), '');
    await page.evaluate((m) => __mwMock.roomReceive(m), { room: 'Lobby', from: ALICE, text: '<b>hi</b> from Alice' });
    await page.evaluate((m) => __mwMock.roomReceive(m), { room: 'Elsewhere', from: BOB, text: 'another room is ignored' });
    await waitFor(page, () => document.querySelectorAll('#lobby-log li').length === 2);
    assert.equal(await text(page, '#lobby-log li:last-child .msg'), '<b>hi</b> from Alice');
    assert.equal(await text(page, '#lobby-log li:last-child .who'), 'Alice (' + shortOf(ALICE) + ')', 'the name comes from the ledger profiles, the short id from the key');
    assert.equal(await count(page, '#lobby-log img, #lobby-log b'), 0);
    assert.equal(await page.evaluate(() => typeof window.__xss), 'undefined');
    assert.deepEqual(problems, []);
    await context.close();
  });

  it('members, chat: already on when the page opens, and the loader\'s refusals (no tracker of the site\'s own, host only) are shown in the SDK\'s words', async () => {
    let r = await open(chromium, '/members.html', signedIn({ features: Object.assign({}, FEATURES_OFF, { chat: true }), chat: { enabled: true } }));
    await waitText(r.page, '#chat-status', 'Chat is on. You are in the Lobby.');
    assert.equal(await shown(r.page, '#chat-enable'), false);
    assert.equal((await calls(r.page, 'chat.room.join')).length, 1);
    await r.context.close();
    for (const code of ['E_NO_OWN_TRACKER', 'E_HOST_ONLY']) {
      r = await open(chromium, '/members.html', signedIn({ features: Object.assign({}, FEATURES_OFF, { chat: true }), chat: { enabled: false, enableError: code } }));
      await waitFor(r.page, () => !document.querySelector('#chat-enable').hidden);
      await r.page.click('#chat-enable');
      await waitFor(r.page, () => document.querySelector('.toast.error'));
      assert.equal(await text(r.page, '.toast.error'), ERR[code]);
      assert.equal(await shown(r.page, '#lobby'), false);
      assert.equal(await shown(r.page, '#chat-enable'), true, 'the button stays so the member can try again');
      await r.context.close();
    }
  });

  it('members, files: listings only when the owner turned them on; Fetch comes first, then Show and Save; sharing and removing', async () => {
    const list = [
      { ref: 'r1', name: 'door.jpg', ext: 'jpg', len: 3000, mime: 'image/jpeg', mine: false, fetched: false },
      { ref: 'r2', name: 'notes.txt', ext: 'txt', len: 120, mime: 'text/plain', mine: false, fetched: true },
      { ref: 'r3', name: 'mine.png', ext: 'png', len: 800, mime: 'image/png', mine: true, fetched: true },
    ];
    const sc = signedIn({ features: Object.assign({}, FEATURES_OFF, { files: true }), fileList: list });
    const { context, page, problems } = await open(chromium, '/members.html', sc);
    await waitText(page, '#files-status', 'File listings are on. Files are public on this site.');
    await waitFor(page, () => document.querySelectorAll('#file-list li').length === 3);
    assert.equal(await shown(page, '#file-empty'), false);
    assert.equal(await text(page, '#file-fetch-note'), CARD.fetchPublic);
    assert.equal(await shown(page, '#file-fetch-note'), true);
    assert.equal(await text(page, '#chat-status'), 'Messages are off on this site. The owner has not turned them on.');
    // Nothing is fetched or previewed before a tap, and a listing that was not fetched offers only Fetch.
    assert.equal((await calls(page, 'files.fetch')).length + (await calls(page, 'files.preview')).length, 0);
    const row = (ref) => page.locator('#file-list li[data-ref="' + ref + '"]');
    assert.deepEqual(await row('r1').locator('.actions button').allTextContents(), ['Fetch']);
    assert.deepEqual(await row('r2').locator('.actions button').allTextContents(), ['Show', 'Save']);
    assert.deepEqual(await row('r3').locator('.actions button').allTextContents(), ['Show', 'Save', 'Remove']);
    assert.match(await row('r1').locator('.small').textContent(), /image\/jpeg, not fetched/);
    await row('r1').locator('.actions button').click();
    await waitFor(page, () => document.querySelector('#file-list li[data-ref="r1"] .actions button') && document.querySelector('#file-list li[data-ref="r1"] .actions button').textContent === 'Show');
    assert.deepEqual(await row('r1').locator('.actions button').allTextContents(), ['Show', 'Save']);
    await row('r1').locator('.actions button', { hasText: 'Show' }).click();
    await waitFor(page, () => document.querySelector('#file-list li[data-ref="r1"] .preview img'));
    assert.equal(await row('r1').locator('.preview img').getAttribute('alt'), 'Shared picture: door.jpg');
    const order = (await callNames(page)).filter((n) => n === 'files.fetch' || n === 'files.preview');
    assert.deepEqual(order, ['files.fetch', 'files.preview'], 'a file is fetched before it is previewed');
    await row('r2').locator('.actions button', { hasText: 'Show' }).click();
    await waitFor(page, () => document.querySelector('#file-list li[data-ref="r2"] .preview pre'));
    assert.equal(await row('r2').locator('.preview pre').textContent(), 'Plain text from a member');
    await row('r2').locator('.actions button', { hasText: 'Save' }).click();
    await waitFor(page, () => __mwMock.calls.some((c) => c[0] === 'files.save' && c[1] === 'r2'));
    // Share a picture of your own: the loader's card (strip, list) is the mock's share; the list refreshes.
    await page.setInputFiles('#file-input', { name: 'new.png', mimeType: 'image/png', buffer: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64') });
    await page.click('#file-share');
    await waitFor(page, () => document.querySelectorAll('#file-list li').length === 4);
    assert.deepEqual((await calls(page, 'files.share')).map((c) => [c[1], c[2]]), [['new.png', { public: true }]]);
    await tap2(page.locator('#file-list li[data-ref="r3"] .act-remove'));
    await waitFor(page, () => document.querySelectorAll('#file-list li').length === 3);
    assert.ok((await calls(page, 'files.remove')).some((c) => c[1] === 'r3'));
    assert.deepEqual(problems, []);
    await context.close();
  });

  it('members, files: the fetch note is for sharing visitors only; an empty list, a refusal and an unavailable file are told in words', async () => {
    let r = await open(chromium, '/members.html', signedIn({ features: Object.assign({}, FEATURES_OFF, { files: true }), consent: 'host-only', fileList: [] }));
    await waitText(r.page, '#files-status', 'File listings are on. Files are public on this site.');
    assert.equal(await shown(r.page, '#file-fetch-note'), false, 'host only: nothing is shared with others');
    assert.equal(await shown(r.page, '#file-empty'), true);
    await r.page.click('#file-share');
    await waitFor(r.page, () => document.querySelector('.toast.info'));
    assert.equal(await text(r.page, '.toast.info'), 'Choose a file first.');
    await r.context.close();
    r = await open(chromium, '/members.html', signedIn({ features: Object.assign({}, FEATURES_OFF, { files: true }), shareError: 'E_MEDIA_STRIP', fetchError: 'E_FILE_UNAVAILABLE',
      fileList: [{ ref: 'r1', name: 'door.jpg', ext: 'jpg', len: 3000, mime: 'image/jpeg', mine: false, fetched: false }] }));
    await waitFor(r.page, () => document.querySelectorAll('#file-list li').length === 1);
    await r.page.locator('#file-list li .actions button').click();
    await waitFor(r.page, () => document.querySelector('#file-list li .preview p'));
    assert.equal(await text(r.page, '#file-list li .preview p'), ERR.E_FILE_UNAVAILABLE);
    assert.deepEqual(await r.page.locator('#file-list li .actions button').allTextContents(), ['Fetch'], 'the button comes back so the member can try again');
    await r.page.setInputFiles('#file-input', { name: 'x.png', mimeType: 'image/png', buffer: Buffer.from('x') });
    await r.page.click('#file-share');
    await waitFor(r.page, () => document.querySelector('.toast.error'));
    assert.equal(await text(r.page, '.toast.error'), ERR.E_MEDIA_STRIP);
    assert.deepEqual(r.problems, []);
    await r.context.close();
  });

  // ------------------------------------------------------------------------------------------------ layout and structure
  for (const width of [320, 390, 1024]) {
    it('every page lays out at ' + width + ' CSS px without sideways scroll, with 44 px targets, guest and signed in', async () => {
      for (const [path, scenario] of [['/', signedIn()], ['/about.html', base()], ['/profile.html', signedIn({ me2: { display: 'Ads' } })], ['/members.html', signedIn({ features: { chat: true, files: true, media: false, records: true, requests: false }, chat: { enabled: true },
        fileList: [{ ref: 'r1', name: 'a-very-long-file-name-that-keeps-going-and-going-for-a-while.jpg', ext: 'jpg', len: 3000, mime: 'image/jpeg', mine: true, fetched: true }] })], ['/profile.html', base()], ['/members.html', base()]]) {
        const { context, page, problems } = await open(chromium, path, scenario, { width });
        await waitFor(page, () => document.querySelector('#auth-bar') && !document.querySelector('#auth-bar').hidden);
        await page.waitForTimeout(150);
        const m = await page.evaluate(() => ({
          scroll: document.documentElement.scrollWidth, inner: window.innerWidth,
          small: Array.from(document.querySelectorAll('button:not([hidden]), .site-nav a, input:not([hidden]):not([type="checkbox"]), select, summary')).filter((n) => !n.closest('[hidden]') && n.getBoundingClientRect().width > 0)
            .filter((n) => n.getBoundingClientRect().height < 43.5).map((n) => (n.id || n.tagName) + ':' + Math.round(n.getBoundingClientRect().height)),
        }));
        assert.ok(m.scroll <= m.inner, path + ' at ' + width + ': scrollWidth ' + m.scroll + ' > ' + m.inner);
        assert.deepEqual(m.small, [], path + ' at ' + width + ': targets under 44 px');
        assert.equal(await count(page, 'h1'), 1);
        assert.deepEqual(problems, []);
        await context.close();
      }
    });
  }

  it('structure of the new pages: one h1, a labelled nav with one current page, live regions for state, labels on every field, and the dark theme', async () => {
    for (const [path, h1] of [['/profile.html', 'Your profile'], ['/members.html', 'Members area']]) {
      const { context, page, problems } = await open(chromium, path, signedIn({ features: { chat: true, files: true, media: false, records: true, requests: false }, chat: { enabled: true }, fileList: [] }));
      await waitFor(page, () => document.querySelector('#auth-bar') && !document.querySelector('#auth-bar').hidden);
      assert.equal(await text(page, 'h1'), h1);
      assert.equal(await page.$eval('nav.site-nav', (n) => n.getAttribute('aria-label')), 'Site');
      assert.equal(await count(page, 'nav.site-nav [aria-current="page"]'), 1);
      assert.equal(await page.$eval('#auth-state', (n) => n.getAttribute('aria-live')), 'polite');
      const unlabelled = await page.$$eval('input:not([type="hidden"]), textarea, select', (nodes) => nodes.filter((n) => !n.closest('[hidden]'))
        .filter((n) => !(n.id && document.querySelector('label[for="' + n.id + '"]')) && !n.getAttribute('aria-label')).map((n) => n.id || n.tagName));
      assert.deepEqual(unlabelled, [], path + ' has fields without a label');
      assert.deepEqual(problems, []);
      await context.close();
    }
    const dark = await chromium.newContext({ colorScheme: 'dark', viewport: { width: 390, height: 800 } });
    const page = await dark.newPage();
    await page.addInitScript((s) => { globalThis.__mwScenario = s; }, signedIn());
    await page.goto(srv.base + '/profile.html');
    await waitFor(page, () => document.querySelector('#profile-signed') && !document.querySelector('#profile-signed').hidden);
    assert.equal(await page.evaluate(() => getComputedStyle(document.body).backgroundColor), 'rgb(15, 20, 26)');
    await dark.close();
  });

  it('WebKit runs the sign-in flow: a guest posts after signing in, and the profile and members pages draw', async (t) => {
    if (!webkit) return t.skip('WebKit is not installed for Playwright');
    let r = await open(webkit, '/', base());
    await waitText(r.page, '#auth-state', 'You are browsing as a guest.');
    await r.page.fill('#msg', 'Hello from WebKit');
    await r.page.click('#post-btn');
    await waitText(r.page, '#entries li:first-child .msg', 'Hello from WebKit');
    await waitText(r.page, '#auth-state', 'Signed in as (cafe0001).');
    assert.deepEqual(r.problems, []);
    await r.context.close();
    r = await open(webkit, '/profile.html', signedIn());
    await waitFor(r.page, () => !document.querySelector('#profile-signed').hidden);
    assert.equal(await text(r.page, '#rec-privacy'), REPLACED.profileSealed);
    await r.context.close();
    r = await open(webkit, '/members.html', signedIn({ features: Object.assign({}, FEATURES_OFF, { chat: true }), chat: { enabled: true } }));
    await waitText(r.page, '#chat-status', 'Chat is on. You are in the Lobby.');
    assert.deepEqual(r.problems, []);
    await r.context.close();
  });
});
