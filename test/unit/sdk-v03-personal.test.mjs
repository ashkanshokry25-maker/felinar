// Unit tests for personal sites in hub mode (src/loader/personal-site.js; R 3.1, 3.3, 3.5; MF-64, MF-65; N-3) and the
// followed ledgers of the hub amendment (docs/SDK.md "Amendment to R 2.11.2: followed ledgers"). Keys and
// signatures are real P-256 (WebCrypto); the keys sign only through sign(bytes), as WorkingKeys do.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  PERSONAL_POLICY, FOLLOW_CAPS, GENESIS_FRAGMENT, genesisBlocks, personalPolicyOp, personalPointer, createPersonalSite, encodeGenesis,
  decodeGenesis, checkGenesis, randomChain, hubScope, createHubService, transportOf
} from '../../src/loader/personal-site.js';
import { MwApi } from '../../src/loader/api.js';
import { generateKeyPair, exportPublicKey, sign } from '../../src/chain/crypto.js';
import { validateBlock, DEFAULT_POLICY } from '../../src/chain/block.js';
import { ChainNode } from '../../src/chain/node.js';
import { parsePointer, verifyPointer, ledgerIdFor, hubLabelFor, nextKeyCommitment, formatPointer, signPointer } from '../../src/common/pointer.js';
import { b64url } from '../../src/chain/canonical.js';

const TEMPLATE = 'a1'.repeat(20);
const HUB = 'hub.test';

/** A WorkingKeys stand-in: pub, sign(bytes) -> 64 bytes, rc and nextPubHash from the key bundle, nothing raw. */
async function workingKeys({ rc = true, nx = true } = {}) {
  const kp = await generateKeyPair({ extractable: false });
  const pub = await exportPublicKey(kp.publicKey);
  const next = await generateKeyPair({ extractable: false });
  const keys = { pub, sign: (bytes) => sign(kp.privateKey, bytes), signed: 0 };
  const inner = keys.sign;
  keys.sign = async (b) => { keys.signed++; return inner(b); };
  if (rc) keys.rc = b64url.encode(globalThis.crypto.getRandomValues(new Uint8Array(32)));
  if (nx) keys.nextPubHash = await nextKeyCommitment(await exportPublicKey(next.publicKey));
  return keys;
}

test('genesis: a policy block (writers owner, bits 16, maxChainBytes 8 MiB) and a keyinfo block with rc, both valid', async () => {
  assert.deepEqual(PERSONAL_POLICY, { writers: 'owner', bits: 16, maxChainBytes: 8 * 1024 * 1024 });
  const keys = await workingKeys();
  const signer = { pub: keys.pub, sign: keys.sign };
  const site = 'mw1:' + 'Z'.repeat(27);
  // v0.3 reconciliation: ChainNode.genesis (lane chain-net) is the only minting path.
  const { blocks, gen } = await genesisBlocks({ signer, site, rc: keys.rc, now: Date.UTC(2026, 9, 20, 12, 34, 56), chainGenesis: (o) => ChainNode.genesis(o) });
  assert.equal(blocks.length, 2);
  const [policy, keyinfo] = blocks;
  assert.equal(gen, policy.h);
  assert.deepEqual(policy.e.op, personalPolicyOp());
  assert.deepEqual(policy.e.op, { t: 'policy', writers: 'owner', bits: 16, maxValueBytes: DEFAULT_POLICY.maxValueBytes, maxChainBytes: 8388608, moderators: [], allow: [] });
  assert.deepEqual(policy.e.prev, []);
  assert.equal(policy.e.seq, 0);
  assert.deepEqual(keyinfo.e.op, { t: 'keyinfo', rc: keys.rc });
  assert.deepEqual(keyinfo.e.prev, [policy.h]);
  assert.equal(keyinfo.e.seq, 1);
  for (const b of blocks) {
    assert.equal(b.e.author, keys.pub);
    assert.equal(b.e.site, site);
    assert.equal(b.e.bits, 0, 'the owner pays no fee');
    assert.equal(b.e.ts % 60000, 0, 'minute rounding');
    assert.deepEqual(await validateBlock(b, { site, genesisOwner: keys.pub }), { ok: true });
  }
  await assert.rejects(genesisBlocks({ signer, site, rc: null, chainGenesis: (o) => ChainNode.genesis(o) }), (e) => e.code === 'E_UNSUPPORTED', 'no rc in the bundle: no personal site');
  await assert.rejects(genesisBlocks({ signer, site, rc: keys.rc }), (e) => e.code === 'E_UNSUPPORTED', 'no ChainNode.genesis: no second minting path');
});

