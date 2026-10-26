// Unit tests for src/chat/service.js and wire.js (SVC contract; R 2.11.2): gesture gating, E_HOST_ONLY without
// any network request, policy and key errors, and two or three services exchanging DMs, ACKs and a message
// request over fake BEP 10 wires through a fake TorrentManager seam, with no ledger write for DMs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPair, exportPublicKey, sign } from '../../src/chain/crypto.js';
import { createChatService, CHAT_METHODS, CHAT_EVENTS } from '../../src/chat/service.js';
import { generateChatKey } from '../../src/chat/seal.js';
import { DAY_MS, EXT_NAME } from '../../src/chat/limits.js';

const LEDGER = 'mw1:serviceLedger';
const T0 = 20381 * DAY_MS + 12 * 3600000;
const CODES = new Set(['E_HOST_ONLY', 'E_POLICY', 'E_NO_OWN_TRACKER', 'E_NO_CHAT_KEY', 'E_SYNCING', 'E_BLOCKED', 'E_LIMIT', 'E_STAMP',
  'E_RATE', 'E_BANNED', 'E_NOT_MEMBER', 'E_NOT_ADMIN', 'E_NOT_CONTACT', 'E_PEER_UNREACHABLE', 'E_NEEDS_GESTURE', 'E_NOT_SIGNED_IN',
  'E_USER_CANCELLED', 'E_BAD_REQUEST', 'E_UNSUPPORTED']);
const CLICK = { activation: true, tab: 'leader' };
const NOCLICK = { activation: false, tab: 'leader' };

function fakeClock(start = T0) {
  let t = start;
  let seq = 0;
  const q = [];
  return {
    now: () => t,
    setTimeout: (fn, ms) => { const h = { at: t + Math.max(0, ms || 0), fn, seq: seq++ }; q.push(h); return h; },
    clearTimeout: (h) => { const i = q.indexOf(h); if (i >= 0) q.splice(i, 1); },
    async advance(ms) {
      const end = t + ms;
      for (;;) {
        await settle();
        q.sort((a, b) => a.at - b.at || a.seq - b.seq);
        const h = q[0];
        if (!h || h.at > end) break;
        q.shift();
        t = Math.max(t, h.at);
        h.fn();
      }
      t = end;
      await settle();
    },
    /** Moves the clock at once: every timer due by then fires once (a periodic one does not catch up). */
    async jump(ms) {
      t += ms;
      for (const h of q) if (h.at < t) h.at = t;
      await this.advance(0);
    },
  };
}

async function settle(rounds = 4) {
  for (let i = 0; i < rounds; i++) await new Promise((r) => setTimeout(r, 1));
}

async function waitFor(pred, ms = 5000) {
  const end = Date.now() + ms;
  while (!pred()) {
    if (Date.now() > end) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 2));
  }
}

class FakeWire {
  constructor() {
    this.peer = null;
    this.destroyed = false;
    this.handlers = {};
    this.ext = null;
  }
  use(Ext) { this.ext = new Ext(this); }
  extended(name, buf) {
    assert.equal(name, EXT_NAME);
    const p = this.peer;
    const copy = new Uint8Array(buf);
    setImmediate(() => { if (!p.destroyed && p.ext) p.ext.onMessage(copy); });
  }
  once(ev, fn) { this.handlers[ev] = fn; }
  destroy() {
    if (this.destroyed) return;
    this.destroyed = true;
    if (this.handlers.close) this.handlers.close();
    this.peer.destroy();
  }
}

class FakeTM {
  constructor() {
    this.exts = [];
    this.calls = [];
  }
  registerWireExtension(name, handler, opts) {
    this.calls.push(['register', name, opts]);
    this.exts.push(handler);
    return () => { this.calls.push(['unregister', name]); this.exts = []; };
  }
  joinLane(o) {
    this.calls.push(['joinLane', o]);
    return { leave: () => this.calls.push(['leave']) };
  }
}

function connect(tmA, tmB) {
  const wa = new FakeWire();
  const wb = new FakeWire();
  wa.peer = wb;
  wb.peer = wa;
  for (const h of tmA.exts) h.onWire(wa, 'rendezvous');
  for (const h of tmB.exts) h.onWire(wb, 'rendezvous');
  wa.ext.onExtendedHandshake({ m: { [EXT_NAME]: 3 } });
  wb.ext.onExtendedHandshake({ m: { [EXT_NAME]: 3 } });
  return [wa, wb];
}

function fakeNode() {
  const appended = [];
  return {
    appended,
    syncing: false,
    state: { owner: null, ownerConflict: false, policy: { banned: new Set(), moderators: new Set(), allow: new Set(), writers: 'open' }, lists: new Map() },
    append(l, v) { appended.push([l, v]); return { h: 'x' }; },
  };
}

function memStore() {
  const m = new Map();
  return { m, async get(k) { return m.get(k); }, async set(k, v) { m.set(k, JSON.parse(JSON.stringify(v))); } };
}

async function person(clock, overrides = {}) {
  const idn = overrides.identity || null; // a reload: the same keys and the same sealed store
  const kp = idn ? idn.kp : await generateKeyPair();
  const pub = idn ? idn.pub : await exportPublicKey(kp.publicKey);
  const chat = idn ? idn.chat : await generateChatKey();
  const tm = new FakeTM();
  const node = fakeNode();
  const prompts = [];
  const cfg = Object.assign({ chat: 'open', requests: 'on', chatBits: 10 }, overrides.cfg || {});
  const store = overrides.store || memStore();
  const svc = createChatService(Object.assign({
    keys: { pub, sign: (b) => sign(kp.privateKey, b), chat },
    ledgerId: LEDGER, node, cfg: () => cfg, deviceClass: 'desktop', hostOnly: false, ownTracker: 'wss://tracker.example.test',
    wires: tm, store, prompt: async (kind, data) => { prompts.push(kind); return true; },
    now: clock.now, setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout, random: Math.random,
    ckShare: 'reason', // review round (PRIV-2): these tests run the policy the loader is asked to pass
  }, overrides.deps || {}));
  const events = {};
  for (const e of CHAT_EVENTS) {
    events[e] = [];
    svc.on(e, (x) => events[e].push(x));
  }
  return { kp, pub, chat, tm, node, svc, prompts, events, cfg, store, call: (m, p, ctx = CLICK) => svc.methods[m](p, ctx) };
}

async function code(p) {
  try {
    await p;
  } catch (e) {
    assert.ok(CODES.has(e.code), 'unexpected code ' + e.code);
    return e.code;
  }
  return null;
}

test('the method table covers every chat.* method of R 2.11.2', async () => {
  const p = await person(fakeClock());
  for (const m of CHAT_METHODS) assert.equal(typeof p.svc.methods[m], 'function', m);
  for (const m of ['chat.enable', 'chat.dm.send', 'chat.room.join', 'chat.group.create', 'chat.holder.set', 'chat.direct.connect']) assert.ok(CHAT_METHODS.includes(m));
  assert.throws(() => p.svc.on('nope', () => {}), TypeError);
  await p.svc.destroy();
});

test('gesture gating: UI methods throw E_NEEDS_GESTURE without a loader-verified click', async () => {
  const clock = fakeClock();
  const p = await person(clock);
  assert.equal(await code(p.call('chat.enable', {}, NOCLICK)), 'E_NEEDS_GESTURE');
  assert.equal(await code(p.call('chat.enable', {}, {})), 'E_NEEDS_GESTURE');
  assert.equal(await code(p.call('chat.enable', {}, { activation: 'yes' })), 'E_NEEDS_GESTURE', 'only the boolean true from the loader counts');
  assert.equal(p.prompts.length, 0, 'no card without a click');
  assert.deepEqual(await p.call('chat.enable', {}, CLICK), { state: 'on' });
  assert.deepEqual(p.prompts, ['chat.enable']);
  for (const [m, args] of [['chat.holder.set', { on: true }], ['chat.requests.setOpen', { open: true }], ['chat.direct.connect', { pub: p.pub }]]) {
    assert.equal(await code(p.call(m, args, NOCLICK)), 'E_NEEDS_GESTURE', m);
  }
  assert.equal(await code(p.call('chat.presence.set', { on: true, public: true }, NOCLICK)), 'E_NEEDS_GESTURE');
  assert.deepEqual(await p.call('chat.presence.set', { on: true }, NOCLICK), { on: true, public: false }, 'private presence needs no card');
  // Per-session cards: contacts.list and dm.history need a click the first time only.
  assert.equal(await code(p.call('chat.contacts.list', {}, NOCLICK)), 'E_NEEDS_GESTURE');
  assert.deepEqual(await p.call('chat.contacts.list', {}, CLICK), []);
  assert.deepEqual(await p.call('chat.contacts.list', {}, NOCLICK), []);
  assert.equal(await code(p.call('chat.dm.history', { pub: p.pub }, NOCLICK)), 'E_NEEDS_GESTURE');
  assert.deepEqual(await p.call('chat.dm.history', { pub: p.pub }, CLICK), []);
  // A declined card is E_USER_CANCELLED.
  const q = await person(clock, { deps: { prompt: async () => false } });
  assert.equal(await code(q.call('chat.enable', {}, CLICK)), 'E_USER_CANCELLED');
  await p.svc.destroy();
  await q.svc.destroy();
});

