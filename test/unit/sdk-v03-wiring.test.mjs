// Unit tests for the v0.3 wiring of the loader and drop-in mode (src/loader/api.js mountV03Services and its
// helpers, src/loader/bridge.js): the deps each service gets at the SVC contract boundary (fakes stand in for the
// lanes idp, chat, files and media), the routing and redaction of chat grants, host-only refusals that make no
// request, follower tabs that hold no keys, the torrent seam, the node identity adapter, the prompt adapter and
// the Bridge's keep-alive pushes.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  MwApi, API_METHODS, mountV03Services, createTorrentSeam, liveObject, setNodeIdentity, nodeIdentityOf, chatKeyOf, workingKeysOf,
  redactGrant, chatStore, createSealedStore, sealedAdapter, promptAdapter, ownTrackerOf, chatDeviceClass, denyChecker, countPostsBy, siteModeOf, cfgFromNode, rotationBlocker
} from '../../src/loader/api.js';
import { Bridge, portSafe } from '../../src/loader/bridge.js';
import { generateKeyPair, exportPublicKey, sign as signBytes } from '../../src/chain/crypto.js';
import { ChainNode } from '../../src/chain/node.js';
import { MemoryBlockStore } from '../../src/chain/stores.js';

const PUB = 'p256:B' + 'A'.repeat(86);
const PUB2 = 'p256:B' + 'Q'.repeat(86);
const LEDGER = 'mw1:' + 'a'.repeat(27);
const H = 'c'.repeat(64);

function recorder(names, impl = {}) {
  const calls = [];
  const listeners = new Map();
  const methods = {};
  for (const n of names) {
    methods[n] = async (params, ctx) => {
      calls.push({ method: n, params, ctx });
      return impl[n] ? impl[n](params, ctx) : 'ran ' + n;
    };
  }
  return {
    methods,
    calls,
    on(ev, fn) {
      if (!listeners.has(ev)) listeners.set(ev, new Set());
      listeners.get(ev).add(fn);
      return () => listeners.get(ev).delete(fn);
    },
    emit(ev, data) { for (const fn of Array.from(listeners.get(ev) || [])) fn(data); },
    destroy() { this.destroyed = true; },
  };
}

function fakeNode(over = {}) {
  const calls = [];
  return Object.assign({
    calls,
    role: 'writer',
    height: 2,
    state: { kv: new Map(), lists: new Map(), policy: { maxValueBytes: 2048 } },
    snapshot() { return { height: 2, kv: {}, lists: {}, profiles: {}, policy: {} }; },
    subscribe() { return () => {}; },
    async put(k, v) { calls.push(['put', k, v]); return { h: H }; },
  }, over);
}

/** Fake service modules: each factory records its deps and returns a recorder for its namespace. */
function fakeModules({ signedIn = { v: false }, throwIn = null } = {}) {
  const made = {};
  const make = (name, prefix, extra = {}) => (deps) => {
    if (throwIn === name) throw new Error(name + ' failed to start');
    const names = API_METHODS.filter((m) => prefix.test(m));
    const svc = Object.assign(recorder(names, extra.impl || {}), extra.props || {});
    svc.deps = deps;
    made[name] = svc;
    return svc;
  };
  const modules = {
    identity: {
      createIdentityService: make('identity', /^(auth|identity|me)\./, {
        impl: {
          'auth.state': () => (signedIn.v ? 'signed-in' : 'guest'),
          'identity.current': () => (signedIn.v ? { pub: PUB, short: 'abcd1234', name: null, mode: 'private' } : null),
        },
        props: { keys: () => (signedIn.v ? { pub: PUB, chat: { pub: PUB, ecdh: async () => new Uint8Array(32) }, saveLocal: async () => true, loadLocal: async () => null } : null) },
      }),
    },
    chat: { createChatService: make('chat', /^chat\./) },
    files: { createFilesService: make('files', /^files\./, { props: { grants: [], onGrant(from, g) { this.grants.push([from, g]); } } }) },
    media: { createMediaService: make('media', /^media\./, { props: { grants: [], onGrant(from, g) { this.grants.push([from, g]); } } }) },
    sealed: { seal: async (o) => ({ sealed: o }), open: async (o) => ({ opened: o }) },
  };
  return { made, modules };
}