test('genesis through ChainNode.genesis (lane chain-net): the same ledger and the same two blocks', async () => {
  const keys = await workingKeys();
  const signer = { pub: keys.pub, sign: keys.sign };
  const chain = randomChain();
  const draft = parsePointer(formatPointer({ v: 'mw1', btih: TEMPLATE, owner: keys.pub, chain, seq: 1, exp: 2, sig: 'A'.repeat(86) })).record;
  const site = await ledgerIdFor(draft, hubScope(TEMPLATE));
  const via = await genesisBlocks({ signer, site, chain, rc: keys.rc, chainGenesis: (o) => ChainNode.genesis(o) });
  assert.equal(via.blocks.length, 2);
  assert.equal(via.blocks[0].e.site, site, 'minted for the ledger of this pointer');
  assert.deepEqual(via.blocks[0].e.op, personalPolicyOp(), 'chain-net writes the same policy op');
  assert.deepEqual(via.blocks[1].e.op, { t: 'keyinfo', rc: keys.rc });
  for (const b of via.blocks) assert.deepEqual(await validateBlock(b, { site, genesisOwner: keys.pub }), { ok: true });
  await assert.rejects(genesisBlocks({ signer, site, chain, rc: keys.rc, chainGenesis: async () => ({ blocks: via.blocks, ledgerId: 'mw1:' + 'Q'.repeat(27) }) }), (e) => e.code === 'E_INTERNAL');
});

test('the pointer: v=mw1; btih; owner; chain; gen; nx; seq; exp, signed by the working key for the hub scope', async () => {
  const keys = await workingKeys();
  const signer = { pub: keys.pub, sign: keys.sign };
  const now = Date.now();
  const chain = randomChain();
  assert.match(chain, /^[A-Za-z0-9_-]{22}$/);
  const gen = 'e'.repeat(64);
  const { record, text } = await personalPointer({ signer, templateBtih: TEMPLATE, chain, gen, nx: keys.nextPubHash, now });
  assert.match(text, /^v=mw1;/);
  assert.equal(record.btih, TEMPLATE);
  assert.equal(record.owner, keys.pub);
  assert.equal(record.chain, chain);
  assert.equal(record.gen, gen);
  assert.equal(record.nx, keys.nextPubHash);
  assert.equal(record.seq, Math.floor(now / 1000));
  assert.equal(record.exp, record.seq + 90 * 86400);
  const v = await verifyPointer(record, hubScope(TEMPLATE), { now });
  assert.equal(v.ok, true, 'signed for btih:<template>: ' + v.reason);
  assert.equal((await verifyPointer(record, 'other.example', { now })).ok, false, 'and for nothing else');
  await assert.rejects(personalPointer({ signer, templateBtih: TEMPLATE, chain, gen, nx: null, now }), (e) => e.code === 'E_UNSUPPORTED', 'no nextPubHash: no nx=, no personal site');
  await assert.rejects(personalPointer({ signer: null, templateBtih: TEMPLATE, chain, gen, nx: keys.nextPubHash }), (e) => e.code === 'E_NOT_SIGNED_IN');
  assert.throws(() => hubScope('nothex'), TypeError);
});

