// Unit tests for src/dropin/binding.js: window.mw bound directly to MwApi (src/loader/api.js). A
// fake ledger node (Map state, recorded calls) and a manual clock; the checks cover the §9 surface,
// validation parity with the SDK, error codes, the write rate limit, snapshots and net events.
// v0.3 (R 2.11.2): the surface grew (auth, me, hub, chat, files, media, report; db.setMine/getMine/listBy; the
// moderation methods); mod.ban is a UI method (a click, then the loader's moderator card, MF-27), and
// identity.current() carries the identity's mode ('legacy' for the 0.2.1 per-site key).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createClock, flush } from './dropin-fake-timers.mjs';
import { MwApi } from '../../src/loader/api.js';
import { createBinding, NET_EVENTS } from '../../src/dropin/binding.js';

const H = 'c'.repeat(64);
const PUB = 'p256:B' + 'A'.repeat(86); // algorithm-tagged key shape (v0.2.1 A2)

function fakeNode(over = {}) {
  const calls = [];
  const subs = new Set();
  const node = {
    calls,
    role: 'writer',
    peers: 2,
    inSyncPeers: 1,
    height: 4,
    identity: { pub: PUB },
    state: { kv: new Map([['notice', { v: 'hello', h: H, author: PUB, ts: 1 }]]), lists: new Map([['guestbook', [{ h: 'a'.repeat(64), v: 'first' }, { h: 'b'.repeat(64), v: 'second' }]]]), policy: { maxValueBytes: 2048 } },
    snapshot() { return { height: this.height, kv: { notice: 'hello' }, lists: {}, profiles: {}, policy: { writers: 'open', maxValueBytes: 2048 } }; },
    subscribe(fn) { subs.add(fn); return () => subs.delete(fn); },
    emit() { for (const fn of Array.from(subs)) fn(); },
    async put(k, v) { calls.push(['put', k, v]); return { h: H }; },
    async del(k) { calls.push(['del', k]); return { h: H }; },
    async append(l, v) { calls.push(['append', l, v]); return { h: H }; },
    async profile(n) { calls.push(['profile', n]); return { h: H }; },
    async tombstone(h) { calls.push(['tombstone', h]); return { h: H }; },
    async ban(p) { calls.push(['ban', p]); return { h: H }; },
  };
  return Object.assign(node, over);
}

function setup({ node = fakeNode(), consent = null, clock = createClock(), limits = {}, activation = null, prompt = null } = {}) {
  const info = { siteId: 'mw1:abc', btih: 'ab'.repeat(20), mode: 'dropin', name: 'Existing Site', files: [{ path: 'css/app.3f2a1b.css', length: 12, type: 'text/css', offset: 0 }], owner: PUB, unmoderated: false, source: 'cache' };
  const identity = { current: () => ({ pub: PUB, short: 'abcd1234', name: null }), export: async (p) => 'wrapped:' + p, import: async (b, p) => ({ pub: PUB, from: b, p }) };
  // activation: what the loader's ActivationTracker reports (a trusted click on the page); prompt: the panel's card.
  const api = new MwApi({ node, consent, info, identity, limits, activation, ui: prompt ? { prompt } : null, ...clock.timers() });
  const binding = createBinding({ api, ...clock.timers() });
  return { node, api, clock, ...binding };
}