function fakeTm() {
  const regs = [];
  return {
    regs,
    peers: 4,
    budget: { total: 30, bySwarm: {} },
    registerWireExtension(name, handler, opts) { const r = { name, handler, opts, off: 0 }; regs.push(r); return () => { r.off++; }; },
    async joinLane(o) { return { joined: o }; },
    async addFileTorrent(o) { return { added: o }; },
  };
}

test('mountV03Services gives each service the documented deps (the SVC contract boundary)', async () => {
  const signedIn = { v: false };
  const { made, modules } = fakeModules({ signedIn });
  const api = new MwApi({ mod: true });
  let tm = null;
  let ensured = 0;
  const torrents = createTorrentSeam({ get: () => tm, ensure: async () => { ensured++; return tm; } });
  const prefs = { m: new Map(), get: async (k, d) => (prefs.m.has(k) ? prefs.m.get(k) : d), set: async (k, v) => { prefs.m.set(k, v); } };
  const downloads = [];
  const res = await mountV03Services(api, {
    modules,
    deps: {
      ledgerId: LEDGER, pointer: 'v=mw1; btih=' + 'f'.repeat(40), deviceClass: 'phone', chatDevice: 'android', hostOnly: () => false,
      ownTracker: 'wss://own.example/announce', torrents, swPort: { ready: () => false }, prefs, download: (url, name) => { downloads.push([url, name]); return true; },
      shareOnNetwork: true, identityExtra: { sharedHub: false, win: 'the window', origin: 'https://site.test' },
    },
  });
  assert.deepEqual(res.mounted, ['identity', 'chat', 'files', 'media']);
  assert.deepEqual(res.errors, {});
  for (const n of res.mounted) assert.equal(api.service(n), made[n]);

  const id = made.identity.deps;
  for (const k of ['node', 'ledgerId', 'pointer', 'cfg', 'prompt', 'now', 'random', 'countPosts', 'sharedHub', 'win', 'origin']) assert.ok(k in id, 'identity deps.' + k);
  assert.equal(id.ledgerId, LEDGER);
  assert.equal(id.win, 'the window', 'identityExtra is merged');
  assert.equal(id.prompt, api.prompt, 'the loader prompt (cards in the loader UI)');
  // node is live: a service made before the ledger opened sees it once it does.
  assert.equal(id.node.role, undefined);
  api.setNode(fakeNode({ role: 'moderator' }));
  assert.equal(id.node.role, 'moderator');
  assert.equal(typeof id.cfg(), 'object');

  const chat = made.chat.deps;
  assert.equal(chat.ledgerId, LEDGER);
  assert.equal(chat.deviceClass, 'android');
  assert.equal(chat.hostOnly(), false, 'read live (the sharing choice can change)');
  assert.equal(chat.ownTracker, 'wss://own.example/announce');
  assert.equal(chat.wires, torrents);
  assert.equal(chat.shareOnNetwork, true);
  assert.equal(typeof chat.store.get, 'function');
  assert.equal(chat.random, undefined, 'review round R 5.3: the chat service uses its own secureRandom');
  assert.equal(chat.ckShare, 'reason', 'PRIV-2: the own CK only with a reason');
  // keys are live too: nothing for a guest, the working keys after a sign-in.
  assert.equal(chat.keys.pub, undefined);
  signedIn.v = true;
  await api.identity.refresh();
  assert.equal(chat.keys.pub, PUB);
  assert.equal(typeof chat.keys.chat.ecdh, 'function');

  for (const name of ['files', 'media']) {
    const d = made[name].deps;
    assert.equal(typeof d.keys, 'function', name + ': keys() at call time');
    assert.equal(d.keys().pub, PUB);
    assert.equal(d.deviceClass, 'phone');
    assert.equal(d.ledgerId, LEDGER);
    assert.equal(typeof d.hostOnly, 'function');
    assert.equal(typeof d.isDenied, 'function');
    assert.equal(d.torrents, torrents);
    assert.equal(typeof d.chat.dm.send, 'function');
    assert.deepEqual(Object.keys(d.sealed).sort(), ['open', 'seal'], 'no sealTo: durable grants have no reader yet (v0.3 reconciliation)');
    const r = d.random(16);
    assert.ok(r instanceof Uint8Array && r.length === 16, 'files and media get the CSPRNG');
    d.download('/_mw/f/x', 'x.pdf');
  }
  assert.equal(typeof made.media.deps.canWrite, 'function');
  assert.equal(made.media.deps.canWrite(), true, 'a moderator may write');
  assert.equal(downloads.length, 2);
  // The chat seam the media and files services share sends through the chat service, never with a click.
  await made.media.deps.chat.dm.send(PUB2, { grant: { t: 'media', id: 'm1' } });
  const sent = made.chat.calls.find((c) => c.method === 'chat.dm.send');
  assert.deepEqual(sent.params, { pub: PUB2, grant: { t: 'media', id: 'm1' } });
  assert.equal(sent.ctx.activation, false);
  assert.equal(ensured, 0, 'mounting made no torrent request');

  // Mounting again keeps what is mounted; a failing factory is reported and skipped; skip leaves a service out.
  assert.deepEqual((await mountV03Services(api, { modules, deps: { ledgerId: LEDGER } })).mounted, []);
  const other = new MwApi({});
  const bad = fakeModules({ throwIn: 'chat' });
  const r2 = await mountV03Services(other, { modules: bad.modules, deps: { ledgerId: LEDGER, skip: ['media'] } });
  assert.deepEqual(r2.mounted, ['identity', 'files']);
  assert.match(r2.errors.chat, /failed to start/);
  assert.equal(other.service('media'), null);
});