test('v0.3 final integration: the pointer repeats the template\'s tr=, ws=, xs= and idp= (a signed pointer is announced and fetched only from its own lists); nothing that names the template\'s ledger', async () => {
  const seeds = Array.from({ length: 9 }, (_, i) => 'https://seed' + i + '.example/ws/');
  const template = {
    tr: ['wss://tracker.example/announce', '', 5], ws: seeds, xs: ['https://hub.example/t.torrent'], idp: 'https://id.example',
    cs: 'https://hub.example/cs.json', gen: 'f'.repeat(64), chain: 'template-chain', lo: 'mw1:x', org: ['hub.example'], nx: 'n'.repeat(43), rot: 'r',
  };
  assert.deepEqual(transportOf(template), {
    tr: ['wss://tracker.example/announce'], ws: seeds.slice(0, 8), xs: ['https://hub.example/t.torrent'], idp: 'https://id.example',
  }, 'the transport lists (at most 8 each, strings only) and idp=; no cs=, gen=, chain=, lo=, org=, nx= or rot=');
  assert.deepEqual(transportOf(null), {});
  assert.deepEqual(transportOf('v=mw1'), {});
  assert.deepEqual(transportOf({ tr: 'wss://not-a-list.example', idp: '' }), {});
  const keys = await workingKeys();
  const signer = { pub: keys.pub, sign: keys.sign };
  const now = Date.now();
  const chain = randomChain();
  const { record, text } = await personalPointer({ signer, templateBtih: TEMPLATE, chain, gen: 'e'.repeat(64), nx: keys.nextPubHash, transport: template, now });
  assert.deepEqual(record.tr, ['wss://tracker.example/announce']);
  assert.deepEqual(record.ws, seeds.slice(0, 8));
  assert.deepEqual(record.xs, ['https://hub.example/t.torrent']);
  assert.equal(record.idp, 'https://id.example');
  assert.equal(record.chain, chain, 'the person\'s own chain, not the template\'s');
  assert.equal(record.cs, null);
  assert.equal(record.lo, null);
  assert.doesNotMatch(text, /cs=|lo=|rot=|org=/);
  assert.equal((await verifyPointer(record, hubScope(TEMPLATE), { now })).ok, true, 'the lists are signed by the person');
  const bare = await personalPointer({ signer, templateBtih: TEMPLATE, chain, gen: 'e'.repeat(64), nx: keys.nextPubHash, now });
  assert.equal(bare.record.tr.length + bare.record.ws.length + bare.record.xs.length, 0, 'without a transport, no lists (as before)');
});

test('createPersonalSite: the identity page confirms first; then genesis, pointer, ledger id, label and the link with the genesis', async () => {
  const keys = await workingKeys();
  const order = [];
  const watched = {
    pub: keys.pub,
    sign: (b) => { order.push('sign'); return keys.sign(b); },
    get rc () { order.push('rc'); return keys.rc; },
    get nextPubHash () { order.push('nx'); return keys.nextPubHash; },
  };
  const cards = [];
  const site = await createPersonalSite({
    keys: watched, templateBtih: TEMPLATE, hub: { host: HUB, scheme: 'https:' },
    confirm: async (card) => { cards.push(card); order.push('confirm'); return true; },
    genesis: (o) => ChainNode.genesis(o),
  });
  assert.deepEqual(cards, [{ kind: 'create-page', hub: HUB }]);
  assert.equal(order[0], 'confirm', 'the card comes before anything is read or signed (its answer carries rc and nx)');
  assert.ok(order.indexOf('rc') > 0 && order.indexOf('nx') > 0);
  const scope = hubScope(TEMPLATE);
  assert.equal(site.ledgerId, await ledgerIdFor(site.record, scope));
  assert.match(site.ledgerId, /^mw1:[A-Za-z0-9_-]{27}$/);
  assert.equal(site.label, hubLabelFor(site.record, site.ledgerId));
  assert.equal(site.origin, 'https://' + site.label + '.' + HUB);
  assert.equal(site.record.gen, site.blocks[0].h);
  assert.equal(site.record.nx, keys.nextPubHash);
  assert.equal((await verifyPointer(site.record, scope)).ok, true);
  // The link: origin/#<pointer>#mwgen=<b64url JSON blocks>; the loader at the new address checks before it keeps.
  assert.ok(site.url.startsWith(site.origin + '/#' + site.text + '#' + GENESIS_FRAGMENT));
  const part = site.url.slice(site.url.lastIndexOf('#') + 1);
  const blocks = decodeGenesis(part);
  assert.deepEqual(blocks, site.blocks);
  assert.equal(await checkGenesis(blocks, site.record, site.ledgerId), true);
  // A tampered genesis is refused: another block, another owner, another ledger, a broken signature.
  const other = await workingKeys();
  const forged = await genesisBlocks({ signer: { pub: other.pub, sign: other.sign }, site: site.ledgerId, rc: other.rc, chainGenesis: (o) => ChainNode.genesis(o) });
  assert.equal(await checkGenesis(forged.blocks, site.record, site.ledgerId), false);
  assert.equal(await checkGenesis(blocks, site.record, 'mw1:' + 'Q'.repeat(27)), false);
  const broken = JSON.parse(JSON.stringify(blocks));
  broken[1].e.op.rc = other.rc;
  assert.equal(await checkGenesis(broken, site.record, site.ledgerId), false);
  assert.equal(await checkGenesis([], site.record, site.ledgerId), false);
  assert.equal(decodeGenesis('mwgen=' + 'x'.repeat(9000)), null, 'bounded');
  assert.equal(decodeGenesis('nope'), null);
  assert.equal(decodeGenesis(encodeGenesis([])), null);
});

