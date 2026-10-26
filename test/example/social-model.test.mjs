// U-SO-1 (V03-DESIGN-REVIEW 4.1): the pure logic of examples/social. Timeline merge order by (ts, h), edit history, mw.ok
// batching of at most 20 refs, and one reaction per member per target, plus the rules around them (wall acceptance, follow
// caps, mentions, threads, validation, drafts). Run: node --test test/example/social-model.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as M from '../../examples/social/js/model.js';
import { LIMITS, FOLLOW_CAPS } from '../../examples/social/js/config.js';
import { ledgerId, hashOf, pubOf, item, snapshot, person, T0, MINUTE } from './social-helpers.mjs';

const view = (p) => M.viewFromSnapshot(p.id, p.snap, { label: 'lbl' + p.id.slice(4, 8) });
const keys = (items) => items.map((it) => it.key);

test('timeline: merged newest first by (ts, h) across ledgers, whatever order the ledgers arrive in', () => {
  const A = person(1, { posts: [{ ts: T0 + 5 * MINUTE, text: 'a-late' }, { ts: T0, text: 'a-early', h: 'a'.repeat(64) }] });
  const B = person(2, { posts: [{ ts: T0 + 5 * MINUTE, text: 'b-late' }, { ts: T0, text: 'b-early', h: 'b'.repeat(64) }] });
  const C = person(3, { posts: [{ ts: T0 + 9 * MINUTE, text: 'c-newest' }] });
  const views = [A, B, C].map(view);
  const merged = M.timelineItems(views);
  assert.equal(merged.length, 5);
  assert.equal(merged[0].text, 'c-newest');
  // Equal ts: the larger h sorts first ("newest").
  const [x, y] = merged.slice(1, 3);
  assert.equal(x.ts, y.ts);
  assert.ok(x.h > y.h, 'ties on ts are broken by h, descending');
  const [p, q] = merged.slice(3);
  assert.deepEqual([p.h, q.h], ['b'.repeat(64), 'a'.repeat(64)]);
  for (const order of [[0, 1, 2], [2, 1, 0], [1, 2, 0], [2, 0, 1]]) {
    assert.deepEqual(keys(M.timelineItems(order.map((i) => views[i]))), keys(merged), 'the merge does not depend on the order of the ledgers');
  }
  for (let i = 1; i < merged.length; i++) assert.ok(merged[i - 1].sortKey > merged[i].sortKey, 'strictly descending by (ts, h)');
});

test('timeline: no ranking, only filters; duplicates, hidden items and blocked authors are dropped', () => {
  const A = person(1, { posts: [{ ts: T0, text: 'plain' }, { ts: T0 + MINUTE, text: 'with pic', v: { text: 'with pic', media: [{ ref: 'r1', kind: 'image', alt: 'a red door' }] } }] });
  const B = person(2, { posts: [{ ts: T0 + 2 * MINUTE, text: 'bee' }], lists: { 'mw.c': [item(hashOf('c1'), pubOf(2), T0 + 3 * MINUTE, { text: 'nice', target: { l: A.id, h: hashOf('t') } })] } });
  const views = [view(A), view(B), view(A)]; // A twice
  assert.equal(M.timelineItems(views).length, 3, 'a ledger seen twice counts once');
  assert.deepEqual(M.timelineItems(views, { filter: 'media' }).map((i) => i.text), ['with pic']);
  assert.deepEqual(M.timelineItems(views, { filter: 'replies' }).map((i) => i.text), ['nice']);
  assert.deepEqual(M.timelineItems(views, { filter: 'person', person: B.id }).map((i) => i.text), ['nice', 'bee']);
  assert.deepEqual(M.timelineItems(views, { filter: 'posts' }).map((i) => i.text), ['bee', 'with pic', 'plain']);
  const hide = M.timelineItems(views)[0].key;
  assert.ok(!keys(M.timelineItems(views, { hidden: new Set([hide]) })).includes(hide));
  assert.ok(M.timelineItems(views, { blocked: new Set([B.owner]) }).every((i) => i.author !== B.owner));
});

