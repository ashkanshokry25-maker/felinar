// The identity service (R 2.11.2, 2.4, 2.5.4, 2.6, 2.15; the SVC contract): gating (E_NEEDS_GESTURE for UI
// methods, me.get UI on its first call per session, follower tabs read only), E_POLICY on owner-only sites for
// synced records, E_FIELD for reserved field names, E_LIMIT, local proofs and their revocation, server proofs,
// sealed items in the ledger at most once an hour, erasure, the shared-origin hub, and the 0.2.1 key migration.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';

import { createIdentityService, fieldProblem, didKeyOf, OWNER_ONLY_REASON, SYNC_INTERVAL_MS, IDENTITY_METHODS } from '../../src/identity/service.js';
import { WorkingKeys } from '../../src/identity/store.js';
import * as client from '../../src/identity/client.js';
import { createIdp } from '../../src/idp/idp.js';
import { openIdoStore } from '../../src/idp/store.js';
import { generateKeyPair, exportPublicKey, verify } from '../../src/chain/crypto.js';
import { createVerifier, issueChallenge, MemoryNonceStore } from '../../packages/verify/verify.js';

const IDP = 'http://localhost:9555';
const SITE = 'https://shop.example';
const LEDGER = 'mw1:abcdefghijklmnopqrstuvwxyz0';
const UI = { activation: true, tab: 'leader' };
const NO_UI = { activation: false, tab: 'leader' };