test('chat grants go to the media, files and moderation services; the site sees only their type', async () => {
  const { made, modules } = fakeModules({ signedIn: { v: true } });
  const api = new MwApi({ mod: false, activation: () => true });
  const modGrants = [];
  api.mount('mod', Object.assign(recorder([]), { receive: (from, g) => modGrants.push([from, g]) }));
  await mountV03Services(api, { modules, deps: { ledgerId: LEDGER } });
  const pushes = [];
  api.addPushListener((event, data) => pushes.push({ event, data }));
  const chat = made.chat;
  chat.emit('message', { from: PUB2, dir: 'in', grant: { t: 'media', id: 'm1', fk: 'SECRET-KEY' } });
  chat.emit('message', { from: PUB2, dir: 'in', grant: { t: 'file', ref: 'r1', fk: 'SECRET-2' } });
  chat.emit('message', { from: PUB2, dir: 'in', grant: { t: 'report', report: { reason: 'spam' }, sig: 'x' } });
  chat.emit('message', { from: PUB, dir: 'out', grant: { t: 'media', id: 'mine', fk: 'MINE' } });
  chat.emit('message', { from: PUB2, dir: 'in', text: 'hello' });
  assert.deepEqual(made.media.grants.map((g) => g[1].id), ['m1'], 'outgoing grants are not routed back');
  assert.equal(made.media.grants[0][0], PUB2);
  assert.deepEqual(made.files.grants.map((g) => g[1].ref), ['r1']);
  assert.deepEqual(modGrants.map((g) => g[1].t), ['report']);
  const msgs = pushes.filter((p) => p.event === 'chat' && p.data.type === 'message').map((p) => p.data.data);
  assert.equal(msgs.length, 5);
  assert.deepEqual(msgs[0].grant, { t: 'media' });
  assert.deepEqual(msgs[1].grant, { t: 'file' });
  assert.equal(JSON.stringify(pushes).indexOf('SECRET'), -1, 'no file key reaches the site');
  assert.equal(msgs[4].text, 'hello');
  // Stored history is redacted the same way.
  api.unmount('chat');
  api.mount('chat', recorder(['chat.dm.history'], { 'chat.dm.history': () => [{ from: PUB2, grant: { t: 'media', fk: 'SECRET-3' } }, { from: PUB2, text: 'x' }] }));
  const res = await api.request('chat.dm.history', { pub: PUB2 });
  assert.deepEqual(res.result, [{ from: PUB2, grant: { t: 'media' } }, { from: PUB2, text: 'x' }]);
  assert.deepEqual(redactGrant({ grant: { fk: 1 } }), { grant: { t: 'unknown' } });
});

