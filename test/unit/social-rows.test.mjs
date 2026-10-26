// Unit tests for the social example's pieces the social rows lane added (docs/deviations/rows-social.md): the join request of R 2.5.2
// without mw.mod.requestJoin (examples GAP 4: a join grant to each moderator and the owner over mw.chat.dm.send, which the loader's
// moderation service queues, src/loader/mod.js receive), the pointer a first follow needs (model.js pointerFor) and the notices a
// followed window already shows (notices.js syncedNotices, mentionsOfMe). End-to-end: E-SO-3, E-SO-7 and E-SO-8 in
// test/e2e/scenarios-social-rows.mjs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { joinGrant, joinRecipients, createHub, JOIN_NOTE_MAX } from '../../examples/social/js/hub.js';
import { pointerFor, timelineTop, newerThan, sortKeyOf } from '../../examples/social/js/model.js';
import { syncedNotices, mentionsOfMe } from '../../examples/social/js/notices.js';

const pub = (c) => 'p256:' + c.repeat(87);
const led = (c) => 'mw1:' + c.repeat(27);
const H = 'a'.repeat(64);

test('joinGrant carries the requester key and a trimmed note of at most JOIN_NOTE_MAX characters (mod.js takes t "join")', () => {
  assert.deepEqual(joinGrant(pub('A')), { t: 'join', pub: pub('A') });
  assert.deepEqual(joinGrant(pub('A'), '   '), { t: 'join', pub: pub('A') }, 'a blank note is left out');
  const g = joinGrant(pub('A'), '  ' + 'x'.repeat(500) + '  ');
  assert.equal(g.note.length, JOIN_NOTE_MAX);
  assert.equal(JOIN_NOTE_MAX, 140);
});

test('joinRecipients: the owner and the moderators, each once, never the requester, never a malformed key, at most 51', () => {
  assert.deepEqual(joinRecipients({ owner: pub('O'), moderators: [pub('M'), pub('O'), 'nope', pub('R')], me: pub('R') }), [pub('O'), pub('M')]);
  assert.deepEqual(joinRecipients({}), []);
  const many = Array.from({ length: 80 }, (_, i) => 'p256:' + String(i).padStart(2, '0') + 'B'.repeat(85));
  assert.equal(joinRecipients({ owner: pub('O'), moderators: many, me: pub('R') }).length, 51);
});

test('requestJoin without mw.mod.requestJoin: one dm.send per recipient with the grant; delivered when any browser took it', async () => {
  const sent = [];
  const mw = { chat: { dm: { send: async (to, body) => { sent.push([to, body]); return { state: to === pub('M') ? 'delivered' : 'queued' }; } } }, mod: {} };
  const hub = createHub(mw, null);
  assert.equal(hub.joinBySdk, false);
  const r = await hub.requestJoin(led('G'), { owner: pub('O'), moderators: [pub('M')], me: pub('R'), note: 'hi' });
  assert.deepEqual(r, { sent: 2, delivered: true, states: ['queued', 'delivered'] });
  assert.deepEqual(sent, [[pub('O'), { grant: { t: 'join', pub: pub('R'), note: 'hi' } }], [pub('M'), { grant: { t: 'join', pub: pub('R'), note: 'hi' } }]]);
  // Nobody to ask, no own key, or no messages: NOT_AVAILABLE, nothing faked.
  await assert.rejects(hub.requestJoin(led('G'), { owner: pub('R'), me: pub('R') }), (e) => e.code === 'NOT_AVAILABLE');
  await assert.rejects(hub.requestJoin(led('G'), { owner: pub('O') }), (e) => e.code === 'NOT_AVAILABLE');
  await assert.rejects(createHub({}, null).requestJoin(led('G'), { owner: pub('O'), me: pub('R') }), (e) => e.code === 'NOT_AVAILABLE');
});

test('requestJoin: every send failing rejects with the first error (E_POLICY for a stranger on a site without message requests)', async () => {
  const mw = { chat: { dm: { send: async () => { throw Object.assign(new Error('no requests'), { code: 'E_POLICY' }); } } } };
  await assert.rejects(createHub(mw, null).requestJoin(led('G'), { owner: pub('O'), me: pub('R') }), (e) => e.code === 'E_POLICY');
});

test('requestJoin prefers mw.mod.requestJoin(group) once the loader has it', async () => {
  const hub = createHub({ mod: { requestJoin: async (g) => ({ asked: g }) }, chat: { dm: { send: async () => { throw new Error('not used'); } } } }, null);
  assert.equal(hub.joinBySdk, true);
  assert.deepEqual(await hub.requestJoin(led('G'), { owner: pub('O'), me: pub('R') }), { asked: led('G') });
});