test('timeline pages hold 30, and "N new posts" counts what sorts above the item last seen at the top', () => {
  const posts = Array.from({ length: 70 }, (_, i) => ({ ts: T0 + i * MINUTE, text: 'p' + i }));
  const items = M.timelineItems([view(person(1, { posts }))]);
  const p0 = M.paginate(items, 0), p2 = M.paginate(items, 2);
  assert.equal(M.paginate(items).items.length, LIMITS.pageSize);
  assert.equal(LIMITS.pageSize, 30);
  assert.deepEqual([p0.items.length, p0.hasMore, p2.items.length, p2.hasMore], [30, true, 10, false]);
  const top = items[0].sortKey;
  const more = M.timelineItems([view(person(1, { posts: posts.concat([{ ts: T0 + 100 * MINUTE, text: 'new1' }, { ts: T0 + 101 * MINUTE, text: 'new2' }]) }))]);
  assert.deepEqual(M.newerThan(more, top).map((i) => i.text), ['new2', 'new1']);
  assert.deepEqual(M.newerThan(items, top), []);
  assert.deepEqual(M.newerThan(items, ''), []);
});

test('edit history: the newest version is shown "edited", earlier ones sit under History, and the permalink is the original hash', () => {
  const h0 = hashOf('orig'), h1 = hashOf('edit1'), h2 = hashOf('edit2'), a = pubOf(1);
  const A = person(1, { posts: [], lists: { 'mw.post': [
    item(h0, a, T0, { text: 'first' }), item(h1, a, T0 + 2 * MINUTE, { text: 'second', edit: h0 }), item(h2, a, T0 + 5 * MINUTE, { text: 'third', edit: h0 }),
    item(hashOf('other'), a, T0 + MINUTE, { text: 'unrelated' }),
  ] } });
  const v = view(A), post = v.posts.find((p) => p.h === h0);
  assert.equal(v.posts.length, 2);
  assert.equal(post.text, 'third');
  assert.equal(post.edited, true);
  assert.equal(post.latestH, h2);
  assert.equal(post.key, A.id + '/' + h0);
  assert.equal(post.ts, T0, 'an edit does not move the post up the timeline: it keeps the time of the original');
  assert.deepEqual(M.editHistory(post.versions).map((x) => x.text), ['second', 'first']);
  assert.deepEqual(M.timelineItems([v]).map((i) => i.text), ['unrelated', 'third'].reverse().reverse() && ['unrelated', 'third']);
});

test('edit history survives a tombstoned original, ignores edits by someone else and follows an edit of an edit', () => {
  const h0 = hashOf('o'), h1 = hashOf('e1'), h2 = hashOf('e2'), a = pubOf(1), eve = pubOf(9);
  // The author tombstoned the original: the SDK lists only the edit, which still names the original.
  let v = view(person(1, { lists: { 'mw.post': [item(h1, a, T0 + MINUTE, { text: 'kept', edit: h0 })] } }));
  assert.equal(v.posts.length, 1);
  assert.equal(v.posts[0].h, h0);
  assert.equal(v.posts[0].text, 'kept');
  assert.deepEqual(M.editHistory(v.posts[0].versions), [], 'the earlier versions are gone, the post stays');
  // Eve "edits" Andrea's post on a ledger where several authors write (a group): not an edit of it.
  v = view({ id: ledgerId(7), snap: snapshot({ owner: pubOf(7), policy: { writers: 'allow' }, lists: { 'mw.post': [
    item(h0, a, T0, { text: 'mine' }), item(h1, eve, T0 + MINUTE, { text: 'hijack', edit: h0 }) ] } }) });
  assert.deepEqual(v.posts.map((p) => p.text), ['mine']);
  // An edit that names a previous edit still lands on the original.
  v = view(person(1, { lists: { 'mw.post': [item(h0, a, T0, { text: 'v1' }), item(h1, a, T0 + MINUTE, { text: 'v2', edit: h0 }), item(h2, a, T0 + 2 * MINUTE, { text: 'v3', edit: h1 })] } }));
  assert.equal(v.posts.length, 1);
  assert.equal(v.posts[0].text, 'v3');
  assert.equal(v.posts[0].versions.length, 3);
});