test('host-only: chat.enable, files.share and media.upload refuse with E_HOST_ONLY, with no service call, card or torrent request', async () => {
  const { made, modules } = fakeModules({ signedIn: { v: true } });
  const cards = [];
  let ensured = 0;
  const api = new MwApi({ hostOnly: () => true, activation: () => true, ui: { prompt: async (k) => { cards.push(k); return true; } } });
  const torrents = createTorrentSeam({ get: () => null, ensure: async () => { ensured++; return null; } });
  await mountV03Services(api, { modules, deps: { ledgerId: LEDGER, torrents, hostOnly: () => true } });
  assert.equal(made.chat.deps.hostOnly(), true, 'the chat service knows too');
  const blob = new Blob(['x']);
  for (const [method, params] of [['chat.enable', {}], ['files.share', { file: blob, public: true }], ['media.upload', { file: blob }], ['chat.dm.send', { pub: PUB2, text: 'hi' }], ['chat.room.join', { name: 'Lobby' }], ['files.fetch', { ref: 'r' }], ['report.send', { target: { h: H }, reason: 'spam' }]]) {
    const res = await api.request(method, params);
    assert.equal(res.ok, false, method);
    assert.equal(res.error.code, 'E_HOST_ONLY', method);
  }
  for (const n of ['chat', 'files', 'media']) assert.equal(made[n].calls.length, 0, n + ' was never called');
  assert.deepEqual(cards, [], 'no card');
  assert.equal(ensured, 0, 'no torrent manager was asked for');
  // What does not reach peers still works host-only.
  assert.equal((await api.request('media.list', {})).ok, true);
  assert.equal((await api.request('files.list', {})).ok, true);
});

test('a follower tab holds no keys: it shows the engine tab\'s auth state, v0.3 methods answer E_POLICY, a guest write E_NOT_SIGNED_IN', async () => {
  const cards = [];
  const node = fakeNode();
  const api = new MwApi({ node, tab: () => 'follower', activation: () => true, ui: { prompt: async (k) => { cards.push(k); return true; } } });
  api.identity.setRemote({ state: 'signed-in', info: { pub: PUB, short: 'abcd1234', name: null, mode: 'pairwise' } });
  assert.equal(api.identity.mode(), 'v03');
  assert.equal(api.identity.state(), 'signed-in');
  assert.equal(api.identity.keys(), null, 'never keys in a follower');
  assert.equal((await api.request('auth.state', {})).result, 'signed-in');
  assert.deepEqual((await api.request('identity.current', {})).result, { pub: PUB, short: 'abcd1234', name: null, mode: 'pairwise' });
  for (const [method, params] of [['chat.dm.send', { pub: PUB2, text: 'x' }], ['me.get', {}], ['files.list', {}], ['media.upload', { file: new Blob(['x']) }]]) {
    const res = await api.request(method, params);
    assert.equal(res.error.code, 'E_POLICY', method);
    assert.match(res.error.message, /first tab/);
  }
  // Signed in in the engine tab: this tab's writes go to the node (the RemoteNode forwards them there).
  assert.equal((await api.request('db.set', { key: 'k', value: 1 })).ok, true);
  // The engine tab signed out: the next write here asks nothing and fails.
  api.identity.setRemote({ state: 'guest', info: null });
  const res = await api.request('db.set', { key: 'k', value: 2 });
  assert.equal(res.error.code, 'E_NOT_SIGNED_IN');
  assert.deepEqual(cards, [], 'no sign-in card in a follower tab');
  assert.deepEqual(node.calls, [['put', 'k', 1]]);
  assert.equal((await api.request('ready', {})).result.auth, 'guest');
});