test('the surface is the R 2.11.2 one and is frozen', () => {
  const { mw } = setup();
  for (const [group, names] of Object.entries({
    db: ['get', 'set', 'del', 'list', 'append', 'tombstone', 'subscribe', 'setMine', 'getMine', 'listBy'],
    mod: ['ban', 'unban', 'tombstoneMany', 'queue', 'decide'],
    identity: ['current', 'setName', 'backupStatus', 'openIdentity'],
    auth: ['signIn', 'signOut', 'state', 'onChange', 'prove', 'verify', 'signInServer'],
    me: ['get', 'set', 'del', 'sync', 'erase'],
    hub: ['follow', 'unfollow', 'list', 'createPage'],
    files: ['enable', 'list', 'received', 'share', 'fetch', 'preview', 'save', 'keepSharing', 'stopSharing', 'remove', 'pinRequest', 'on'],
    media: ['upload', 'list', 'open', 'close', 'share', 'revoke', 'delete', 'keepAvailable', 'pinRequest', 'on'],
    report: ['send'],
    net: ['peers', 'on', 'seeding', 'dock', 'keep'],
    calls: ['start', 'accept', 'decline', 'hangup', 'mute', 'camera', 'screen', 'state', 'list', 'on'],
    site: ['info'],
    consent: ['request', 'state'],
    owner: ['policy'],
  })) {
    for (const n of names) assert.equal(typeof mw[group][n], 'function', group + '.' + n);
    assert.deepEqual(Object.keys(mw[group]).sort(), names.slice().sort(), group + ' has exactly the v0.3 methods');
  }
  assert.deepEqual(Object.keys(mw.chat).sort(), ['contacts', 'direct', 'disable', 'dm', 'enable', 'group', 'holder', 'on', 'presence', 'requests', 'room', 'state']);
  assert.deepEqual(Object.keys(mw.chat.dm).sort(), ['history', 'keepHistory', 'send']);
  assert.equal(mw.version, '0.3.0');
  // v0.2.1 A4: identity export/import and consent decisions are loader-owned UI only.
  assert.equal(mw.identity.export, undefined);
  assert.equal(mw.identity.import, undefined);
  assert.equal(mw.consent.accept, undefined);
  assert.equal(typeof mw.ready, 'function');
  assert.ok(Object.isFrozen(mw) && Object.isFrozen(mw.db), 'sites cannot patch the binding by accident');
  assert.deepEqual(NET_EVENTS.slice().sort(), ['peers', 'pow', 'progress', 'status', 'sync']); // 'pow': code review round 1 (the write fee)
  assert.throws(() => createBinding({}), TypeError);
});

test('ready(): the info of §9 with mode dropin, after the ledger opened late', async () => {
  const clock = createClock();
  const node = fakeNode();
  const { mw, api } = setup({ node: null, clock });
  assert.equal(api.node, null);
  const pending = mw.ready();
  await flush();
  api.setNode(node);
  const info = await pending;
  assert.equal(info.mode, 'dropin');
  assert.equal(info.siteId, 'mw1:abc');
  assert.equal(info.btih, 'ab'.repeat(20));
  assert.equal(info.role, 'writer');
  assert.equal(info.peers, 2);
  assert.equal(info.height, 4);
  assert.equal(info.owner, PUB);
  assert.equal(info.unmoderated, false);
  assert.deepEqual(info.identity, { pub: PUB, short: 'abcd1234', name: null, mode: 'legacy' });
  assert.equal(info.auth, 'signed-in', 'the 0.2.1 per-site key signs: the visitor counts as signed in');
});

test('db reads and writes go to the node and return what the Bridge would', async () => {
  const cards = [];
  const { mw, node } = setup({ node: fakeNode({ role: 'moderator' }), activation: () => true, prompt: async (kind, data) => { cards.push([kind, data && data.pub]); return true; } });
  assert.equal(await mw.db.get('notice'), 'hello');
  assert.equal(await mw.db.get('nope'), undefined);
  assert.deepEqual(await mw.db.set('k', { a: 1 }), { h: H });
  assert.deepEqual(await mw.db.del('k'), { h: H });
  assert.deepEqual(await mw.db.append('guestbook', 'hello'), { h: H });
  assert.deepEqual(await mw.db.tombstone(H), { h: H });
  assert.deepEqual(await mw.identity.setName('Ash'), { h: H });
  assert.deepEqual(await mw.mod.ban(PUB), { h: H });
  assert.deepEqual(node.calls, [['put', 'k', { a: 1 }], ['del', 'k'], ['append', 'guestbook', 'hello'], ['tombstone', H], ['profile', 'Ash'], ['ban', PUB]]);
  assert.deepEqual(cards, [['mod.ban', PUB]], 'v0.3 (MF-27): the ban went through the loader\'s moderator card');
  assert.deepEqual((await mw.db.list('guestbook')).map((i) => i.v), ['second', 'first'], 'newest first by default');
  assert.deepEqual((await mw.db.list('guestbook', { newestFirst: false })).map((i) => i.v), ['first', 'second']);
  assert.equal((await mw.db.list('guestbook', { limit: 1 })).length, 1);
  assert.deepEqual(await mw.db.list('missing'), []);
});