test('host-only mode: every method but chat.state is E_HOST_ONLY, with no network request', async () => {
  const clock = fakeClock();
  const p = await person(clock, { deps: { hostOnly: true } });
  for (const m of CHAT_METHODS) {
    if (m === 'chat.state') continue;
    assert.equal(await code(p.call(m, { pub: p.pub, text: 'x', on: true, name: 'Lobby' }, CLICK)), 'E_HOST_ONLY', m);
  }
  assert.deepEqual(p.tm.calls, [], 'no wire extension, no lane join');
  assert.deepEqual(p.prompts, [], 'no card either');
  const st = await p.call('chat.state', {}, NOCLICK);
  assert.equal(st.state, 'off');
  assert.equal(st.hostOnly, true);
  assert.equal(p.node.appended.length, 0);
});

test('enable: E_POLICY when the site has chat off or for members only, E_NO_OWN_TRACKER, E_NOT_SIGNED_IN; followers only read', async () => {
  const clock = fakeClock();
  assert.equal(await code((await person(clock, { cfg: { chat: 'off' } })).call('chat.enable', {})), 'E_POLICY');
  const members = await person(clock, { cfg: { chat: 'members' } });
  members.node.state.policy.writers = 'owner';
  assert.equal(await code(members.call('chat.enable', {})), 'E_POLICY', 'a reader on a members-only site');
  members.node.state.policy.writers = 'open';
  assert.deepEqual(await members.call('chat.enable', {}), { state: 'on' });
  assert.equal(await code((await person(clock, { deps: { ownTracker: null } })).call('chat.enable', {})), 'E_NO_OWN_TRACKER');
  assert.equal(await code((await person(clock, { deps: { keys: null } })).call('chat.enable', {})), 'E_NOT_SIGNED_IN');
  const p = await person(clock);
  assert.equal(await code(p.call('chat.dm.send', { pub: p.pub, text: 'x' })), 'E_POLICY', 'chat not on yet');
  assert.equal(await code(p.call('chat.enable', {}, { activation: true, tab: 'follower' })), 'E_POLICY');
  assert.equal((await p.call('chat.state', {}, { tab: 'follower' })).state, 'off');
  await p.call('chat.enable', {});
  // The wire extension is registered through the seam, on rendezvous wires.
  assert.deepEqual(p.tm.calls[0], ['register', EXT_NAME, { swarms: ['rendezvous', 'chat'] }]);
  assert.ok(p.tm.calls.some((c) => c[0] === 'joinLane' && c[1].kind === 'chat' && c[1].announce.length === 1), 'no rendezvous neighbours yet: the chat lane, own tracker only');
  assert.equal(p.events.state.length, 1);
  await p.call('chat.disable', {}, NOCLICK);
  assert.ok(p.tm.calls.some((c) => c[0] === 'unregister'));
  assert.equal((await p.call('chat.state', {})).state, 'off');
  await members.svc.destroy();
});

async function pair(clock, { contacts = true } = {}) {
  const ana = await person(clock);
  const bo = await person(clock);
  await ana.call('chat.enable', {});
  await bo.call('chat.enable', {});
  const wires = connect(ana.tm, bo.tm);
  await waitFor(() => ana.svc.lane.peers().length === 1 && bo.svc.lane.peers().length === 1);
  await waitFor(() => ana.svc.lane && bo.svc.lane && ana.svc.lane.neighbourOf(bo.chat.pub) && bo.svc.lane.neighbourOf(ana.chat.pub));
  // Review round (PRIV-2): a CK goes only where there is a reason. Contacts both ways: each side is looking for the
  // other's chat key, so each shows its CK to its neighbours.
  if (contacts) {
    await ana.call('chat.contacts.add', { pub: bo.pub, nick: 'Bo' });
    await bo.call('chat.contacts.add', { pub: ana.pub, nick: 'Ana' });
    await waitFor(() => ana.svc.sig.ckOf(bo.pub) && bo.svc.sig.ckOf(ana.pub));
    await settle(4);
  }
  return { ana, bo, wires };
}

test('DMs between contacts: delivered live, ACKed after 2 to 20 s, never written to the ledger', async () => {
  const clock = fakeClock();
  const { ana, bo } = await pair(clock);
  await ana.call('chat.contacts.add', { pub: bo.pub, nick: 'Bo' });
  await bo.call('chat.contacts.add', { pub: ana.pub, nick: 'Ana' });
  const r = await ana.call('chat.dm.send', { pub: bo.pub, text: 'Hi Bo' });
  assert.equal(r.state, 'outbox');
  assert.match(r.id, /^[A-Za-z0-9_-]{22}$/);
  await waitFor(() => bo.events.message.length === 1);
  const m = bo.events.message[0];
  assert.equal(m.text, 'Hi Bo');
  assert.equal(m.from, ana.pub);
  assert.equal(m.id, r.id);
  assert.equal(m.gap, false);
  // The ACK leaves after a random 2 to 20 s delay.
  await clock.advance(1900);
  assert.equal(ana.events.delivery.filter((e) => e.state === 'delivered').length, 0);
  await clock.advance(18200);
  await waitFor(() => ana.events.delivery.some((e) => e.id === r.id && e.state === 'delivered'));
  // Second message: the counter moves on; history is ordered.
  await ana.call('chat.dm.send', { pub: bo.pub, text: 'Second' });
  await waitFor(() => bo.events.message.length === 2);
  assert.equal(bo.events.message[1].n, 1);
  const h = await bo.call('chat.dm.history', { pub: ana.pub });
  assert.deepEqual(h.map((x) => x.text), ['Hi Bo', 'Second']);
  // States are exactly the five strings.
  for (const e of ana.events.delivery) assert.ok(['delivered', 'handed', 'outbox', 'sent-unknown', 'not-delivered'].includes(e.state), e.state);
  // No conversation in the ledger.
  assert.deepEqual(ana.node.appended, []);
  assert.deepEqual(bo.node.appended, []);
  assert.equal((await ana.call('chat.contacts.verify', { pub: bo.pub })).code, (await bo.call('chat.contacts.verify', { pub: ana.pub })).code, 'both sides see one safety code');
  await ana.svc.destroy();
  await bo.svc.destroy();
});

test('DM errors: E_NO_CHAT_KEY, E_BLOCKED, E_LIMIT, E_RATE, E_SYNCING, E_BAD_REQUEST; direct channels', async () => {
  const clock = fakeClock();
  const { ana, bo } = await pair(clock);
  const stranger = (await generateKeyPair()).publicKey;
  const nobody = await exportPublicKey(stranger);
  assert.equal(await code(ana.call('chat.dm.send', { pub: nobody, text: 'x' })), 'E_NO_CHAT_KEY');
  assert.equal(await code(ana.call('chat.dm.send', { pub: 'not-a-key', text: 'x' })), 'E_BAD_REQUEST');
  await ana.call('chat.contacts.add', { pub: bo.pub });
  assert.equal(await code(ana.call('chat.dm.send', { pub: bo.pub, text: 'x'.repeat(4001) })), 'E_LIMIT');
  assert.equal(await code(ana.call('chat.dm.send', { pub: bo.pub, text: '' })), 'E_BAD_REQUEST');
  ana.node.syncing = true;
  assert.equal(await code(ana.call('chat.dm.send', { pub: bo.pub, text: 'x' })), 'E_SYNCING');
  ana.node.syncing = false;
  await ana.call('chat.contacts.block', { pub: bo.pub });
  assert.equal(await code(ana.call('chat.dm.send', { pub: bo.pub, text: 'x' })), 'E_BLOCKED');
  await ana.call('chat.contacts.unblock', { pub: bo.pub });
  await ana.call('chat.contacts.add', { pub: bo.pub });
  let rate = null;
  for (let i = 0; i < 61 && !rate; i++) rate = await code(ana.call('chat.dm.send', { pub: bo.pub, text: 'n' + i }));
  assert.equal(rate, 'E_RATE');
  // C2 calls: direct data channels stay P2; with calls off the site setting answers, with calls on the version does.
  assert.equal(await code(ana.call('chat.direct.connect', { pub: nobody })), 'E_POLICY');
  assert.equal(await code(ana.call('chat.direct.connect', { pub: bo.pub })), 'E_POLICY');
  ana.cfg.calls = 'contacts';
  assert.equal(await code(ana.call('chat.direct.connect', { pub: bo.pub })), 'E_UNSUPPORTED');
  assert.equal(await code(ana.call('chat.direct.connect', { pub: nobody })), 'E_UNSUPPORTED', 'and it tells the site nothing about who is a contact');
  assert.equal(await code(ana.call('chat.direct.connect', { pub: 'x' })), 'E_BAD_REQUEST');
  await ana.svc.destroy();
  await bo.svc.destroy();
});