test('items that do not match their schema are hidden, never thrown on', () => {
  const a = pubOf(1);
  const bad = [
    item(hashOf('1'), a, T0, { text: 7 }), item(hashOf('2'), a, T0, null), item(hashOf('3'), a, T0, { text: 'x'.repeat(2001) }),
    item(hashOf('4'), a, T0, { text: 'ok', media: new Array(5).fill({ ref: 'r', kind: 'image', alt: 'a' }) }),
    item(hashOf('5'), a, T0, { text: 'ok', link: { url: 'http://insecure.example/' } }), item(hashOf('6'), a, T0, { text: 'ok', to: 'not-a-ledger' }),
    item(hashOf('7'), a, T0, { text: 'ok', edit: 'short' }), item('not-a-hash', a, T0, { text: 'ok' }), null, 7,
    item(hashOf('9'), a, T0, { text: 'fine', link: { url: 'https://example.org/page' } }),
  ];
  const v = view(person(1, { lists: { 'mw.post': bad } }));
  assert.deepEqual(v.posts.map((p) => p.text), ['fine']);
  assert.equal(M.parsePost({ text: 'x', media: [{ ref: 'r', kind: 'audio' }] }), null);
  assert.equal(M.parseOk({ refs: new Array(21).fill({ l: ledgerId(1), h: hashOf('z') }) }), null, 'an mw.ok item holds at most 20 refs');
  assert.equal(M.parseProfile({ bio: 'x'.repeat(281) }), null);
  assert.equal(M.parseProfile({ links: ['https://a.example/', 'https://b.example/', 'https://c.example/', 'https://d.example/'] }), null, 'at most 3 links');
  assert.equal(M.parseProfile({ links: ['http://a.example/'] }), null, 'links are https only');
  assert.deepEqual(M.viewFromSnapshot(ledgerId(1), null).posts, []);
});

test('mw.ok batches hold at most 20 refs, fit the value cap, drop duplicates and keep order', () => {
  const refs = Array.from({ length: 45 }, (_, i) => M.makeRef(ledgerId(i % 30), hashOf('c' + i)));
  const batches = M.batchRefs(refs.concat(refs.slice(0, 5)), { maxBytes: 1e9 });
  assert.deepEqual(batches.map((b) => b.length), [20, 20, 5], '45 distinct refs, 5 duplicates dropped');
  assert.deepEqual(batches.flat().map(M.refKey), refs.map(M.refKey), 'order kept');
  const real = M.batchRefs(refs); // with the 2,048-byte value cap of the default policy
  for (const b of real) {
    assert.ok(b.length <= 20);
    assert.ok(new TextEncoder().encode(JSON.stringify({ refs: b })).length <= 2048, 'every batch fits policy.maxValueBytes');
    assert.ok(M.parseOk({ refs: b }), 'every batch is a valid mw.ok item');
  }
  assert.equal(real.flat().length, 45);
  assert.ok(real.length >= 3, '20 refs of this size are about 2,230 bytes, so the byte cap can split earlier than the count cap');
  assert.deepEqual(M.batchRefs([]), []);
  assert.deepEqual(M.batchRefs([{ l: 'bad', h: 'bad' }, refs[0]]), [[refs[0]]], 'malformed refs are skipped');
  assert.equal(M.batchRefs(refs, { max: 500, maxBytes: 1e9 })[0].length, 20, 'the cap of 20 cannot be raised by a caller');
  const have = new Set(refs.slice(0, 10).map(M.refKey));
  assert.deepEqual(M.pendingOkRefs(refs.slice(0, 12), have).map(M.refKey), refs.slice(10, 12).map(M.refKey));
});