test('pointerFor: a private follow first, then a follow item of a held view; nothing for an unknown or malformed id', () => {
  const views = [{ follows: new Map([[led('B'), { ptr: 'v=mw1; btih=b' }]]) }, { follows: null }];
  assert.equal(pointerFor(led('B'), views, []), 'v=mw1; btih=b');
  assert.equal(pointerFor(led('B'), views, [{ l: led('B'), ptr: 'v=mw1; btih=private' }]), 'v=mw1; btih=private');
  assert.equal(pointerFor(led('C'), views, []), '');
  assert.equal(pointerFor('not-a-ledger', views, []), '');
  assert.equal(pointerFor(led('B'), null, null), '');
});

test('syncedNotices: replies to my posts and a follow of my page, from a followed window; nothing for my own page', () => {
  const me = led('A');
  const view = {
    id: led('B'),
    comments: [{ h: H, target: { l: me, h: 'b'.repeat(64) } }, { h: 'c'.repeat(64), target: { l: led('C'), h: 'b'.repeat(64) } }, null],
    follows: new Map([[me, { ptr: 'x' }]]),
  };
  const out = syncedNotices(view, me);
  assert.deepEqual(out.map((n) => n.k), ['reply', 'follow']);
  assert.equal(out[0].from, led('B'));
  assert.equal(out[0].ref.l, led('B'));
  assert.equal(out[0].ref.h, H);
  assert.equal(out[0].target.l, me);
  assert.deepEqual(syncedNotices(Object.assign({}, view, { id: me }), me), []);
  assert.deepEqual(syncedNotices(null, me), []);
  assert.deepEqual(syncedNotices(view, 'bad'), []);
});

test('mentionsOfMe: "@<my short id>" as a whole token in another page\'s post; not my own, not inside a longer word', () => {
  const me = led('A');
  const items = [
    { l: led('B'), h: H, text: 'Hi @f6df2bc8, see you' },
    { l: led('B'), h: 'b'.repeat(64), text: 'mail x@f6df2bc8 or @f6df2bc8x' },
    { l: me, h: 'c'.repeat(64), text: '@f6df2bc8 my own' },
  ];
  const out = mentionsOfMe(items, 'f6df2bc8', me);
  assert.equal(out.length, 1);
  assert.equal(out[0].k, 'mention');
  assert.equal(out[0].ref.h, H);
  assert.deepEqual(mentionsOfMe(items, '', me), []);
  // The identity service's short id ("k3f9-2xq1") and the template's (8 hex) both count; one alert per post.
  const both = [{ l: led('B'), h: H, text: 'Hi @cw3y-mu8w' }, { l: led('B'), h: 'd'.repeat(64), text: '@f6df2bc8 and @cw3y-mu8w' }];
  assert.deepEqual(mentionsOfMe(both, ['cw3y-mu8w', 'f6df2bc8'], me).map((n) => n.ref.h), [H, 'd'.repeat(64)]);
  assert.deepEqual(mentionsOfMe(both, [null, ''], me), []);
});

test('timelineTop: the reader\'s own new post shows at once; other people\'s new posts wait behind "N new posts" (E-SO-9)', () => {
  const me = led('A'), other = led('B');
  const item = (l, ts, c) => ({ l, h: c.repeat(64), sortKey: sortKeyOf(ts, c.repeat(64)) });
  const old = [item(other, 1000, 'b'), item(me, 900, 'a')];
  assert.equal(timelineTop([], '', me), '');
  assert.equal(timelineTop(old, '', me), old[0].sortKey, 'no top yet: the newest item');
  const top = old[0].sortKey;
  // Offline, db.append resolves before the model has the post: the redraw keeps the old top, then the post arrives.
  const withOwn = [item(me, 2000, 'c')].concat(old);
  assert.equal(timelineTop(withOwn, top, me), withOwn[0].sortKey, 'own post: the feed goes to the top');
  assert.deepEqual(newerThan(withOwn, timelineTop(withOwn, top, me)), [], 'no "1 new post" box for your own post');
  const withOther = [item(other, 2000, 'd')].concat(old);
  assert.equal(timelineTop(withOther, top, me), top, 'someone else\'s new post waits for a tap');
  assert.equal(newerThan(withOther, top).length, 1);
  assert.equal(timelineTop(withOwn, top, null), top, 'no own ledger (signed out): nothing jumps');
});