test('validation matches the SDK: E_LIMIT before anything is sent', async () => {
  const { mw, node } = setup();
  const code = (p) => p.then(() => 'resolved', (e) => e.code);
  assert.equal(await code(mw.db.get('')), 'E_LIMIT');
  assert.equal(await code(mw.db.get(5)), 'E_LIMIT');
  assert.equal(await code(mw.db.set('k', undefined)), 'E_LIMIT');
  assert.equal(await code(mw.db.set('k', () => 1)), 'E_LIMIT');
  assert.equal(await code(mw.db.set('k', { d: new Date() })), 'E_LIMIT');
  assert.equal(await code(mw.db.set('k', 'x'.repeat(3000))), 'E_LIMIT', 'bigger than the ledger policy allows');
  assert.equal(await code(mw.db.list('l', { limit: 0 })), 'E_LIMIT');
  assert.equal(await code(mw.db.list('l', { limit: 2.5 })), 'E_LIMIT');
  assert.equal(await code(mw.db.append('', 1)), 'E_LIMIT');
  assert.equal(await code(mw.db.tombstone('nothex')), 'E_LIMIT');
  assert.equal(await code(mw.mod.ban('')), 'E_LIMIT');
  assert.equal(await code(mw.identity.setName('')), 'E_LIMIT');
  assert.equal(await code(mw.mod.ban('A'.repeat(87))), 'E_LIMIT', 'an untagged v0.2 key is not a public key (A2)');
  assert.equal(node.calls.length, 0);
});

test('v0.2.1 A4: the loader-only methods are unknown to the API whoever calls them', async () => {
  const { api } = setup();
  for (const method of ['identity.export', 'identity.import', 'consent.accept']) {
    const res = await api.request(method, { passphrase: 'long enough', blob: 'x' });
    assert.equal(res.ok, false, method);
    assert.equal(res.error.code, 'E_BAD_REQUEST', method);
  }
});

test('errors from the node keep their codes; a non-moderator ban is E_NOT_MODERATOR; owner.policy is E_NOT_OWNER', async () => {
  const node = fakeNode({ role: 'reader' });
  node.put = async () => { throw Object.assign(new Error('writers is owner'), { code: 'E_POLICY' }); };
  node.append = async () => { throw Object.assign(new Error('ledger full'), { code: 'E_CAP' }); };
  node.profile = async () => { throw Object.assign(new Error('aborted'), { name: 'AbortError' }); };
  const { mw } = setup({ node, activation: () => true, prompt: async () => true });
  await assert.rejects(mw.db.set('k', 1), (e) => e.code === 'E_POLICY' && /writers is owner/.test(e.message));
  await assert.rejects(mw.db.append('l', 1), (e) => e.code === 'E_CAP');
  await assert.rejects(mw.identity.setName('Ash'), (e) => e.code === 'E_POW_ABORTED');
  await assert.rejects(mw.mod.ban(PUB), (e) => e.code === 'E_NOT_MODERATOR');
  await assert.rejects(mw.owner.policy({ writers: 'owner' }), (e) => e.code === 'E_NOT_OWNER');
  // v0.3: mod.ban is a UI method; without a click the boundary answers first (docs/SDK.md "Gating").
  const noClick = setup({ node: fakeNode({ role: 'moderator' }), prompt: async () => true });
  await assert.rejects(noClick.mw.mod.ban(PUB), (e) => e.code === 'E_NEEDS_GESTURE');
  assert.equal(noClick.node.calls.length, 0);
  // A cancelled moderator card writes nothing.
  const cancelled = setup({ node: fakeNode({ role: 'moderator' }), activation: () => true, prompt: async () => false });
  await assert.rejects(cancelled.mw.mod.ban(PUB), (e) => e.code === 'E_USER_CANCELLED');
  assert.equal(cancelled.node.calls.length, 0);
  const without = setup({ node: null });
  without.api.setNode(null, { failed: true });
  await assert.rejects(without.mw.db.set('k', 1), (e) => e.code === 'E_IDENTITY' && /not available/.test(e.message));
  assert.equal(await without.mw.db.get('k'), undefined, 'reads still answer');
});

test('writes are limited to 20 per minute, like the Bridge', async () => {
  const clock = createClock();
  const { mw } = setup({ clock });
  for (let i = 0; i < 20; i++) await mw.db.set('k' + i, i);
  await assert.rejects(mw.db.set('overflow', 1), (e) => e.code === 'E_RATE');
  assert.equal(await mw.db.get('notice'), 'hello', 'reads are never limited');
  clock.advance(60001);
  assert.deepEqual(await mw.db.set('later', 1), { h: H });
});