test('reactions: one per member per target, the latest wins, counts are labelled "from people you follow"', () => {
  const author = person(1, { posts: [{ ts: T0, text: 'hello' }] });
  const target = M.makeRef(author.id, author.snap.lists['mw.post'][0].h);
  const key = M.reactionKey(target);
  assert.equal(key, 're/' + author.id + '/' + target.h);
  const reactor = (n, r, extra = {}) => person(n, { kv: Object.assign({ [key]: { r } }, extra) });
  const bob = reactor(2, 'heart'), carol = reactor(3, '+1'), dave = reactor(4, 'sad'), me = reactor(5, 'laugh');
  const views = [me, bob, carol, dave, bob].map(view); // bob appears twice
  const entries = M.collectReactions(target, views);
  assert.equal(entries.length, 4, 'a member listed twice counts once');
  const followed = new Set([bob.id, carol.id]);
  const sum = M.summarizeReactions(entries, { followed, me: me.id });
  assert.equal(sum.label, 'from people you follow');
  assert.equal(sum.total, 3, 'the reader plus two followed people; dave is not followed');
  assert.deepEqual(sum.counts, { '+1': 1, heart: 1, laugh: 1, sad: 0 });
  assert.equal(sum.mine, 'laugh');
  // A change of mind replaces the reaction: the key holds one value per target, so the tally has one entry per member.
  const changed = view(reactor(2, 'sad'));
  assert.equal(M.collectReactions(target, [changed]).length, 1);
  assert.equal(M.summarizeReactions(M.collectReactions(target, [changed]), { followed: new Set([bob.id]) }).counts.sad, 1);
  // An unknown reaction value or a key for a malformed target is ignored.
  const junk = view(person(6, { kv: { [key]: { r: 'angry' }, ['re/' + author.id + '/nothash']: { r: '+1' } } }));
  assert.equal(M.collectReactions(target, [junk]).length, 0);
  // The same person reacting in two views (their ledger listed twice under different ids) is one member when the owner key matches.
  const twin = { id: ledgerId(99), owner: bob.owner, snap: bob.snap };
  assert.equal(M.collectReactions(target, [view(bob), M.viewFromSnapshot(twin.id, twin.snap)]).length, 1);
  assert.deepEqual(M.reportedCount(M.viewFromSnapshot(author.id, snapshot({ owner: author.owner, lists: { 'mw.cnt': [item(hashOf('cnt'), author.owner, T0, { target, n: 41, t: T0 })] } })), target),
    { n: 41, t: T0, label: 'as counted by the author' });
  assert.equal(M.reportedCount(view(author), target), null);
});

test('reactions on a group ledger are author-scoped keys: one per author key, counted as keys', () => {
  const g = ledgerId(50), ph = hashOf('grouppost');
  const scopeA = 'A'.repeat(16), scopeB = 'B'.repeat(16);
  const snap = snapshot({ owner: pubOf(50), policy: { writers: 'allow' }, kv: {
    ['@' + scopeA + '/re/' + ph]: { r: '+1' }, ['@' + scopeB + '/re/' + ph]: { r: 'heart' }, ['@' + scopeB + '/re/' + hashOf('other')]: { r: 'sad' }, '@short/re/x': { r: '+1' },
  } });
  const v = M.viewFromSnapshot(g, snap), target = M.makeRef(g, ph);
  assert.equal(M.scopedReactionName(target), 're/' + ph);
  const entries = M.collectReactions(target, [v]);
  assert.equal(entries.length, 2);
  const sum = M.summarizeReactions(entries, { group: true, meScope: scopeB });
  assert.deepEqual([sum.total, sum.mine, sum.label], [2, 'heart', 'from members (counts of keys)']);
});