test('message requests: a stranger\'s first message arrives as a request (no preview) and opens after accept', async () => {
  const clock = fakeClock();
  const { ana, bo } = await pair(clock, { contacts: false });
  // Bo has not opened requests: his chat key is not shown to a neighbour that is not a contact (review round, PRIV-2).
  assert.equal(await code(ana.call('chat.dm.send', { pub: bo.pub, text: 'request one' })), 'E_NO_CHAT_KEY');
  await clock.advance(100);
  await settle(20);
  assert.equal(bo.events.request.length, 0);
  assert.deepEqual(await bo.call('chat.requests.setOpen', { open: true }), { open: true });
  await waitFor(() => ana.svc.sig.ckOf(bo.pub));
  const r = await ana.call('chat.dm.send', { pub: bo.pub, text: 'hello from a stranger' });
  assert.equal(r.state, 'sent-unknown');
  await waitFor(() => bo.events.request.length === 1);
  const req = bo.events.request[0];
  assert.equal(req.from, ana.pub);
  assert.equal(req.text, undefined, 'no preview');
  const list = await bo.call('chat.requests.list', {});
  assert.equal(list.length, 1);
  assert.equal(await code(bo.call('chat.requests.accept', { id: 'nope' })), 'E_BAD_REQUEST');
  await bo.call('chat.requests.accept', { id: list[0].id });
  assert.equal(bo.events.message.at(-1).text, 'hello from a stranger');
  assert.deepEqual(await bo.call('chat.requests.list', {}), []);
  // Strangers get no ACK.
  await clock.advance(25000);
  await settle(10);
  assert.equal(ana.events.delivery.filter((e) => e.state === 'delivered').length, 0);
  // A site without requests: sending to a non-contact is E_POLICY.
  ana.cfg.requests = 'off';
  assert.equal(await code(ana.call('chat.dm.send', { pub: bo.pub, text: 'x' })), 'E_POLICY');
  assert.equal(await code(bo.call('chat.requests.setOpen', { open: true })), null);
  bo.cfg.requests = 'off';
  assert.equal(await code(bo.call('chat.requests.setOpen', { open: true })), 'E_POLICY');
  await ana.svc.destroy();
  await bo.svc.destroy();
});

test('rooms are signed and checked; groups need members, admins and chat keys; holders refuse phones', async () => {
  const clock = fakeClock();
  const { ana, bo } = await pair(clock);
  assert.equal(await code(ana.call('chat.room.send', { name: 'Lobby', text: 'x' })), 'E_POLICY', 'join first');
  const j = await ana.call('chat.room.join', {});
  assert.equal(j.name, 'Lobby');
  assert.match(j.label, /a recording proves what you wrote/);
  await bo.call('chat.room.join', { name: 'Lobby' });
  await ana.call('chat.room.send', { name: 'Lobby', text: 'hello room' });
  await waitFor(() => bo.events.room.length === 1);
  assert.equal(bo.events.room[0].text, 'hello room');
  assert.equal(bo.events.room[0].from, ana.pub);
  assert.equal(await code(ana.call('chat.room.send', { name: 'Lobby', text: 'x'.repeat(2001) })), 'E_LIMIT');
  let rate = null;
  for (let i = 0; i < 11 && !rate; i++) rate = await code(ana.call('chat.room.send', { name: 'Lobby', text: 'r' + i }));
  assert.equal(rate, 'E_RATE');
  ana.node.state.policy.banned.add(ana.pub);
  assert.equal(await code(ana.call('chat.room.join', { name: 'Other' })), 'E_BANNED');
  ana.node.state.policy.banned.delete(ana.pub);
  // A banned author's room frames are dropped by others.
  await clock.advance(11000);
  bo.node.state.policy.banned.add(ana.pub);
  await ana.call('chat.room.send', { name: 'Lobby', text: 'from a banned key' });
  await clock.advance(100);
  await settle(20);
  assert.ok(!bo.events.room.some((e) => e.text === 'from a banned key'));
  bo.node.state.policy.banned.delete(ana.pub);
  // Groups.
  await ana.call('chat.contacts.add', { pub: bo.pub });
  await bo.call('chat.contacts.add', { pub: ana.pub });
  const nobody = await exportPublicKey((await generateKeyPair()).publicKey);
  assert.equal(await code(ana.call('chat.group.create', { name: 'g', members: [nobody] })), 'E_NO_CHAT_KEY');
  const g = await ana.call('chat.group.create', { name: 'pair', members: [bo.pub] });
  assert.equal(g.members.length, 2);
  await waitFor(() => bo.events.group.some((e) => e.groupId === g.groupId));
  await ana.call('chat.group.send', { groupId: g.groupId, text: 'hello group' });
  await waitFor(() => bo.events.group.some((e) => e.text === 'hello group'));
  assert.equal(await code(bo.call('chat.group.invite', { groupId: g.groupId, pub: nobody })), 'E_NOT_ADMIN');
  assert.equal(await code(bo.call('chat.group.send', { groupId: 'nope', text: 'x' })), 'E_NOT_MEMBER');
  assert.equal(await code(ana.call('chat.group.remove', { groupId: g.groupId, pub: nobody })), 'E_NOT_MEMBER');
  // Holders: desktops after the card; phones never.
  assert.deepEqual(await ana.call('chat.holder.set', { on: true }), { on: true });
  assert.ok(ana.prompts.includes('chat.holder'));
  const phone = await person(clock, { deps: { deviceClass: 'ios' } });
  await phone.call('chat.enable', {});
  assert.equal(await code(phone.call('chat.holder.set', { on: true })), 'E_POLICY');
  assert.deepEqual(ana.node.appended, [], 'no ledger writes for rooms or groups');
  await ana.svc.destroy();
  await bo.svc.destroy();
  await phone.svc.destroy();
});

test('the opt-in ledger copy of the chat key is the only ledger write, and only after its card', async () => {
  const clock = fakeClock();
  const p = await person(clock);
  await p.call('chat.enable', { ledgerCopy: true });
  assert.deepEqual(p.prompts, ['chat.enable', 'chat.ck.ledger']);
  assert.equal(p.node.appended.length, 1);
  assert.equal(p.node.appended[0][0], 'mw.ck');
  assert.equal(p.node.appended[0][1].ek, p.chat.pub);
  await p.svc.destroy();
});

test('junk addressed to a public inbox tag strikes only the neighbour that made it (hop 0), never a relay', async () => {
  const { T, envBody, withHop } = await import('../../src/chat/frames.js');
  const { inboxTag } = await import('../../src/chat/tags.js');
  const { publicKeyBytes } = await import('../../src/chain/crypto.js');
  const { FLAG_STRANGER } = await import('../../src/chat/limits.js');
  const clock = fakeClock();
  const { ana, bo } = await pair(clock, { contacts: false });
  await bo.call('chat.requests.setOpen', { open: true });
  const strikes = [];
  bo.svc.lane.on('strike', (s) => strikes.push(s));
  const tag = await inboxTag(bo.chat.pub, Math.floor(clock.now() / DAY_MS));
  const junk = async () => ana.svc.lane.stamped(T.ENV, {
    flags: FLAG_STRANGER, bits: 10,
    body: envBody({ tag, epk: publicKeyBytes((await generateChatKey()).pub), iv: new Uint8Array(12), ct: new Uint8Array(1040) }),
  });
  ana.svc.lane.send(withHop(await junk(), 1), { to: bo.chat.pub });
  await settle(20);
  assert.equal(strikes.length, 0, 'a relayed frame is not the relay\'s fault');
  ana.svc.lane.send(await junk(), { to: bo.chat.pub });
  await waitFor(() => strikes.length === 1);
  assert.equal(strikes[0].reason, 'aead');
  await ana.svc.destroy();
  await bo.svc.destroy();
});