function scriptedCards(script = {}) {
  return new Proxy({ lang: 'en' }, {
    get(t, k) {
      if (k in t) return t[k];
      return async () => {
        if (script[k] !== undefined) return typeof script[k] === 'function' ? script[k]() : script[k];
        if (k === 'signin') return { action: 'continue', mode: { kind: 'private' }, stay: false, sharedComputer: false, hub: null };
        if (k === 'chooseUnlock') return { method: 'passkey', nickname: 'test' };
        if (k === 'legacy') return 'keep';
        if (k === 'foundPosts') return 'continue';
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

/** An in-process client: the real identity origin (createIdp) behind the client.signIn contract. */
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
      if (opts.legacy) req.legacy = { pub: opts.legacy.pub, ledger: opts.legacy.ledger };
      const v = client.validateRequest(req);
      if (!v.ok) throw Object.assign(new Error(v.reason), { code: 'E_BAD_REQUEST' });
      const channel = {
        async ask(message) {
          if (message.t === 'mw-idp-count') return { t: 'mw-idp-count-res', requestId, count: opts.countPosts ? await opts.countPosts(message.pub) : null };
          if (message.t === 'mw-idp-legacy') {
            const jwk = await opts.legacy.exportKey();
            return { t: 'mw-idp-legacy-res', requestId, sealed: await client.seal(client.LEGACY_PREFIX, message.epk, { jwk }, { origin, requestId }) };
          }
          return null;
        },
      };
      const res = await idp.handleRequest(req, origin, channel);
      if (!res.ok) throw Object.assign(new Error(res.code), { code: res.code });
      const out = {};
      if (res.bundle) out.bundle = await client.open(client.BUNDLE_PREFIX, box.privateKey, res.bundle, { origin, requestId });
      if (res.record) out.record = await client.open(client.RECORD_PREFIX, box.privateKey, res.record, { origin, requestId });
      if (res.proof) out.proof = res.proof;
      if (res.erased) out.erased = true;
      return out;
    },
    async openIdentity(opts) { calls.push({ openIdentity: opts }); return 'done'; },
  };
}

/** A minimal ledger node: reduced state plus append / tombstone / profile by the current working key. */
function fakeNode({ writers = 'open', owner = 'p256:owner' } = {}) {
  let n = 0;
  const node = {
    me: null,
    state: { owner, ownerConflict: false, policy: { writers, moderators: new Set(), banned: new Set(), allow: new Set(), bits: 0 }, lists: new Map(), profiles: new Map() },
    writes: [],
    async append(l, v) {
      const h = (++n).toString(16).padStart(64, '0');
      if (!node.state.lists.has(l)) node.state.lists.set(l, []);
      node.state.lists.get(l).push({ h, author: node.me, ts: Date.now() + n, v });
      node.writes.push({ op: 'append', l, h });
      return { h };
    },
    async tombstone(h) {
      for (const [l, items] of node.state.lists) node.state.lists.set(l, items.filter((it) => it.h !== h));
      node.writes.push({ op: 'tombstone', h });
      return { h: 't' + h };
    },
    async profile(name) {
      node.state.profiles.set(node.me, name);
      return { h: 'p'.repeat(64) };
    },
  };
  return node;
}

function noChannel() {
  return null;
}

async function setup({ node = fakeNode(), cfg = { records: 'sealed' }, store, prompt = async () => true, sharedHub = false, legacy = null, now, cards } = {}) {
  const st = store || await openIdoStore({ memory: true });
  const idp = createIdp({ win: null, doc: null, navigator: null, location: { origin: IDP }, cards: cards || scriptedCards(), passkey: setup.passkey || (setup.passkey = fakePasskey()), store: st, wasm: true, ios: false, standalone: false, build: { version: '0.3.0', id: 'test0001', hash: '', test: true } });
  const cl = processClient(idp);
  const keysSeen = [];
  const svc = createIdentityService({
    node, ledgerId: LEDGER, cfg: () => cfg, prompt, client: cl, Keys: WorkingKeys, origin: SITE, idb: null, channelFactory: noChannel,
    sharedHub, legacy, now, onKeys: (k) => { keysSeen.push(k); node.me = k ? k.pub : null; },
  });
  return { svc, node, cl, idp, store: st, keysSeen, m: svc.methods };
}

test('the method table is R 2.11.2: auth.*, identity.*, me.*', async () => {
  const { svc } = await setup();
  assert.deepEqual(Object.keys(svc.methods).sort(), IDENTITY_METHODS.slice().sort());
  assert.equal(typeof svc.keys, 'function');
});

test('gating: UI methods need the loader-verified click; follower tabs only read; keys first', async () => {
  const { m } = await setup();
  await assert.rejects(m['auth.signIn']({}, NO_UI), (e) => e.code === 'E_NEEDS_GESTURE');
  await assert.rejects(m['auth.signIn']({}, { activation: true, tab: 'follower' }), (e) => e.code === 'E_POLICY');
  assert.equal(await m['auth.state']({}, { tab: 'follower' }), 'guest');
  await assert.rejects(m['me.set'](['display', 'Ana'], NO_UI), (e) => e.code === 'E_NOT_SIGNED_IN');
  await assert.rejects(m['auth.prove']({}, NO_UI), (e) => e.code === 'E_NOT_SIGNED_IN');
  await assert.rejects(m['identity.openIdentity']({}, NO_UI), (e) => e.code === 'E_NEEDS_GESTURE');
  await assert.rejects(m['me.erase']({}, NO_UI), (e) => e.code === 'E_NEEDS_GESTURE');
  await assert.rejects(m['auth.signOut']({ forget: true }, NO_UI), (e) => e.code === 'E_NEEDS_GESTURE');
  assert.deepEqual(await m['auth.signOut']({}, NO_UI), { state: 'guest' });
});

test('sign in: keys installed, identity.current with a did:key, the auth event, onKeys; sign out drops them', async () => {
  const { svc, m, keysSeen } = await setup();
  const events = [];
  svc.on('auth', (e) => events.push(e));
  const r = await m['auth.signIn']({}, UI);
  assert.equal(r.state, 'signed-in');
  assert.equal(r.identity.mode, 'private');
  assert.equal(r.identity.keyMode, 'pairwise');
  assert.match(r.identity.did, /^did:key:zDn/);
  assert.equal(r.identity.did, didKeyOf(r.identity.pub));
  assert.equal(await m['auth.state']({}, NO_UI), 'signed-in');
  assert.equal(svc.keys().pub, r.identity.pub);
  assert.equal(keysSeen[keysSeen.length - 1].pub, r.identity.pub);
  assert.equal(events[events.length - 1].state, 'signed-in');
  assert.deepEqual(await m['auth.signOut']({}, NO_UI), { state: 'guest' });
  assert.equal(svc.keys(), null);
  assert.equal(keysSeen[keysSeen.length - 1], null);
  assert.equal(events[events.length - 1].state, 'guest');
  assert.equal(await m['identity.current']({}, NO_UI), null);
});

test('me.get is UI on its first call per session (the identity origin card), a read afterwards', async () => {
  const { m, cl } = await setup();
  await m['auth.signIn']({}, UI);
  await assert.rejects(m['me.get'](['display'], NO_UI), (e) => e.code === 'E_NEEDS_GESTURE');
  assert.equal(await m['me.get'](['display'], UI), null);
  const recordCall = cl.calls.find((c) => c.want && c.want[0] === 'record');
  assert.ok(recordCall, 'the record was asked for at the identity origin');
  assert.deepEqual(await m['me.get']([], NO_UI), {}, 'afterwards a plain read');
});

test('E_FIELD for reserved field names; E_LIMIT over the item budget; stored locally by default', async () => {
  const { m } = await setup({ cfg: {} });
  await m['auth.signIn']({}, UI);
  for (const name of ['email', 'phoneNumber', 'birthDate', 'legal_name', 'health', 'Passport', 'home-address', 'dob']) {
    await assert.rejects(m['me.set']([name, 'x'], NO_UI), (e) => e.code === 'E_FIELD', name);
  }
  assert.equal(fieldProblem('display'), null);
  await assert.rejects(m['me.set'](['9bad', 'x'], NO_UI), (e) => e.code === 'E_BAD_REQUEST');
  assert.deepEqual(await m['me.set'](['display', 'Ana'], NO_UI), { stored: 'local' });
  await assert.rejects(m['me.set'](['notes', 'x'.repeat(32000)], NO_UI), (e) => e.code === 'E_LIMIT');
  assert.deepEqual(await m['me.del'](['display'], NO_UI), { stored: 'local' });
});

test('me.sync: E_POLICY on an owner-only site and where records are off; needs the click', async () => {
  const owner = await setup({ node: fakeNode({ writers: 'owner' }), cfg: { records: 'sealed' } });
  await owner.m['auth.signIn']({}, UI);
  await assert.rejects(owner.m['me.sync']({ on: true }, NO_UI), (e) => e.code === 'E_NEEDS_GESTURE');
  await assert.rejects(owner.m['me.sync']({ on: true }, UI), (e) => e.code === 'E_POLICY' && e.message === OWNER_ONLY_REASON);
  const off = await setup({ cfg: { records: 'off' } });
  await off.m['auth.signIn']({}, UI);
  await assert.rejects(off.m['me.sync']({ on: true }, UI), (e) => e.code === 'E_POLICY');
  const declined = await setup({ prompt: async () => false });
  await declined.m['auth.signIn']({}, UI);
  await assert.rejects(declined.m['me.sync']({ on: true }, UI), (e) => e.code === 'E_USER_CANCELLED', 'the sync card was declined');
});

test('synced records: sealed mw.s items under K_rec, at most one synced update an hour, read back in a new session', async () => {
  let t = 1_800_000_000_000;
  const now = () => t;
  const node = fakeNode();
  const store = await openIdoStore({ memory: true });
  const a = await setup({ node, store, now });
  await a.m['auth.signIn']({}, UI);
  await a.m['me.set'](['display', 'Ana'], NO_UI);
  assert.deepEqual(await a.m['me.sync']({ on: true }, UI), { on: true });
  const items = () => node.state.lists.get('mw.s') || [];
  assert.equal(items().length, 2, 'one index item and one data item');
  for (const it of items()) {
    assert.equal(it.author, a.svc.keys().pub);
    assert.equal(it.v.enc, 'mw-seal-v1');
    assert.equal(Buffer.from(it.v.ct, 'base64url').length, 1040, 'fixed size');
    // C2 integrator: the clear name is not there. A bare 'Ana' also turned up by chance in about 1 run in 100 (three letters in
    // 1,390 random base64url characters); quoted, or as the record's field name inside the ciphertext bytes, it cannot.
    assert.ok(!JSON.stringify(it.v).includes('"Ana"'));
    assert.ok(!Buffer.from(it.v.ct, 'base64url').includes(Buffer.from('"display"')));
  }
  t += 60 * 1000;
  assert.deepEqual(await a.m['me.set'](['notes', 'hello'], NO_UI), { stored: 'local' }, 'inside the hour: local only');
  t += SYNC_INTERVAL_MS;
  const r = await a.m['me.set'](['links', ['https://a.example']], NO_UI);
  assert.equal(r.stored, 'synced');
  assert.equal(items().length, 2, 'the old items were tombstoned after the new ones were written');
  // Another session (another device with the same identity) reads the record from the ledger copy.
  const b = await setup({ node, store, now });
  await b.m['auth.signIn']({}, UI);
  assert.deepEqual(await b.m['me.get']([], UI), { display: 'Ana', notes: 'hello', links: ['https://a.example'] });
});

test('me.erase: the identity origin destroys K_rec and K_own; own sealed items are tombstoned; fresh keys follow', async () => {
  const node = fakeNode();
  const s = await setup({ node });
  await s.m['auth.signIn']({}, UI);
  await s.m['me.set'](['display', 'Ana'], NO_UI);
  await s.m['me.sync']({ on: true }, UI);
  const before = s.svc.keys();
  const out = await s.m['me.erase']({}, UI);
  assert.deepEqual(out, { tombstoned: 2, shredded: true });
  assert.equal((node.state.lists.get('mw.s') || []).length, 0);
  const after = s.svc.keys();
  assert.equal(after.pub, before.pub, 'the public identity stays');
  assert.notEqual(after, before);
  assert.deepEqual(await s.m['me.get']([], NO_UI), {});
  assert.ok(s.cl.calls.some((c) => c.want && c.want[0] === 'erase'));
});

test('local proofs: in-tab, at most 15 minutes, revoked by sign-out; server proofs need a verifier nonce', async () => {
  const s = await setup();
  await s.m['auth.signIn']({}, UI);
  const proof = await s.m['auth.prove']({}, NO_UI);
  assert.equal(proof.c.t, 'mw-local');
  assert.equal(proof.c.exp - proof.c.iat, 900000);
  await assert.rejects(s.m['auth.prove']({ ttlMs: 900001 }, NO_UI), (e) => e.code === 'E_BAD_REQUEST');
  const ok = await s.m['auth.verify']([proof], NO_UI);
  assert.equal(ok.ok, true);
  assert.equal(ok.kind, 'local');
  await s.m['auth.signOut']({}, NO_UI);
  assert.equal((await s.m['auth.verify']([proof], NO_UI)).reason, 'revoked');
  await s.m['auth.signIn']({}, UI);
  await assert.rejects(s.m['auth.signInServer']({ challenge: { statement: 'x' } }, UI), (e) => e.code === 'E_NONCE_REQUIRED');
  const nonces = new MemoryNonceStore();
  const ch = await issueChallenge({ statement: 'Sign in to Example Shop', nonces, ttlMs: 300000 });
  const sp = await s.m['auth.signInServer']({ challenge: ch }, UI);
  const v = await createVerifier({ origin: SITE, nonces, allowKeyModes: ['pairwise'] }).verify(sp);
  assert.equal(v.ok, true);
  assert.equal(v.pub, s.svc.keys().pub);
});

test('a shared-origin hub: this visit only; no stay, no record, no server proof', async () => {
  const s = await setup({ sharedHub: true });
  await assert.rejects(s.m['auth.signIn']({ stay: true }, UI), (e) => e.code === 'E_HOST_ONLY_IDENTITY');
  const r = await s.m['auth.signIn']({}, UI);
  assert.equal(r.identity.mode, 'visit');
  assert.equal(s.svc.keys().keyMode, 'visit-only');
  assert.equal(s.svc.keys().sharedComputer, true, 'memory only');
  await assert.rejects(s.m['me.get']([], UI), (e) => e.code === 'E_HOST_ONLY_IDENTITY');
  await assert.rejects(s.m['auth.signInServer']({ challenge: { nonce: 'A'.repeat(22) } }, UI), (e) => e.code === 'E_HOST_ONLY_IDENTITY');
  const s2 = await setup({ sharedHub: true, store: s.store });
  const r2 = await s2.m['auth.signIn']({}, UI);
  assert.notEqual(r2.identity.pub, r.identity.pub, 'a new random key every visit');
});

test('identity.setName writes the profile; the recovery-kit event fires on the first meaningful action', async () => {
  const s = await setup();
  const kit = [];
  s.svc.on('kit', (e) => kit.push(e));
  await s.m['auth.signIn']({}, UI);
  await assert.rejects(s.m['identity.setName'](['x'.repeat(49)], NO_UI), (e) => e.code === 'E_LIMIT');
  const r = await s.m['identity.setName'](['Ana'], NO_UI);
  assert.equal(typeof r.h, 'string');
  assert.equal(s.node.state.profiles.get(s.svc.keys().pub), 'Ana');
  assert.equal((await s.m['identity.current']({}, NO_UI)).name, 'Ana');
  assert.equal(kit.length, 1);
  await s.m['me.set'](['display', 'Ana'], NO_UI);
  assert.equal(kit.length, 1, 'once');
  assert.deepEqual(await s.m['identity.backupStatus']({}, NO_UI), { kitSaved: false, fileSaved: false, passkey: true, persisted: false, legacy: false });
});

test('the 0.2.1 key moves into the vault; keep links it to the new key with a mw.link item signed both ways', async () => {
  const pair = await generateKeyPair({ extractable: true });
  const legacyPub = await exportPublicKey(pair.publicKey);
  const written = [];
  const removed = [];
  const legacy = {
    get: async () => ({ kind: 'cryptokey', privateKey: pair.privateKey, publicKey: pair.publicKey, pub: legacyPub }),
    remove: async () => removed.push(true),
    write: async (item) => written.push(item),
  };
  const s = await setup({ legacy });
  const r = await s.m['auth.signIn']({}, UI);
  assert.equal(written.length, 1);
  const item = written[0];
  assert.equal(item.l, 'mw.link');
  assert.equal(item.v.from, legacyPub);
  assert.equal(item.v.to, r.identity.pub);
  const msg = new TextEncoder().encode('mw-link-v1\n' + LEDGER + item.v.from + item.v.to + item.v.t);
  assert.equal(await verify(item.v.to, msg, item.v.sigTo), true, 'sigTo is the new key\'s consent');
  assert.deepEqual(removed, [], 'the old key stays until a backup file exists');
  const st = await s.store.getState();
  assert.ok(st.origins[SITE]);
  assert.equal((await s.m['identity.backupStatus']({}, NO_UI)).legacy, true);
});

test('every UI method reaches client.signIn before its first await, so the window opens inside the click', async () => {
  const s = await setup();
  await s.m['auth.signIn']({}, UI);
  const sync = [];
  const spy = Object.assign({}, s.cl, {
    signIn(opts) { sync.push(opts.want.join('+')); return s.cl.signIn(opts); },
    openIdentity(opts) { sync.push('identity'); return s.cl.openIdentity(opts); },
  });
  const svc = createIdentityService({ node: s.node, ledgerId: LEDGER, cfg: () => ({ records: 'sealed' }), prompt: async () => true, client: spy, Keys: WorkingKeys, origin: SITE, idb: null, channelFactory: noChannel,
    legacy: { get: async () => null, remove: async () => {}, write: async () => {} } });
  const calls = [
    () => svc.methods['auth.signIn']({}, UI),
    () => svc.methods['identity.openIdentity']({}, UI),
    () => svc.methods['auth.signInServer']({ challenge: { nonce: 'A'.repeat(22) } }, UI),
  ];
  for (const call of calls) {
    const before = sync.length;
    const p = call();
    assert.equal(sync.length, before + 1, 'called synchronously');
    await p.catch(() => {});
  }
  const p = svc.methods['me.get']([], UI);
  assert.equal(sync[sync.length - 1], 'record', 'me.get asks the identity origin at once');
  await p;
  const e = svc.methods['me.erase']({}, UI);
  assert.equal(sync[sync.length - 1], 'erase');
  await e;
  await svc.destroy();
});

// ------------------------------------------------------------------------------------------- review round 2026-10-24

/** A node with the ledger's author throttle: limit local writes per 10 minutes (chain/node.js ingressRate), E_RATE past it. */
function throttledNode(now, { limit = 30, perMs = 600000 } = {}) {
  const node = fakeNode();
  const times = [];
  const gate = () => {
    const t = now();
    while (times.length && times[0] <= t - perMs) times.shift();
    if (times.length >= limit) throw Object.assign(new Error('rate'), { code: 'E_RATE' });
    times.push(t);
  };
  const append = node.append.bind(node);
  const tombstone = node.tombstone.bind(node);
  node.append = async (l, v) => { gate(); return append(l, v); };
  node.tombstone = async (h) => { gate(); return tombstone(h); };
  return node;
}

test('review round SCALE-3: a record too large to sync whole stays local with no write; data first, index last; refused tombstones are retried', async () => {
  let t = 1_800_000_000_000;
  const now = () => t;
  const { SYNC_WRITE_BUDGET, MAX_SYNC_RECORD_BYTES } = await import('../../src/identity/service.js');
  assert.ok(SYNC_WRITE_BUDGET * 2 <= 30, 'an update and the tombstones of the one before fit one throttle window');
  // 1. Over the sync size: stored on this device, nothing written to the ledger (no partial version).
  const big = throttledNode(now);
  const store = await openIdoStore({ memory: true });
  const a = await setup({ node: big, store, now });
  await a.m['auth.signIn']({}, UI);
  await a.m['me.sync']({ on: true }, UI);
  const before = big.writes.length;
  t += SYNC_INTERVAL_MS;
  const r = await a.m['me.set'](['notes', 'x'.repeat(MAX_SYNC_RECORD_BYTES + 100)], NO_UI);
  assert.equal(r.stored, 'local');
  assert.equal(big.writes.length, before, 'no append before the refusal');
  // 2. A throttle that refuses some tombstones: they wait and go at a later sync; no item of an old version stays live.
  t += SYNC_INTERVAL_MS;
  const node = throttledNode(now, { limit: 20 });
  const b = await setup({ node, store: await openIdoStore({ memory: true }), now });
  await b.m['auth.signIn']({}, UI);
  await b.m['me.set'](['notes', 'y'.repeat(11000)], NO_UI);
  await b.m['me.sync']({ on: true }, UI);
  const items = () => node.state.lists.get('mw.s') || [];
  const first = items().map((it) => it.h);
  assert.equal(first.length, 12, 'eleven data items and the index');
  t += SYNC_INTERVAL_MS;
  await b.m['me.set'](['notes', 'z'.repeat(11000)], NO_UI);
  assert.ok(items().some((it) => first.includes(it.h)), 'the throttle left some old items for now');
  t += SYNC_INTERVAL_MS;
  await b.m['me.set'](['more', 1], NO_UI);
  assert.equal(items().filter((it) => first.includes(it.h)).length, 0, 'every item of version 1 is gone after the retry');
  // 3. A refusal in the middle of the data items writes no index: another device still reads the whole earlier version.
  const c = await setup({ node, store: b.store, now });
  await c.m['auth.signIn']({}, UI);
  const readBefore = await c.m['me.get']([], UI);
  t += 1000;
  const spent = node.writes.length;
  node.append = (() => { const inner = node.append; let k = 0; return async (l, v) => { if (++k > 2) throw Object.assign(new Error('rate'), { code: 'E_RATE' }); return inner(l, v); }; })();
  t += SYNC_INTERVAL_MS;
  await assert.rejects(b.m['me.set'](['notes', 'w'.repeat(5000)], NO_UI), (e) => e.code === 'E_RATE');
  assert.ok(node.writes.length > spent);
  const d = await setup({ node, store: b.store, now });
  await d.m['auth.signIn']({}, UI);
  assert.deepEqual(await d.m['me.get']([], UI), readBefore, 'the partial update hides nothing');
});

test('review round SCALE-5: a sync of an unchanged record writes nothing to the ledger', async () => {
  let t = 1_800_000_000_000;
  const now = () => t;
  const node = fakeNode();
  const a = await setup({ node, now });
  await a.m['auth.signIn']({}, UI);
  await a.m['me.set'](['display', 'Ana'], NO_UI);
  await a.m['me.sync']({ on: true }, UI);
  const n = node.writes.length;
  assert.ok(n >= 2);
  t += SYNC_INTERVAL_MS;
  assert.deepEqual(await a.m['me.sync']({ on: true }, UI), { on: true });
  assert.equal(node.writes.length, n, 'no new items and no tombstones for the same record');
});

test('review round PTR-10: with linkPointer (a hub label or a door) the client is told not to take the identity origin from the pointer', async () => {
  const seen = [];
  const fakeClient = { async signIn(o) { seen.push(o); throw Object.assign(new Error('x'), { code: 'E_IDP_UNREACHABLE' }); } };
  const node = fakeNode();
  for (const linkPointer of [true, undefined]) {
    const svc = createIdentityService({ node, ledgerId: LEDGER, pointer: 'v=mw1; btih=' + 'a'.repeat(40) + '; idp=https://evil.example', cfg: () => ({}), client: fakeClient, Keys: WorkingKeys, origin: SITE, idb: null, channelFactory: noChannel, linkPointer });
    await assert.rejects(svc.methods['auth.signIn']({}, UI), (e) => e.code === 'E_IDP_UNREACHABLE');
  }
  assert.equal(seen[0].trustPointer, false);
  assert.equal(seen[1].trustPointer, undefined);
});