test('db.subscribe: snapshots on change, throttled to one per 250 ms with a trailing delivery; late subscribers get the last one', async () => {
  const clock = createClock();
  const { mw, node, pushState } = setup({ clock });
  const seen = [];
  const off = mw.db.subscribe((s) => seen.push(s.height));
  await flush();
  assert.deepEqual(seen, [4], 'subscribing triggers the first snapshot');
  node.height = 5;
  pushState();
  assert.deepEqual(seen, [4], 'within 250 ms: held back');
  node.height = 6;
  pushState();
  clock.advance(249);
  assert.deepEqual(seen, [4]);
  clock.advance(1);
  assert.deepEqual(seen, [4, 6], 'one trailing delivery with the newest state');
  const late = [];
  mw.db.subscribe((s) => late.push(s.height));
  await flush();
  assert.deepEqual(late, [6], 'late subscriber: the last snapshot, asynchronously');
  off();
  clock.advance(1000);
  node.height = 9;
  pushState();
  assert.deepEqual(seen, [4, 6], 'unsubscribed');
  assert.throws(() => mw.db.subscribe('nope'), (e) => e.code === 'E_LIMIT');
});

test('db.subscribe: a push while there is no ledger node yet does not use up the first interval', async () => {
  const clock = createClock();
  const { api, mw, pushState } = setup({ node: null, clock });
  const seen = [];
  mw.db.subscribe((s) => seen.push(s.height));
  pushState();
  pushState();
  await flush();
  assert.deepEqual(seen, [], 'no node: nothing to deliver');
  api.setNode(fakeNode());
  pushState();
  assert.deepEqual(seen, [4], 'the first real snapshot goes out at once, not 250 ms later');
  pushState();
  assert.deepEqual(seen, [4], 'and then the throttle applies as usual');
});

test('snapshot content: the ledger snapshot plus peers, inSync and role; sync events carry the counters', async () => {
  const clock = createClock();
  const { mw, pushState } = setup({ clock });
  const snaps = [];
  const syncs = [];
  mw.net.on('sync', (d) => syncs.push(d));
  mw.db.subscribe((s) => snaps.push(s));
  pushState();
  await flush();
  assert.equal(snaps[0].peers, 2);
  assert.equal(snaps[0].inSync, 1);
  assert.equal(snaps[0].role, 'writer');
  assert.equal(snaps[0].height, 4);
  assert.deepEqual(syncs, [{ height: 4, peers: 2, inSync: 1 }]);
});

test('net.on: peers/progress/status/sync listeners, unsubscribe, unknown events throw E_LIMIT; a listener bug does not stop others', async () => {
  const clock = createClock();
  const thrown = [];
  const { mw, push } = setup({ clock });
  const got = [];
  const off = mw.net.on('peers', (d) => got.push(['a', d.count]));
  mw.net.on('peers', () => { throw new Error('site bug'); });
  mw.net.on('peers', (d) => got.push(['c', d.count]));
  mw.net.on('progress', (d) => got.push(['p', d.progress]));
  mw.net.on('status', (d) => got.push(['s', d.code]));
  push('peers', { count: 3 });
  push('progress', { progress: 0.5 });
  push('status', { code: 'seeding' });
  push('nonsense', {});
  assert.deepEqual(got, [['a', 3], ['c', 3], ['p', 0.5], ['s', 'seeding']]);
  off();
  push('peers', { count: 4 });
  assert.deepEqual(got.filter((g) => g[0] === 'a').length, 1);
  assert.throws(() => mw.net.on('state', () => {}), (e) => e.code === 'E_LIMIT');
  assert.throws(() => mw.net.on('bogus', () => {}), (e) => e.code === 'E_LIMIT');
  assert.throws(() => mw.net.on('peers', 'nope'), (e) => e.code === 'E_LIMIT');
  assert.throws(() => mw.net.on('', () => {}), (e) => e.code === 'E_LIMIT');
  void thrown;
});

test('net.peers(): the live count from the node, 0 when nothing knows', () => {
  const a = setup();
  assert.equal(a.mw.net.peers(), 2);
  const b = setup({ node: null });
  assert.equal(b.mw.net.peers(), 0);
});