test('wall acceptance: everyone, people I follow (the default), nobody, or approve each; blocked keys are always ignored', () => {
  const fromLedger = ledgerId(2), followed = new Set([fromLedger]), stranger = ledgerId(3);
  assert.equal(M.wallMode({ cfg: {} }), 'follow', 'people I follow is the default');
  assert.equal(M.wallMode({ cfg: { wall: 'nobody' } }), 'nobody');
  assert.equal(M.wallMode({ cfg: { wall: 'bogus' } }), 'follow');
  // R 3.5 names _mw.cfg.wall; the ledger hides a _mw.cfg with a key it does not know, so the template keeps the choice in the mw.prof item and reads it second.
  assert.equal(M.wallMode({ cfg: {}, profile: { wall: 'nobody' } }), 'nobody');
  assert.equal(M.wallMode({ profile: { wall: 'approve' } }), 'approve');
  assert.equal(M.wallMode({ cfg: { wall: 'everyone' }, profile: { wall: 'nobody' } }), 'everyone', '_mw.cfg.wall wins if a ledger ever carries it');
  assert.equal(M.wallMode({ profile: { wall: 'bogus' } }), 'follow');
  assert.equal(M.parseProfile({ bio: 'x', wall: 'approve' }).wall, 'approve');
  assert.equal(M.parseProfile({ bio: 'x', wall: 'bogus' }).wall, '', 'an unknown choice is ignored, not an error');
  assert.equal(M.validateProfileDraft({ name: 'Ada', bio: '', wall: 'nobody' }).value.wall, 'nobody');
  assert.equal('wall' in M.validateProfileDraft({ name: 'Ada', bio: '', wall: 'bogus' }).value, false);
  assert.equal(M.wallDecision('everyone', { fromLedger: stranger, followed }), 'accept');
  assert.equal(M.wallDecision('follow', { fromLedger, followed }), 'accept');
  assert.equal(M.wallDecision('follow', { fromLedger: stranger, followed }), 'ignore');
  assert.equal(M.wallDecision('nobody', { fromLedger, followed }), 'ignore');
  assert.equal(M.wallDecision('approve', { fromLedger: stranger, followed }), 'queue');
  for (const mode of ['everyone', 'follow', 'approve']) assert.equal(M.wallDecision(mode, { fromLedger, followed, fromPub: pubOf(2), blocked: new Set([pubOf(2)]) }), 'ignore', mode + ' + blocked');
});

test('threads: comments live on the commenters\' ledgers and show once the author accepted them (mw.ok); own comments show as pending', () => {
  const author = person(1, { posts: [{ ts: T0, text: 'the post' }] });
  const post = M.makeRef(author.id, author.snap.lists['mw.post'][0].h);
  const c1 = hashOf('c1'), c2 = hashOf('c2'), c3 = hashOf('c3'), c4 = hashOf('c4'), meC = hashOf('mine');
  const bob = person(2, { lists: { 'mw.c': [item(c1, pubOf(2), T0 + MINUTE, { text: 'bob root', target: post }), item(c3, pubOf(2), T0 + 4 * MINUTE, { text: 'bob again', target: post, replyTo: M.makeRef(ledgerId(3), c2) })] } });
  const carol = person(3, { lists: { 'mw.c': [item(c2, pubOf(3), T0 + 2 * MINUTE, { text: 'carol reply', target: post, replyTo: M.makeRef(bob.id, c1) }), item(c4, pubOf(3), T0 + 3 * MINUTE, { text: 'not accepted', target: post })] } });
  const me = person(5, { lists: { 'mw.c': [item(meC, pubOf(5), T0 + 5 * MINUTE, { text: 'my comment', target: post })] } });
  const ghost = ledgerId(77);
  const ok = [item(hashOf('ok1'), author.owner, T0 + 6 * MINUTE, { refs: [M.makeRef(bob.id, c1), M.makeRef(carol.id, c2), M.makeRef(bob.id, c3), M.makeRef(ghost, hashOf('gone'))] })];
  const authorV = M.viewFromSnapshot(author.id, snapshot({ owner: author.owner, lists: { 'mw.post': author.snap.lists['mw.post'], 'mw.ok': ok } }));
  const views = [authorV, view(bob), view(carol), view(me)];
  const t = M.threadOf({ l: author.id, h: post.h }, views, { me: me.id });
  assert.equal(t.count, 4, 'three accepted comments and the reader\'s own');
  assert.equal(t.missing, 1, 'one accepted ref names a ledger this browser does not hold');
  assert.deepEqual(t.roots.map((n) => n.comment.text), ['bob root', 'my comment'], 'oldest first');
  const bobRoot = t.roots[0];
  assert.equal(bobRoot.accepted, true);
  assert.deepEqual(bobRoot.children.map((n) => n.comment.text), ['carol reply']);
  assert.deepEqual(bobRoot.children[0].children.map((n) => n.comment.text), ['bob again'], 'nesting follows replyTo');
  assert.equal(t.roots[1].accepted, false, 'the reader\'s own comment is pending until the author accepts it');
  assert.ok(!JSON.stringify(t).includes('not accepted'), 'a comment the author did not accept is not shown');
  const blocked = M.threadOf({ l: author.id, h: post.h }, views, { me: me.id, blocked: new Set([pubOf(2)]) });
  assert.equal(blocked.count, 2, 'blocked authors are dropped');
  // A reply cycle does not hang or lose comments.
  const x = hashOf('x'), y = hashOf('y');
  const loopA = person(8, { lists: { 'mw.c': [item(x, pubOf(8), T0, { text: 'x', target: post, replyTo: M.makeRef(ledgerId(8), y) }), item(y, pubOf(8), T0 + MINUTE, { text: 'y', target: post, replyTo: M.makeRef(ledgerId(8), x) })] } });
  const loopAuthor = M.viewFromSnapshot(author.id, snapshot({ owner: author.owner, lists: { 'mw.ok': [item(hashOf('ok2'), author.owner, T0, { refs: [M.makeRef(loopA.id, x), M.makeRef(loopA.id, y)] })] } }));
  const lt = M.threadOf({ l: author.id, h: post.h }, [loopAuthor, view(loopA)]);
  assert.equal(lt.count, 2);
  assert.ok(lt.roots.length >= 1);
});