test('createPersonalSite refuses without a sign-in, a hub, the identity page, its yes, rc or nx; nothing is signed then', async () => {
  const keys = await workingKeys();
  const base = { keys, templateBtih: TEMPLATE, hub: { host: HUB }, confirm: async () => true };
  await assert.rejects(createPersonalSite(Object.assign({}, base, { keys: null })), (e) => e.code === 'E_NOT_SIGNED_IN');
  await assert.rejects(createPersonalSite(Object.assign({}, base, { confirm: null })), (e) => e.code === 'E_UNSUPPORTED', 'never an in-page card instead');
  await assert.rejects(createPersonalSite(Object.assign({}, base, { hub: {} })), (e) => e.code === 'E_POLICY');
  await assert.rejects(createPersonalSite(Object.assign({}, base, { confirm: async () => false })), (e) => e.code === 'E_USER_CANCELLED');
  assert.equal(keys.signed, 0, 'nothing signed');
  const noRc = await workingKeys({ rc: false });
  await assert.rejects(createPersonalSite(Object.assign({}, base, { keys: noRc })), (e) => e.code === 'E_UNSUPPORTED');
  const noNx = await workingKeys({ nx: false });
  await assert.rejects(createPersonalSite(Object.assign({}, base, { keys: noNx })), (e) => e.code === 'E_UNSUPPORTED');
});

/** Signed hub pointers for followed ledgers, and a hub service over fake read-only nodes. */
async function hubFixture({ deviceClass = 'desktop', count = 1 } = {}) {
  const owner = await generateKeyPair({ extractable: false });
  const pub = await exportPublicKey(owner.publicKey);
  const now = Math.floor(Date.now() / 1000);
  const texts = [];
  for (let i = 0; i < count; i++) {
    const rec = { v: 'mw1', btih: TEMPLATE, owner: pub, chain: 'c' + String(i).padStart(21, '0'), gen: 'e'.repeat(64), seq: now, exp: now + 86400 };
    texts.push(formatPointer(await signPointer(rec, hubScope(TEMPLATE), owner.privateKey)));
  }
  const opened = [];
  const closed = [];
  const prefs = { m: new Map(), get: async (k, d) => (prefs.m.has(k) ? prefs.m.get(k) : d), set: async (k, v) => { prefs.m.set(k, v); } };
  const multi = { follows: [], follow(id) { this.follows.push(id); }, unfollow(id) { this.follows = this.follows.filter((x) => x !== id); } };
  const deps = {
    deviceClass, prefs, multi,
    openLedger: async ({ ledgerId, record }) => {
      const kv = new Map([['bio', { v: 'hello from ' + ledgerId, h: 'b'.repeat(64), author: record.owner, ts: 1 }]]);
      const node = { ledgerId, height: 5, state: { kv, lists: new Map([['posts', [{ h: '1'.repeat(64), v: 'one' }, { h: '2'.repeat(64), v: 'two' }]]]) }, snapshot: () => ({ height: 5, kv: { bio: 'hello' }, lists: {} }), subscribe: () => () => {}, close: async () => { closed.push(ledgerId); } };
      opened.push(ledgerId);
      return node;
    },
    verifyPointer: async (record) => (await verifyPointer(record, hubScope(record.btih))).ok,
  };
  return { texts, deps, opened, closed, prefs, multi, pub, hub: createHubService(deps) };
}