// ---------------------------------------------------------------------------------------------
// C2 calls: the SIG seam (src/calls/service.js uses it; docs/deviations/calls.md)
// ---------------------------------------------------------------------------------------------

async function sigPair(clock, { contacts = true } = {}) {
  const { ana, bo } = await pair(clock, { contacts });
  ana.cfg.calls = 'contacts';
  bo.cfg.calls = 'contacts';
  if (contacts) {
    await ana.call('chat.contacts.add', { pub: bo.pub, nick: 'Bo' });
    await bo.call('chat.contacts.add', { pub: ana.pub, nick: 'Ana' });
  }
  const got = [];
  bo.svc.sig.onReceive((pub, payload, meta) => got.push({ pub, text: new TextDecoder().decode(payload), meta }));
  const frames = [];
  const send = ana.svc.lane.send.bind(ana.svc.lane);
  ana.svc.lane.send = (f, o) => {
    frames.push(new Uint8Array(f));
    return send(f, o);
  };
  return { ana, bo, got, frames };
}

async function craft(ana, bo, { type, kind, flags = 0 }) {
  const { sealDm } = await import('../../src/chat/seal.js');
  const { envBody } = await import('../../src/chat/frames.js');
  const ck = ana.svc.sig.ckOf(bo.pub);
  const id = new Uint8Array(16);
  globalThis.crypto.getRandomValues(id);
  const sealed = await sealDm({ myChat: ana.chat, theirChatPub: ck.ek, ledgerId: LEDGER, day: Math.floor(Date.now() / DAY_MS), message: { id, t: Date.now(), n: 0, kind, body: new TextEncoder().encode('{"crafted":true}') }, directional: true });
  return ana.svc.lane.stamped(type, { flags, bits: 10, body: envBody(sealed) });
}

test('SIG seam: a contact\'s payload is sealed under kind sig in a SIG frame (no hold, no stranger), delivered once, never ACKed, never in history', async () => {
  const { T, decode } = await import('../../src/chat/frames.js');
  // The fake clock starts now: craft() below seals with the real date, which must be today for the receiver.
  const { ana, bo, got, frames } = await sigPair(fakeClock(Date.now()));
  const r = await ana.svc.sig.send(bo.pub, '{"hello":"sig"}');
  assert.equal(r.reached, 1);
  assert.equal(r.route, 'direct');
  assert.equal(r.bucket, 256);
  await waitFor(() => got.length === 1);
  assert.equal(got[0].pub, ana.pub);
  assert.equal(got[0].text, '{"hello":"sig"}');
  assert.equal(got[0].meta.contact, true);
  assert.equal(got[0].meta.listen, false);
  assert.deepEqual(got[0].meta.groups, []);
  const d = decode(frames[0]);
  assert.equal(d.type, T.SIG);
  assert.equal(d.header.flags, 0, 'never FLAG_HOLD, never FLAG_STRANGER');
  assert.equal(new TextDecoder().decode(frames[0]).indexOf('hello'), -1, 'sealed');
  // Bytes too, and the 16,000 bucket for a large payload.
  const big = await ana.svc.sig.send(bo.pub, new Uint8Array(9000).fill(65));
  assert.equal(big.bucket, 16000);
  await waitFor(() => got.length === 2);
  assert.equal(got[1].text.length, 9000);
  // Never in history, never ACKed (no delivery events, no message events).
  await new Promise((res) => setTimeout(res, 50));
  assert.deepEqual(bo.events.message, []);
  assert.deepEqual(await bo.call('chat.dm.history', { pub: ana.pub }), []);
  assert.deepEqual(ana.events.delivery, []);
  // Bounds and refusals.
  assert.equal(await code(ana.svc.sig.send(bo.pub, new Uint8Array(15001))), 'E_LIMIT');
  assert.equal(await code(ana.svc.sig.send(bo.pub, '')), 'E_LIMIT');
  assert.equal(await code(ana.svc.sig.send(bo.pub, 42)), 'E_BAD_REQUEST');
  assert.equal(await code(ana.svc.sig.send('p256:nope', 'x')), 'E_BAD_REQUEST');
  await ana.call('chat.contacts.block', { pub: bo.pub });
  assert.equal(await code(ana.svc.sig.send(bo.pub, 'x')), 'E_BLOCKED');
  await ana.call('chat.contacts.unblock', { pub: bo.pub });
  // Bo blocks Ana: nothing from her reaches the seam any more.
  await bo.call('chat.contacts.block', { pub: ana.pub });
  await ana.svc.sig.send(bo.pub, '{"after":"block"}');
  await new Promise((res) => setTimeout(res, 50));
  assert.equal(got.length, 2);
  // The accessors.
  assert.deepEqual(Object.keys(ana.svc.sig.contact(bo.pub)).sort(), ['accepted', 'blocked', 'hasChatKey', 'nick', 'pub', 'verified']);
  assert.equal(ana.svc.sig.contact(bo.pub).hasChatKey, true);
  assert.deepEqual(ana.svc.sig.state(), { on: true, calls: true });
  assert.equal(ana.svc.sig.ckOf(bo.pub).ek, bo.chat.pub);
  await ana.call('chat.disable', {});
  assert.equal(await code(ana.svc.sig.send(bo.pub, 'x')), 'E_POLICY', 'chat off');
  await ana.svc.destroy();
  await bo.svc.destroy();
});

test('SIG seam: kind sig only inside SIG, SIG only with kind sig; a held SIG is dropped; nothing becomes a message', async () => {
  const { T } = await import('../../src/chat/frames.js');
  const { KIND, FLAG_HOLD } = await import('../../src/chat/limits.js');
  const { ana, bo, got } = await sigPair(fakeClock(Date.now()));
  for (const f of [
    await craft(ana, bo, { type: T.ENV, kind: KIND.sig }),
    await craft(ana, bo, { type: T.SIG, kind: KIND.text }),
    await craft(ana, bo, { type: T.SIG, kind: KIND.sig, flags: FLAG_HOLD }),
  ]) ana.svc.lane.send(f, { to: bo.chat.pub });
  await new Promise((res) => setTimeout(res, 80));
  assert.deepEqual(got, [], 'none reached the seam');
  assert.deepEqual(bo.events.message, [], 'none became a message');
  ana.svc.lane.send(await craft(ana, bo, { type: T.SIG, kind: KIND.sig }), { to: bo.chat.pub });
  await waitFor(() => got.length === 1);
  assert.equal(got[0].text, '{"crafted":true}');
  await ana.svc.destroy();
  await bo.svc.destroy();
});

test('SIG seam: a listen set lets a call roster key that is not a contact send SIG (and nothing else) for at most 2 h', async () => {
  const clock = fakeClock(Date.now());
  const { ana, bo, got } = await sigPair(clock, { contacts: false });
  assert.equal(await code(ana.svc.sig.send(bo.pub, 'x')), 'E_NOT_CONTACT');
  const stopA = ana.svc.sig.listen([bo.pub], clock.now() + 10 * 3600000);
  const stopB = bo.svc.sig.listen([ana.pub, 'not a key', bo.pub]);
  await settle(10);
  await ana.svc.sig.send(bo.pub, '{"roster":"member"}');
  await waitFor(() => got.length === 1);
  assert.equal(got[0].meta.contact, false);
  assert.equal(got[0].meta.listen, true);
  // The same key cannot slip a message through its SIG-only interest: an ENV under the pair tag is dropped unopened,
  // and a DM through the inbox is a request (none open here), never a message.
  const { T } = await import('../../src/chat/frames.js');
  const { KIND } = await import('../../src/chat/limits.js');
  ana.svc.lane.send(await craft(ana, bo, { type: T.ENV, kind: KIND.text }), { to: bo.chat.pub });
  await ana.call('chat.dm.send', { pub: bo.pub, text: 'not through the seam' }).catch(() => {});
  await new Promise((res) => setTimeout(res, 80));
  assert.deepEqual(bo.events.message, []);
  assert.deepEqual(bo.events.request, []);
  assert.equal(got.length, 1);
  // At most 2 h, whatever was asked.
  await clock.advance(2 * 3600000 + 1000);
  assert.equal(await code(ana.svc.sig.send(bo.pub, 'x')), 'E_NOT_CONTACT', 'the sender\'s listen set ended at 2 h');
  stopA();
  stopB();
  stopB();
  await ana.svc.destroy();
  await bo.svc.destroy();
});

