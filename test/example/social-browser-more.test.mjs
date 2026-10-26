// Browser tests for examples/social, part 3: private photos and videos (poster grid, playback through Range requests, upload, share,
// revoke), messages and presence, alerts, and groups (join request, member posts, moderation, group reactions, the Lobby).
// Mock SDK; Chromium with the local-only flags, WebKit on 127.0.0.1 for playback. Run: node --test test/example/social-browser-more.test.mjs
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { pw, setup, open, text, count, visible, waitText, waitFor, calls, body, go, pngFile, quiet } from './social-browser-lib.mjs';
import * as H from './social-helpers.mjs';
import { ERROR_TEXT, AVAILABLE, CONNECTED } from '../../examples/social/js/strings.js';
import { encodeNotice } from '../../examples/social/js/notices.js';
import { authorScope } from '../../examples/social/js/ids.js';

const now = Date.now();
const MIN = 60000;
const me = H.pubOf(1), boPub = H.pubOf(2), cyPub = H.pubOf(3);
const boShort = H.shortIdOf(boPub), cyShort = H.shortIdOf(cyPub);
const BO_POST = H.hashOf('bopost'), MINE = H.hashOf('mine1');
const bo = () => H.ledger(2, { name: 'Bo', posts: [{ ts: now - 30 * MIN, text: 'Hello from Bo @' + H.shortIdOf(me), h: BO_POST }] });
const cy = () => H.ledger(3, { name: 'Cy', posts: [{ ts: now - 60 * MIN, text: 'Cy says hi' }] });
const contacts = [{ pub: boPub, nick: 'Bo', short: boShort }, { pub: cyPub, nick: 'Cy', short: cyShort }];
const MEDIA = [
  { id: 'm1', kind: 'image', mime: 'image/png', len: 2000, w: 10, h: 10, from: 'me', t: now - MIN, available: 'kept' },
  { id: 'm2', kind: 'video', mime: 'video/mp4', len: 18833, w: 320, h: 180, from: 'me', t: now - 2 * MIN, available: 'online' },
  { id: 'm3', kind: 'image', mime: 'image/png', len: 3000, w: 10, h: 10, from: 'bo', t: now - 3 * MIN, available: 'unknown' },
];
function home(extra = {}, o = {}) {
  return H.scenario(Object.assign({ name: 'Ada', followed: [2, 3], ledgers: [bo(), cy()], chat: { enabled: true, contacts }, lists: { 'mw.post': [H.item(MINE, me, now - 20 * MIN, { text: 'my own post' })] } }, o, { extra }));
}
const msgFrom = (pub, name, short, t) => ({ from: { pub, name, short }, text: t, id: 'in' + Math.random().toString(16).slice(2), t: Date.now() });