test('hub.follow / unfollow / list: a pointer pins the owner; caps 1000 on a computer, 250 on a phone; kept across visits', async () => {
  assert.deepEqual(FOLLOW_CAPS, { phone: 250, desktop: 1000 });
  const f = await hubFixture({ count: 2 });
  const events = [];
  f.hub.on('follow', (e) => events.push(['follow', e.ledger]));
  f.hub.on('unfollow', (e) => events.push(['unfollow', e.ledger]));
  const a = await f.hub.methods['hub.follow']({ target: f.texts[0] });
  assert.match(a.ledger, /^mw1:/);
  assert.equal(a.cap, 1000);
  assert.deepEqual(f.multi.follows, [a.ledger], 'the hub lane gossips it');
  assert.equal((await f.hub.methods['hub.follow']({ target: 'https://x.' + HUB + '/#' + encodeURIComponent(f.texts[0]) })).already, true, 'a link to it is the same follow');
  assert.equal((await f.hub.methods['hub.follow']({ target: a.ledger })).already, true, 'its ledger id once followed');
  await assert.rejects(f.hub.methods['hub.follow']({ target: 'mw1:' + 'N'.repeat(27) }), (e) => e.code === 'E_BAD_REQUEST', 'the first follow needs the pointer');
  const tampered = f.texts[1].replace('chain=c', 'chain=d');
  await assert.rejects(f.hub.methods['hub.follow']({ target: tampered }), (e) => e.code === 'E_BAD_REQUEST', 'a pointer that does not verify');
  const list = await f.hub.methods['hub.list']({});
  assert.deepEqual(list.map((x) => [x.ledger, x.owner, x.height]), [[a.ledger, f.pub, 5]]);
  assert.deepEqual(f.prefs.m.get('hub:follows').map((x) => x.ledger), [a.ledger], 'kept for the next visit');
  // A new page view loads the follows again from this origin's prefs.
  const again = createHubService(f.deps);
  assert.deepEqual((await again.methods['hub.list']({})).map((x) => x.ledger), [a.ledger]);
  assert.deepEqual(await f.hub.methods['hub.unfollow']({ ledger: a.ledger }), { ledger: a.ledger, following: 0, removed: true });
  assert.deepEqual(f.closed, [a.ledger]);
  assert.deepEqual(f.multi.follows, []);
  assert.deepEqual(events, [['follow', a.ledger], ['unfollow', a.ledger]]);
  assert.equal((await f.hub.methods['hub.unfollow']({ ledger: a.ledger })).removed, false);
  // The cap of a phone (250): the 251st follow is E_LIMIT.
  const phone = await hubFixture({ deviceClass: 'android', count: 251 });
  for (let i = 0; i < 250; i++) await phone.hub.methods['hub.follow']({ target: phone.texts[i] });
  await assert.rejects(phone.hub.methods['hub.follow']({ target: phone.texts[250] }), (e) => e.code === 'E_LIMIT' && /250/.test(e.message));
  await again.destroy();
  await phone.hub.destroy();
});