test('the torrent seam: extensions wait for a manager, follow a rebuilt one, and unregister; lanes and files go through ensure()', async () => {
  let tm = null;
  let ensured = 0;
  const seam = createTorrentSeam({ get: () => tm, ensure: async () => { ensured++; return tm; } });
  const off = seam.registerWireExtension('mw_chat', () => {}, { kind: 'chat' });
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(ensured, 1, 'asked once (no manager before the sharing choice)');
  assert.equal(seam.registered, 1);
  const a = fakeTm();
  seam.attach(a);
  seam.attach(a);
  assert.equal(a.regs.length, 1, 'once per manager');
  const b = fakeTm();
  seam.attach(b);
  assert.equal(a.regs[0].off, 1, 'removed from the old manager');
  assert.equal(b.regs.length, 1, 'registered on the rebuilt one');
  tm = b;
  assert.equal(seam.peers, 4);
  assert.deepEqual(seam.budget, { total: 30, bySwarm: {} });
  assert.deepEqual(await seam.joinLane({ kind: 'chat' }), { joined: { kind: 'chat' } });
  assert.deepEqual(await seam.addFileTorrent({ infoHash: 'f'.repeat(40) }), { added: { infoHash: 'f'.repeat(40) } });
  off();
  assert.equal(b.regs[0].off, 1);
  assert.equal(seam.registered, 0);
  tm = null;
  await assert.rejects(seam.joinLane({}), (e) => e.code === 'E_UNSUPPORTED');
  await assert.rejects(seam.addFileTorrent({}), (e) => e.code === 'E_FILE_UNAVAILABLE');
  assert.equal(seam.peers, 0);
});

test('the node identity adapter: the working keys sign blocks on a ledger opened read only, and sign-out takes them away', async () => {
  const kp = await generateKeyPair({ extractable: false });
  const pub = await exportPublicKey(kp.publicKey);
  const keys = { pub, identity: { privateKey: kp.privateKey, pub }, sign: async () => new Uint8Array(64) };
  const id = nodeIdentityOf(keys);
  assert.deepEqual(Object.keys(id).sort(), ['kind', 'privateKey', 'pub']);
  assert.equal(id.privateKey, kp.privateKey);
  assert.equal(nodeIdentityOf(null), null);
  assert.equal(nodeIdentityOf({ pub: 'not a key' }), null);
  assert.equal(nodeIdentityOf({ pub, sign: async () => new Uint8Array(64) }), null, 'sign-only keys cannot sign blocks: a guest, not a broken writer');
  // A real ledger with open writers (genesis by its owner), opened read only as a guest.
  const owner = await generateKeyPair({ extractable: false });
  const ownerPub = await exportPublicKey(owner.publicKey);
  const g = await ChainNode.genesis({ signer: { pub: ownerPub, sign: (b) => signBytes(owner.privateKey, b) }, policy: { writers: 'open', bits: 0 } });
  const node = await ChainNode.open({ siteId: g.ledgerId, expectedOwner: ownerPub, ledgerOwner: ownerPub, genesisHash: g.gen, store: new MemoryBlockStore(), identity: null, config: { minBits: 0 } });
  try {
    await node.ingest(g.blocks, 'local');
    assert.equal(node.identity, null);
    assert.equal(node.role, 'reader');
    await assert.rejects(node.append('guestbook', 'guest'), (e) => e.code === 'E_IDENTITY', 'a guest cannot write');
    assert.equal(setNodeIdentity(node, id), true, 'sign-in: bound without reopening the ledger');
    assert.equal(node.identity.pub, pub);
    assert.equal(node.role, 'writer');
    const block = await node.append('guestbook', 'hello');
    assert.equal(block.e.author, pub, 'the working key signed the entry');
    assert.deepEqual(node.state.lists.get('guestbook').map((i) => i.v), ['hello']);
    assert.equal(setNodeIdentity(node, null), true, 'sign-out');
    assert.equal(node.identity, null);
    assert.equal(node.role, 'reader');
    await assert.rejects(node.append('guestbook', 'after'), (e) => e.code === 'E_IDENTITY');
  } finally {
    await node.close();
  }
  const withSetter = { got: [], setIdentity(x) { this.got.push(x); } };
  assert.equal(setNodeIdentity(withSetter, id), true);
  assert.deepEqual(withSetter.got, [id]);
  assert.equal(setNodeIdentity({}, id), false, 'not a node');
  assert.equal(setNodeIdentity(null, id), false);
  // chatKeyOf and workingKeysOf read the documented shapes.
  assert.equal(chatKeyOf({ chat: { pub, ecdh: () => 1 } }).pub, pub);
  assert.equal(chatKeyOf({ chatPub: pub, ecdh: () => 1 }).pub, pub);
  assert.equal(chatKeyOf({}), null);
  assert.equal(workingKeysOf({ keys: () => keys }), keys);
  assert.equal(workingKeysOf({ keys: () => null }), null, 'signed out');
  assert.equal(workingKeysOf({ workingKeys: keys }), null, 'only the service\'s keys() (lane idp) counts');
  assert.equal(workingKeysOf(null), null);
});