test('SIG seam: members of a group both hold may signal while calls are on, naming the group', async () => {
  const clock = fakeClock(Date.now());
  const ana = await person(clock, { cfg: { calls: 'contacts' } });
  const bo = await person(clock, { cfg: { calls: 'contacts' } });
  const cy = await person(clock, { cfg: { calls: 'contacts' } });
  for (const p of [ana, bo, cy]) await p.call('chat.enable', {});
  connect(ana.tm, bo.tm);
  connect(ana.tm, cy.tm);
  connect(bo.tm, cy.tm);
  for (const [x, y] of [[ana, bo], [bo, ana], [ana, cy], [cy, ana]]) await x.call('chat.contacts.add', { pub: y.pub });
  await waitFor(() => ana.svc.sig.ckOf(bo.pub) && ana.svc.sig.ckOf(cy.pub) && bo.svc.sig.ckOf(ana.pub) && cy.svc.sig.ckOf(ana.pub));
  const g = await ana.call('chat.group.create', { name: 'trio', members: [bo.pub, cy.pub] });
  await waitFor(() => bo.events.group.some((e) => e.groupId === g.groupId) && cy.events.group.some((e) => e.groupId === g.groupId));
  // Review round (PRIV-2): Bo and Cy show each other their CKs once they share a group (each looks for the other's).
  await waitFor(() => bo.svc.sig.ckOf(cy.pub) && cy.svc.sig.ckOf(bo.pub));
  assert.deepEqual(bo.svc.sig.groupMembers(g.groupId).sort(), [ana.pub, cy.pub].sort());
  assert.equal(bo.svc.sig.contact(cy.pub), null, 'Bo and Cy are not contacts');
  const got = [];
  cy.svc.sig.onReceive((pub, payload, meta) => got.push({ pub, meta }));
  assert.equal(await code(bo.svc.sig.send(cy.pub, 'x')), 'E_NOT_CONTACT', 'without naming the group');
  await bo.svc.sig.send(cy.pub, '{"group":"call"}', { group: g.groupId });
  await waitFor(() => got.length === 1);
  assert.equal(got[0].pub, bo.pub);
  assert.deepEqual(got[0].meta.groups, [g.groupId]);
  assert.equal(got[0].meta.contact, false);
  // Calls off at the receiver: a member who is not a contact is no longer heard.
  cy.cfg.calls = 'off';
  await bo.svc.sig.send(cy.pub, '{"group":"again"}', { group: g.groupId });
  await new Promise((res) => setTimeout(res, 80));
  assert.equal(got.length, 1);
  bo.cfg.calls = 'off';
  assert.equal(await code(bo.svc.sig.send(cy.pub, 'x', { group: g.groupId })), 'E_NOT_CONTACT', 'and calls off at the sender refuses it');
  for (const p of [ana, bo, cy]) await p.svc.destroy();
});

test('SIG seam: host-only refuses before anything is sealed; destroy() drops the listeners', async () => {
  const clock = fakeClock(Date.now());
  let hostOnly = false;
  const p = await person(clock, { deps: { hostOnly: () => hostOnly } });
  await p.call('chat.enable', {});
  hostOnly = true;
  assert.equal(await code(p.svc.sig.send(p.pub, 'x')), 'E_HOST_ONLY');
  assert.throws(() => p.svc.sig.onReceive(null), TypeError);
  const off = p.svc.sig.onReceive(() => {});
  off();
  await p.svc.destroy();
  assert.equal(await code(p.svc.sig.send(p.pub, 'x')), 'E_POLICY');
});

// ---------------------------------------------------------------------------------------------
// Code review v0.3 (chat): reloads, held mail, lost ACKs, day changes, held copies, groups, HOLDING
// ---------------------------------------------------------------------------------------------

async function link(a, b) {
  const wires = connect(a.tm, b.tm);
  await waitFor(() => a.svc.lane && b.svc.lane && a.svc.lane.neighbourOf(b.chat.pub) && b.svc.lane.neighbourOf(a.chat.pub));
  return wires;
}

/**
 * A page reload: the tab dies (no turnOff, nothing saved from then on: the new page reads a copy of what was in the
 * sealed store at that moment) and the service is made again with the same keys.
 */
async function reload(clock, p, overrides = {}) {
  const disk = memStore();
  for (const [k, v] of p.store.m) disk.m.set(k, JSON.parse(JSON.stringify(v)));
  if (p.svc.lane) p.svc.lane.disable(); // its wires close; the dead page's timers write only to its own store
  const q = await person(clock, Object.assign({ identity: p, store: disk }, overrides));
  await q.call('chat.enable', {});
  return q;
}

/** Ana and Bo meet once and add each other, then part; Carol holds messages and is connected to Ana. */
async function heldSetup(clock, { holder = true } = {}) {
  const ana = await person(clock);
  const bo = await person(clock);
  const carol = await person(clock);
  for (const p of [ana, bo, carol]) await p.call('chat.enable', {});
  const [ab] = await link(ana, bo);
  await ana.call('chat.contacts.add', { pub: bo.pub, nick: 'Bo' });
  await bo.call('chat.contacts.add', { pub: ana.pub, nick: 'Ana' });
  await waitFor(() => ana.svc.sig.ckOf(bo.pub) && bo.svc.sig.ckOf(ana.pub));
  await settle(4);
  ab.destroy();
  await settle();
  if (holder) await carol.call('chat.holder.set', { on: true });
  const [ac] = await link(ana, carol);
  return { ana, bo, carol, ac };
}

test('code review v0.3 (p7): contacts\' chat keys survive a reload, so held mail is still collected and DMs still go out', async () => {
  const clock = fakeClock();
  const { ana, bo, carol, ac } = await heldSetup(clock);
  await ana.call('chat.dm.send', { pub: bo.pub, text: 'held for Bo', deliverLater: true });
  await clock.advance(5000);
  assert.equal(carol.svc.lane.holder.stats().count, 1);
  ac.destroy();
  await ana.svc.destroy();
  const bo2 = await reload(clock, bo);
  const list = await bo2.call('chat.contacts.list', {});
  assert.deepEqual(list.map((c) => [c.nick, c.hasChatKey]), [['Ana', true]], 'Ana\'s chat key came back from the sealed store');
  await link(bo2, carol);
  await clock.advance(2 * 60000);
  await waitFor(() => bo2.events.message.some((m) => m.text === 'held for Bo'));
  await waitFor(() => carol.svc.lane.holder.stats().count === 0);
  const r = await bo2.call('chat.dm.send', { pub: ana.pub, text: 'got it' });
  assert.equal(r.state, 'outbox', 'not E_NO_CHAT_KEY');
  await bo2.svc.destroy();
  await carol.svc.destroy();
});

test('code review v0.3 (p4): held mail older than one UTC day is collected; after the 7-day hold it is gone', async () => {
  for (const [gap, got] of [[72 * 3600000, 1], [8 * DAY_MS, 0]]) {
    const clock = fakeClock();
    const { ana, bo, carol, ac } = await heldSetup(clock);
    await ana.call('chat.dm.send', { pub: bo.pub, text: 'see you', deliverLater: true });
    await clock.advance(5000);
    assert.equal(carol.svc.lane.holder.stats().count, 1);
    ac.destroy();
    await ana.svc.destroy();
    await clock.jump(gap);
    await link(bo, carol);
    await clock.advance(2 * 60000);
    if (got) await waitFor(() => bo.events.message.some((m) => m.text === 'see you'));
    else {
      await settle(20);
      assert.equal(carol.svc.lane.holder.stats().count, 0, 'expired at the holder');
    }
    assert.equal(bo.events.message.filter((m) => m.text === 'see you').length, got, (gap / 3600000) + ' h');
    await bo.svc.destroy();
    await carol.svc.destroy();
  }
});