test('reads of a followed ledger ({ ledger }) are answered from it, read only; writes stay on the page\'s own ledger', async () => {
  const f = await hubFixture({ count: 1 });
  const { ledger } = await f.hub.methods['hub.follow']({ target: f.texts[0] });
  const own = 'mw1:' + 'O'.repeat(27);
  const node = { role: 'owner', state: { kv: new Map([['bio', { v: 'mine', h: 'b'.repeat(64), ts: 1 }]]), lists: new Map() }, snapshot: () => ({ height: 1 }), async put() { return { h: 'f'.repeat(64) }; } };
  const api = new MwApi({ node, info: { siteId: own, mode: 'shell' } });
  api.mount('hub', f.hub);
  const ok = async (method, params) => { const r = await api.request(method, params); assert.equal(r.ok, true, method + ': ' + JSON.stringify(r.error)); return r.result; };
  assert.equal(await ok('db.get', { key: 'bio' }), 'mine');
  assert.equal(await ok('db.get', { key: 'bio', ledger: own }), 'mine', 'its own id is the own ledger');
  assert.equal(await ok('db.get', { key: 'bio', ledger }), 'hello from ' + ledger);
  assert.deepEqual((await ok('db.list', { name: 'posts', ledger })).map((i) => i.v), ['two', 'one']);
  assert.equal((await ok('db.snapshot', { ledger })).ledger, ledger);
  assert.equal((await api.request('db.set', { key: 'k', value: 1, ledger })).error.code, 'E_POLICY', 'writes go to the own ledger only');
  assert.equal((await api.request('db.get', { key: 'bio', ledger: 'mw1:' + 'U'.repeat(27) })).error.code, 'E_POLICY', 'not followed');
  assert.equal((await api.request('db.get', { key: 'bio', ledger: 'nonsense' })).error.code, 'E_BAD_REQUEST');
  await assert.rejects(f.hub.read(ledger, 'db.set', []), (e) => e.code === 'E_BAD_REQUEST');
  // hub.createPage is an owner action from a click (UI method); without one, nothing happens.
  assert.equal((await api.request('hub.createPage', {})).error.code, 'E_NEEDS_GESTURE');
  await assert.rejects(f.hub.methods['hub.createPage']({}, { activation: true }), (e) => e.code === 'E_POLICY', 'not a hub page: no createPage');
  const made = [];
  const withPage = createHubService(Object.assign({}, f.deps, { createPage: async (params, ctx) => { made.push([params, ctx.activation]); return { ledgerId: own }; } }));
  assert.deepEqual(await withPage.methods['hub.createPage']({ title: 'Me' }, { activation: true }), { ledgerId: own });
  assert.deepEqual(made, [[{ title: 'Me' }, true]]);
  await assert.rejects(withPage.methods['hub.createPage']({}, {}), (e) => e.code === 'E_NEEDS_GESTURE');
  await withPage.destroy();
  await f.hub.destroy();
});

test('integrator (STALK-3): hub.follow(target, { private: true }) reaches the hub lane as a private follow and stays private across visits', async () => {
  const f = await hubFixture({ count: 2 });
  const calls = [];
  f.deps.multi = { follows: [], follow(id, o) { calls.push([id, !!(o && o.private)]); this.follows.push(id); }, unfollow() {} };
  const hub = createHubService(f.deps);
  const a = await hub.methods['hub.follow']({ target: f.texts[0], opts: { private: true } });
  const b = await hub.methods['hub.follow']({ target: f.texts[1] });
  assert.deepEqual(calls, [[a.ledger, true], [b.ledger, false]]);
  assert.deepEqual(f.prefs.m.get('hub:follows').map((x) => [x.ledger, x.private === true]), [[a.ledger, true], [b.ledger, false]]);
  calls.length = 0;
  const again = createHubService(f.deps);
  await again.methods['hub.list']({});
  assert.deepEqual(calls.sort(), [[a.ledger, true], [b.ledger, false]].sort(), 'the next visit follows them the same way');
  calls.length = 0;
  await again.methods['hub.follow']({ target: f.texts[1], opts: { private: true } });
  assert.deepEqual(calls, [[b.ledger, true]], 'a public follow made private later');
});