test('stores: the chat store uses the working keys\' sealed cache; the fallback seals under K_local; sealedAdapter shapes', async () => {
  const saved = new Map();
  const keys = { saveLocal: async (k, v) => { saved.set(k, v); }, loadLocal: async (k) => (saved.has(k) ? saved.get(k) : null) };
  let current = keys;
  const store = chatStore(() => current, null);
  await store.set('contacts', [PUB2]);
  assert.deepEqual(saved.get('chat:contacts'), [PUB2]);
  assert.deepEqual(await store.get('contacts'), [PUB2]);
  current = null;
  assert.equal(await store.get('nothing'), undefined);
  // Without the keys' cache: AES-GCM under K_local before anything reaches storage.
  const prefs = { m: new Map(), get: async (k, d) => (prefs.m.has(k) ? prefs.m.get(k) : d), set: async (k, v) => { prefs.m.set(k, v); } };
  const local = globalThis.crypto.getRandomValues(new Uint8Array(32));
  const sealedStore = createSealedStore({ prefs, key: () => local, prefix: 'chat:' });
  assert.equal(await sealedStore.set('k', { secret: 'value' }), true);
  const rec = prefs.m.get('chat:k');
  assert.ok(rec.iv && rec.ct, 'stored sealed');
  assert.equal(JSON.stringify(rec).indexOf('value'), -1, 'no plaintext in storage');
  const reread = createSealedStore({ prefs, key: () => local, prefix: 'chat:' });
  assert.deepEqual(await reread.get('k'), { secret: 'value' });
  const wrong = createSealedStore({ prefs, key: () => globalThis.crypto.getRandomValues(new Uint8Array(32)), prefix: 'chat:' });
  assert.equal(await wrong.get('k'), undefined, 'another key opens nothing');
  const noKey = createSealedStore({ prefs, key: () => null });
  assert.equal(await noKey.set('m', 1), false, 'without K_local: memory only');
  assert.equal(await noKey.get('m'), 1);
  // sealedAdapter: seal/open in the media lane's shape; no sealTo, so durable: true sends the grant over chat only.
  const ad = sealedAdapter({ seal: async (o) => o, open: async (o) => o });
  const s = await ad.seal({ kind: 3, data: 'text', key: 'k' });
  assert.ok(s.data instanceof Uint8Array);
  assert.deepEqual(await ad.open('V', { key: 'k' }), { key: 'k', value: 'V' });
  assert.equal(ad.sealTo, undefined);
  assert.equal(sealedAdapter(null), null);
});