test('walls show posts by others only when the wall owner accepted them (mw.ok) and they are addressed to that wall', () => {
  const owner = person(1, { posts: [{ ts: T0, text: 'own' }] });
  const bobPostH = hashOf('bobpost');
  const bob = person(2, { lists: { 'mw.post': [item(bobPostH, pubOf(2), T0 + MINUTE, { text: 'to alice', to: owner.id }), item(hashOf('bp2'), pubOf(2), T0 + 2 * MINUTE, { text: 'to nobody' })] } });
  const ownerV = M.viewFromSnapshot(owner.id, snapshot({ owner: owner.owner, lists: { 'mw.post': owner.snap.lists['mw.post'], 'mw.ok': [item(hashOf('ok'), owner.owner, T0, { refs: [M.makeRef(bob.id, bobPostH), M.makeRef(bob.id, hashOf('bp2'))] })] } }));
  const wall = M.wallPosts(ownerV, [ownerV, view(bob)]);
  assert.deepEqual(wall.map((p) => p.text), ['to alice', 'own'], 'the accepted post addressed to this wall, and nothing else');
});

test('follows: caps by device class, the sentence the UI prints, public and private follows together, suggestions', () => {
  assert.deepEqual(FOLLOW_CAPS, { phone: 250, desktop: 1000 });
  assert.equal(M.followCapView(250, 'phone').text, 'You follow 250 of 250 on this phone');
  assert.equal(M.followCapView(250, 'phone').atCap, true);
  assert.equal(M.followCapView(12, 'desktop').text, 'You follow 12 of 1,000 on this computer');
  assert.equal(M.followCapView(1000, 'desktop').atCap, true);
  assert.equal(M.followCapView(225, 'phone').near, true);
  assert.equal(M.followCapView(3).cap, 250, 'an unknown device class is treated as a phone');
  assert.equal(M.followCapView(-5, 'phone').count, 0);
  const me = person(1, { lists: { 'mw.f': [item(hashOf('f1'), pubOf(1), T0, { l: ledgerId(2) }), item(hashOf('f2'), pubOf(1), T0 + MINUTE, { l: ledgerId(3), ptr: 'v=mw1; btih=x' }), item(hashOf('f3'), pubOf(1), T0, { l: 'bogus' })] } });
  const set = M.followedSet(view(me), [{ l: ledgerId(4) }, { l: 'bogus' }]);
  assert.deepEqual(Array.from(set).sort(), [ledgerId(2), ledgerId(3), ledgerId(4)].sort());
  // Suggestions: people followed by people you follow, most shared first, nothing else.
  const bob = person(2, { lists: { 'mw.f': [item(hashOf('b1'), pubOf(2), T0, { l: ledgerId(10) }), item(hashOf('b2'), pubOf(2), T0, { l: ledgerId(11), ptr: 'p11' }), item(hashOf('b3'), pubOf(2), T0, { l: me.id })] } });
  const carol = person(3, { lists: { 'mw.f': [item(hashOf('c1'), pubOf(3), T0, { l: ledgerId(11) }), item(hashOf('c2'), pubOf(3), T0, { l: ledgerId(2) })] } });
  const sug = M.suggestions([view(bob), view(carol), view(me)], new Set([bob.id, carol.id]), me.id);
  assert.deepEqual(sug.map((s) => [s.l, s.count]), [[ledgerId(11), 2], [ledgerId(10), 1]].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1)));
  assert.equal(sug.find((s) => s.l === ledgerId(11)).ptr, 'p11');
  assert.deepEqual(M.followersYouCanSee(me.id, [view(bob), view(carol)]), [bob.id]);
  // An unfollow is a tombstone: the SDK stops listing the item, so the follow is gone.
  assert.equal(view(person(1, { lists: { 'mw.f': [] } })).follows.size, 0);
});

