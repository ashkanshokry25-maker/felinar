// Browser tests for examples/social against the mock SDK (test/example/mock-sdk.js): the home timeline, the composer and its alt-text
// rule, follows and the follow cap, comments and mw.ok, reactions, edits, deletes, hides, blocks and reports, the wall setting, deep
// links and the R 3.7 states. The real loader is covered by the integration E2E suite (E-SO-1 to E-SO-13); this one checks the page's
// own behaviour against the written contract. Chromium with the repository's local-only flags, WebKit on 127.0.0.1 where installed.
// Run: node --test test/example/social-browser.test.mjs   (skips when playwright is not installed)
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { pw, setup, open, text, count, visible, waitText, waitFor, calls, body, go, pngFile, quiet } from './social-browser-lib.mjs';
import * as H from './social-helpers.mjs';
import { encodeNotice } from '../../examples/social/js/notices.js';
import { ERROR_TEXT } from '../../examples/social/js/strings.js';

const now = Date.now();
const MIN = 60000;
const me = H.pubOf(1), boPub = H.pubOf(2), cyPub = H.pubOf(3);
const boShort = H.shortIdOf(boPub), cyShort = H.shortIdOf(cyPub);
const BO_POST = H.hashOf('bopost'), BO_OLD = H.hashOf('boold'), CY_POST = H.hashOf('cypost'), MINE = H.hashOf('mine1');
const bo = () => H.ledger(2, { name: 'Bo', posts: [{ ts: now - 30 * MIN, text: 'Hello from Bo', h: BO_POST }, { ts: now - 180 * MIN, text: 'older from Bo', h: BO_OLD }] });
const cy = () => H.ledger(3, { name: 'Cy', posts: [{ ts: now - 60 * MIN, text: 'Cy says hi', h: CY_POST }] });
const contacts = [{ pub: boPub, nick: 'Bo', short: boShort }, { pub: cyPub, nick: 'Cy', short: cyShort }];
function world(extra = {}) {
  return H.scenario({
    name: 'Ada', followed: [2, 3], ledgers: [bo(), cy()], chat: { enabled: true, contacts },
    lists: { 'mw.post': [H.item(MINE, me, now - 20 * MIN, { text: 'my own post' })] }, extra,
  });
}
const feedKeys = (page) => page.$$eval('#feed article', (as) => as.map((a) => a.dataset.key));
const feedTexts = (page) => page.$$eval('#feed article .post-body', (as) => as.map((a) => a.textContent));
// Two taps. The button is held as a handle: once armed its text no longer matches the text it was found by.
const tap2 = async (loc) => { await quiet(loc.page()); const btn = await loc.elementHandle(); await btn.click(); assert.equal(await btn.textContent(), 'Tap again to confirm'); await btn.click(); };
const notice = (n) => encodeNotice(n);