describe('Social in a browser, media, messages, alerts and groups', { skip: pw ? false : 'playwright is not installed' }, () => {
  let env;
  before(async () => { env = await setup(); });
  after(async () => { await env.close(); });
  const o = (path, scenario, opts) => open(env, env.chromium, path, scenario, opts);

  it('private media: the poster grid says whether the hub keeps each item, and uploading shows the phases and refreshes the grid', async () => {
    const { context, page, problems } = await o('/media', home({ media: MEDIA }));
    await waitFor(page, () => document.querySelectorAll('#poster-grid img').length === 2);
    assert.deepEqual(await page.$$eval('#poster-grid .poster > p', (n) => n.map((x) => x.textContent)), [AVAILABLE.kept, AVAILABLE.other], 'the exact strings of R 3.5');
    assert.deepEqual(await page.$$eval('#poster-grid img', (n) => n.map((x) => new URL(x.src).search)), ['?part=poster', '?part=poster'], 'posters come from open(id, { part: "poster" })');
    assert.deepEqual((await calls(page, 'media.open')).map((c) => c[2]), ['poster', 'poster']);
    await page.click('button.tab:has-text("Shared with me")');
    await waitFor(page, () => document.querySelectorAll('#poster-grid li').length === 1);
    assert.equal(await text(page, '#poster-grid .poster > p'), AVAILABLE.other, 'unknown availability still carries the caveat');
    await page.click('button.tab:has-text("Mine")');
    await waitFor(page, () => document.querySelectorAll('#poster-grid li').length === 2);
    const seen = [];
    page.on('console', () => {});
    await page.setInputFiles('#media-file', pngFile('holiday.png'));
    await waitFor(page, () => document.querySelector('#media-upload'));
    assert.equal((await calls(page, 'media.upload')).length, 0, 'choosing a file uploads nothing: the loader accepts mw.media.upload only from a click');
    await page.click('#media-upload');
    await waitFor(page, () => /^Done\. Photo/.test(document.querySelector('#upload-line').textContent));
    assert.equal((await calls(page, 'media.upload')).length, 1);
    const names = (await page.evaluate(() => __mwMock.calls.map((c) => [c[0], c[1]]))).filter((c) => c[0] === 'media.upload' || (c[0] === 'db.set' && c[1] === '_mw.cfg')).map((c) => c[0]);
    assert.deepEqual(names, ['db.set', 'media.upload'], 'a personal site starts with no switch for private media: the first upload turns it on, then uploads');
    const cfgWrite = (await calls(page, 'db.set')).find((c) => c[1] === '_mw.cfg')[2];
    assert.deepEqual(cfgWrite, { media: 'members' });
    await waitFor(page, () => document.querySelectorAll('#poster-grid li').length === 3);
    assert.match(await text(page, '#media-hint'), /^Encrypted before it leaves this device\. Only you, after signing in, and the people you share it with can open it\./);
    void seen;
    assert.deepEqual(problems, []);
    await context.close();
  });

  it('private media: a video plays from the worker route with Range requests (206), and a photo opens; the viewer offers share, revoke, keep, ask the hub and delete', async () => {
    const { context, page, problems } = await o('/media/m2', home({ media: MEDIA }));
    await page.waitForSelector('#viewer video');
    const src = await page.getAttribute('#viewer video', 'src');
    assert.equal(src, '/_mw/media/v-m2', 'a plain <video src> on the session URL');
    assert.match(await page.getAttribute('#viewer video', 'poster'), /\?part=poster$/);
    await page.waitForFunction(() => document.querySelector('#viewer video').readyState >= 1, null, { timeout: 15000 });
    assert.ok(Math.abs((await page.$eval('#viewer video', (v) => v.duration)) - 4) < 0.1);
    await page.$eval('#viewer video', (v) => { v.currentTime = 2.5; });
    await page.waitForFunction(() => { const v = document.querySelector('#viewer video'); return !v.seeking && v.readyState >= 2 && Math.abs(v.currentTime - 2.5) < 0.6; }, null, { timeout: 15000 });
    const ranged = env.srv.hits.filter((h) => h.path === '/_mw/media/v-m2' && !h.search);
    assert.ok(ranged.length > 0 && ranged.every((h) => h.status === 206), 'every request for the video carried a Range: ' + JSON.stringify(ranged.map((h) => [h.range, h.status])));
    assert.match(await text(page, '#media-meta'), new RegExp('^' + AVAILABLE.other.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\. 18\\.4 KB\\. 4 s\\.'));
    assert.deepEqual(await page.$$eval('#media-actions > *', (n) => n.map((x) => x.textContent.trim())), ['Share', 'Take back access', 'Ask the hub to keep it', 'Keep it available while this page is open', 'Delete']);
    await page.check('#keep-available');
    await waitFor(page, async () => true);
    assert.deepEqual((await calls(page, 'media.keepAvailable')).map((c) => [c[1], c[2]]), [['m2', true]]);
    await page.click('#media-actions button:has-text("Ask the hub")');
    await waitFor(page, () => document.querySelector('.toast.ok'));
    assert.equal((await calls(page, 'media.pinRequest')).length, 1);
    // Share with a contact (the contact list opens a card once per session), then take access back with a re-encryption.
    await page.click('#share');
    await page.waitForSelector('dialog');
    assert.match(await text(page, 'dialog .small'), /People you share with can open it after they accept, and they can keep a copy\./);
    await page.check('dialog input[value="' + boPub + '"]');
    await page.click('dialog button:has-text("Share")');
    await waitFor(page, () => document.querySelector('.toast.ok'));
    assert.deepEqual((await calls(page, 'media.share'))[0].slice(1), ['m2', { to: [boPub] }]);
    await page.click('#revoke');
    await page.waitForSelector('dialog');
    await page.check('dialog input[value="' + boPub + '"]');
    await page.check('#reenc');
    await page.click('dialog button:has-text("Take back")');
    await waitFor(page, async () => true);
    await page.waitForTimeout(150);
    assert.deepEqual((await calls(page, 'media.revoke'))[0].slice(1), ['m2', { from: [boPub], reencrypt: true }]);
    await quiet(page);
    const del = await page.locator('#media-actions button', { hasText: 'Delete' }).elementHandle();
    await del.click(); await del.click();
    await waitFor(page, () => location.pathname === '/media');
    assert.equal((await calls(page, 'media.delete')).length, 1);
    assert.ok((await calls(page, 'media.close')).length >= 1, 'leaving closes the playback sessions');
    await go(page, '/media/m1');
    await page.waitForSelector('#viewer img');
    assert.equal(await page.getAttribute('#viewer img', 'src'), '/_mw/media/i-m1');
    assert.deepEqual(problems, []);
    await context.close();
  });

  it('private media: a revoked or unavailable item says so in words, and an unplayable video offers a download', async () => {
    const r = await o('/media/m1', home({ media: MEDIA, revoked: ['m1'] }));
    await waitFor(r.page, () => document.querySelector('#viewer .error'));
    assert.equal(await text(r.page, '#viewer .error'), 'Access to this was taken back.');
    await go(r.page, '/media/nothere');
    await waitFor(r.page, () => document.querySelector('#viewer .error'));
    assert.equal(await text(r.page, '#viewer .error'), 'Nobody who has this file is online right now.');
    await r.context.close();
  });

  it('WebKit plays the private video through the same route and seeks with Range requests', async (t) => {
    if (!env.webkit) return t.skip('WebKit is not installed for Playwright');
    const before = env.srv.hits.length;
    const { context, page } = await open(env, env.webkit, '/media/m2', home({ media: MEDIA }));
    await page.waitForSelector('#viewer video');
    await page.waitForFunction(() => document.querySelector('#viewer video').readyState >= 1, null, { timeout: 20000 });
    await page.$eval('#viewer video', (v) => { v.currentTime = 2.5; });
    await page.waitForFunction(() => { const v = document.querySelector('#viewer video'); return !v.seeking && v.readyState >= 2 && Math.abs(v.currentTime - 2.5) < 0.6; }, null, { timeout: 20000 });
    const ranged = env.srv.hits.slice(before).filter((h) => h.path === '/_mw/media/v-m2' && !h.search);
    if (process.platform === 'linux') {
      // WebKit on Linux (GStreamer) first asks for the whole file without a Range header, then seeks with Range; on macOS every
      // request carries Range. The seek above proves the 206 route; here only the pattern of the first request differs.
      assert.ok(ranged.some((h) => h.status === 206) && ranged.every((h) => h.status === 200 || h.status === 206), 'WebKit requested the video: ' + JSON.stringify(ranged));
    } else {
      assert.ok(ranged.length > 0 && ranged.every((h) => h.status === 206));
    }
    await context.close();
  });

  it('messages: off until you turn them on (with the loader\'s refusal in words), then conversations, a thread, verification and the "Connected to you now" list', async () => {
    let r = await o('/messages', home({ chat: { enabled: false, enableError: 'E_HOST_ONLY', contacts } }));
    assert.match(await text(r.page, '#view .state'), /Messages are off\./);
    assert.ok((await body(r.page)).includes('Conversations are never written to the site ledger. Anyone connected can record the encrypted copies.'));
    await r.page.click('#chat-on');
    await waitFor(r.page, () => document.querySelector('#view .error') && document.querySelector('#view .error').textContent.length > 0);
    assert.equal(await text(r.page, '#view .error'), 'This feature needs peer connections, and you chose host only.');
    await r.context.close();
    r = await o('/messages', home({ chat: { enabled: false, contacts } }));
    await r.page.click('#chat-on');
    await waitFor(r.page, () => document.querySelector('#presence'));
    assert.equal((await calls(r.page, 'chat.enable')).length, 1);
    assert.deepEqual((await calls(r.page, 'db.set')).find((c) => c[1] === '_mw.cfg')[2], { chat: 'members' }, 'the owner of a personal site turns messages on for it before asking the loader');
    await r.context.close();
    const sc = home({ chat: { enabled: true, contacts, presence: [{ pub: boPub, nick: 'Bo', short: boShort, status: 'here', since: now }] } });
    const { context, page, problems } = await o('/messages', sc);
    assert.equal(await text(page, '#presence h2'), CONNECTED);
    assert.equal(await text(page, '#show-contacts'), 'Show my conversations');
    assert.equal((await calls(page, 'chat.contacts.list')).length, 0, 'reading contacts opens a card, so it waits for a tap');
    await page.click('#show-contacts');
    await waitFor(page, () => document.querySelectorAll('#contacts .convo-list li').length === 2);
    assert.equal(await text(page, '#presence .convo-list li'), 'Bo');
    await page.click('#contacts a[href="/messages/' + boShort + '"]');
    await page.waitForSelector('#load-thread');
    await page.click('#load-thread');
    await waitFor(page, () => document.querySelector('#bubbles'));
    assert.equal(await text(page, '#bubbles p'), 'No messages yet.');
    await page.fill('#dm-text', 'Hi Bo');
    await page.click('#dm-send');
    await waitFor(page, () => document.querySelectorAll('.bubble.me').length === 1);
    assert.deepEqual((await calls(page, 'chat.dm.send')).map((c) => [c[1], c[2]]), [[boPub, { text: 'Hi Bo' }]]);
    assert.match(await text(page, '.bubble.me small'), /Sent$/, 'the page says Sent and nothing about delivery: the loader\'s delivery strings are off until their gate rows pass');
    assert.match(await text(page, '#view .badge'), /^New contact$/, 'until you compare a code the contact is marked new');
    await page.click('#verify');
    await waitFor(page, () => document.querySelector('#verify-code'));
    assert.match(await text(page, '#verify-code p'), /Compare this code with Bo in person or over a call you trust: 4829 1305$/);
    await page.click('#codes-match');
    await waitFor(page, () => document.querySelector('#verified-line'));
    assert.match(await text(page, '#verified-line'), /^Verified You compared a code with Bo on this device\.$/);
    assert.equal(await count(page, '#verify'), 0);
    assert.deepEqual(await page.evaluate(() => JSON.parse(localStorage.getItem('social.verified'))), [boPub]);
    // A message from Bo arrives; a notice from Bo never shows up as a conversation message.
    await page.evaluate((m) => { __mwMock.chatReceive(m.a); __mwMock.chatReceive(m.b); }, { a: msgFrom(boPub, 'Bo', boShort, 'Hi back'), b: msgFrom(boPub, 'Bo', boShort, encodeNotice({ k: 'follow', from: H.ledgerId(2) })) });
    await waitFor(page, () => document.querySelectorAll('.bubble').length === 2);
    assert.deepEqual(await page.$$eval('.bubble', (n) => n.map((x) => x.firstChild.textContent)), ['Hi Bo', 'Hi back']);
    assert.deepEqual(problems, []);
    await context.close();
  });

  it('messages: a message that arrives while you are elsewhere is announced and counted; open it and the count goes; blocking drops the person', async () => {
    const { context, page, problems } = await o('/', home());
    await waitFor(page, () => document.querySelectorAll('#feed article').length >= 2); // the followed pages are in, so the sender\'s name is known
    await page.evaluate((m) => __mwMock.chatReceive(m), msgFrom(cyPub, 'Cy', cyShort, 'Are you there?'));
    await waitFor(page, () => document.querySelector('#alerts-count') && !document.querySelector('#alerts-count').hidden);
    assert.equal(await text(page, '#alerts-count'), '1');
    await waitFor(page, () => document.querySelector('#live-polite').textContent === 'New message from Cy');
    await go(page, '/notifications');
    await waitFor(page, () => document.querySelector('#unread-messages'));
    assert.match(await text(page, '#unread-messages'), /Cy \(1\)/);
    await page.click('#unread-messages a');
    await page.waitForSelector('#contacts, #load-thread, #view .state');
    assert.deepEqual(problems, []);
    await context.close();
  });

  it('alerts: follows, replies, mentions and shares arrive as notices, show once however often they arrive, and are marked seen', async () => {
    const { context, page, problems } = await o('/', home());
    const l = H.ledgerId(2), ref = { l, h: H.hashOf('their-comment') }, target = { l: H.ledgerId(1), h: MINE };
    const send = (n) => page.evaluate((m) => __mwMock.chatReceive(m), msgFrom(boPub, 'Bo', boShort, encodeNotice(n)));
    await send({ k: 'follow', from: l });
    await send({ k: 'follow', from: l });
    await send({ k: 'mention', from: l, ref: { l, h: BO_POST } });
    await send({ k: 'share', from: l, ref: { l, h: H.hashOf('share1') }, target });
    await send({ k: 'reply', from: l, ref, target });
    await waitFor(page, () => !document.querySelector('#alerts-count').hidden && document.querySelector('#alerts-count').textContent === '4');
    await go(page, '/notifications');
    await waitFor(page, () => document.querySelectorAll('#alerts > li').length >= 4);
    const verbs = await page.$$eval('#alerts > li', (n) => n.map((x) => x.dataset.kind));
    assert.deepEqual(verbs.sort(), ['follow', 'mention', 'reply', 'share'], 'the second follow notice was the same event');
    assert.match(await text(page, '#alerts > li[data-kind="follow"]'), /Bo followed you\./);
    assert.match(await text(page, '#alerts > li[data-kind="reply"]'), /Bo replied to your post\. Open/);
    assert.equal(await page.getAttribute('#alerts > li[data-kind="mention"] a:last-of-type', 'href'), '/@' + H.label(2) + '/p/' + BO_POST);
    await page.click('#mark-seen');
    await waitFor(page, () => document.querySelector('#alerts-count').hidden);
    assert.equal(await page.$$eval('#alerts > li .badge', (n) => n.length), 0);
    assert.deepEqual(problems, []);
    await context.close();
  });
});

describe('Social in a browser, groups', { skip: pw ? false : 'playwright is not installed' }, () => {
  let env;
  before(async () => { env = await setup(); });
  after(async () => { await env.close(); });
  const OWNER = H.pubOf(50), G = H.ledgerId(50);
  const POST = H.hashOf('grouppost');
  const group = (extra = {}, role = 'reader', policy = {}) => H.scenario({
    me: 1, name: 'Ada', ledgers: [], chat: { enabled: true, contacts },
    extra: Object.assign({
      auth: 'signed-in', role, siteId: G, owner: OWNER, me, short: H.shortIdOf(me), followed: [], siteName: 'Door fans',
      home: { policy: Object.assign({ writers: 'allow', bits: 16, maxValueBytes: 2048, maxChainBytes: 8388608, moderators: [H.pubOf(51)], banned: [], allowCount: 12 }, policy),
        profiles: { [OWNER]: 'Door fans', [boPub]: 'Bo' },
        lists: { 'mw.post': [H.item(POST, boPub, now - 30 * MIN, { text: 'Welcome to the group' })], 'mw.prof': [H.item(H.hashOf('gp'), OWNER, now - 90 * MIN, { bio: 'For people who like doors.' })],
          'mw.c': [H.item(H.hashOf('gc'), boPub, now - 10 * MIN, { text: 'First!', target: { l: G, h: POST } })] } },
    }, extra),
  });
  const o = (path, scenario, opts) => open(env, env.chromium, path, scenario, opts);

  it('a group site: its policy in words, the join request, member posting, comments without mw.ok, reactions as keys', async () => {
    const { context, page, problems } = await o('/', group({ requestJoin: true }));
    assert.equal(await text(page, '#view-title'), 'Door fans');
    assert.match(await text(page, '#group-head'), /Invite-only group: only members can post\. Anyone with this group's address can still read it\. For private conversation, use a private group chat\./);
    assert.match(await text(page, '#group-head'), /1 moderator, 12 members\. Members can keep and forward anything sent here, and can prove to others what you wrote in this group\./);
    assert.match(await text(page, '#group-head'), /For people who like doors\./);
    assert.equal(await count(page, '[data-composer]'), 0, 'not a member yet');
    assert.equal(await text(page, '#group-role'), 'You are not a member yet.');
    assert.match(await text(page, '#group-feed .post-body'), /Welcome to the group/);
    await page.click('#ask-join');
    await waitFor(page, () => /Request sent/.test(document.querySelector('#group-role').textContent));
    assert.equal((await calls(page, 'mod.requestJoin')).length, 1);
    assert.equal(await text(page, '#group-role'), 'Request sent. No moderator may be connected to you now; your request waits for up to 7 days.');
    // The moderators let you in: the page notices the new role and offers the composer.
    await page.evaluate(() => __mwMock.setRole('writer'));
    await page.evaluate(() => window.__social.ctx.data.refresh());
    await waitFor(page, () => document.querySelector('[data-composer="post"]'));
    assert.equal(await text(page, '#group-role'), "You're in.");
    await page.locator('[data-composer="post"] textarea').fill('Hello doors');
    await page.click('[data-composer="post"] button[type="submit"]');
    await waitFor(page, () => document.querySelectorAll('#group-feed article').length === 2);
    assert.deepEqual((await calls(page, 'db.append')).map((c) => [c[1], c[2]]), [['mw.post', { text: 'Hello doors' }]], 'a member writes to the group\'s own ledger');
    // The comment a member wrote on the group ledger shows with the post, with no mw.ok.
    await go(page, '/@' + H.label(50) + '/p/' + POST).catch(() => {});
    await page.evaluate(([l, h]) => window.__social.ctx.go('/@' + window.__social.ctx.data.labelOf(l) + '/p/' + h), [G, POST]);
    await waitFor(page, () => document.querySelectorAll('[data-comment]').length === 1);
    assert.equal(await text(page, '[data-comment] .post-body'), 'First!');
    // A reaction on a group post is an author-scoped key, counted as keys.
    await page.click('[data-react="+1"]');
    await waitFor(page, () => document.querySelector('[data-react="+1"][aria-pressed="true"]'));
    assert.deepEqual((await calls(page, 'db.setMine')).map((c) => [c[1], c[2]]), [['re/' + POST, { r: '+1' }]]);
    assert.equal(await text(page, '.react-note'), '1 from members (counts of keys)');
    const key = authorScope(me) + 're/' + POST;
    assert.ok(await page.evaluate((k) => Object.keys(__mwMock.ledger(__mwMock.scenario.siteId).kv).includes(k), key), 'the key starts with the author\'s own scope');
    assert.deepEqual(problems, []);
    await context.close();
  });

  it('moderators: the queue, accept, decline and deny; remove a post and ban an author (two taps); lift a ban', async () => {
    const sc = group({ modQueue: [{ id: 'q1', kind: 'join', from: { short: 'deadbeef' } }, { id: 'q2', kind: 'report', from: { short: 'cafebabe' } }] }, 'moderator');
    const { context, page, problems } = await o('/', sc);
    await waitFor(page, () => document.querySelector('#mod-panel') && !document.querySelector('#mod-panel').hidden);
    assert.equal(await count(page, '#mod-panel li'), 2);
    await page.click('#mod-panel li:first-child [data-decision="accept"]');
    await waitFor(page, () => document.querySelectorAll('#mod-panel li').length === 1);
    assert.deepEqual((await calls(page, 'mod.decide')).map((c) => c.slice(1)), [['q1', 'accept']]);
    const post = page.locator('#group-feed article').first();
    await post.locator('.menu summary').click();
    await quiet(page);
    const ban = await post.locator('.menu-list button', { hasText: 'Ban author' }).elementHandle();
    await ban.click(); await ban.click();
    await waitFor(page, () => document.querySelectorAll('#group-feed article').length === 0);
    assert.deepEqual((await calls(page, 'mod.ban')).map((c) => c[1]), [boPub]);
    await page.fill('#unban-pub', boPub);
    await page.click('#mod-panel form button[type="submit"]');
    await waitFor(page, () => document.querySelector('.toast.ok'));
    assert.deepEqual((await calls(page, 'mod.unban')).map((c) => c[1]), [boPub]);
    assert.deepEqual(problems, []);
    await context.close();
  });

  it('an open group: anyone signed in may post; the Lobby is a public, signed room', async () => {
    const { context, page, problems } = await o('/', group({}, 'writer', { writers: 'open' }));
    assert.match(await text(page, '#group-head'), /Open group: anyone who is signed in can post, with a small spam fee \(16-bit proof of work per post\)\./);
    await waitFor(page, () => document.querySelector('[data-composer="post"]'));
    assert.match(await text(page, '#lobby'), /Public and signed\. Anyone connected can read this, and a recording proves what you wrote\./);
    await page.click('#join-lobby');
    await waitFor(page, () => !document.querySelector('#lobby form').hidden);
    await page.fill('#room-text', 'anyone here?');
    await page.click('#lobby form button[type="submit"]');
    await waitFor(page, () => document.querySelectorAll('#room-log .bubble').length === 1);
    assert.deepEqual((await calls(page, 'chat.room.send')).map((c) => [c[1], c[2]]), [['Lobby', { text: 'anyone here?' }]]);
    assert.match(await text(page, '#room-log .bubble'), /anyone here\?$/, 'the loader does not echo a room message to its sender, so the form shows it');
    await page.evaluate((m) => __mwMock.roomReceive(m), { room: 'Lobby', from: boPub, text: 'yes, Bo here' });
    await waitFor(page, () => document.querySelectorAll('#room-log .bubble').length === 2);
    assert.equal(await text(page, '#room-log .bubble:last-child small'), boShort + ':', 'a room message names its sender by key, so a stranger shows as the short id');
    assert.equal((await calls(page, 'chat.room.join')).length, 1);
    assert.deepEqual(problems, []);
    await context.close();
  });

  it('report on a group (R 3.5): on its own address it goes to its moderators and the page says how many got it, or that nobody did; from your home it offers the group', async () => {
    const report = async (page) => {
      const post = page.locator('#group-feed article').first();
      await post.locator('.menu summary').click();
      await post.locator('[data-act="report"]').click();
      assert.match(await text(page, '#rep-where'), /to the moderators of this group\. It never sends the picture or video itself\./);
      await page.selectOption('#rep-reason', 'harassment');
      await page.locator('dialog button', { hasText: 'Send report' }).click();
    };
    let r = await o('/', group({ reportSent: 2 }));
    await report(r.page);
    await waitFor(r.page, () => /Report sent to 2 moderators of this group\./.test(document.querySelector('#toasts').textContent));
    assert.deepEqual((await calls(r.page, 'report.send')).map((c) => [c[1].target.h, c[1].reason]), [[POST, 'harassment']]);
    assert.deepEqual(r.problems, []);
    await r.context.close();
    r = await o('/', group({ reportSent: 0 }), { config: { appName: 'Social', directory: false, moderationContact: 'abuse@hub.example' } });
    await report(r.page);
    await waitFor(r.page, () => document.querySelector('.toast.error'));
    assert.equal(await text(r.page, '.toast.error'), 'Nobody received this report: no moderator of this group could be reached. This hub takes reports at: abuse@hub.example.');
    assert.ok(!/Report sent/.test(await r.page.locator('#toasts').textContent()), '{ sent: 0 } never reads as "Report sent."');
    assert.deepEqual(r.problems, []);
    await r.context.close();
    // From your home the group is read-only, and mw.report.send there would go to your own page's moderators (you): nothing is sent.
    const gp = H.pointerFor(50);
    const g = H.ledger(50, { id: gp.id, name: 'Door fans', policy: { writers: 'allow', bits: 16, maxValueBytes: 2048, moderators: [H.pubOf(51)], banned: [], allowCount: 3 }, posts: [{ ts: now - 30 * MIN, text: 'Welcome to the group', h: POST }] });
    g.lists['mw.post'][0].author = boPub;
    const sc = H.scenario({ name: 'Ada', followed: [], ledgers: [g], chat: { enabled: true, contacts }, pointers: { [gp.pointer]: gp.id } });
    r = await o('/g/' + gp.label + '#' + encodeURIComponent(gp.pointer), sc);
    await waitFor(r.page, () => document.querySelector('#group-feed article'));
    const post = r.page.locator('#group-feed article').first();
    await post.locator('.menu summary').click();
    await post.locator('[data-act="report"]').click();
    assert.match(await text(r.page, '#rep-where'), /^This post belongs to a group\. A report sent from here would reach nobody, because a report goes to the moderators of the page it is sent from\. Open the group and report the post there\. This hub has not named a moderation contact\.$/);
    assert.equal(await r.page.locator('dialog button', { hasText: 'Send report' }).count(), 0);
    assert.equal((await calls(r.page, 'report.send')).length, 0);
    assert.deepEqual(r.problems, []);
    await r.context.close();
  });

  it('from your own page a group is read-only: its posts, a way to follow it, and no composer', async () => {
    const gp = H.pointerFor(50);
    const g = H.ledger(50, { id: gp.id, name: 'Door fans', policy: { writers: 'allow', bits: 16, maxValueBytes: 2048, moderators: [], banned: [], allowCount: 3 }, posts: [{ ts: now - 30 * MIN, text: 'Welcome to the group', h: POST }] });
    const sc = H.scenario({ name: 'Ada', followed: [], ledgers: [g], chat: { enabled: true, contacts }, pointers: { [gp.pointer]: gp.id } });
    const { context, page, problems } = await o('/g/' + gp.label + '#' + encodeURIComponent(gp.pointer), sc);
    await waitFor(page, () => document.querySelector('#group-head h2') && document.querySelector('#group-head h2').textContent === 'Door fans');
    assert.equal(await count(page, '[data-composer]'), 0);
    assert.equal(await count(page, '#ask-join'), 0);
    assert.equal(await text(page, '#group-feed .post-body'), 'Welcome to the group');
    await page.click('#follow-group');
    await waitFor(page, () => !document.querySelector('#follow-group'));
    assert.ok((await calls(page, 'db.append')).some((c) => c[1] === 'mw.f' && c[2].l === gp.id), 'following a group is a public follow like any other');
    assert.deepEqual(problems, []);
    await context.close();
  });
});
