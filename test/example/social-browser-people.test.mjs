// Browser tests for examples/social, part 2: signing in on someone else's page ("Open in your home", "Create my page"), a person's
// page and wall, every settings section, the invite and its QR code, the hub directory (off by default), data export and
// "Delete my page". Mock SDK; Chromium with the local-only flags. Run: node --test test/example/social-browser-people.test.mjs
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { pw, setup, open, text, count, visible, waitText, waitFor, calls, body, go, pngFile, quiet } from './social-browser-lib.mjs';
import * as H from './social-helpers.mjs';
import { SETTINGS_SECTIONS } from '../../examples/social/js/config.js';
import { ERROR_TEXT, PRIVACY, STATE } from '../../examples/social/js/strings.js';
import { encodeNotice } from '../../examples/social/js/notices.js';
import { shardOf } from '../../examples/social/js/directory.js';
import { authorScope } from '../../examples/social/js/ids.js';
import * as D from './social-directory-keys.mjs';

const now = Date.now();
const MIN = 60000;
const me = H.pubOf(1), boPub = H.pubOf(2), cyPub = H.pubOf(3);
const boShort = H.shortIdOf(boPub);
const BO_POST = H.hashOf('bopost'), MINE = H.hashOf('mine1');
const bo = (o = {}) => H.ledger(2, Object.assign({ name: 'Bo', posts: [{ ts: now - 30 * MIN, text: 'Hello from Bo', h: BO_POST }],
  lists: { 'mw.prof': [H.item(H.hashOf('bop'), boPub, now - 90 * MIN, { bio: 'Bo writes about doors. @' + H.shortIdOf(me), links: ['https://example.org/bo'], handle: 'bo.example' })] } }, o));
const cy = (o = {}) => H.ledger(3, Object.assign({ name: 'Cy', posts: [{ ts: now - 60 * MIN, text: 'Cy says hi', h: H.hashOf('cypost') }] }, o));
const contacts = [{ pub: boPub, nick: 'Bo', short: boShort }];
function home(extra = {}, o = {}) {
  return H.scenario(Object.assign({ name: 'Ada', followed: [2], ledgers: [bo(), cy()], chat: { enabled: true, contacts }, lists: { 'mw.post': [H.item(MINE, me, now - 20 * MIN, { text: 'my own post' })] } }, o, { extra }));
}
/** Someone else's page, as a visitor: Bo's site, nothing of yours on it. */
function visitor(auth, extra = {}) {
  return H.scenario({
    me: 1, name: 'Ada', ledgers: [], extra: Object.assign({
      auth, role: 'reader', siteId: H.ledgerId(2), owner: boPub, short: H.shortIdOf(me), me, followed: [], siteName: 'Bo',
      home: { policy: { writers: 'owner', bits: 16, maxValueBytes: 2048, maxChainBytes: 8388608, moderators: [], banned: [] }, profiles: { [boPub]: 'Bo' },
        lists: { 'mw.post': [H.item(BO_POST, boPub, now - 30 * MIN, { text: 'Hello from Bo' })], 'mw.prof': [H.item(H.hashOf('bop'), boPub, now - 90 * MIN, { bio: 'Bo writes about doors.' })] } },
    }, extra),
  });
}

