// v0.3 reconciliation (integrator after lane sdk): the SDK wiring (src/loader/api.js mountV03Services, mod.js,
// personal-site.js, app.js helpers) against the REAL modules of the lanes it was built against contract-first:
// lane idp (the identity service, WorkingKeys, the identity origin itself in-process through createIdp), lane chat
// (the chat service over fake BEP 10 wires through the SDK's torrent seam), lanes media and files (their services),
// idcore's sealed.js and lane chain-net's ChainNode (setIdentity, writeControl, genesis). Each test names the adapter
// of docs/deviations/sdk.md it replaces; docs/deviations/integration-v03.md, "Reconciliation", lists the findings.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';

import { MwApi, API_METHODS, mountV03Services, createTorrentSeam, setNodeIdentity, nodeIdentityOf, sealedAdapter } from '../../src/loader/api.js';
import { writeControl } from '../../src/loader/mod.js';
import { createPersonalSite, checkGenesis, hubScope } from '../../src/loader/personal-site.js';
import { signedPinCache } from '../../src/loader/app.js';
import { createDeviceKey } from '../../src/loader/harden.js';
import * as identityService from '../../src/identity/service.js';
import { WorkingKeys } from '../../src/identity/store.js';
import * as client from '../../src/identity/client.js';
import * as sealed from '../../src/identity/sealed.js';
import * as chatService from '../../src/chat/service.js';
import * as filesService from '../../src/files/service.js';
import * as mediaService from '../../src/media/service.js';
import { EXT_NAME } from '../../src/chat/limits.js';
import { createIdp } from '../../src/idp/idp.js';
import { openIdoStore } from '../../src/idp/store.js';
import { ChainNode } from '../../src/chain/node.js';
import { MemoryBlockStore } from '../../src/chain/stores.js';
import { schemaOk } from '../../src/chain/state.js';
import { generateKeyPair, exportPublicKey, sign } from '../../src/chain/crypto.js';
import { b64url } from '../../src/chain/canonical.js';
import { streamPlan } from '../../src/files/encrypt.js';
import { verifyPointer } from '../../src/common/pointer.js';

const SITE = 'https://site.test';
const IDP = 'http://localhost:9555';
const OWN_TRACKER = 'wss://own.site.test/announce';
const CFG = { chat: 'open', requests: 'on', chatBits: 8, files: 'members', media: 'members' }; // the freeze schema's values (state.js CFG)
const MODULES = { identity: identityService, chat: chatService, files: filesService, media: mediaService, sealed };

// ------------------------------------------------------------------------------------------- the identity origin

/** The identity origin's cards, answered as a person would (the first identity: a passkey with PRF). */
function scriptedCards(script = {}) {
  return new Proxy({ lang: 'en' }, {
    get(t, k) {
      if (k in t) return t[k];
      return async () => {
        if (script[k] !== undefined) return typeof script[k] === 'function' ? script[k]() : script[k];
        if (k === 'signin') return { action: 'continue', mode: { kind: 'private' }, stay: false, sharedComputer: false, hub: null };
        if (k === 'chooseUnlock') return { method: 'passkey', nickname: 'test' };
        if (k === 'busy') return undefined;
        return true;
      };
    },
  });
}

function fakePasskey() {
  const prf = webcrypto.getRandomValues(new Uint8Array(32));
  return {
    async capabilities() { return { webauthn: true, platform: true, prf: true }; },
    async create() { return { credId: 'Y3JlZA', prf, prfEnabled: true, uv: true }; },
    async prfFor({ created }) { return { prf: created.prf, uv: true, credId: created.credId }; },
    async get() { return { credId: 'Y3JlZA', prf, uv: true }; },
  };
}

/** An in-process client.signIn: the real identity origin (createIdp) behind the client contract (lane idp's test form). */
function processClient(idp, { origin = SITE } = {}) {
  const calls = [];
  return {
    calls,
    async signIn(raw) {
      calls.push(raw);
      const opts = await client.resolveLate(raw);
      const want = opts.want || ['keys'];
      const box = want.some((w) => w !== 'proof') ? await client.newBoxKey() : null;
      const requestId = Buffer.from(webcrypto.getRandomValues(new Uint8Array(16))).toString('base64url');
      const req = { v: 1, t: 'mw-signin-req', requestId, purpose: opts.purpose || 'site', want };
      if (box) req.epk = box.pub;
      for (const k of ['pointer', 'scope', 'challenge', 'shared', 'hubDefault', 'create', 'owner', 'escrow', 'record']) if (opts[k] !== undefined && opts[k] !== null) req[k] = opts[k];
      const v = client.validateRequest(req);
      if (!v.ok) throw Object.assign(new Error(v.reason), { code: 'E_BAD_REQUEST' });
      const res = await idp.handleRequest(req, origin, null);
      if (!res.ok) throw Object.assign(new Error(res.code), { code: res.code });
      const out = {};
      if (res.bundle) out.bundle = await client.open(client.BUNDLE_PREFIX, box.privateKey, res.bundle, { origin, requestId });
      if (res.proof) out.proof = res.proof;
      return out;
    },
    async openIdentity() { return 'done'; },
  };
}