test('code review v0.3 (p3): a lost ACK is sent again for the next copy; the message shows once', async () => {
  const clock = fakeClock();
  const { ana, bo, wires } = await pair(clock);
  await ana.call('chat.contacts.add', { pub: bo.pub, nick: 'Bo' });
  await bo.call('chat.contacts.add', { pub: ana.pub, nick: 'Ana' });
  const r = await ana.call('chat.dm.send', { pub: bo.pub, text: 'Hi Bo' });
  await waitFor(() => bo.events.message.length === 1);
  wires[0].destroy(); // the wire drops before Bo's ACK leaves (2 to 20 s)
  await settle();
  await clock.advance(25000);
  assert.ok(!ana.events.delivery.some((e) => e.id === r.id && e.state === 'delivered'), 'the ACK went to nobody');
  await link(ana, bo);
  await clock.advance(10 * 60000);
  await waitFor(() => ana.events.delivery.some((e) => e.id === r.id && e.state === 'delivered'));
  assert.equal(bo.events.message.length, 1, 'no second message event');
  // A reload of Bo keeps what he delivered, so a copy after the reload is ACKed too.
  const r2 = await ana.call('chat.dm.send', { pub: bo.pub, text: 'Second' });
  await waitFor(() => bo.events.message.length === 2);
  await clock.advance(3000);
  const bo2 = await reload(clock, bo);
  await link(ana, bo2);
  await clock.advance(10 * 60000);
  await waitFor(() => ana.events.delivery.some((e) => e.id === r2.id && e.state === 'delivered'));
  assert.equal(bo2.events.message.length, 0, 'the replayed copy is not shown again after the reload');
  await ana.svc.destroy();
  await bo2.svc.destroy();
});

test('code review v0.3 (p8): a long-lived tab follows the UTC day; messages after 0, 20, 44 and 68 h arrive', async () => {
  const clock = fakeClock();
  const { ana, bo } = await pair(clock);
  await ana.call('chat.contacts.add', { pub: bo.pub, nick: 'Bo' });
  await bo.call('chat.contacts.add', { pub: ana.pub, nick: 'Ana' });
  await ana.call('chat.dm.send', { pub: bo.pub, text: 'day 0' });
  await clock.advance(60000);
  for (const h of [20, 44, 68]) {
    await clock.jump((h === 20 ? 20 : 24) * 3600000 - 2 * 60000);
    await clock.advance(60000);
    await ana.call('chat.dm.send', { pub: bo.pub, text: 'after ' + h + ' h' });
    await clock.advance(60000);
  }
  await waitFor(() => bo.events.message.length === 4);
  assert.deepEqual(bo.events.message.map((m) => m.text), ['day 0', 'after 20 h', 'after 44 h', 'after 68 h']);
  await ana.svc.destroy();
  await bo.svc.destroy();
});

test('code review v0.3: one held copy per message per UTC day; a holder keeps the message once', async () => {
  const clock = fakeClock();
  const { ana, bo, carol } = await heldSetup(clock, { holder: false });
  const { decode, frameId } = await import('../../src/chat/frames.js');
  const { FLAG_HOLD } = await import('../../src/chat/limits.js');
  const held = new Set();
  const send = ana.svc.lane.send.bind(ana.svc.lane);
  ana.svc.lane.send = (f, o) => {
    const dd = decode(f);
    if (dd.header.flags & FLAG_HOLD) held.add(Buffer.from(frameId(dd)).toString('hex'));
    return send(f, o);
  };
  await ana.call('chat.dm.send', { pub: bo.pub, text: 'once', deliverLater: true });
  await clock.advance(30 * 60000); // retries every 5 minutes while Carol holds nothing
  assert.equal(held.size, 1, 'every re-send of the day is the same frame');
  await carol.call('chat.holder.set', { on: true });
  await clock.advance(30 * 60000);
  assert.equal(carol.svc.lane.holder.stats().count, 1, 'held once, not once per retry');
  assert.equal(held.size, 1);
  await ana.svc.destroy();
  await bo.svc.destroy();
  await carol.svc.destroy();
});

async function trio(clock) {
  const ana = await person(clock);
  const bo = await person(clock);
  const cy = await person(clock);
  for (const p of [ana, bo, cy]) await p.call('chat.enable', {});
  connect(ana.tm, bo.tm);
  connect(ana.tm, cy.tm);
  connect(bo.tm, cy.tm);
  await waitFor(() => [ana, bo, cy].every((p) => p.svc.lane.peers().length === 2));
  for (const [x, y] of [[ana, bo], [bo, ana], [ana, cy], [cy, ana]]) await x.call('chat.contacts.add', { pub: y.pub });
  await waitFor(() => ana.svc.sig.ckOf(bo.pub) && ana.svc.sig.ckOf(cy.pub) && bo.svc.sig.ckOf(ana.pub) && cy.svc.sig.ckOf(ana.pub));
  return { ana, bo, cy };
}

test('code review v0.3: a removed group member cannot keep posting through the epoch it still holds', async () => {
  const clock = fakeClock();
  const { ana, bo, cy } = await trio(clock);
  const g = await ana.call('chat.group.create', { name: 'trio', members: [bo.pub, cy.pub] });
  await waitFor(() => bo.events.group.some((e) => e.groupId === g.groupId) && cy.events.group.some((e) => e.groupId === g.groupId));
  await bo.call('chat.group.send', { groupId: g.groupId, text: 'before' });
  await clock.advance(5000);
  await waitFor(() => cy.events.group.some((e) => e.text === 'before'));
  const rm = await ana.call('chat.group.remove', { groupId: g.groupId, pub: bo.pub });
  assert.ok(rm.members.indexOf(bo.pub) < 0);
  await waitFor(() => cy.events.group.some((e) => e.event === 'epoch' && e.epochId === rm.epochId));
  assert.deepEqual(cy.svc.groupMembers(g.groupId), [ana.pub]);
  await clock.advance(10 * 60000);
  // Bo got no new key: his tab still writes under the previous epoch, which Cy keeps listening on for 7 days.
  await bo.call('chat.group.send', { groupId: g.groupId, text: 'after removal' });
  await clock.advance(5000);
  await settle(20);
  assert.ok(!cy.events.group.some((e) => e.text === 'after removal'), 'dropped: not a member of the current epoch');
  await ana.call('chat.group.send', { groupId: g.groupId, text: 'new epoch' });
  await clock.advance(5000); // interest routing may send it through Bo, who relays it after the 0.5 to 3 s jitter
  await waitFor(() => cy.events.group.some((e) => e.text === 'new epoch'));
  for (const p of [ana, bo, cy]) await p.svc.destroy();
});

test('code review v0.3: the replay guard is saved after a group message; after a reload the same frame is refused', async () => {
  const clock = fakeClock();
  const { ana, bo } = await pair(clock);
  await ana.call('chat.contacts.add', { pub: bo.pub });
  await bo.call('chat.contacts.add', { pub: ana.pub });
  const g = await ana.call('chat.group.create', { name: 'pair', members: [bo.pub] });
  await waitFor(() => bo.events.group.some((e) => e.groupId === g.groupId));
  const frames = [];
  const send = ana.svc.lane.send.bind(ana.svc.lane);
  ana.svc.lane.send = (f, o) => {
    frames.push({ f: new Uint8Array(f), o });
    return send(f, o);
  };
  await ana.call('chat.group.send', { groupId: g.groupId, text: 'hello group' });
  await waitFor(() => bo.events.group.some((e) => e.text === 'hello group'));
  const captured = frames[frames.length - 1];
  await clock.advance(3000); // the debounced save
  const bo2 = await reload(clock, bo);
  await link(ana, bo2);
  ana.svc.lane.send = send;
  ana.svc.lane.send(captured.f, captured.o); // a relay replays the captured frame
  await clock.advance(5000);
  await settle(20);
  assert.ok(!bo2.events.group.some((e) => e.text === 'hello group'), 'refused as a replay after the reload');
  await ana.call('chat.group.send', { groupId: g.groupId, text: 'after the reload' });
  await waitFor(() => bo2.events.group.some((e) => e.text === 'after the reload'), 5000);
  await ana.svc.destroy();
  await bo2.svc.destroy();
});

test('code review v0.3 and review round (DS-5, MP-7, SYB-17): HOLDING frames count once per neighbour wire and stop nothing: held copies go on until the ACK', async () => {
  const { Outbox } = await import('../../src/chat/outbox.js');
  const clock = fakeClock();
  let sends = 0;
  const ob = new Outbox({ send: async () => { sends++; return { reached: 1, frameId: 'aa' }; }, now: clock.now, setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout });
  await ob.add({ id: 'm1', to: 'p256:x', deliverLater: true, payload: {} });
  assert.equal(sends, 1);
  for (let i = 0; i < 50; i++) ob.holding('aa', 'w1');
  assert.equal(ob.get('m1').handed, 1, 'fifty HOLDING frames from one wire count once');
  assert.equal(ob.get('m1').state, 'handed');
  ob.holding('aa', 'w2');
  assert.equal(ob.get('m1').handed, 2);
  // A HOLDING proves nothing (any neighbour that saw the frame can send one): the held copy goes out every 5 minutes.
  await clock.advance(30 * 60000);
  assert.equal(sends, 7, 'held copies kept going out: ' + sends);
  assert.equal(ob.retry('m1'), true);
  await settle();
  assert.equal(sends, 8, 'the person may still retry');
  ob.ack(['m1']);
  await clock.advance(30 * 60000);
  assert.equal(sends, 8, 'the ACK stops them');
  assert.equal(ob.get('m1').state, 'delivered');
  ob.destroy();
});