describe('Social in a browser, people and settings', { skip: pw ? false : 'playwright is not installed' }, () => {
  let env;
  before(async () => { env = await setup(); });
  after(async () => { await env.close(); });
  const o = (path, scenario, opts) => open(env, env.chromium, path, scenario, opts);

  it('a guest on someone\'s page reads it, can sign in, and then gets "Open in your home" and "Create my page"', async () => {
    const pointer = 'v=mw1; btih=0123456789abcdef0123456789abcdef01234567; owner=' + boPub + '; chain=chain00000000000000002; seq=3; exp=1900000000; sig=' + 'S'.repeat(86);
    const homeOrigin = 'http://127.0.0.1:65500';
    const sc = visitor('guest', { pointer, me2: { home: { origin: homeOrigin } } });
    const { context, page, problems } = await o('/', sc);
    assert.equal(await text(page, '#view-title'), 'Bo');
    assert.equal(await text(page, '#profile-head h2'), 'Bo');
    assert.equal(await text(page, '#profile-head .short'), 'Short id ' + boShort);
    assert.equal(await text(page, '#wall .post-body'), 'Hello from Bo');
    assert.equal(await count(page, '[data-composer]'), 0, 'a guest cannot write');
    assert.equal(await text(page, '#follow-signin'), 'Sign in to follow');
    assert.deepEqual(await page.$$eval('#main-nav a:not([hidden])', (a) => a.map((x) => x.innerText.trim())), ['Timeline', 'About'], 'a guest sees only what they can use');
    assert.equal(await text(page, '#sign-in'), 'Sign in');
    assert.equal(await page.$eval('[data-react="+1"]', (b) => b.disabled), true);
    assert.match(await text(page, '.react-note'), /^Sign in to react\.$/);
    await page.evaluate(() => { window.__nav = null; window.__social.ctx.navigateTop = (u) => { window.__nav = u; }; });
    await page.click('#sign-in');
    await waitFor(page, () => document.querySelector('#open-home'));
    assert.equal(await text(page, '#sign-in'), 'Sign out');
    assert.equal((await calls(page, 'auth.signIn')).length, 1);
    assert.deepEqual(await page.$$eval('#main-nav a:not([hidden])', (a) => a.map((x) => x.innerText.trim())), ['Timeline', 'Messages', 'Alerts', 'Media', 'Settings', 'About']);
    assert.match(await text(page, '.react-note'), /^To react, open this in your own page\.$/);
    await page.click('#open-home');
    await waitFor(page, () => window.__nav);
    assert.equal(await page.evaluate(() => window.__nav), homeOrigin + '/@' + H.label(2) + '#' + encodeURIComponent(pointer), 'the pointer travels in the fragment, to your own page');
    // Without a page of your own yet: the loader's own "Create my page" step opens (mw.hub.createPage; the first scenario has none, so the page says so, then one has).
    await page.click('#create-page');
    await waitFor(page, () => document.querySelector('.toast.error'));
    assert.equal(await text(page, '.toast.error'), ERROR_TEXT.NOT_AVAILABLE);
    assert.deepEqual(problems, []);
    await context.close();
    // A key for this address only (the identity page's hub box left unticked): a page made with it would not take its owner's posts on its
    // own address, so the page refuses before any card and says why.
    const p0 = await o('/', visitor('signed-in', { createPage: { origin: homeOrigin, label: 'x' } }));
    await p0.page.evaluate(() => { window.__nav = null; window.__social.ctx.navigateTop = (u) => { window.__nav = u; }; });
    await p0.page.click('#create-page');
    await waitFor(p0.page, () => document.querySelector('#profile-head [role="status"]').textContent.length > 0);
    assert.equal(await text(p0.page, '#profile-head [role="status"]'), ERROR_TEXT.HUB_IDENTITY);
    assert.equal((await calls(p0.page, 'hub.createPage')).length, 0, 'no card opens and nothing is minted');
    assert.equal(await p0.page.evaluate(() => window.__nav), null);
    assert.deepEqual(p0.problems, []);
    await p0.context.close();
    const r = await o('/', visitor('signed-in', { createPage: { origin: homeOrigin, label: 'x' }, identityMode: 'hub' }));
    await r.page.evaluate(() => { window.__nav = null; window.__social.ctx.navigateTop = (u) => { window.__nav = u; }; });
    await r.page.click('#open-home');
    await waitFor(r.page, () => document.querySelector('#profile-head [role="status"]').textContent.length > 0);
    assert.equal(await text(r.page, '#profile-head [role="status"]'), ERROR_TEXT.NO_HOME, 'no home page known on this browser yet');
    await r.page.click('#create-page');
    await waitFor(r.page, () => window.__nav);
    const nav = await r.page.evaluate(() => window.__nav);
    assert.ok(nav.startsWith(homeOrigin + '/#v%3Dmw1') && nav.includes('#mwgen='), 'the new address is opened as the loader made it: the pointer and the genesis travel in its fragment');
    assert.ok((await calls(r.page, 'me.set')).some((c) => c[1] === 'home' && c[2].origin === homeOrigin), 'the new page is remembered for the next hub label');
    await r.context.close();
    // Sign out: the page forgets the member and says so.
    const out = await o('/', visitor('signed-in'));
    await out.page.click('#sign-in');
    await waitFor(out.page, () => document.querySelector('#follow-signin'));
    assert.equal((await calls(out.page, 'auth.signOut')).length, 1);
    assert.equal(await text(out.page, '.toast.ok'), 'Signed out. This site no longer holds your keys.');
    await out.context.close();
  });

  it('Message: the person becomes a contact first, the contacts are read in the same tap, and the conversation opens; with messages off it opens the page that turns them on', async () => {
    let r = await o('/@' + H.label(3), home({}, { followed: [2, 3], chat: { enabled: true, contacts: [] } }));
    await waitFor(r.page, () => document.querySelector('#profile-head h2'));
    await r.page.click('#profile-head a[href^="/messages/"]');
    await waitFor(r.page, () => location.pathname.startsWith('/messages/'));
    await waitFor(r.page, () => document.querySelector('#load-thread'));
    assert.deepEqual((await calls(r.page, 'chat.contacts.add')).map((c) => [c[1], c[2]]), [[cyPub, { nick: 'Cy' }]], 'a first message to a stranger is a request that most sites do not take, so the person is added as a contact first');
    assert.equal((await calls(r.page, 'chat.contacts.list')).length, 1, 'the contacts are read inside the tap, because the first read opens a card');
    assert.equal(await r.page.evaluate(() => location.pathname), '/messages/' + H.shortIdOf(cyPub));
    assert.deepEqual(r.problems, []);
    await r.context.close();
    r = await o('/@' + H.label(3), home({}, { followed: [2, 3], chat: { enabled: false } }));
    await waitFor(r.page, () => document.querySelector('#profile-head h2'));
    await r.page.click('#profile-head a[href^="/messages/"]');
    await waitFor(r.page, () => document.querySelector('#chat-on'));
    assert.equal(await r.page.evaluate(() => location.pathname), '/messages');
    assert.equal((await calls(r.page, 'chat.contacts.add')).length, 0);
    await r.context.close();
  });

  it('a person\'s page: name with short id, claimed handle, links that leave safely, follow, message, wall posts, accepted posts, followers you can see', async () => {
    const dee = H.ledger(4, { name: 'Dee', posts: [{ ts: now - 10 * MIN, text: 'To Bo from Dee', h: H.hashOf('deepost'), v: { text: 'To Bo from Dee', to: H.ledgerId(2) } }], lists: { 'mw.f': [H.item(H.hashOf('f1'), H.pubOf(4), now - MIN, { l: H.ledgerId(2) })] } });
    const boL = bo(); boL.lists['mw.ok'] = [H.item(H.hashOf('ok1'), boPub, now - MIN, { refs: [{ l: dee.id, h: H.hashOf('deepost') }] })];
    boL.lists['mw.f'] = [H.item(H.hashOf('bf'), boPub, now - MIN, { l: H.ledgerId(3) })];
    const sc = home({}, { ledgers: [boL, cy(), dee], followed: [2, 3, 4] });
    const { context, page, problems } = await o('/@' + H.label(2), sc);
    await waitFor(page, () => document.querySelector('#profile-head h2'));
    assert.equal(await text(page, '#profile-head h2'), 'Bo');
    assert.equal(await text(page, '#profile-head .short'), 'Short id ' + boShort);
    assert.match(await text(page, '#profile-head'), /Claimed handle @bo\.example \(not checked by this app; open the page at that address to check it\)/);
    assert.equal(await page.$eval('#profile-head .links a', (a) => [a.getAttribute('href'), a.rel, a.target].join(' ')), 'https://example.org/bo noopener noreferrer nofollow _blank');
    assert.equal(await page.$eval('#profile-head p:not(.short):not(.small) a', (a) => a.textContent), '@Ada', 'a mention of you shows your name');
    assert.equal(await page.locator('#profile-head button', { hasText: 'Unfollow' }).count(), 1, 'you follow Bo');
    assert.equal(await page.getAttribute('#profile-head a[href^="/messages/"]', 'href'), '/messages/' + boShort);
    await waitFor(page, () => document.querySelectorAll('#wall .post-body').length === 2); // Dee's page is a followed ledger and arrives a moment after Bo's
    const texts = await page.$$eval('#wall .post-body', (n) => n.map((x) => x.textContent));
    assert.deepEqual(texts, ['To Bo from Dee', 'Hello from Bo'], 'Bo\'s own post and the post by Dee that Bo accepted onto the wall, newest first');
    assert.match(await text(page, '#wall-note'), /^This wall takes posts from people the owner follows\. Others are not shown\.$/);
    assert.match(await text(page, '#profile-lists details:nth-child(1) summary'), /Following \(public list\) \(1\)/);
    assert.match(await text(page, '#profile-lists details:nth-child(2) summary'), /Followers you can see \(1\)/);
    // Write on his wall: the post is addressed to his ledger and he is told.
    await page.locator('[data-composer="wall"] textarea').fill('Hello Bo!');
    await page.click('[data-composer="wall"] button[type="submit"]');
    await waitFor(page, async () => true);
    await page.waitForTimeout(200);
    const post = (await calls(page, 'db.append')).find((c) => c[1] === 'mw.post');
    assert.deepEqual(post[2], { text: 'Hello Bo!', to: H.ledgerId(2) });
    const wallNotice = (await calls(page, 'chat.dm.send')).map((c) => c[2].text).find((t) => t.includes('"k":"wall"'));
    assert.ok(wallNotice && wallNotice.startsWith('mwn1:'), 'a notice of kind wall goes to the wall owner');
    // Unfollow takes two taps and tombstones the public follow.
    await quiet(page);
    const btn = await page.locator('#profile-head button', { hasText: 'Unfollow' }).elementHandle();
    await btn.click(); await btn.click();
    await waitFor(page, () => document.querySelector('#follow'));
    assert.equal((await calls(page, 'hub.unfollow')).length >= 1, true);
    assert.deepEqual(problems, []);
    await context.close();
  });

  it('a wall that takes nobody\'s posts has no composer; a page that was withdrawn or removed by the hub says so', async () => {
    const closed = bo({ kv: { '_mw.cfg': { wall: 'nobody' } } });
    const gone = H.ledger(5, { name: 'Eve', withdrawn: true });
    const removed = H.ledger(6, { name: 'Fay', removed: { reason: 'illegal' } });
    const sc = home({}, { ledgers: [closed, cy(), gone, removed], followed: [2, 3, 5, 6] });
    const r = await o('/@' + H.label(2), sc);
    await waitFor(r.page, () => document.querySelector('#profile-head h2'));
    assert.equal(await count(r.page, '[data-composer]'), 0);
    assert.equal(await text(r.page, '#wall-note'), 'This wall does not take posts from other people.');
    await go(r.page, '/@' + H.label(5));
    await waitFor(r.page, () => /withdrawn/.test(document.querySelector('#profile-head').textContent));
    assert.equal(await text(r.page, '#profile-head .notice'), STATE.withdrawn);
    await go(r.page, '/@' + H.label(6));
    await waitFor(r.page, () => /Removed/.test(document.querySelector('#profile-head').textContent));
    assert.equal(await text(r.page, '#profile-head .notice'), 'Removed by this hub (illegal)');
    assert.deepEqual(r.problems, []);
    await r.context.close();
  });

  it('settings: every section of R 3.7 is a route with a title, a list and a way back', async () => {
    const { context, page, problems } = await o('/settings', home());
    assert.equal(await text(page, '#view-title'), 'Settings');
    assert.equal(await count(page, '.settings-list a'), SETTINGS_SECTIONS.length);
    assert.equal(SETTINGS_SECTIONS.length, 12);
    const titles = {};
    for (const section of SETTINGS_SECTIONS) {
      await go(page, '/settings/' + section);
      await waitFor(page, () => document.querySelector('#view .settings-grid'));
      titles[section] = await text(page, '#view-title');
      assert.ok(titles[section] && titles[section] !== 'Settings', section);
      assert.equal(await page.$eval('.settings-nav a[aria-current="page"]', (a) => a.getAttribute('href')), '/settings/' + section);
      assert.equal(await count(page, '#view a[href="/settings"]'), 1, 'a way back to the list');
    }
    assert.equal(titles.visibility, 'What others can see');
    assert.equal(titles.delete, 'Delete my page');
    assert.equal(titles.export, 'Export my data');
    assert.deepEqual(problems, []);
    await context.close();
  });

  it('settings: profile (name, bio, links, handle, picture with a description), saved as a profile op and an mw.prof item', async () => {
    const { context, page, problems } = await o('/settings/profile', home());
    await page.fill('#pf-name', 'Ada L.');
    await page.fill('#pf-bio', 'I write about doors.');
    await page.fill('#pf-link0', 'http://insecure.example/');
    await page.click('#profile-form button[type="submit"]');
    assert.match(await text(page, '#profile-form .error'), /^Links must start with https\. \(links\[0\]\)$/);
    await page.fill('#pf-link0', 'https://example.org/ada');
    await page.fill('#pf-handle', '@Ada.Example');
    await page.setInputFiles('#pf-avatar', pngFile('me.png'));
    await waitFor(page, () => document.querySelector('#pf-avatar-share') && !document.querySelector('#pf-avatar-share').hidden);
    assert.equal((await calls(page, 'files.share')).length, 0, 'scaling shares nothing; the loader accepts mw.files.share only from a click');
    await page.click('#pf-avatar-share');
    await waitFor(page, () => /Picture shared/.test(document.querySelector('#profile-form .small[role="status"]').textContent));
    const shared = (await calls(page, 'files.share'))[0];
    assert.equal(shared[1], 'avatar.jpg', 'the picture is scaled to a JPEG before it is shared');
    assert.deepEqual(shared[2], { public: true });
    await page.fill('#pf-avatar-alt', 'Ada smiling');
    await page.click('#profile-form button[type="submit"]');
    await waitFor(page, async () => true);
    await page.waitForTimeout(250);
    assert.deepEqual((await calls(page, 'identity.setName')).map((c) => c[1]), ['Ada L.']);
    const prof = (await calls(page, 'db.append')).find((c) => c[1] === 'mw.prof')[2];
    assert.deepEqual(prof, { bio: 'I write about doors.', links: ['https://example.org/ada'], handle: 'ada.example', avatar: { ref: 'ref1-avatar.jpg', kind: 'image', alt: 'Ada smiling' }, wall: 'follow' }, 'each profile item carries the wall choice');
    await page.fill('#pf-name', '');
    await page.click('#profile-form button[type="submit"]');
    assert.match(await text(page, '#profile-form .error'), /^Write something first\. \(name\)$/);
    assert.deepEqual(problems, []);
    await context.close();
  });

  it('settings: identity opens the identity page and has no field for a phrase or a backup file; privacy sets the wall and your defaults; private data loads on a tap', async () => {
    const privateRecord = { follows: [{ l: H.ledgerId(4) }], blocks: [cyPub] };
    const deeP = H.pointerFor(4);
    const r = await o('/settings/identity', home({ me2: privateRecord, pointers: { [deeP.pointer]: deeP.id }, backup: { kitSaved: true, fileSaved: false, passkey: true, persisted: true } }));
    await waitFor(r.page, () => document.querySelector('.facts div'));
    assert.deepEqual(await r.page.$$eval('#view .facts dd', (n) => n.map((x) => x.textContent)), ['Yes', 'No', 'Yes', 'Yes']);
    assert.equal(await count(r.page, '#view input, #view textarea'), 0, 'nothing on this page asks for a secret');
    assert.ok((await body(r.page)).includes(PRIVACY.neverWords));
    await r.page.click('#open-identity');
    await waitFor(r.page, async () => true);
    assert.equal((await calls(r.page, 'identity.openIdentity')).length, 1);
    await go(r.page, '/settings/privacy');
    await r.page.click('#follows-private');
    await r.page.click('#requests-open');
    await r.page.click('#presence-on');
    await waitFor(r.page, async () => true);
    await r.page.waitForTimeout(150);
    assert.deepEqual((await calls(r.page, 'chat.requests.setOpen')).map((c) => c[1]), [true]);
    assert.deepEqual((await calls(r.page, 'chat.presence.set')).map((c) => c[1]), [{ on: true, public: false }]);
    assert.equal(await r.page.evaluate(() => JSON.parse(localStorage.getItem('social.prefs')).followsPublic), false);
    // A private follow is kept in the private record, not on the ledger.
    await r.page.evaluate(async (p) => { await window.__social.ctx.data.follow(p); }, deeP.pointer);
    await waitFor(r.page, async () => true);
    assert.deepEqual((await calls(r.page, 'db.append')).filter((c) => c[1] === 'mw.f'), []);
    assert.ok((await calls(r.page, 'me.set')).some((c) => c[1] === 'follows'));
    await r.page.click('#load-private');
    await waitFor(r.page, () => /Loaded 1 private follows and 1 blocks\./.test(document.querySelector('#load-private').parentElement.textContent));
    assert.match(await body(r.page), /Blocked \(1\)/);
    await r.context.close();
  });

  it('settings: what others can see, appearance, notifications, storage (unfollow, clear cache), messages and pictures', async () => {
    const { context, page, problems } = await o('/settings/visibility', home());
    const bodyText = await body(page);
    assert.ok(bodyText.includes(PRIVACY.whatOthersSee) && bodyText.includes(PRIVACY.keyMatching) && bodyText.includes(PRIVACY.recordNote) && bodyText.includes(PRIVACY.conversations));
    assert.equal(await count(page, '.ceiling tbody tr'), 8);
    await go(page, '/settings/appearance');
    await page.click('#theme-dark');
    assert.equal(await page.evaluate(() => document.documentElement.getAttribute('data-theme')), 'dark');
    assert.equal(await text(page, '#theme-toggle'), 'Theme: dark');
    await go(page, '/settings/notifications');
    await page.uncheck('#n-mentions');
    assert.equal(await page.evaluate(() => JSON.parse(localStorage.getItem('social.prefs')).notifyMentions), false);
    assert.match(await body(page), /no push notifications when the page is closed/);
    await go(page, '/settings/storage');
    assert.equal(await text(page, '#cap-text'), 'You follow 1 of 1,000 on this computer');
    assert.equal(await count(page, '#view .settings-grid > .stack ul li'), 1);
    await page.evaluate(() => localStorage.setItem('social.hidden', '["x"]'));
    await quiet(page);
    const clear = await page.locator('button', { hasText: 'Clear cache' }).elementHandle();
    await clear.click(); await clear.click();
    await waitFor(page, () => localStorage.getItem('social.hidden') === null);
    await go(page, '/settings/chat');
    await waitFor(page, () => document.querySelector('#chat-state').textContent === 'Messages are on.');
    assert.equal(await text(page, '#chat-toggle'), 'Turn messages off');
    assert.equal(await count(page, '#holder'), 1, 'holding messages for others is offered on a computer only');
    await go(page, '/settings/media');
    await page.check('#auto-pictures');
    assert.equal(await page.evaluate(() => JSON.parse(localStorage.getItem('social.prefs')).autoPictures), true);
    assert.deepEqual(problems, []);
    await context.close();
  });

  it('pictures from people you follow load without a tap only when you turned that on', async () => {
    const withPic = bo({ posts: [{ ts: now - 30 * MIN, text: 'with a picture', v: { text: 'with a picture', media: [{ ref: 'r1', kind: 'image', alt: 'A door' }] } }] });
    const sc = home({}, { ledgers: [withPic, cy()] });
    const { context, page } = await o('/', sc, { init: () => localStorage.setItem('social.prefs', JSON.stringify({ autoPictures: true })) });
    await waitFor(page, () => document.querySelector('#feed img[alt="A door"]'));
    assert.equal((await calls(page, 'files.preview')).length, 1);
    await context.close();
  });

  it('the invite: the link carries the pointer in the fragment, the QR code is drawn from it, and copying works', async () => {
    const pointer = 'v=mw1; btih=0123456789abcdef0123456789abcdef01234567; owner=' + me + '; chain=chain00000000000000001; seq=3; exp=1900000000; sig=' + 'S'.repeat(86);
    const { context, page, problems } = await o('/settings/invite', home({ pointer }), { context: { permissions: ['clipboard-read', 'clipboard-write'] } });
    await waitFor(page, () => document.querySelector('#invite-link').value.length > 0);
    const link = await page.inputValue('#invite-link');
    assert.ok(link.endsWith('/#' + encodeURIComponent(pointer)), link.slice(-60));
    assert.equal(await text(page, '#invite-note'), '');
    const svg = page.locator('.qr svg');
    assert.equal(await svg.getAttribute('role'), 'img');
    assert.match(await svg.getAttribute('aria-label'), /QR code of the link to your page/);
    assert.ok(Number(await svg.getAttribute('data-qr-version')) >= 5);
    assert.ok((await page.$eval('.qr svg path', (p) => p.getAttribute('d'))).length > 500);
    const decoded = await page.evaluate(async () => {
      if (typeof BarcodeDetector === 'undefined') return null;
      try {
        const el = document.querySelector('.qr svg'), xml = new XMLSerializer().serializeToString(el);
        const img = new Image(); img.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(xml); await img.decode();
        const c = document.createElement('canvas'); c.width = c.height = 640; const g = c.getContext('2d'); g.imageSmoothingEnabled = false; g.drawImage(img, 0, 0, 640, 640);
        const r = await new BarcodeDetector({ formats: ['qr_code'] }).detect(c); return r.length ? r[0].rawValue : '';
      } catch (e) { return null; }
    });
    if (decoded !== null) assert.equal(decoded, link, 'a QR decoder reads back the link');
    await page.click('#invite-copy');
    await waitFor(page, () => document.querySelector('.toast.ok'));
    assert.equal(await page.evaluate(() => navigator.clipboard.readText()), link);
    assert.deepEqual(problems, []);
    await context.close();
    const r = await o('/settings/invite', home());
    await waitFor(r.page, () => document.querySelector('#invite-note').textContent.length > 0);
    assert.match(await text(r.page, '#invite-note'), /cannot read your page's pointer yet/);
    assert.equal(await count(r.page, '.qr svg'), 1, 'there is still a link and a code for the page itself');
    await r.context.close();
  });

  it('the hub directory is off by default and says why; with the flag on it looks names up, follows only verified entries and warns when a followed name moves', async () => {
    const off = await o('/settings/invite', home());
    assert.match(await text(off.page, '#directory-off'), /Off\. This hub has not turned its directory on \(pending counsel\)\. Links and QR codes work without it\./);
    assert.equal(await count(off.page, '#directory-on'), 0);
    assert.equal(await off.page.evaluate(() => window.__social.ctx.flags.directory), false);
    await off.context.close();
    // Real P-256 keys: the person's (the owner key of their pointer) and the hub's directory key (in /config.json).
    const deeKeys = await D.newKey(), eveKeys = await D.newKey(), hubKeys = await D.newKey();
    const deePtr = D.pointerOf(deeKeys.pub, 4), evePtr = D.pointerOf(eveKeys.pub, 5);
    const deeLedger = H.ledger(4, { id: deePtr.id, name: 'Dee', posts: [{ ts: now - 5 * MIN, text: 'Dee here' }] });
    const sc = home({ pointers: { [deePtr.pointer]: deePtr.id } }, { ledgers: [bo(), cy(), deeLedger] });
    const dee = await D.entry({ name: 'dee', ledgerId: deePtr.id, pointer: deePtr.pointer, t: now }, deeKeys, hubKeys);
    // A name mapped to Dee's page by someone who is not Dee (the shard's host, a CDN): the hub countersigned it, Dee did not sign it.
    const forged = await D.entry({ name: 'dee', ledgerId: deePtr.id, pointer: deePtr.pointer, t: now }, eveKeys, hubKeys);
    let shard = [forged];
    const config = { appName: 'Social', directory: true, moderationContact: 'abuse@hub.example', directoryKey: hubKeys.pub };
    const r = await open(env, env.chromium, '/settings/invite', sc, { noWait: true, init: () => {} });
    await r.page.close();
    const ctx2 = await env.chromium.newContext({ viewport: { width: 1024, height: 900 } });
    const page = await ctx2.newPage();
    const problems = [];
    page.on('pageerror', (e) => problems.push(e.message));
    await page.addInitScript((s) => { globalThis.__mwScenario = s; }, sc);
    await page.route('**/config.json', (route) => route.fulfill({ contentType: 'application/json', body: JSON.stringify(config) }));
    await page.route('**/_dir/*.json', (route) => route.fulfill({ contentType: 'application/json', body: JSON.stringify(shard) }));
    await page.goto(env.srv.base + '/settings/invite');
    await page.waitForSelector('#directory-on');
    assert.match(await text(page, '#directory-on'), /pending counsel/);
    await page.fill('#dir-name', 'nobody');
    await page.click('#directory-on button[type="submit"]');
    await waitFor(page, () => /No such name in this directory\./.test(document.querySelector('#dir-results').textContent));
    await page.fill('#dir-name', 'Dee');
    await page.click('#directory-on button[type="submit"]');
    await waitFor(page, () => document.querySelector('#dir-unverified'));
    assert.equal(await text(page, '#dir-unverified'), 'The person this entry names did not sign it. It cannot be followed from the directory. Ask the person for their link instead.');
    assert.equal(await count(page, '#dir-follow'), 0, 'a forged entry is not followable');
    shard = [dee];
    await page.click('#directory-on button[type="submit"]');
    await page.waitForSelector('#dir-follow');
    assert.match(await text(page, '#dir-results'), /Signed by the person and the hub/);
    assert.ok((await calls(page, 'hub.follow')).length === 0);
    await page.click('#dir-follow');
    await waitFor(page, () => localStorage.getItem('social.dirPins') !== null);
    assert.deepEqual(JSON.parse(await page.evaluate(() => localStorage.getItem('social.dirPins'))), { [deePtr.id]: 'dee' });
    // A forged move (the name now names Eve's page, without Eve's own signature): no warning, the follow stays.
    shard = [Object.assign({}, await D.entry({ name: 'dee', ledgerId: evePtr.id, pointer: evePtr.pointer, t: now + 1 }, deeKeys, hubKeys))];
    await page.evaluate((h) => window.__social.ctx.go(h), '/@' + deePtr.label);
    await waitFor(page, () => document.querySelector('#profile-head h2') && document.querySelector('#profile-head h2').textContent === 'Dee');
    await page.waitForTimeout(400);
    assert.equal(await page.$eval('#dir-warning', (n) => n.hidden), true, 'an entry that does not verify never moves a name');
    // The name really moved (Eve signed it and the hub countersigned it): the pinned page's profile warns, and the follow stays where it was.
    shard = [await D.entry({ name: 'dee', ledgerId: evePtr.id, pointer: evePtr.pointer, t: now + 2 }, eveKeys, hubKeys)];
    await page.evaluate((h) => window.__social.ctx.go(h), '/settings');
    await page.evaluate((h) => window.__social.ctx.go(h), '/@' + deePtr.label);
    await waitFor(page, () => document.querySelector('#dir-warning') && !document.querySelector('#dir-warning').hidden);
    assert.equal(await text(page, '#dir-warning'), 'This name now points to a different page');
    assert.deepEqual(problems, []);
    await ctx2.close();
    assert.equal(shardOf('Dee'), shardOf('dee'));
    assert.ok(shardOf('dee') >= 0 && shardOf('dee') < 4096);
  });

  it('export downloads what this browser holds of yours with the private record; Delete my page hides every payload, removes your reactions and keys, and promises only what runs', async () => {
    const REACT = 're/' + H.ledgerId(2) + '/' + BO_POST, MINE_KEY = authorScope(me) + 'note', RH = H.hashOf('react-entry'), NH = H.hashOf('note-entry');
    const kv = { [REACT]: { v: { r: 'heart' }, author: me, h: RH, ts: now - 5 * MIN }, [MINE_KEY]: { v: 'kept for me', author: me, h: NH, ts: now - 4 * MIN },
      '_mw.cfg': { v: { chat: 'members', calls: 'contacts' }, author: me, h: H.hashOf('cfg-entry'), ts: now - 9 * MIN } };
    const { context, page, problems } = await o('/settings/export', home({ withdrawPage: true, me2: { notes: 'x' } }, { kv }), { context: { acceptDownloads: true } });
    assert.match(await text(page, '#export-signed'), /Export them from the loader's own Settings: Site ledger, Export ledger JSON\.$/);
    const [download] = await Promise.all([page.waitForEvent('download'), page.click('#export-data')]);
    assert.match(download.suggestedFilename(), /^my-page-[a-z2-7]{8}\.json$/);
    const data = JSON.parse(await (await import('node:fs/promises')).readFile(await download.path(), 'utf8'));
    assert.equal(data.ledger, H.ledgerId(1));
    assert.equal(data.lists['mw.post'][0].v.text, 'my own post');
    assert.ok(data.note.includes('Private photos and videos'));
    assert.deepEqual(data.privateRecord, { notes: 'x' }, 'R 3.3: the decrypted record fields are in the file, read in the same tap');
    assert.match(data.signedEntries, /not in this file/);
    assert.equal((await calls(page, 'me.get')).length, 1);
    const [dl2] = await Promise.all([page.waitForEvent('download'), page.click('#export-private')]);
    assert.equal(dl2.suggestedFilename(), 'my-private-record.json');
    await go(page, '/settings/delete');
    const card = await text(page, '#delete-text');
    assert.ok(card.includes('It also withdraws your page\'s address.') && card.includes('Your display name stays on your page'), card);
    await page.click('#delete-ack');
    await quiet(page);
    const btn = await page.locator('#view button', { hasText: 'Delete my page' }).elementHandle();
    await btn.click(); await btn.click();
    await waitFor(page, () => /Cleared this device/.test(document.querySelector('#delete-log').textContent));
    assert.equal((await calls(page, 'me.erase')).length, 1);
    assert.deepEqual((await calls(page, 'db.tombstone')).map((c) => c[1]).sort(), [MINE, NH, RH].sort(), 'the one post, and the entries of the keys removed');
    assert.deepEqual((await calls(page, 'db.set')).filter((c) => c[2] === null).map((c) => c[1]).sort(), [MINE_KEY, REACT].sort(), 'each key of yours is deleted first');
    const left = await page.evaluate(() => Object.keys(__mwMock.ledger(__mwMock.scenario.siteId).kv));
    assert.deepEqual(left, ['_mw.cfg'], 'no reaction and no key of yours stays live; the page\'s own settings stay');
    assert.equal((await calls(page, 'hub.withdrawPage')).length, 1);
    const log = await text(page, '#delete-log');
    assert.match(log, /Hidden 1 of 1 items\./);
    assert.match(log, /Removed 2 of 2 reactions and other values\./);
    assert.match(log, /Visitors see: This page was withdrawn by its owner\./);
    assert.match(log, /Your display name stays on your page: this copy of the loader cannot clear it yet\./);
    assert.equal((await calls(page, 'identity.setName')).length, 0, 'the SDK takes a name of 1 to 48 characters, so the page does not try to clear it');
    assert.equal(await page.evaluate(() => Object.keys(localStorage).filter((k) => k.startsWith('social.')).length), 0, 'this device is cleared');
    assert.deepEqual(problems, []);
    await context.close();
    // Without mw.hub.withdrawPage (GAP 2) the card does not promise the withdrawal, and the log says the address keeps working.
    const r = await o('/settings/delete', home());
    const card2 = await text(r.page, '#delete-text');
    assert.ok(!card2.includes('withdraws your page'), card2);
    assert.ok(card2.includes('Your page\'s address keeps working: this copy of the loader cannot withdraw it yet.'), card2);
    await r.page.click('#delete-ack');
    await quiet(r.page);
    const b2 = await r.page.locator('#view button', { hasText: 'Delete my page' }).elementHandle();
    await b2.click(); await b2.click();
    await waitFor(r.page, () => /Cleared this device/.test(document.querySelector('#delete-log').textContent));
    assert.match(await text(r.page, '#delete-log'), /Your page's address keeps working: this copy of the loader cannot withdraw it yet\./);
    assert.equal((await calls(r.page, 'hub.withdrawPage')).length, 0);
    assert.deepEqual(r.problems, []);
    await r.context.close();
  });
});