test('mentions: at most 10 per post, short ids only, tokens never carry HTML', () => {
  const ids = Array.from({ length: 12 }, (_, i) => i.toString(16).padStart(8, '0'));
  const text = ids.map((s) => '@' + s).join(' ') + ' and a@deadbeef is not a mention, nor is @@deadbeef';
  assert.deepEqual(M.extractMentions(text), ids);
  const long = M.validatePostDraft({ text });
  assert.deepEqual(long.errors.map((e) => e.code), ['MENTIONS']);
  assert.equal(M.validatePostDraft({ text: ids.slice(0, 10).map((s) => '@' + s).join(' ') }).ok, true, 'exactly 10 is allowed');
  const tokens = M.tokenize('hi @0123abcd see https://example.org/a?b=1, ok <b>x</b> http://not.example/ @zzzzzzzz');
  assert.deepEqual(tokens.map((t) => t.type), ['text', 'mention', 'text', 'link', 'text']);
  assert.equal(tokens[3].value, 'https://example.org/a?b=1', 'trailing punctuation is not part of the link');
  assert.ok(tokens[4].value.includes('<b>x</b>'), 'markup stays text');
  assert.equal(M.tokenize('').length, 0);
});

test('the composer validates in the page: length, 4 media, a description for every picture, https links, the value cap', () => {
  const pic = (alt) => ({ ref: 'r', kind: 'image', alt });
  const codes = (d) => M.validatePostDraft(d).errors.map((e) => e.field + ':' + e.code);
  assert.deepEqual(codes({ text: '' }), ['text:EMPTY']);
  assert.deepEqual(codes({ text: 'x'.repeat(2001) }), ['text:E_LIMIT']);
  assert.equal(M.validatePostDraft({ text: 'x'.repeat(2000) }).ok, true, '2,000 plain characters and the JSON wrapper are under the 2,048-byte value cap');
  assert.deepEqual(codes({ text: '\u00e9'.repeat(1500) }), ['size:E_LIMIT'], 'but 1,500 two-byte characters are not: the cap counts bytes');
  assert.deepEqual(codes({ text: 'look', media: [pic('')] }), ['media[0].alt:ALT_REQUIRED']);
  assert.deepEqual(codes({ text: 'look', media: [pic('   ')] }), ['media[0].alt:ALT_REQUIRED'], 'blank is not a description');
  assert.deepEqual(codes({ text: 'look', media: [pic('a red door')] }), []);
  assert.deepEqual(codes({ text: '', media: [pic('a red door')] }), [], 'a picture alone is a post');
  assert.deepEqual(codes({ text: 'v', media: [{ ref: 'r', kind: 'video', alt: '' }] }), [], 'alt text is required for public pictures; a video may go without');
  assert.ok(codes({ text: 'five', media: new Array(5).fill(pic('d')) }).includes('media:E_LIMIT'));
  assert.deepEqual(codes({ text: 'x', link: { url: 'http://insecure.example/' } }), ['link:LINK_HTTPS']);
  assert.equal(M.validatePostDraft({ text: 'x', link: { url: 'https://example.org/' } }).value.link.url, 'https://example.org/');
  assert.deepEqual(codes({ text: 'x'.repeat(1200), media: new Array(4).fill(pic('d'.repeat(200))) }), ['size:E_LIMIT'], 'a long text plus four long descriptions pushes the value past 2,048 bytes');
  const ok = M.validatePostDraft({ text: '  hi  ', media: [pic(' door ')], edit: hashOf('e') });
  assert.deepEqual(ok.value, { text: 'hi', media: [{ ref: 'r', kind: 'image', alt: 'door' }], edit: hashOf('e') });
  assert.equal(M.validateCommentDraft({ text: 'ok', target: M.makeRef(ledgerId(1), hashOf('t')) }).ok, true);
  assert.deepEqual(M.validateCommentDraft({ text: 'x'.repeat(1001), target: M.makeRef(ledgerId(1), hashOf('t')) }).errors.map((e) => e.code), ['E_LIMIT']);
  assert.deepEqual(M.validateCommentDraft({ text: 'x', target: null }).errors.map((e) => e.field), ['target']);
  const prof = M.validateProfileDraft({ name: 'Ada', bio: 'x'.repeat(280), links: ['https://a.example/'], handle: '@Example.org' });
  assert.equal(prof.ok, true);
  assert.equal(prof.value.handle, 'example.org');
  assert.deepEqual(M.validateProfileDraft({ name: '', bio: 'x'.repeat(281), links: ['http://x.example', 'a', 'b', 'c'] }).errors.map((e) => e.field + ':' + e.code),
    ['name:EMPTY', 'bio:E_LIMIT', 'links:E_LIMIT', 'links[0]:LINK_HTTPS', 'links[1]:LINK_HTTPS', 'links[2]:LINK_HTTPS', 'links[3]:LINK_HTTPS']);
  assert.deepEqual(M.validateProfileDraft({ name: 'x'.repeat(49) }).errors.map((e) => e.code), ['E_LIMIT']);
});