async function newIdp(cards) {
  const store = await openIdoStore({ memory: true });
  return createIdp({
    win: null, doc: null, navigator: null, location: { origin: IDP }, cards: cards || scriptedCards(), passkey: fakePasskey(), store,
    wasm: true, ios: false, standalone: false, build: { version: '0.3.0', id: 'test0001', hash: '', test: true },
  });
}

// ------------------------------------------------------------------------------------------- a site and its ledger

async function ownerKey() {
  const kp = await generateKeyPair({ extractable: false });
  const pub = await exportPublicKey(kp.publicKey);
  return { pub, privateKey: kp.privateKey, signer: { pub, sign: (b) => sign(kp.privateKey, b) } };
}

/** An open ledger (genesis by its owner) with _mw.cfg written by the owner: the blocks every visitor copies. */
async function siteLedger({ cfg = CFG, writers = 'open', moderators = [] } = {}) {
  const owner = await ownerKey();
  const g = await ChainNode.genesis({ signer: owner.signer, policy: { writers, bits: 0, moderators } });
  const node = await openNode(g, owner, { pub: owner.pub, privateKey: owner.privateKey });
  if (cfg) await node.put('_mw.cfg', cfg);
  const blocks = node.exportBlocks();
  await node.close();
  return { ledgerId: g.ledgerId, gen: g.gen, owner, blocks };
}

async function openNode(ledger, owner, identity = null) {
  const node = await ChainNode.open({
    siteId: ledger.ledgerId, expectedOwner: owner.pub, ledgerOwner: owner.pub, genesisHash: ledger.gen, store: new MemoryBlockStore(),
    identity, config: { minBits: 0, tickMs: 0 },
  });
  await node.ingest(ledger.blocks, 'local');
  return node;
}

function memPrefs() {
  const m = new Map();
  return { m, get: async (k, d) => (m.has(k) ? m.get(k) : d), set: async (k, v) => { m.set(k, v); } };
}

// ------------------------------------------------------------------------------------------- chat wires

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