test('the prompt adapter turns service prompts into loader cards and grants nothing by default', async () => {
  const shown = [];
  let answer = true;
  const ui = { prompt: async (kind, data) => { shown.push([kind, data]); if (answer === 'throw') throw new Error('closed'); return answer; } };
  const prompt = promptAdapter(ui, { lang: 'fr' });
  assert.equal(await prompt('chat.enable', { tracker: 'wss://t.example', stun: 'stun:s.example' }), true);
  assert.deepEqual(shown[0], ['consent', { card: 'turnOnChat', params: { tracker: 'wss://t.example', stun: 'stun:s.example' } }]);
  assert.equal(await prompt({ kind: 'file-share', public: true, name: 'a.pdf', size: 3, mime: 'application/pdf' }), true);
  // Code review v0.3 (conformance): nothing was removed from a PDF, so the card must not say so.
  assert.deepEqual(shown[1], ['upload', { visibility: 'public', name: 'a.pdf', size: 3, type: 'application/pdf', stripped: false, unchecked: false }]);
  await prompt({ kind: 'media-share', recipients: [PUB, PUB2] });
  assert.equal(shown[2][0], 'confirm');
  assert.match(shown[2][1].title, /2/, 'French text with the count');
  assert.equal(await prompt('chat.requests.open', { open: false }), true, 'closing requests needs no card');
  assert.equal(shown.length, 3);
  assert.equal(await prompt('no.such.prompt', {}), false, 'no card: no');
  assert.equal(shown.length, 3);
  answer = undefined;
  assert.equal(await prompt('chat.holder', {}), false, 'a card closed without an answer: no');
  answer = 'throw';
  assert.equal(await prompt('chat.holder', {}), false);
  assert.equal(await promptAdapter(null)('chat.enable', {}), false, 'no loader UI: no');
});

test('the Bridge keeps a request that waits for the person alive with wait pushes, and files.fetch crosses the port as a Blob', async () => {
  let release = null;
  const api = new MwApi({ activation: () => true, mod: false });
  api.mount('media', recorder(['media.share'], { 'media.share': () => new Promise((resolve) => { release = resolve; }) }));
  api.mount('files', recorder(['files.fetch'], { 'files.fetch': () => ({ handle: 'h1', name: 'a.pdf', size: 3, mime: 'application/pdf', stream: () => null, blob: async () => new Blob(['abc'], { type: 'application/octet-stream' }) }) }));
  const frameWin = {};
  const sent = [];
  const port = { postMessage: (m) => sent.push(m), start() {}, close() {} };
  const bridge = new Bridge({ iframe: { contentWindow: frameWin }, api, win: { addEventListener() {}, removeEventListener() {} }, origin: 'https://x.test', limits: { waitPushMs: 15 } });
  bridge.attach();
  bridge.handleWindowMessage({ source: frameWin, origin: 'https://x.test', data: { mw: 'hello', proto: 1 }, ports: [port] });
  const pending = bridge.handleRequest({ id: 7, method: 'media.share', params: { id: 'm1', to: [PUB2] } });
  await new Promise((r) => setTimeout(r, 60));
  const waits = sent.filter((m) => m.event === 'wait');
  assert.ok(waits.length >= 2, 'wait pushes while the person decides');
  assert.ok(waits.every((m) => m.data.id === 7));
  release({ granted: [PUB2], held: [] });
  await pending;
  const answer = sent.find((m) => m.id === 7);
  assert.deepEqual(answer, { id: 7, ok: true, result: { granted: [PUB2], held: [] } });
  const before = sent.filter((m) => m.event === 'wait').length;
  await new Promise((r) => setTimeout(r, 40));
  assert.equal(sent.filter((m) => m.event === 'wait').length, before, 'no wait after the answer');
  await bridge.handleRequest({ id: 8, method: 'files.fetch', params: { ref: 'r1' } });
  const f = sent.find((m) => m.id === 8);
  assert.equal(f.ok, true);
  assert.deepEqual(Object.keys(f.result).sort(), ['blob', 'handle', 'mime', 'name', 'size']);
  assert.equal(f.result.blob.type, 'application/octet-stream', 'the only Blob a site gets from files is octet-stream');
  assert.deepEqual(await portSafe('x', { a: 1, fn: () => 1 }), { a: 1 }, 'functions never go over the port');
  bridge.destroy();
});