test('drafts: local, newest first, one per id, at most 20', () => {
  let drafts = [];
  for (let i = 0; i < 25; i++) drafts = M.upsertDraft(drafts, { id: 'd' + i, text: 'draft ' + i, savedAt: 1000 + i });
  assert.equal(drafts.length, 20);
  assert.equal(drafts[0].id, 'd24');
  assert.equal(drafts[19].id, 'd5', 'the oldest five are dropped');
  drafts = M.upsertDraft(drafts, { id: 'd10', text: 'edited', savedAt: 9999 });
  assert.equal(drafts.length, 20);
  assert.deepEqual([drafts[0].id, drafts[0].text], ['d10', 'edited']);
  assert.equal(M.removeDraft(drafts, 'd10').length, 19);
});

test('profile and settings come from the ledger: newest mw.prof of the owner, name from the profile op, wall setting from _mw.cfg', () => {
  const a = pubOf(1);
  const v = view(person(1, { name: 'Ada', lists: { 'mw.prof': [
    item(hashOf('p1'), a, T0, { bio: 'old' }), item(hashOf('p2'), a, T0 + MINUTE, { bio: 'new bio', links: ['https://example.org/'], handle: 'ada.example' }),
    item(hashOf('p3'), pubOf(9), T0 + 2 * MINUTE, { bio: 'impostor' }), item(hashOf('p4'), a, T0 + 3 * MINUTE, { bio: 7 }),
  ] }, kv: { '_mw.cfg': { wall: 'approve', chat: 'members' } } }));
  assert.equal(v.name, 'Ada');
  assert.equal(v.profile.bio, 'new bio');
  assert.equal(v.profile.handle, 'ada.example');
  assert.deepEqual(v.profile.links, ['https://example.org/']);
  assert.equal(M.wallMode(v), 'approve');
  assert.equal(v.short.length, 8);
  // A kv entry may arrive as a record { v, author, h, ts }; both forms are read.
  const rec = view(person(1, { kv: { '_mw.cfg': { v: { wall: 'nobody' }, author: a, h: hashOf('k'), ts: T0 } } }));
  assert.equal(M.wallMode(rec), 'nobody');
});

test('timeAgo reads the claimed time as a claim and never throws', () => {
  const now = T0 + 3 * 3600000;
  assert.equal(M.timeAgo(now - 20000, now), 'just now');
  assert.equal(M.timeAgo(now - 5 * 60000, now), '5 min ago');
  assert.equal(M.timeAgo(now - 3 * 3600000, now), '3 h ago');
  assert.equal(M.timeAgo(now - 2 * 86400000, now), '2 d ago');
  assert.equal(M.timeAgo(T0 - 40 * 86400000, now), '2026-09-10');
  assert.equal(M.timeAgo(NaN, now), '');
  assert.equal(M.timeAgo('x', now), '');
});