/** The TorrentManager seams chat uses (harden-loader lane): registerWireExtension and joinLane. */
class FakeTM {
  constructor() {
    this.exts = [];
    this.calls = [];
  }
  registerWireExtension(name, handler, opts) {
    this.calls.push(['register', name, opts]);
    this.exts.push(handler);
    return () => { this.calls.push(['unregister', name]); this.exts = this.exts.filter((h) => h !== handler); };
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

async function waitFor(pred, label = 'condition', ms = 8000) {
  const end = Date.now() + ms;
  for (;;) {
    if (await pred()) return;
    if (Date.now() > end) throw new Error('timed out: ' + label);
    await new Promise((r) => setTimeout(r, 5));
  }
}

// ------------------------------------------------------------------------------------------- a browser

/**
 * One visitor's tab as app.js builds it: a MwApi over a real ChainNode (opened read only, as for a guest), the real
 * services mounted by mountV03Services, the loader's sign-in card answered with a click (signInFromCard), and the
 * working keys bound to the ledger by onKeys (app.js bindKeys).
 */
async function browser(ledger, { prompt = null } = {}) {
  const node = await openNode(ledger, ledger.owner, null);
  const tm = new FakeTM();
  const cards = [];
  const pushes = [];
  let api = null;
  const ui = {
    async prompt(kind, data) {
      cards.push(kind);
      if (kind === 'signin') {
        await api.signInFromCard((data && data.options) || {});
        return true;
      }
      return prompt ? prompt(kind, data) : true;
    },
  };
  api = new MwApi({ node, ui, activation: () => true, info: () => ({ siteId: ledger.ledgerId, mode: 'shell' }), mod: true });
  api.addPushListener((event, data) => pushes.push({ event, data }));
  const idp = await newIdp();
  const cl = processClient(idp);
  const seam = createTorrentSeam({ get: () => tm, ensure: async () => tm });
  const bound = [];
  const res = await mountV03Services(api, {
    modules: MODULES,
    deps: {
      ledgerId: ledger.ledgerId, pointer: null, deviceClass: 'desktop', chatDevice: 'desktop', hostOnly: () => false, ownTracker: OWN_TRACKER,
      torrents: seam, swPort: null, prefs: memPrefs(), download: () => true,
      identityExtra: {
        client: cl, Keys: WorkingKeys, origin: SITE, idb: null, channelFactory: () => null,
        onKeys: (k) => { const id = k ? nodeIdentityOf(k) : null; bound.push(id ? id.pub : null); setNodeIdentity(node, id); },
      },
    },
  });
  const call = async (method, params = {}) => {
    const r = await api.request(method, params);
    if (!r.ok) throw Object.assign(new Error(method + ': ' + r.error.code + ' ' + r.error.message), { code: r.error.code });
    return r.result;
  };
  return { api, node, tm, res, cards, pushes, cl, idp, bound, call, svc: (n) => api.service(n) };
}

async function close(...tabs) {
  for (const t of tabs) {
    for (const n of ['media', 'files', 'chat', 'identity']) {
      const s = t.api.service(n);
      if (s && typeof s.destroy === 'function') { try { await s.destroy(); } catch (_) { /* gone */ } }
    }
    try { await t.node.close(); } catch (_) { /* closed */ }
  }
}

// ------------------------------------------------------------------------------------------- tests

test('ChainNode.setIdentity and writeControl (requested by lane sdk, now in lane chain-net\'s node): a returning author keeps their own chain; control ops go through the admit rules', async () => {
  const mod = await ownerKey();
  const ledger = await siteLedger({ moderators: [mod.pub] });
  const writerKp = await generateKeyPair({ extractable: false });
  const writer = { privateKey: writerKp.privateKey, pub: await exportPublicKey(writerKp.publicKey) };
  const node = await openNode(ledger, ledger.owner, null);
  try {
    assert.equal(node.role, 'reader');
    await assert.rejects(node.append('g', 'guest'), (e) => e.code === 'E_IDENTITY', 'a guest cannot write');
    let reasons = [];
    node.subscribe((_, { reason }) => reasons.push(reason));
    assert.equal(node.setIdentity(writer), true);
    assert.deepEqual(reasons, ['identity'], 'subscribers hear the change (the role may differ)');
    assert.equal(node.role, 'writer');
    const b1 = await node.append('g', 'one');
    const b2 = await node.append('g', 'two');
    assert.equal(b2.e.seq, b1.e.seq + 1);
    // Sign out and back in: the own-chain hints come back from the DAG (the adapter it replaces reset them to 0).
    node.setIdentity(null);
    assert.equal(node.role, 'reader');
    node.setIdentity(Object.assign({}, writer));
    const b3 = await node.append('g', 'three');
    assert.equal(b3.e.seq, b2.e.seq + 1, 'seq continues after a sign-in');
    assert.ok(b3.e.prev.includes(b2.h), 'prev names the own last entry');
    reasons = [];
    node.setIdentity(Object.assign({}, writer));
    assert.deepEqual(reasons, [], 'the same key again: no notification');
    // writeControl: a moderator's unban and ban until; a writer's control op fails in admit; payload ops are refused.
    await assert.rejects(writeControl(node, { t: 'ban', author: mod.pub }), (e) => e.code === 'E_NOT_MODERATOR' || e.code === 'E_NOT_OWNER' || e.code === 'E_POLICY', 'a writer cannot ban');
    await assert.rejects(node.writeControl({ t: 'put', k: 'x' }), (e) => e.code === 'E_INVALID');
    await assert.rejects(node.writeControl(null), (e) => e.code === 'E_INVALID');
    node.setIdentity({ privateKey: mod.privateKey, pub: mod.pub });
    assert.equal(node.role, 'moderator');
    const ban = await writeControl(node, { t: 'ban', author: writer.pub });
    assert.equal(ban.e.op.t, 'ban');
    assert.ok(node.state.policy.banned.has(writer.pub), 'banned');
    const unban = await writeControl(node, { t: 'unban', author: writer.pub });
    assert.equal(unban.e.op.t, 'unban');
    assert.equal(node.state.policy.banned.has(writer.pub), false, 'unbanned (freeze group op, written from the browser)');
    // A follower tab's node forwards only ban and one-entry tombstones; anything else asks for the first tab.
    const remote = { ban: async () => ({ h: 'x' }), tombstone: async () => ({ h: 'y' }) };
    assert.deepEqual(await writeControl(remote, { t: 'ban', author: writer.pub }), { h: 'x' });
    await assert.rejects(writeControl(remote, { t: 'unban', author: writer.pub }), (e) => e.code === 'E_UNSUPPORTED' && /first tab/.test(e.message));
    assert.equal(setNodeIdentity(remote, writer), false, 'a follower node never signs');
  } finally {
    await node.close();
  }
});

test('mountV03Services with the real modules of lanes idp, chat, files and media: every service starts, every method of R 2.11.2 is served', async () => {
  const ledger = await siteLedger();
  const t = await browser(ledger);
  try {
    assert.deepEqual(t.res.errors, {}, 'no service failed to start with the deps the SDK builds');
    assert.deepEqual(t.res.mounted, ['identity', 'chat', 'files', 'media']);
    for (const [name, prefix] of [['identity', /^(auth|identity|me)\./], ['chat', /^chat\./], ['files', /^files\./], ['media', /^media\./]]) {
      const svc = t.svc(name);
      const want = API_METHODS.filter((m) => prefix.test(m) && !m.startsWith('auth.onChange') && m !== 'chat.on' && m !== 'files.on' && m !== 'media.on');
      const missing = want.filter((m) => typeof svc.methods[m] !== 'function');
      assert.deepEqual(missing, [], name + ': the SDK table names no method the service lacks');
    }
    // The seams the media and files lanes read (docs/deviations/media.md): chat.dm.send, chat.groupMembers, sealed.
    const lane = t.svc('media').lane;
    assert.equal(typeof lane.d.chat.dm.send, 'function');
    assert.equal(typeof lane.d.chat.groupMembers, 'function', 'media.share({ to: groupId }) reads the group from chat');
    assert.equal(lane.d.sealed.sealTo, undefined, 'no durable-grant writer without a reader');
    // A guest: ready() says so; reads work; the services refuse without keys.
    const ready = await t.call('ready');
    assert.equal(ready.auth, 'guest');
    assert.equal(ready.identity, null);
    assert.deepEqual(ready.features, { chat: true, files: true, media: true, records: false, requests: true, calls: false });
    const r = await t.api.request('media.list', {});
    assert.equal(r.error.code, 'E_NOT_SIGNED_IN');
  } finally {
    await close(t);
  }
});

test('sign-in through the real identity origin: the loader card, WorkingKeys bound to the open ledger, writes signed by the working key, sign-out unbinds', async () => {
  const ledger = await siteLedger();
  const t = await browser(ledger);
  try {
    // A guest's write opens the loader's sign-in card (implicit sign-in, R 2.4.1); its click signs in at the IdO.
    const posted = await t.call('db.append', { name: 'guestbook', value: 'hello' });
    // Code review v0.3 (conformance, R 2.2.6): the first write is a meaningful action, so the loader's kit card follows.
    assert.deepEqual(t.cards, ['signin', 'kit']);
    assert.equal(t.cl.calls.length, 1, 'one identity window');
    const keys = t.api.identity.keys();
    assert.ok(keys instanceof WorkingKeys, 'the real WorkingKeys');
    assert.equal(t.node.identity.pub, keys.pub, 'ChainNode.setIdentity bound the working key without reopening the ledger');
    const item = t.node.state.lists.get('guestbook')[0];
    assert.equal(item.h, posted.h);
    assert.equal(item.author, keys.pub, 'the entry is signed by the identity origin\'s key for this site');
    const ready = await t.call('ready');
    assert.equal(ready.auth, 'signed-in');
    assert.equal(ready.identity.pub, keys.pub);
    assert.equal(ready.identity.mode, 'private', 'the site form of keyMode pairwise');
    assert.equal(ready.role, 'writer');
    // identity.current carries the did:key of R 2.11.2.
    const cur = await t.call('identity.current');
    assert.match(cur.did, /^did:key:zDn/);
    // A local proof made in this tab verifies here (auth.prove / auth.verify).
    const proof = await t.call('auth.prove', {});
    const v = await t.call('auth.verify', { proof });
    assert.equal(v.ok, true);
    assert.equal(v.pub, keys.pub);
    // Sign out: keys gone from the service and from the ledger node.
    await t.call('auth.signOut', {});
    assert.equal(t.api.identity.keys(), null);
    assert.equal(t.node.identity, null, 'unbound');
    assert.equal(t.node.role, 'reader');
    assert.deepEqual(t.bound.filter((x) => x === null).length >= 1, true);
  } finally {
    await close(t);
  }
});

test('the sealed adapter over the real sealed.js: the media lane\'s own-index item is 1,040 bytes, passes the freeze schema, and opens only for its author', async () => {
  const ad = sealedAdapter(sealed);
  const own = webcrypto.getRandomValues(new Uint8Array(32));
  const ledgerId = 'mw1:' + 'a'.repeat(27);
  const author = (await ownerKey()).pub;
  const value = await ad.seal({ kind: 3, data: JSON.stringify({ id: 'm1', M: { v: 1 } }), key: own, ledgerId, authorPub: author });
  assert.equal(b64url.decode(value.ct).length, 1040);
  assert.equal(schemaOk('mw.s', value), true, 'not hidden by the freeze schema');
  const opened = await ad.open(value, { key: own, ledgerId, authorPub: author });
  assert.equal(opened.kind, 3);
  assert.deepEqual(JSON.parse(new TextDecoder().decode(opened.data)), { id: 'm1', M: { v: 1 } });
  assert.equal(await ad.open(value, { key: own, ledgerId, authorPub: (await ownerKey()).pub }), null, 'another author: nothing');
});

test('two visitors over real chat: a file grant sent through the SDK\'s chat seam reaches the other visitor\'s files service; the site sees only its type; a group\'s members come from chat', async () => {
  const ledger = await siteLedger();
  const ana = await browser(ledger);
  const bo = await browser(ledger);
  try {
    // Both sign in (each at their own identity origin: two people) and turn on messages.
    for (const t of [ana, bo]) {
      await t.api.signInFromCard({});
      assert.equal(t.api.identity.state(), 'signed-in');
      await t.call('chat.enable', {});
    }
    const anaPub = ana.api.identity.keys().pub;
    const boPub = bo.api.identity.keys().pub;
    assert.ok(ana.tm.calls.some((c) => c[0] === 'register' && c[1] === EXT_NAME), 'the chat wire extension went through the SDK torrent seam');
    connect(ana.tm, bo.tm);
    const chatA = ana.svc('chat');
    const chatB = bo.svc('chat');
    await waitFor(() => chatA.lane && chatB.lane && chatA.lane.peers().length === 1 && chatB.lane.peers().length === 1, 'wires');
    await waitFor(async () => (await chatA.methods['chat.presence.list']({}, { tab: 'leader' })).length >= 0 && chatA.lane.neighbourOf(bo.api.identity.keys().chatPub) && chatB.lane.neighbourOf(ana.api.identity.keys().chatPub), 'chat keys exchanged');
    await ana.call('chat.contacts.add', { pub: boPub, nick: 'Bo' });
    await bo.call('chat.contacts.add', { pub: anaPub, nick: 'Ana' });
    // Review round R 5.3 (PRIV-2): the loader passes ckShare 'reason', so the CKs come once each side looks for the other's key.
    await waitFor(() => chatA.sig.ckOf(boPub) && chatB.sig.ckOf(anaPub), 'the contacts\' chat keys');
    // A private file grant as the files lane makes it (src/files/lane.js share), through the seam it was given.
    const fk = webcrypto.getRandomValues(new Uint8Array(32));
    const F = { fk: b64url.encode(fk), ih: 'ab'.repeat(20), ref: 'cd'.repeat(16), plen: 1000, len: streamPlan(1000).bytes, P: 65536, name: 'notes.txt', from: anaPub, to: boPub };
    const seam = ana.svc('files').lane.d.chat;
    const sent = await seam.dm.send(boPub, { grant: { t: 'file', F } });
    assert.ok(['delivered', 'handed', 'outbox', 'sent-unknown'].includes(sent.state), 'sent: ' + sent.state);
    await waitFor(async () => (await bo.call('files.received', {})).length === 1, 'the grant reached the files service');
    const got = (await bo.call('files.received', {}))[0];
    assert.equal(got.ref, F.ref);
    assert.equal(got.from, anaPub, 'from the sender\'s site key (chat message from string)');
    const chatPushes = bo.pushes.filter((p) => p.event === 'chat');
    const msg = chatPushes.map((p) => p.data && p.data.data).find((m) => m && m.grant);
    assert.deepEqual(msg.grant, { t: 'file' }, 'the site sees the grant\'s type only');
    assert.equal(JSON.stringify(bo.pushes).indexOf(F.fk), -1, 'no file key reaches the site');
    // A group: its members come from the chat service (media.share({ to: groupId })).
    const g = await ana.call('chat.group.create', { name: 'Hikers', members: [boPub] });
    assert.deepEqual(await ana.svc('media').lane.d.chat.groupMembers(g.groupId), [boPub], 'members without this tab\'s own key');
    assert.throws(() => ana.svc('chat').groupMembers('nope'), (e) => e.code === 'E_NOT_MEMBER');
  } finally {
    await close(ana, bo);
  }
});

test('"Create my page" with real keys: ownerAction at the identity origin returns rc and nextPubHash; ChainNode.genesis mints a ledger the new owner writes to', async () => {
  const ledger = await siteLedger();
  const t = await browser(ledger);
  try {
    await t.api.signInFromCard({});
    const svc = t.svc('identity');
    const before = t.api.identity.keys();
    assert.equal(before.nextPubHash, null, 'a plain sign-in carries no next-key commitment');
    const live = () => svc.keys();
    const keys = { get pub() { return live().pub; }, sign: (b) => live().sign(b), get rc() { return live().rc; }, get nextPubHash() { return live().nextPubHash; } };
    const template = 'a1'.repeat(20);
    const site = await createPersonalSite({ keys, templateBtih: template, hub: { host: 'hub.test', scheme: 'https:' }, confirm: (card) => svc.ownerAction(card), genesis: (o) => ChainNode.genesis(o) });
    const after = live();
    assert.notEqual(after, before, 'the create answer replaced the working keys');
    assert.equal(after.pub, before.pub, 'same label, same key');
    assert.match(after.nextPubHash, /^[A-Za-z0-9_-]{43}$/);
    assert.equal(site.record.nx, after.nextPubHash, 'nx= of the new pointer');
    assert.equal(site.blocks[1].e.op.rc, after.rc, 'keyinfo carries the bundle\'s recovery commitment');
    assert.equal((await verifyPointer(site.record, hubScope(template))).ok, true);
    assert.equal(await checkGenesis(site.blocks, site.record, site.ledgerId), true);
    assert.equal(t.cl.calls.filter((c) => c.create === true).length, 1, 'one identity window for the create card');
    // The new owner's ledger: opened from the link's genesis, owned by the working key, writable only by it.
    const node = await ChainNode.open({ siteId: site.ledgerId, expectedOwner: after.pub, ledgerOwner: after.pub, genesisHash: site.gen, store: new MemoryBlockStore(), identity: nodeIdentityOf(after), config: { minBits: 0, tickMs: 0 } });
    try {
      await node.importSnapshot(site.blocks);
      assert.equal(node.role, 'owner');
      const p = await node.append('posts', 'first post');
      assert.equal(p.e.author, after.pub);
      // owner.policy confirms at the identity origin (ownerAction 'policy'), then writes the policy op.
      t.api.setNode(node);
      t.api.ownerConfirm = (card) => svc.ownerAction(card);
      const r = await t.call('owner.policy', { modAllowPerDay: 5 });
      assert.match(r.h, /^[0-9a-f]{64}$/);
      assert.equal(node.state.policy.modAllowPerDay, 5);
      assert.equal(t.cl.calls.filter((c) => c.owner && c.owner.what === 'policy').length, 1, 'the identity origin\'s owner card');
    } finally {
      await node.close();
    }
  } finally {
    await close(t);
  }
});

test('signed pins with a cache whose exports are getter-only (the esbuild namespace shape of the built loader): getPin and savePin sign', async () => {
  const store = new Map();
  const real = {
    async getPin(scope) { return store.get('pin:' + scope) || null; },
    async savePin(scope, owner, extra = {}) { store.set('pin:' + scope, Object.assign({ owner }, extra)); },
    async getPref(k, d) { return store.has(k) ? store.get(k) : d; },
    async setPref(k, v) { store.set(k, v); },
    async getSite() { return 'site'; },
  };
  // What esbuild emits for `import * as cache`: an object of getters (no setters).
  const ns = {};
  for (const k of Object.keys(real)) Object.defineProperty(ns, k, { get: () => real[k], enumerable: true });
  assert.throws(() => { 'use strict'; const o = Object.create(ns); o.getPin = () => 1; }, TypeError, 'the shape that broke the device key');
  const dk = await createDeviceKey();
  const wrapped = signedPinCache(ns, dk);
  const owner = (await ownerKey()).pub;
  await wrapped.savePin('site.test', owner, { firstSeen: 1 });
  assert.ok(store.get('pin:site.test').signed, 'saved with a signature');
  const pin = await wrapped.getPin('site.test');
  assert.equal(pin.owner, owner);
  store.set('pin:site.test', Object.assign({}, store.get('pin:site.test'), { owner: (await ownerKey()).pub }));
  assert.equal(await wrapped.getPin('site.test'), null, 'a pin rewritten without the device key reads as no pin');
  assert.equal(await wrapped.getSite(), 'site', 'everything else is the cache');
});

// ------------------------------------------------------------------------------------------- drop-in mode

test('drop-in mode with the real modules: lane idp\'s drop-in identity over WorkingKeys and the in-process identity origin, the real chat, files and media services; sign-in binds, sign-out unbinds', async () => {
  const { DropinEngine } = await import('../../src/dropin/engine.js');
  const store = await import('../../src/identity/store.js');
  const migrate = await import('../../src/identity/migrate.js');
  const { ledgerIdFor, parsePointer } = await import('../../src/common/pointer.js');
  const { createClock } = await import('./dropin-fake-timers.mjs');
  const fakes = await import('./dropin-fakes.mjs');
  const site = await fakes.buildSite(fakes.SITE_FILES);
  const owner = await fakes.newOwner();
  const text = await fakes.stampFor({ owner, btih: site.infoHash, more: { tr: [OWN_TRACKER] } });
  const ledgerId = await ledgerIdFor(parsePointer(text).record, 'site.test');
  const idp = await newIdp();
  const cl = processClient(idp, { origin: fakes.ORIGIN });
  const chain = fakes.chainModule();
  const tmod = fakes.torrentModule(site);
  const clock = createClock(Date.now());
  const win = fakes.fakeWindow({ stamp: text });
  const cache = fakes.memoryCache();
  const deps = {
    cache: async () => cache,
    verify: () => import('../../src/loader/verify.js'),
    torrentFile: () => import('../../src/common/torrent-file.js'),
    crypto: () => import('../../src/chain/crypto.js'),
    torrent: async () => tmod,
    chain: async () => chain,
    webtorrent: async () => class WebTorrent {},
    // The real v0.3 modules, except the client: an in-process identity origin stands in for the popup.
    v03: async () => ({ client: cl, store, migrate, sealed, chat: chatService, files: filesService, media: mediaService }),
  };
  const engine = new DropinEngine({ win, deps, options: { swRecheckMs: 0 }, timers: clock.timers() });
  const p = engine.start();
  await fakes.until(() => engine.state === 'ready' || engine.state === 'off', { label: 'evaluate' });
  if (engine.state === 'ready') clock.advance(200);
  await p;
  if (engine.ledgerPromise) await engine.ledgerPromise;
  try {
    assert.equal(engine.identityMode, 'v03');
    for (const name of ['identity', 'chat', 'files', 'media']) assert.ok(engine.api.service(name), name + ' mounted from the real module');
    assert.equal(engine.api.service('identity'), engine.dropinIdentity.service, 'lane idp\'s drop-in adapter');
    assert.equal(engine.ledgerId, ledgerId);
    const node = chain.FakeChainNode.opened[0];
    assert.equal(node.identity, null, 'a guest opens the ledger read only');
    const res = await engine.api.signInFromCard({});
    assert.equal(res.state, 'signed-in');
    const keys = engine.api.identity.keys();
    assert.ok(keys instanceof store.WorkingKeys, 'real WorkingKeys from a real bundle');
    assert.equal(keys.sharedComputer, false);
    await fakes.until(() => node.identity && node.identity.pub === keys.pub, { label: 'keys bound through setIdentity' });
    assert.equal(node.identity.privateKey.extractable, false, 'non-extractable');
    const req = cl.calls[0];
    assert.equal(req.pointer, text, 'the stamped pointer goes to the identity origin');
    assert.equal(req.scope, 'site.test', 'with the scope it was verified under');
    const info = await engine.mw.ready();
    assert.equal(info.auth, 'signed-in');
    assert.equal(info.identity.pub, keys.pub);
    assert.equal(info.identity.mode, 'private');
    await engine.mw.auth.signOut();
    await fakes.until(() => node.identity === null, { label: 'keys unbound' });
    assert.equal(engine.mw.auth.state(), 'guest');
  } finally {
    engine.destroy();
  }
});

// ------------------------------------------------------------------------------------------- hub mode

test('followed ledgers read the hub lane\'s recent window (lane chain-net recent.js through viewAdapters): posts a member holds only in the window are served', async () => {
  const recent = await import('../../src/chain/recent.js');
  const { MultiGossip } = await import('../../src/chain/multi.js');
  const { createHubService, viewAdapters, personalPointer, randomChain } = await import('../../src/loader/personal-site.js');
  const { ledgerIdFor, nextKeyCommitment } = await import('../../src/common/pointer.js');
  // A person's site: genesis in the browser (ChainNode.genesis), three posts and a bio by its owner.
  const owner = await ownerKey();
  const template = 'b2'.repeat(20);
  const chainLabel = randomChain();
  const next = await ownerKey();
  const draft = (await import('../../src/common/pointer.js')).parsePointer((await import('../../src/common/pointer.js')).formatPointer({ v: 'mw1', btih: template, owner: owner.pub, chain: chainLabel, seq: 1, exp: 2, sig: 'A'.repeat(86) })).record;
  const ledgerId = await ledgerIdFor(draft, hubScope(template));
  const g = await ChainNode.genesis({ signer: owner.signer, keyinfo: { rc: b64url.encode(webcrypto.getRandomValues(new Uint8Array(32))) }, chain: chainLabel, ledgerId, policy: { bits: 0 } });
  const src = await ChainNode.open({ siteId: ledgerId, expectedOwner: owner.pub, ledgerOwner: owner.pub, genesisHash: g.gen, store: new MemoryBlockStore(), identity: { privateKey: owner.privateKey, pub: owner.pub }, config: { minBits: 0, tickMs: 0 } });
  await src.ingest(g.blocks, 'local');
  for (const t of ['one', 'two', 'three']) await src.append('posts', t);
  await src.put('bio', 'hello from the owner');
  const { text } = await personalPointer({ signer: owner.signer, templateBtih: template, chain: chainLabel, gen: g.gen, nx: await nextKeyCommitment(next.pub) });
  const window = recent.recentWindow(src, { posts: 200 });
  // The member's tab: a read-only node per followed ledger (empty: the lane fills its view), as app.js opens them.
  const ledgers = new Map();
  const multi = new MultiGossip({ hubSuffix: 'hub.test', ledgers });
  const prefs = memPrefs();
  const opened = [];
  const view = viewAdapters(recent);
  const hub = createHubService(Object.assign({
    multi, prefs, deviceClass: 'desktop',
    openLedger: async ({ ledgerId: id, record }) => {
      const node = await ChainNode.open({ siteId: id, expectedOwner: record.owner, ledgerOwner: record.owner, genesisHash: record.gen, store: new MemoryBlockStore(), identity: null, config: { minBits: 0, tickMs: 0 } });
      ledgers.set(id, node);
      opened.push(node);
      return node;
    },
    closeLedger: (id) => { ledgers.delete(id); },
    verifyPointer: async (record) => (await verifyPointer(record, hubScope(record.btih))).ok,
  }, view));
  try {
    const f = await hub.methods['hub.follow']({ target: text });
    assert.equal(f.ledger, ledgerId);
    const node = opened[0];
    assert.equal(node.height, 0, 'the member holds nothing of it yet');
    // A RECENT answer on the lane (mw_chain2): the window goes to the node's view.
    await recent.applyWindow(node, window);
    assert.ok(recent.viewOf(node).size >= 5, 'the window is in the view');
    const posts = await hub.read(ledgerId, 'db.list', ['posts', { limit: 10, newestFirst: true }]);
    assert.deepEqual(posts.map((p) => p.v), ['three', 'two', 'one'], 'served from the view (the adapter it replaces read the view result as a state and found nothing)');
    assert.equal(await hub.read(ledgerId, 'db.get', ['bio']), 'hello from the owner');
    const snap = await hub.read(ledgerId, 'db.snapshot', []);
    assert.equal(snap.ledger, ledgerId);
    assert.ok(snap.lists && JSON.stringify(snap.lists).indexOf('three') >= 0, 'the snapshot is the view\'s too');
    // Without a view the node's own state is read (a fully held ledger).
    assert.equal(view.stateOf(src), src.state);
  } finally {
    await hub.destroy();
    for (const n of opened) await n.close();
    await src.close();
    multi.destroy();
  }
});