test('small helpers: own tracker, chat device class, deny list, post counts, live objects', async () => {
  assert.equal(ownTrackerOf({ tr: ['wss://tracker.openwebtorrent.com', 'wss://own.example/a'] }, ['wss://tracker.openwebtorrent.com']), 'wss://own.example/a');
  assert.equal(ownTrackerOf({ tr: ['wss://tracker.openwebtorrent.com'] }, ['wss://tracker.openwebtorrent.com']), null);
  assert.equal(ownTrackerOf(null), null);
  assert.equal(chatDeviceClass({ isMobile: false }), 'desktop');
  assert.equal(chatDeviceClass({ isMobile: true }, { userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0)' }), 'ios');
  assert.equal(chatDeviceClass({ isMobile: true }, { userAgent: 'Mozilla/5.0 (Linux; Android 14)' }), 'android');
  const id = 'ab'.repeat(20);
  const digest = new Uint8Array(await globalThis.crypto.subtle.digest('SHA-256', new TextEncoder().encode(id)));
  const key = '_deny/' + Buffer.from(digest).toString('base64url');
  const node = fakeNode();
  node.state.kv.set(key, { v: { reason: 'P0' }, author: PUB, h: H, ts: 1 });
  node.state.lists.set('g', [{ author: PUB, v: 1 }, { author: PUB2, v: 2 }]);
  const isDenied = denyChecker(() => node);
  assert.equal(await isDenied(id), true);
  assert.equal(await isDenied('cd'.repeat(20)), false);
  assert.equal(await denyChecker(() => null)(id), false);
  assert.equal(countPostsBy(node, PUB), 2, 'one list item and the deny entry');
  assert.equal(countPostsBy(node, PUB2), 1);
  // Review round R 5.3 (UX-5): a ledger with nothing past its genesis does not know; a follower node without state neither.
  assert.equal(countPostsBy({ height: 1, state: { lists: new Map(), kv: new Map() } }, PUB), null);
  assert.equal(countPostsBy({ height: 5, state: { lists: new Map(), kv: new Map() } }, PUB), 0);
  assert.equal(countPostsBy({}, PUB), null);
  assert.equal(countPostsBy(null, PUB), null);
  // identity.mode as a site sees it, from either the site form or a WorkingKeys keyMode.
  assert.deepEqual(['linked', 'same', 'hub', 'visit-only', 'visit', 'legacy', 'pairwise', undefined].map(siteModeOf), ['same', 'same', 'hub', 'visit', 'visit', 'legacy', 'private', 'private']);
  let obj = null;
  const live = liveObject(() => obj);
  assert.equal(live.x, undefined);
  assert.equal('x' in live, false);
  obj = { x: 1, f() { return this.x; } };
  assert.equal(live.x, 1);
  assert.equal(live.f(), 1, 'methods are bound to the current object');
});

test('integrator (SYB-18): a _mw.cfg the owner did not write turns features off but never on, and sets no fee or TURN', () => {
  const cfg = { chat: 'open', requests: 'on', chatBits: 10, files: 'off', turn: ['turn:x'], wall: 'everyone', pin: 'p256:pin' };
  const node = (owner) => ({ state: { kv: new Map([['_mw.cfg', { v: cfg, h: 'h1', author: 'p256:m' }]]), ownerWritten: new Set(owner ? ['h1'] : []) } });
  assert.deepEqual(cfgFromNode(node(true)), cfg, 'the owner\'s entry as written');
  assert.deepEqual(cfgFromNode(node(false)), { files: 'off', wall: 'everyone', pin: 'p256:pin' }, 'a moderator\'s entry keeps only what turns a feature off');
});

test('integrator (HUB-5): rotationBlocker names a recovery commitment on the ledger that is not the person\'s own', async () => {
  const rp = 'p256:recoverKeyOfThePerson';
  const rcOf = async (x) => Buffer.from(await globalThis.crypto.subtle.digest('SHA-256', new TextEncoder().encode(x))).toString('base64url');
  const keys = { pub: 'p256:new', rotateNotice: { from: 'p256:old', next: 'p256:new', rp, rsig: 'x', ledger: LEDGER } };
  const node = (ki) => ({ state: { keyinfo: new Map(ki ? [['p256:old', ki]] : []) } });
  assert.equal(await rotationBlocker(node({ rc: await rcOf(rp) }), keys), null, 'the person\'s own commitment');
  assert.equal(await rotationBlocker(node({ rc: await rcOf('p256:planted') }), keys), 'commitment-not-yours');
  assert.equal(await rotationBlocker(node(null), keys), 'no-keyinfo');
  assert.equal(await rotationBlocker(node({ rc: 'x' }), { pub: 'p256:new' }), null, 'no rotation to write');
});