test('code review v0.3 round 2: without node.isBanned the reduced state is read with the service clock, so a temporary ban ends', async () => {
  const clock = fakeClock();
  const p = await person(clock);
  await p.call('chat.enable', {});
  // policy.banned holds permanent bans only (ledger-tools fix); banUntil holds every ban with its end.
  p.node.state.policy.banUntil = new Map([[p.pub, clock.now() + 60000]]);
  assert.equal(await code(p.call('chat.room.join', {})), 'E_BANNED', 'banned until the end of the minute');
  await clock.jump(61000);
  assert.equal((await p.call('chat.room.join', {})).joined, true, 'the ban ended: the service clock decides');
  await p.svc.destroy();
});

test('code review v0.3 round 2 (MF-20): a key the ledger shows as rotated away has no chat key here, cached or in the ledger', async () => {
  const clock = fakeClock();
  const { ana, bo } = await pair(clock);
  await ana.call('chat.contacts.add', { pub: bo.pub, nick: 'Bo' });
  await bo.call('chat.contacts.add', { pub: ana.pub, nick: 'Ana' });
  const ok = await ana.call('chat.dm.send', { pub: bo.pub, text: 'before' });
  assert.equal(ok.state, 'outbox');
  // Bo's key was replaced (a recover rotation): a thief holding the old key must not keep receiving Ana's messages.
  ana.node.state.rotations = new Map([[bo.pub, { next: ana.pub, by: 'recover', h: 'a'.repeat(64), ts: clock.now() }]]);
  assert.equal(await code(ana.call('chat.dm.send', { pub: bo.pub, text: 'after the rotation' })), 'E_NO_CHAT_KEY');
  await ana.svc.destroy();
  await bo.svc.destroy();
});

test('code review v0.3 round 2: a frame right behind a CK frame on the same wire is read with the interest that CK brings (a first SIG to a new neighbour arrives)', async () => {
  const { T, decode, envBody } = await import('../../src/chat/frames.js');
  const { KIND } = await import('../../src/chat/limits.js');
  const { sealDm } = await import('../../src/chat/seal.js');
  // The fake clock starts now: the sealed message carries the real date, which must be today for the receiver.
  const clock = fakeClock(Date.now());
  const ana = await person(clock);
  const bo = await person(clock);
  for (const p of [ana, bo]) {
    await p.call('chat.enable', {});
    p.cfg.calls = 'contacts';
  }
  // Contacts before they meet: neither holds the other's chat key, so neither listens on the pair's tags yet.
  await ana.call('chat.contacts.add', { pub: bo.pub, nick: 'Bo' });
  await bo.call('chat.contacts.add', { pub: ana.pub, nick: 'Ana' });
  const got = [];
  bo.svc.sig.onReceive((pub, payload) => got.push({ pub, text: new TextDecoder().decode(payload) }));
  // Ana's SIG to Bo is sealed and stamped before the wire exists, then sent right behind the CK frame she sends to her
  // new neighbour: Bo reads it while the CK frame's interest refresh would still be running in the background.
  const id = new Uint8Array(16);
  globalThis.crypto.getRandomValues(id);
  const sealed = await sealDm({ myChat: ana.chat, theirChatPub: bo.chat.pub, ledgerId: LEDGER, day: Math.floor(Date.now() / DAY_MS), message: { id, t: Date.now(), n: 0, kind: KIND.sig, body: new TextEncoder().encode('{"first":"sig"}') }, directional: true });
  const sig = await ana.svc.lane.stamped(T.SIG, { flags: 0, bits: 10, body: envBody(sealed) });
  const sendTo = ana.svc.lane.sendTo.bind(ana.svc.lane);
  let behind = 0;
  ana.svc.lane.sendTo = (wire, frame) => {
    const r = sendTo(wire, frame);
    if (!behind && decode(frame).type === T.CK) behind = sendTo(wire, sig) ? 1 : -1;
    return r;
  };
  connect(ana.tm, bo.tm);
  await waitFor(() => behind !== 0 && bo.svc.sig.ckOf(ana.pub));
  assert.equal(behind, 1, 'the SIG left right behind the CK frame');
  await waitFor(() => got.length === 1, 3000);
  assert.deepEqual(got, [{ pub: ana.pub, text: '{"first":"sig"}' }]);
  assert.equal(bo.svc.lane.stats.dropped, 0);
  await ana.svc.destroy();
  await bo.svc.destroy();
});

// ---------------------------------------------------------------------------------------------------------------------------
// Review round (R 5.3, 2026-10-24; docs/deviations/review-round-chat.md)
// ---------------------------------------------------------------------------------------------------------------------------

test('review round (PRIV-2, STALK-2): with presence off and no reason, neighbours get no CK and no presence event; contacts find each other', async () => {
  const { T, decode } = await import('../../src/chat/frames.js');
  const clock = fakeClock();
  const ana = await person(clock);
  const bo = await person(clock);
  for (const p of [ana, bo]) await p.call('chat.enable', {});
  const sent = { ana: [], bo: [] };
  for (const [p, k] of [[ana, 'ana'], [bo, 'bo']]) {
    const orig = p.svc.lane.sendTo.bind(p.svc.lane);
    p.svc.lane.sendTo = (w, f) => { sent[k].push(decode(f).type); return orig(w, f); };
  }
  connect(ana.tm, bo.tm);
  await waitFor(() => ana.svc.lane.neighbourOf(bo.chat.pub) && bo.svc.lane.neighbourOf(ana.chat.pub));
  await clock.advance(5000);
  await settle(10);
  assert.ok(!sent.ana.includes(T.CK) && !sent.bo.includes(T.CK), 'no CK frame left either tab');
  assert.equal(ana.svc.sig.ckOf(bo.pub), null);
  assert.deepEqual(ana.events.presence, []);
  assert.deepEqual(bo.events.presence, []);
  // Contacts both ways: each looks for the other's chat key and shows its own; a DM then goes.
  await ana.call('chat.contacts.add', { pub: bo.pub });
  await bo.call('chat.contacts.add', { pub: ana.pub });
  await waitFor(() => ana.svc.sig.ckOf(bo.pub) && bo.svc.sig.ckOf(ana.pub));
  assert.deepEqual(ana.events.presence, [], 'a CK is never a presence event');
  await ana.call('chat.dm.send', { pub: bo.pub, text: 'found you' });
  await waitFor(() => bo.events.message.some((m) => m.text === 'found you'));
  // A third neighbour who is nobody's contact learns neither key.
  const cy = await person(clock);
  await cy.call('chat.enable', {});
  connect(ana.tm, cy.tm);
  await waitFor(() => cy.svc.lane.neighbourOf(ana.chat.pub));
  await clock.advance(5000);
  await settle(10);
  assert.equal(cy.svc.sig.ckOf(ana.pub), null, 'Ana is not looking for anyone now: her CK stays home');
  for (const p of [ana, bo, cy]) await p.svc.destroy();
});

test('review round (UX-14): chat stays on after a reload, without a card, with the joined rooms; chat.disable keeps it off', async () => {
  const clock = fakeClock();
  const ana = await person(clock);
  await ana.call('chat.enable', {});
  await ana.call('chat.room.join', { name: 'Lobby' });
  await settle(4);
  const disk = memStore();
  for (const [k, v] of ana.store.m) disk.m.set(k, JSON.parse(JSON.stringify(v)));
  ana.svc.lane.disable();
  const again = await person(clock, { identity: ana, store: disk });
  const st = await again.call('chat.state', {}, NOCLICK);
  assert.equal(st.state, 'on', 'back on at the first chat.state');
  assert.deepEqual(again.prompts, [], 'no card the second time');
  assert.equal((await again.call('chat.room.send', { name: 'Lobby', text: 'still here' })).id.length, 22, 'the Lobby is joined');
  // A follower tab never turns chat on.
  const follower = await person(clock, { identity: ana, store: disk });
  assert.equal((await follower.call('chat.state', {}, { tab: 'follower' })).state, 'off');
  // Another tracker named by the site: the consent was for the old one.
  const moved = await person(clock, { identity: ana, store: disk, deps: { ownTracker: 'wss://other.example.test' } });
  assert.equal((await moved.call('chat.state', {}, NOCLICK)).state, 'off');
  // The person turns it off: off after the next reload too.
  await again.call('chat.disable', {}, NOCLICK);
  await settle(4);
  const later = await person(clock, { identity: ana, store: again.store });
  assert.equal((await later.call('chat.state', {}, NOCLICK)).state, 'off');
  for (const p of [again, follower, moved, later]) await p.svc.destroy();
});