describe('Social in a browser', { skip: pw ? false : 'playwright is not installed' }, () => {
  let env;
  before(async () => { env = await setup(); });
  after(async () => { await env.close(); });
  const o = (path, scenario, opts) => open(env, env.chromium, path, scenario, opts);

  it('home timeline: your posts and the posts of the people you follow, merged by (time, hash), newest first, no ranking', async () => {
    const { context, page, problems } = await o('/', world());
    await waitFor(page, () => document.querySelectorAll('#feed article').length === 4);
    assert.deepEqual(await feedTexts(page), ['my own post', 'Hello from Bo', 'Cy says hi', 'older from Bo']);
    const keys = await feedKeys(page);
    assert.equal(keys[0], H.ledgerId(1) + '/' + MINE);
    assert.equal(await text(page, '#view-title'), 'Timeline');
    assert.equal(await page.title(), 'Timeline - Social');
    await waitText(page, '#sync-line', '', 8000); // the line follows the data a moment later (it is throttled)
    assert.equal(await text(page, '#sync-line'), '', 'nothing to say when every followed page is current');
    assert.equal(await text(page, '#identity-chip'), 'Ada (' + H.shortIdOf(me) + ')');
    assert.equal(await text(page, '#sign-in'), 'Sign out');
    assert.match(await page.locator('#feed article .who').first().textContent(), /^Ada \(.{8}\)/, 'the short id sits beside every name');
    assert.equal(await count(page, '#main-nav a[hidden]'), 0, 'a signed-in member sees every section');
    // The filters are filters, nothing more.
    await page.click('[data-filter="media"]');
    await waitFor(page, () => document.querySelectorAll('#feed article').length === 0);
    assert.match(await text(page, '#feed-empty'), /Nothing to show yet/);
    await page.click('[data-filter="all"]');
    await page.selectOption('#person-filter', H.ledgerId(3));
    await waitFor(page, () => document.querySelectorAll('#feed article').length === 1);
    assert.deepEqual(await feedTexts(page), ['Cy says hi']);
    assert.deepEqual(problems, []);
    await context.close();
  });

  it('the timeline holds 30 to a page and "N new posts" waits for a tap instead of moving the feed', async () => {
    const many = H.ledger(2, { name: 'Bo', posts: Array.from({ length: 70 }, (_, i) => ({ ts: now - (200 + i) * MIN, text: 'bo ' + i })) });
    const { context, page } = await o('/', H.scenario({ name: 'Ada', followed: [2], ledgers: [many] }));
    await waitFor(page, () => document.querySelectorAll('#feed article').length === 30);
    assert.equal(await visible(page, '#more'), true);
    await page.click('#more'); await waitFor(page, () => document.querySelectorAll('#feed article').length === 60);
    await page.click('#more'); await waitFor(page, () => document.querySelectorAll('#feed article').length === 70);
    assert.equal(await page.$eval('#more', (n) => n.hidden), true);
    const before = await feedKeys(page);
    await page.evaluate((id) => __mwMock.remoteList(id, 'mw.post', { author: __mwMock.ledger(id).owner, ts: Date.now(), v: { text: 'fresh from Bo' } }), H.ledgerId(2));
    await waitFor(page, () => !document.querySelector('.new-posts').hidden);
    assert.equal(await text(page, '#new-posts'), '1 new post');
    assert.deepEqual(await feedKeys(page), before, 'the feed did not move');
    await waitFor(page, () => document.querySelector('#live-polite').textContent === '1 new post');
    await page.click('#new-posts');
    await waitFor(page, () => document.querySelector('#feed article .post-body').textContent === 'fresh from Bo');
    assert.equal(await page.$eval('.new-posts', (n) => n.hidden), true);
    await context.close();
  });

  it('composer: a counter, the fee line while the write is signed, the post as text (never HTML), and a draft that survives a reload', async () => {
    const { context, page, problems } = await o('/', world({ writeDelay: 400 }));
    const area = page.locator('[data-composer="post"] textarea');
    assert.equal(await page.$eval('[data-composer="post"] button[type="submit"]', (b) => b.disabled), true, 'nothing to post yet');
    await area.fill('half a thought');
    await page.waitForTimeout(600);
    await page.reload();
    await page.waitForSelector('[data-composer="post"] textarea');
    assert.equal(await page.locator('[data-composer="post"] textarea').inputValue(), 'half a thought', 'the draft is kept on this device');
    const evil = '<img src=x onerror="window.__xss=1">hi & bye';
    await page.locator('[data-composer="post"] textarea').fill(evil);
    assert.equal(await text(page, '[data-composer="post"] .counter'), evil.length + ' / 2,000');
    await page.click('[data-composer="post"] button[type="submit"]');
    await waitFor(page, () => document.querySelector('#sync-line').textContent.includes('Working out the spam fee for this post'));
    await waitFor(page, () => document.querySelector('#feed article .post-body').textContent.includes('hi & bye'));
    assert.equal(await page.locator('#feed article .post-body').first().textContent(), evil);
    assert.equal(await page.evaluate(() => typeof window.__xss), 'undefined');
    assert.equal(await count(page, '#feed article img'), 0);
    const appended = await calls(page, 'db.append');
    assert.deepEqual(appended.map((c) => [c[1], c[2]]), [['mw.post', { text: evil }]]);
    // The own post shows from the data layer's change at once (E-SO-9, model.js timelineTop); the composer clears only when the
    // signed write resolves (composer.js), which the mock holds for writeDelay ms, so wait for it rather than assert at once.
    await waitFor(page, () => document.querySelector('[data-composer="post"] textarea').value === '');
    assert.equal(await page.locator('[data-composer="post"] textarea').inputValue(), '');
    assert.deepEqual(problems, []);
    await context.close();
  });

  it('composer: every public picture needs a description before the post can be sent, and the picture loads only when tapped', async () => {
    const { context, page, problems } = await o('/', world());
    const sel = '[data-composer="post"]';
    await page.locator(sel + ' textarea').fill('look at this');
    await page.setInputFiles(sel + ' input[type="file"]', pngFile('door.png'));
    await waitFor(page, () => document.querySelectorAll('[data-attachment] [data-share]').length === 1);
    const post = page.locator(sel + ' button[type="submit"]');
    assert.equal((await calls(page, 'files.share')).length, 0, 'choosing a file shares nothing: the loader accepts mw.files.share only from a click');
    assert.equal(await post.isDisabled(), true, 'a chosen file that is not shared yet keeps Post off');
    await page.click('[data-attachment] [data-share]');
    await waitFor(page, () => document.querySelectorAll('[data-attachment] input[type="text"]').length === 1);
    assert.equal((await calls(page, 'files.share')).length, 1);
    assert.equal(await post.isDisabled(), true, 'no description yet');
    assert.equal(await text(page, sel + ' .small[role="status"]'), ERROR_TEXT.ALT_REQUIRED);
    assert.equal(await page.$eval('[data-attachment] input[type="text"]', (i) => i.getAttribute('aria-invalid')), 'true');
    await page.fill('[data-attachment] input[type="text"]', '   ');
    assert.equal(await post.isDisabled(), true, 'blank is not a description');
    await page.fill('[data-attachment] input[type="text"]', 'A red door in a brick wall');
    assert.equal(await post.isDisabled(), false);
    await post.click();
    await waitFor(page, () => document.querySelector('#feed article .post-body').textContent === 'look at this');
    const order0 = (await page.evaluate(() => __mwMock.calls.map((c) => [c[0], c[1]]))).filter((c) => c[0] === 'files.share' || (c[0] === 'db.set' && c[1] === '_mw.cfg')).map((c) => c[0]);
    assert.deepEqual(order0, ['db.set', 'files.share'], 'a personal site starts with no switch for public files: the first picture turns it on, as the owner, then shares');
    assert.deepEqual((await calls(page, 'db.set')).find((c) => c[1] === '_mw.cfg')[2], { files: 'members' });
    assert.equal(await page.evaluate(() => window.__social.ctx.data.ensureFeature('files')), false, 'a switch that is on is not written again');
    assert.equal((await calls(page, 'db.set')).filter((c) => c[1] === '_mw.cfg').length, 1);
    const [, , value] = (await calls(page, 'db.append'))[0];
    assert.deepEqual(value, { text: 'look at this', media: [{ ref: 'ref1-door.png', kind: 'image', alt: 'A red door in a brick wall' }] });
    const card = page.locator('#feed article').first();
    assert.equal(await card.locator('.tile .small').first().textContent(), 'A red door in a brick wall');
    assert.equal(await count(page, '#feed article img'), 0, 'nothing is fetched before a tap (no thumbnails from peers)');
    assert.equal((await calls(page, 'files.preview')).length, 0);
    assert.equal((await calls(page, 'files.fetch')).length, 0);
    assert.match(await card.locator('.media-grid + p').textContent(), /^Fetching also shares it with others while this page is open, and they see your IP address next to it\.$/);
    await card.locator('.tile button').click();
    await waitFor(page, () => document.querySelectorAll('#feed article img').length === 1);
    assert.equal(await card.locator('.tile img').getAttribute('alt'), 'A red door in a brick wall');
    assert.equal((await calls(page, 'files.preview')).length, 1);
    const order = (await page.evaluate(() => __mwMock.calls.map((c) => c[0]))).filter((n) => n === 'files.fetch' || n === 'files.preview');
    assert.deepEqual(order, ['files.fetch', 'files.preview'], 'the loader previews only a file that was fetched, so a tap fetches first');
    assert.deepEqual(problems, []);
    await context.close();
  });

  it('composer: at most four pictures, a refusal from the SDK is shown in words, and a failed post stays in Drafts', async () => {
    let r = await o('/', world({ shareError: 'E_MEDIA_TYPE' }));
    await r.page.setInputFiles('[data-composer="post"] input[type="file"]', pngFile('x.png'));
    await waitFor(r.page, () => document.querySelector('[data-share]'));
    await r.page.click('[data-share]');
    await waitFor(r.page, () => document.querySelector('.toast.error'));
    assert.equal(await text(r.page, '.toast.error'), 'This kind of file is not accepted here.');
    assert.equal(await count(r.page, '[data-attachment] [data-share]'), 1, 'the file stays in the list to try again or remove');
    await r.context.close();
    r = await o('/', world());
    await r.page.setInputFiles('[data-composer="post"] input[type="file"]', [pngFile('1.png'), pngFile('2.png'), pngFile('3.png'), pngFile('4.png'), pngFile('5.png')]);
    await waitFor(r.page, () => document.querySelectorAll('[data-attachment]').length === 4);
    await r.page.waitForTimeout(150);
    assert.equal(await count(r.page, '[data-attachment]'), 4, 'the fifth is not attached');
    assert.equal(await r.page.$eval('[data-composer="post"] input[type="file"]', (i) => i.disabled), true);
    await r.context.close();
    r = await o('/', world({ appendError: 'E_RATE' }));
    await r.page.locator('[data-composer="post"] textarea').fill('this will fail');
    await r.page.click('[data-composer="post"] button[type="submit"]');
    await waitFor(r.page, () => document.querySelector('[data-composer="post"] .error').textContent.length > 0);
    assert.equal(await text(r.page, '[data-composer="post"] .error'), 'Too fast. Wait a few seconds and try again. Your text is saved in Drafts.');
    assert.equal(await r.page.locator('[data-composer="post"] textarea').inputValue(), 'this will fail', 'the text stays in the box');
    await r.page.click('[data-composer="post"] details summary');
    assert.match(await text(r.page, '[data-composer="post"] details li'), /^Not posted: this will fail/);
    await r.context.close();
  });

  it('follow by link: the pointer in the fragment finds the page, Follow records it on your ledger, and the cap is an error in words', async () => {
    const dee = H.pointerFor(4);
    const deeLedger = H.ledger(4, { id: dee.id, name: 'Dee', posts: [{ ts: now - 5 * MIN, text: 'Dee here', h: H.hashOf('deepost') }] });
    const { context, page, problems } = await o('/@' + dee.label + '#' + encodeURIComponent(dee.pointer), world({ pointers: { [dee.pointer]: dee.id } }) && Object.assign(world(), { ledgers: [bo(), cy(), deeLedger], pointers: { [dee.pointer]: dee.id } }));
    await waitFor(page, () => document.querySelector('#profile-head h2') && document.querySelector('#profile-head h2').textContent === 'Dee');
    assert.equal(await text(page, '#follow'), 'Follow');
    assert.deepEqual((await calls(page, 'hub.follow')).map((c) => c[1]), [dee.id], 'peeking follows the ledger for as long as the page is open; the ledgers already followed are not followed again');
    await page.click('#follow');
    await waitFor(page, () => document.querySelector('#profile-head') && /Unfollow/.test(document.querySelector('#profile-head').textContent));
    const appended = (await calls(page, 'db.append')).filter((c) => c[1] === 'mw.f');
    assert.deepEqual(appended.map((c) => c[2]), [{ l: dee.id, ptr: dee.pointer }], 'a public follow carries the pointer so others can follow too');
    await waitText(page, '#follow-cap', 'You follow 3 of 1,000 on this computer');
    await go(page, '/');
    await waitFor(page, () => document.querySelectorAll('#feed article').length === 5);
    assert.ok((await feedTexts(page)).includes('Dee here'));
    assert.deepEqual(problems, []);
    await context.close();
  });

  it('the follow cap by device class: "You follow 250 of 250 on this phone", and a catch-up line while pages are still arriving', async () => {
    const ids = Array.from({ length: 250 }, (_, i) => H.ledgerId(1000 + i));
    const withData = ids.slice(0, 5).map((id, i) => H.ledger(1000 + i, { name: 'P' + i, posts: [{ ts: now - i * MIN, text: 'p' + i }] }));
    const sc = H.scenario({ name: 'Ada', ledgers: withData, extra: { followed: ids } });
    const { context, page, problems } = await open(env, env.chromium, '/settings/storage', sc, { device: pw.devices['Pixel 7'] });
    assert.equal(await text(page, '#cap-text'), 'You follow 250 of 250 on this phone');
    await waitFor(page, () => document.querySelector('#sync-line').textContent === 'Catching up: 5 of 250 pages');
    await go(page, '/@' + H.hubLabelFor(ids[0]));
    await waitFor(page, () => document.querySelector('#profile-head h2'));
    assert.equal(await page.locator('#profile-head button', { hasText: 'Unfollow' }).count(), 1);
    assert.deepEqual(problems, []);
    await context.close();
    const dee = H.pointerFor(4);
    const r = await o('/', Object.assign(world(), { followCap: 2, pointers: { [dee.pointer]: dee.id } }));
    await r.page.evaluate(() => { window.__err = null; });
    await r.page.evaluate(async (p) => { try { await window.__social.ctx.data.follow(p); } catch (e) { window.__err = e.code; } }, dee.pointer);
    assert.equal(await r.page.evaluate(() => window.__err), 'E_LIMIT', 'the lane refuses past its cap and the page reports it');
    await r.context.close();
  });

  it('comments live on the commenter\'s ledger: yours waits for the author\'s mw.ok, a notice goes to the author, accepted ones thread under the post', async () => {
    const eve = H.ledger(5, { name: 'Eve' });
    const eveComment = H.hashOf('evecomment'), cyComment = H.hashOf('cycomment');
    const postRef = { l: H.ledgerId(2), h: BO_POST };
    eve.lists['mw.c'] = [H.item(eveComment, H.pubOf(5), now - 5 * MIN, { text: 'Eve from far away', target: postRef })];
    const cyL = H.ledger(3, { name: 'Cy', posts: [{ ts: now - 60 * MIN, text: 'Cy says hi', h: CY_POST }], lists: { 'mw.c': [H.item(cyComment, cyPub, now - 10 * MIN, { text: 'Cy answers Eve', target: postRef, replyTo: { l: eve.id, h: eveComment } })] } });
    const boL = bo();
    boL.lists['mw.ok'] = [H.item(H.hashOf('ok0'), boPub, now - MIN, { refs: [{ l: eve.id, h: eveComment }, { l: H.ledgerId(3), h: cyComment }] })];
    const sc = world(); sc.ledgers = [boL, cyL, eve];
    const { context, page, problems } = await o('/@' + H.label(2) + '/p/' + BO_POST, sc);
    await waitFor(page, () => document.querySelectorAll('[data-comment]').length === 2);
    assert.equal(await text(page, '#thread h2'), 'Comments (2)');
    const order = await page.$$eval('[data-comment]', (n) => n.map((x) => x.querySelector('.post-body').textContent));
    assert.deepEqual(order, ['Eve from far away', 'Cy answers Eve'], 'a reply sits under the comment it answers');
    assert.equal(await page.$$eval('.thread .thread [data-comment]', (n) => n.length), 1);
    const followCalls = (await calls(page, 'hub.follow')).map((c) => c[1]);
    assert.ok(followCalls.includes(eve.id), 'the commenter\'s page is fetched for as long as the thread is open');
    await page.fill('#comment-text', 'Nice one, Bo');
    await page.click('#comment-send');
    await waitFor(page, () => document.querySelectorAll('[data-comment]').length === 3);
    const mine = (await calls(page, 'db.append')).find((c) => c[1] === 'mw.c');
    assert.deepEqual(mine[2], { text: 'Nice one, Bo', target: postRef });
    assert.match(await text(page, '[data-comment] .badge.warn'), /Waiting for the author to accept/);
    const sent = (await calls(page, 'chat.dm.send')).filter((c) => c[1] === boPub);
    assert.equal(sent.length, 1, 'the author gets a notice');
    assert.ok(sent[0][2].text.startsWith('mwn1:') && JSON.parse(sent[0][2].text.slice(5)).k === 'reply');
    // The author accepts it (mw.ok on their ledger): the pending mark goes away.
    const myH = await page.evaluate(() => __mwMock.ledger(__mwMock.scenario.siteId).lists['mw.c'][0].h);
    await page.evaluate(([id, ref]) => __mwMock.remoteList(id, 'mw.ok', { author: __mwMock.ledger(id).owner, v: { refs: [ref] } }), [H.ledgerId(2), { l: H.ledgerId(1), h: myH }]);
    await waitFor(page, () => document.querySelectorAll('[data-comment] .badge.warn').length === 0);
    assert.equal(await text(page, '#thread h2'), 'Comments (3)');
    // A reply to a comment is nested and names its parent.
    await page.locator('[data-comment]').first().locator('[data-act="reply"]').click();
    assert.equal(await text(page, '#comment-box label'), 'Your reply');
    await page.fill('#comment-text', 'And thanks');
    await page.click('#comment-send');
    await waitFor(page, () => (document.querySelectorAll('[data-comment]').length === 4));
    const reply = (await calls(page, 'db.append')).filter((c) => c[1] === 'mw.c')[1][2];
    assert.deepEqual(reply.replyTo, { l: eve.id, h: eveComment });
    await go(page, '/');
    await waitFor(page, () => document.querySelectorAll('#feed article').length === 4);
    await waitFor(page, () => true);
    assert.ok((await calls(page, 'hub.unfollow')).some((c) => c[1] === eve.id), 'leaving the thread lets go of the commenter\'s page');
    assert.deepEqual(problems, []);
    await context.close();
  });

  it('reactions: one per member per target, counts say "from people you follow", and taking one back removes the key', async () => {
    const { context, page, problems } = await o('/', world());
    await waitFor(page, () => document.querySelectorAll('#feed article').length === 4);
    const card = page.locator('#feed article', { hasText: 'Hello from Bo' });
    const key = 're/' + H.ledgerId(2) + '/' + BO_POST;
    await card.locator('[data-react="+1"]').click();
    await waitFor(page, () => document.querySelector('[data-react="+1"][aria-pressed="true"]'));
    assert.deepEqual((await calls(page, 'db.set')).map((c) => [c[1], c[2]]), [[key, { r: '+1' }]]);
    assert.equal(await card.locator('.react-note').textContent(), '1 from people you follow');
    // Cy, whom you follow, reacts as well; Dave, whom you do not follow, is not counted.
    await page.evaluate(([cy, k]) => __mwMock.remoteKv(cy, k, { r: 'heart' }), [H.ledgerId(3), key]);
    await waitFor(page, () => document.querySelector('.react-note') && document.querySelector('#feed article:nth-child(2) .react-note').textContent === '2 from people you follow');
    assert.equal(await card.locator('[data-react="heart"]').textContent(), 'Love 1');
    // A change of mind replaces the reaction instead of adding one.
    await card.locator('[data-react="laugh"]').click();
    await waitFor(page, () => document.querySelector('[data-react="laugh"][aria-pressed="true"]'));
    assert.equal(await card.locator('[data-react="+1"]').textContent(), 'Like');
    assert.equal(await card.locator('.react-note').textContent(), '2 from people you follow');
    await card.locator('[data-react="laugh"]').click();
    await waitFor(page, () => !document.querySelector('[data-react][aria-pressed="true"]'));
    assert.ok((await calls(page, 'db.del')).length === 0 && (await calls(page, 'db.set')).some((c) => c[2] === null), 'taking it back deletes the key');
    assert.equal(await card.locator('.react-note').textContent(), '1 from people you follow');
    assert.deepEqual(problems, []);
    await context.close();
  });

  it('edit with history, delete, hide, block and report on a post', async () => {
    const { context, page, problems } = await o('/', world(), { config: { appName: 'Social', directory: false, moderationContact: 'abuse@hub.example' }, context: { permissions: ['clipboard-read', 'clipboard-write'] } });
    await waitFor(page, () => document.querySelectorAll('#feed article').length === 4);
    const mine = page.locator('#feed article', { hasText: 'my own post' });
    await mine.locator('.menu summary').click();
    await mine.locator('[data-act="edit"]').click();
    await waitFor(page, () => document.querySelector('[data-composer="edit"]'));
    assert.equal(await page.locator('[data-composer="edit"] textarea').inputValue(), 'my own post');
    await page.locator('[data-composer="edit"] textarea').fill('my own post, edited');
    await page.click('[data-composer="edit"] button[type="submit"]');
    await waitFor(page, () => document.querySelector('#feed article .post-body').textContent === 'my own post, edited');
    const edit = (await calls(page, 'db.append')).find((c) => c[1] === 'mw.post');
    assert.deepEqual(edit[2], { text: 'my own post, edited', edit: MINE });
    const edited = page.locator('#feed article').first();
    await waitFor(page, () => document.querySelector('#feed article .badge') && /edited/.test(document.querySelector('#feed article').textContent));
    assert.equal(await edited.locator('.badge', { hasText: 'edited' }).count(), 1);
    assert.equal((await feedKeys(page))[0], H.ledgerId(1) + '/' + MINE, 'an edit keeps the post where it was');
    await edited.locator('.history summary').click();
    assert.match(await edited.locator('.history li').first().textContent(), /my own post$/);
    // Delete: the tombstone covers every version, and it takes two taps.
    await edited.locator('.menu summary').click();
    await tap2(edited.locator('.menu-list button', { hasText: 'Delete' }));
    await waitFor(page, () => document.querySelectorAll('#feed article').length === 3);
    assert.equal((await calls(page, 'db.tombstone')).length, 2, 'the original and the edit');
    // Hide is local; Block drops the person on this device. Report (R 3.5): a personal page's only moderator is the person it is about,
    // and mw.report.send from your home would reach nobody, so nothing goes through the site: the dialog names the hub's moderation
    // contact and copies the details (metadata only) to send there.
    const boCard = page.locator('#feed article', { hasText: 'Hello from Bo' });
    await boCard.locator('.menu summary').click();
    await boCard.locator('[data-act="report"]').click();
    assert.match(await text(page, '#rep-where'), /^Reports about a personal page go to this hub, not to the person whose page it is, so nothing is sent from here\. Copy the details and send them to: abuse@hub\.example\./);
    assert.equal(await page.locator('dialog button', { hasText: 'Send report' }).count(), 0, 'no "Send report" that would reach nobody');
    await page.selectOption('#rep-reason', 'spam');
    await page.fill('#rep-note', 'looks like spam');
    await page.locator('dialog button', { hasText: 'Copy the details' }).click();
    await waitFor(page, () => Array.from(document.querySelectorAll('.toast.ok')).some((t) => t.textContent === 'Copied. Send the details to abuse@hub.example.'));
    assert.ok(!/Report sent/.test(await page.locator('#toasts').textContent()), 'the page never says "Report sent." for a report nobody received');
    const copied = await page.evaluate(() => navigator.clipboard.readText());
    assert.match(copied, /^Report: spam\nPost: http:\/\/127\.0\.0\.1:\d+\/@[a-z2-7]{32}\/p\/[0-9a-f]{64}\nPage ledger: mw1:[A-Za-z0-9_-]{27}\nEntry: [0-9a-f]{64}\nWritten by: p256:/);
    assert.ok(copied.includes(BO_POST) && copied.includes(boPub) && copied.endsWith('\nNote: looks like spam'), copied);
    assert.equal((await calls(page, 'report.send')).length, 0);
    await boCard.locator('.menu summary').click();
    await boCard.locator('[data-act="hide"]').click();
    await waitFor(page, () => document.querySelectorAll('#feed article').length === 2);
    const cyCard = page.locator('#feed article', { hasText: 'Cy says hi' });
    await cyCard.locator('.menu summary').click();
    await tap2(cyCard.locator('.menu-list button', { hasText: 'Block' }));
    await waitFor(page, () => document.querySelectorAll('#feed article').length === 1);
    assert.ok((await calls(page, 'chat.contacts.block')).some((c) => c[1] === cyPub));
    assert.deepEqual(problems, []);
    await context.close();
  });

  it('wall setting and mw.ok: replies from people you follow are accepted in batches of at most 20 refs; "approve each" waits for a tap', async () => {
    const { context, page, problems } = await o('/settings/privacy', world());
    await waitFor(page, () => document.querySelector('#wall-follow'));
    assert.equal(await page.$eval('#wall-follow', (i) => i.checked), true, 'people I follow is the default');
    // Reply notices from Bo (followed): accepted without asking.
    const cmt = (n) => ({ l: H.ledgerId(2), h: H.hashOf('c' + n) });
    const target = { l: H.ledgerId(1), h: MINE };
    const msg = (n) => ({ from: { pub: boPub, name: 'Bo', short: boShort }, text: notice({ k: 'reply', from: H.ledgerId(2), ref: cmt(n), target }) });
    await page.evaluate((m) => __mwMock.chatReceive(m), msg(1));
    await waitFor(page, () => JSON.parse(localStorage.getItem('social.okQueue') || '[]').length === 1);
    assert.equal(await page.evaluate(() => window.__social.ctx.data.flushOk()), 1);
    const oks = (await calls(page, 'db.append')).filter((c) => c[1] === 'mw.ok');
    assert.deepEqual(oks.map((c) => c[2]), [{ refs: [cmt(1)] }]);
    // 45 refs at once: batches of at most 20 refs, none over the value cap.
    await page.evaluate((refs) => window.__social.ctx.data.queueOk(refs), Array.from({ length: 45 }, (_, i) => ({ l: H.ledgerId(2), h: H.hashOf('b' + i) })));
    await page.evaluate(() => window.__social.ctx.data.flushOk());
    const batches = (await calls(page, 'db.append')).filter((c) => c[1] === 'mw.ok').slice(1).map((c) => c[2].refs);
    assert.equal(batches.flat().length, 45);
    for (const b of batches) { assert.ok(b.length <= 20); assert.ok(new TextEncoder().encode(JSON.stringify({ refs: b })).length <= 2048); }
    // approve each
    await page.click('#wall-approve');
    await waitFor(page, () => window.__social.ctx.data.own().profile.wall === 'approve');
    const sets = (await calls(page, 'db.set')).filter((c) => c[1] === '_mw.cfg');
    assert.deepEqual(sets, [], 'the wall choice is not written to _mw.cfg: the ledger hides a _mw.cfg with a key it does not know (R 2.5.5, src/chain/state.js)');
    assert.deepEqual((await calls(page, 'db.append')).filter((c) => c[1] === 'mw.prof').pop()[2], { bio: '', wall: 'approve' }, 'it is kept in the mw.prof item');
    await page.evaluate((m) => __mwMock.chatReceive(m), msg(99));
    await go(page, '/notifications');
    await waitFor(page, () => document.querySelector('#wall-queue') && !document.querySelector('#wall-queue').hidden);
    assert.match(await text(page, '#wall-queue h2'), /Waiting for your approval \(1\)/);
    const before = (await calls(page, 'db.append')).filter((c) => c[1] === 'mw.ok').length;
    await page.click('#wall-queue [data-act="accept"]');
    await waitFor(page, () => document.querySelector('#wall-queue').hidden);
    await page.evaluate(() => window.__social.ctx.data.flushOk());
    assert.equal((await calls(page, 'db.append')).filter((c) => c[1] === 'mw.ok').length, before + 1);
    // nobody: nothing is queued
    await go(page, '/settings/privacy');
    await page.click('#wall-nobody');
    await waitFor(page, () => window.__social.ctx.data.own().profile.wall === 'nobody');
    await page.evaluate((m) => __mwMock.chatReceive(m), msg(100));
    await page.waitForTimeout(150);
    assert.equal(await page.evaluate(() => JSON.parse(localStorage.getItem('social.okQueue') || '[]').length + JSON.parse(localStorage.getItem('social.wallQueue') || '[]').length), 0);
    assert.deepEqual(problems, []);
    await context.close();
  });

  it('deep links: /@label/p/hash works on reload; an unknown address and an unknown post say so in the exact words', async () => {
    const path = '/@' + H.label(2) + '/p/' + BO_POST;
    const { context, page, problems } = await o(path, world());
    await waitFor(page, () => document.querySelector('[data-key]'));
    assert.equal(await text(page, '[data-key] .post-body'), 'Hello from Bo');
    await page.reload();
    await page.waitForSelector('[data-key] .post-body');
    assert.equal(await text(page, '[data-key] .post-body'), 'Hello from Bo');
    assert.equal(new URL(page.url()).pathname, path);
    await go(page, '/nowhere/at/all');
    assert.equal(await text(page, '#view .card p'), "This page doesn't exist in this app.");
    assert.equal(await text(page, '#view-title'), 'Page not found');
    await go(page, '/@' + H.label(2) + '/p/' + H.hashOf('missing'));
    await waitFor(page, () => document.querySelector('#view .card p'));
    assert.equal(await text(page, '#view .card p'), "This post isn't in the copies this browser has. It may have been removed, or nobody who has it is online.");
    await page.goBack(); await page.goBack();
    await waitFor(page, (p) => location.pathname === p, path);
    await page.waitForSelector('[data-key] .post-body');
    await page.goForward();
    await waitFor(page, () => location.pathname === '/nowhere/at/all');
    assert.equal(await text(page, '#view .card p'), "This page doesn't exist in this app.");
    assert.deepEqual(problems, []);
    await context.close();
  });

  it('empty and offline states: the follow-nobody sentence, the catch-up line and "Showing what this device has"', async () => {
    const sc = H.scenario({ name: 'Ada' });
    const { context, page } = await o('/', sc);
    await waitFor(page, () => document.querySelector('#feed-empty .state'));
    assert.equal(await text(page, '#feed-empty p'), "You don't follow anyone yet. Share your QR code or open a friend's link.");
    assert.equal(await page.locator('#feed-empty a', { hasText: 'Show my QR code' }).count(), 1);
    await page.click('#feed-empty button');
    assert.equal(await visible(page, '#follow-form'), true);
    await page.fill('#follow-link', 'https://' + H.label(7) + '.hub.example/');
    await page.click('#follow-form button[type="submit"]');
    assert.match(await text(page, '#follow-form [role="status"]'), /has no pointer, so this browser cannot find the page/);
    await context.setOffline(true);
    await waitFor(page, () => /^Showing what this device has\. Last updated \d\d:\d\d\.$/.test(document.querySelector('#sync-line').textContent));
    await context.setOffline(false);
    await waitFor(page, () => document.querySelector('#sync-line').textContent === '');
    await context.close();
  });

  it('shares and quotes (mw.q) show the original under your note and tell its author; the Replies filter lists comments; a mention picker writes @short ids and ten is the limit', async () => {
    const eveComment = H.hashOf('c-in-replies');
    const cyL = H.ledger(3, { name: 'Cy', posts: [{ ts: now - 60 * MIN, text: 'Cy says hi', h: CY_POST }], lists: { 'mw.c': [H.item(eveComment, cyPub, now - 2 * MIN, { text: 'Cy commented somewhere', target: { l: H.ledgerId(2), h: BO_POST } })] } });
    const sc = world(); sc.ledgers = [bo(), cyL];
    const { context, page, problems } = await o('/', sc);
    await waitFor(page, () => document.querySelectorAll('#feed article').length === 4);
    await page.click('[data-filter="replies"]');
    await waitFor(page, () => document.querySelectorAll('#feed article').length === 1);
    assert.equal(await text(page, '#feed article .post-body'), 'Cy commented somewhere');
    assert.match(await text(page, '#feed article .small.muted'), /^In reply to a post by Bo$/);
    await page.click('[data-filter="all"]');
    await waitFor(page, () => document.querySelectorAll('#feed article').length === 4);
    const card = page.locator('#feed article', { hasText: 'Hello from Bo' });
    await card.locator('[data-act="share"]').click();
    await page.fill('#share-note', 'worth a read');
    await page.locator('dialog button', { hasText: 'Share' }).click();
    await waitFor(page, () => document.querySelectorAll('#feed article[data-type="share"]').length === 1);
    const q = (await calls(page, 'db.append')).find((c) => c[1] === 'mw.q');
    assert.deepEqual(q[2], { target: { l: H.ledgerId(2), h: BO_POST }, text: 'worth a read' });
    const share = page.locator('#feed article[data-type="share"]');
    assert.match(await share.locator('.who').textContent(), /^Ada \(.{8}\)shared/);
    assert.equal(await share.locator('.post-body').first().textContent(), 'worth a read');
    assert.equal(await share.locator('blockquote .post-body').textContent(), 'Hello from Bo');
    const notices = (await calls(page, 'chat.dm.send')).map((c) => c[2].text).filter((t) => t.includes('"k":"share"'));
    assert.equal(notices.length, 1, 'the author of the shared post is told');
    // A mention picker puts the short id in the text; the counter and the limit follow.
    const area = page.locator('[data-composer="post"] textarea');
    await area.fill('hello ');
    await page.selectOption('[data-composer="post"] select', boShort);
    assert.equal(await area.inputValue(), 'hello @' + boShort + ' ');
    await area.fill(Array.from({ length: 11 }, (_, i) => '@' + i.toString(16).padStart(8, '0')).join(' '));
    assert.equal(await page.locator('[data-composer="post"] button[type="submit"]').isDisabled(), true);
    assert.equal(await text(page, '[data-composer="post"] .error'), ERROR_TEXT.MENTIONS);
    assert.equal(ERROR_TEXT.MENTIONS, 'You can mention at most 10 people in one post.');
    assert.deepEqual(problems, []);
    await context.close();
  });

  it('people you may know: followed by people you follow, offered in Settings, and a follow carries the pointer they published', async () => {
    const dee = H.pointerFor(4);
    const deeL = H.ledger(4, { id: dee.id, name: 'Dee', posts: [{ ts: now - 5 * MIN, text: 'Dee here' }] });
    const boL = bo(); boL.lists['mw.f'] = [H.item(H.hashOf('bf1'), boPub, now - MIN, { l: dee.id, ptr: dee.pointer })];
    const sc = world({ pointers: { [dee.pointer]: dee.id } }); sc.ledgers = [boL, cy(), deeL];
    const { context, page, problems } = await o('/settings/storage', sc);
    await waitFor(page, () => document.querySelector('#suggestions li'));
    assert.equal(await text(page, '#suggestions li a'), 'Page ' + dee.label.slice(0, 8), 'a page this browser does not hold is not given a name it has not read');
    assert.equal(await text(page, '#suggestions li .short'), 'Followed by Bo');
    await page.click('#suggestions li button');
    await waitFor(page, () => !document.querySelector('#suggestions li') || /Nobody to suggest/.test(document.querySelector('#suggestions').textContent));
    assert.deepEqual((await calls(page, 'hub.follow')).map((c) => c[1]), [dee.pointer], 'the pointer from the public follow list is what is followed');
    assert.deepEqual((await calls(page, 'db.append')).filter((c) => c[1] === 'mw.f').map((c) => c[2]), [{ l: dee.id, ptr: dee.pointer }]);
    assert.deepEqual(problems, []);
    await context.close();
  });

  it('WebKit runs the page logic: the merged timeline, posting, a reaction and a deep link', async (t) => {
    if (!env.webkit) return t.skip('WebKit is not installed for Playwright');
    const { context, page, problems } = await open(env, env.webkit, '/', world());
    await waitFor(page, () => document.querySelectorAll('#feed article').length === 4);
    assert.deepEqual(await feedTexts(page), ['my own post', 'Hello from Bo', 'Cy says hi', 'older from Bo']);
    await page.locator('[data-composer="post"] textarea').fill('Hello from WebKit');
    await page.click('[data-composer="post"] button[type="submit"]');
    await waitFor(page, () => document.querySelector('#feed article .post-body').textContent === 'Hello from WebKit');
    await page.locator('#feed article', { hasText: 'Cy says hi' }).locator('[data-react="heart"]').click();
    await waitFor(page, () => document.querySelector('[data-react="heart"][aria-pressed="true"]'));
    await go(page, '/@' + H.label(2) + '/p/' + BO_POST);
    await page.waitForSelector('[data-key] .post-body');
    assert.deepEqual(problems, []);
    await context.close();
  });
});