test('site.info and consent: info for the site, state is synchronous, request opens the loader card and returns the visitor\'s choice', async () => {
  // The page's consent object: request() shows the loader-owned card; the visitor clicks there.
  let opened = 0;
  let decide = null;
  const consent = {
    s: 'pending',
    state() { return this.s; },
    request() { opened++; return new Promise((resolve) => { decide = (s) => { this.s = s; resolve(s); }; }); },
  };
  const { mw } = setup({ consent });
  const info = await mw.site.info();
  assert.equal(info.mode, 'dropin');
  assert.equal(info.name, 'Existing Site');
  assert.equal(info.btih, 'ab'.repeat(20));
  assert.equal(info.source, 'cache');
  assert.deepEqual(info.files, [{ path: 'css/app.3f2a1b.css', length: 12 }]);
  assert.equal(mw.consent.state(), 'pending');
  const first = mw.consent.request();
  const second = mw.consent.request();
  await flush();
  assert.equal(opened, 1, 'one card at a time: concurrent requests share it');
  assert.equal(mw.consent.state(), 'pending', 'asking grants nothing');
  decide('accepted');
  assert.equal(await first, 'accepted');
  assert.equal(await second, 'accepted');
  assert.equal(mw.consent.state(), 'accepted');
  assert.equal(await mw.consent.request(), 'accepted', 'a decided state opens nothing');
  assert.equal(opened, 1);
  const none = setup();
  assert.equal(none.mw.consent.state(), 'pending');
  assert.equal(await none.mw.consent.request(), 'pending', 'no loader UI: the state, nothing opens, nothing is granted');
});

test('consent.request: a card closed without a choice resolves pending, and the site cannot reopen it for 10 s', async () => {
  const clock = createClock();
  let opened = 0;
  const consent = { state: () => 'pending', request: async () => { opened++; return 'pending'; } };
  const { mw } = setup({ consent, clock });
  assert.equal(await mw.consent.request(), 'pending');
  assert.equal(await mw.consent.request(), 'pending');
  assert.equal(opened, 1, 'within the cooldown the card is not reopened');
  clock.advance(10001);
  assert.equal(await mw.consent.request(), 'pending');
  assert.equal(opened, 2);
  // A ui.openConsent hook (the shell's loader-owned UI) is preferred over consent.request.
  const ui = { calls: 0, openConsent: async () => { ui.calls++; return 'host-only'; } };
  const api = new MwApi({ consent: { state: () => 'pending', request: async () => 'accepted' }, ui, ...clock.timers() });
  const res = await api.request('consent.request', {});
  assert.deepEqual([res.ok, res.result, ui.calls], [true, 'host-only', 1]);
});

test('destroy() stops deliveries and timers', async () => {
  const clock = createClock();
  const { mw, push, pushState, destroy, node } = setup({ clock });
  const got = [];
  mw.net.on('peers', (d) => got.push(d.count));
  mw.db.subscribe((s) => got.push('s' + s.height));
  await flush();
  node.height = 7;
  pushState();
  pushState();
  destroy();
  clock.advance(1000);
  push('peers', { count: 9 });
  pushState();
  assert.deepEqual(got, ['s4']);
  assert.equal(clock.pending(), 0);
});

test('code review round 1: writes report the fee (onProgress and the pow event) and take an AbortSignal', async () => {
  const seenOpts = [];
  const node = fakeNode({
    async append(l, v, opts) {
      seenOpts.push(opts);
      if (opts && opts.onProgress) opts.onProgress({ hashes: 4096, bits: 12 });
      if (opts && opts.signal && opts.signal.aborted) throw Object.assign(new Error('aborted'), { name: 'AbortError', code: 'E_POW_ABORTED' });
      return { h: H };
    },
  });
  const { mw } = setup({ node });
  const events = [];
  mw.net.on('pow', (e) => events.push(e));
  const mine = [];
  assert.deepEqual(await mw.db.append('guestbook', 'hi', { onProgress: (p) => mine.push(p) }), { h: H });
  assert.deepEqual(mine, [{ hashes: 4096, bits: 12 }]);
  assert.deepEqual(events, [{ hashes: 4096, bits: 12 }]);
  // Without options the event still fires; an aborted signal fails the write.
  await mw.db.append('guestbook', 'two');
  assert.equal(events.length, 2);
  await assert.rejects(mw.db.append('guestbook', 'three', { signal: AbortSignal.abort() }), (e) => e.code === 'E_POW_ABORTED');
  assert.equal(seenOpts.length, 3);
  assert.ok(seenOpts.every((o) => o && typeof o.onProgress === 'function'), 'the node gets the write options');
});