test('review round (UX-6, MP-13, STALK-12): room events carry the short id; a replayed room message shows once; t is the minute', async () => {
  const { shortId } = await import('../../src/chat/service.js');
  const { shortId: cardShortId } = await import('../../src/idp/cards.js');
  const { T, decode } = await import('../../src/chat/frames.js');
  const clock = fakeClock(T0 + 37123);
  const { ana, bo } = await pair(clock, { contacts: false });
  assert.equal(shortId(ana.pub), cardShortId(ana.pub), 'the identity cards\' short form');
  await ana.call('chat.room.join', {});
  await bo.call('chat.room.join', {});
  const frames = [];
  const send = ana.svc.lane.send.bind(ana.svc.lane);
  ana.svc.lane.send = (f, o) => { frames.push(new Uint8Array(f)); return send(f, o); };
  await ana.call('chat.room.send', { name: 'Lobby', text: 'hello room' });
  await waitFor(() => bo.events.room.length === 1);
  const ev = bo.events.room[0];
  assert.equal(ev.short, shortId(ana.pub), 'the author has a short id, never "?"');
  assert.equal(ev.t % 60000, 0, 'the signed t is rounded down to the minute');
  assert.equal(decode(frames[0]).fields.t, ev.t);
  // The same signed frame again after Bo's lane forgot it (its seen-set flushed): not shown twice.
  bo.svc.lane.seen.map.clear();
  ana.svc.lane.seen.map.clear();
  send(frames[0], {});
  await clock.advance(4000);
  await settle(10);
  assert.equal(bo.events.room.length, 1);
  // A peer's frame with a millisecond t is refused.
  const { roomBody } = await import('../../src/chat/frames.js');
  const { ROOM_PREFIX } = await import('../../src/chat/limits.js');
  const { sha256 } = await import('../../src/chain/crypto.js');
  const { utf8, hex, b64url } = await import('../../src/chain/canonical.js');
  const idb = new Uint8Array(16);
  globalThis.crypto.getRandomValues(idb);
  const id = b64url.encode(idb);
  const t = clock.now();
  assert.notEqual(t % 60000, 0);
  const bytes = utf8.encode(ROOM_PREFIX + LEDGER + '\nLobby\n' + id + '\n' + t + '\n' + hex.encode(await sha256(utf8.encode('ms clock'))));
  const sig = b64url.encode(await sign(ana.kp.privateKey, bytes));
  send(await ana.svc.lane.stamped(T.ROOM, { body: roomBody({ room: 'Lobby', id, t, text: 'ms clock', author: ana.pub, sig }) }), {});
  await clock.advance(4000);
  await settle(10);
  assert.ok(!bo.events.room.some((e) => e.text === 'ms clock'), 'refused');
  await ana.svc.destroy();
  await bo.svc.destroy();
});

test('review round (SYB-14, STALK-9): one request per sender, the oldest goes when 200 are open, decline all; "introduced" takes none', async () => {
  const clock = fakeClock();
  const bo = await person(clock);
  await bo.call('chat.enable', {});
  await bo.call('chat.requests.setOpen', { open: true });
  const strangers = [];
  for (let i = 0; i < 3; i++) {
    const s = await person(clock);
    await s.call('chat.enable', {});
    connect(s.tm, bo.tm);
    strangers.push(s);
  }
  await waitFor(() => strangers.every((s) => s.svc.sig.ckOf(bo.pub)));
  // Two requests from one key: one entry, the newer.
  await strangers[0].call('chat.dm.send', { pub: bo.pub, text: 'first' });
  await waitFor(() => bo.events.request.length === 1);
  await strangers[0].call('chat.dm.send', { pub: bo.pub, text: 'second' });
  await waitFor(() => bo.events.request.length === 2);
  assert.equal((await bo.call('chat.requests.list', {})).length, 1);
  assert.equal(bo.events.request[0].short.length, 9, 'a short id with every request');
  // decline({ from }) and decline({ all: true }).
  await strangers[1].call('chat.dm.send', { pub: bo.pub, text: 'x' });
  await strangers[2].call('chat.dm.send', { pub: bo.pub, text: 'y' });
  await waitFor(() => bo.events.request.length === 4);
  assert.equal((await bo.call('chat.requests.decline', { from: strangers[1].pub })).count, 1);
  assert.equal((await bo.call('chat.requests.decline', { all: true })).count, 2);
  assert.deepEqual(await bo.call('chat.requests.list', {}), []);
  // 'introduced': no requests until introductions are built.
  bo.cfg.requests = 'introduced';
  await strangers[2].call('chat.dm.send', { pub: bo.pub, text: 'not now' }).catch(() => {});
  await clock.advance(1000);
  await settle(20);
  assert.equal((await bo.call('chat.requests.list', {})).length, 0);
  strangers[2].cfg.requests = 'introduced';
  assert.equal(await code(strangers[2].call('chat.dm.send', { pub: bo.pub, text: 'z' })), 'E_POLICY');
  assert.equal(await code(bo.call('chat.requests.setOpen', { open: true })), 'E_POLICY');
  for (const p of [bo, ...strangers]) await p.svc.destroy();
});

test('review round (SYB-14): a full inbox lets its oldest request go and counts it', async () => {
  const { sealDm } = await import('../../src/chat/seal.js');
  const { T, envBody } = await import('../../src/chat/frames.js');
  const { FLAG_STRANGER, KIND, REQUESTS_MAX } = await import('../../src/chat/limits.js');
  const { makeCk } = await import('../../src/chat/ck.js');
  const clock = fakeClock(Date.now());
  const { ana, bo } = await pair(clock, { contacts: false });
  await bo.call('chat.requests.setOpen', { open: true });
  await waitFor(() => ana.svc.sig.ckOf(bo.pub));
  const ek = bo.svc.sig.ckOf(bo.pub).ek;
  const n = REQUESTS_MAX + 3;
  for (let i = 0; i < n; i++) {
    const s = await generateKeyPair();
    const spub = await exportPublicKey(s.publicKey);
    const chat = await generateChatKey();
    const ck = await makeCk({ signer: { pub: spub, sign: (b) => sign(s.privateKey, b) }, ledger: LEDGER, ek: chat.pub, now: clock.now() });
    const sealed = await sealDm({ myChat: chat, theirChatPub: ek, ledgerId: LEDGER, day: Math.floor(clock.now() / DAY_MS), stranger: true, ck, blindInbox: true, message: { t: clock.now(), n: 0, kind: KIND.text, body: new TextEncoder().encode('r' + i) } });
    ana.svc.lane.send(await ana.svc.lane.stamped(T.ENV, { flags: FLAG_STRANGER, bits: 10, body: envBody(sealed) }), { to: bo.chat.pub });
    if (i % 40 === 39) await clock.advance(1100); // under the 50-a-second decrypt budget of one wire
  }
  await waitFor(() => bo.events.request.length === n, 20000);
  assert.equal((await bo.call('chat.requests.list', {})).length, REQUESTS_MAX);
  assert.equal((await bo.call('chat.state', {})).requestsDropped, 3);
  await ana.svc.destroy();
  await bo.svc.destroy();
});

test('review round (SYB-16): at most 16 groups are adopted from one inviter', async () => {
  const clock = fakeClock();
  const { ana, bo } = await pair(clock);
  for (let i = 0; i < 18; i++) await ana.call('chat.group.create', { name: 'g' + i, members: [bo.pub] });
  await clock.advance(5000);
  await settle(40);
  await waitFor(() => bo.events.group.filter((e) => e.event === 'epoch').length >= 16);
  await clock.advance(5000);
  await settle(20);
  const adopted = new Set(bo.events.group.filter((e) => e.event === 'epoch').map((e) => e.groupId));
  assert.equal(adopted.size, 16);
  await ana.svc.destroy();
  await bo.svc.destroy();
});
