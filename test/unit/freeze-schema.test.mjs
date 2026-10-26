// Unit tests for the schema rule of DESIGN-REVIEW 2.10.2 (MF-21) and U-LG-2: schemas of mw.*
// lists and _mw.* / _deny/ / _roles/ keys are state rules. A non-matching item is valid, stored,
// relayable and hidden; bare names (dm, chat, pres) are not reserved. A frozen copy of the v0.2.1
// reducer (test/fixtures/freeze/state-v021.mjs, copied before the freeze-group edits) agrees with
// the new reducer on every DAG without freeze-group ops (random ledgers with every v1 op, owner
// successions and contested hand-overs, under shuffles).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { reduce, snapshot, schemaOk, ownerAt, CFG_KEYS, CFG_TIERS } from '../../src/chain/state.js';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CFG_ENUMS } from '../../tools/ledger-admin.mjs';
import * as frozen from '../fixtures/freeze/state-v021.mjs';
import { createBlock, validateBlock } from '../../src/chain/block.js';
import { Dag } from '../../src/chain/dag.js';
import { generateKeyPair, exportPublicKey } from '../../src/chain/crypto.js';
import { sha256Sync } from '../../src/chain/sha256-sync.js';
import { canonicalize, utf8, hex, b64url } from '../../src/chain/canonical.js';

const SITE = 'mw1:freezeschematestsite00000';
const T0 = Date.UTC(2026, 9, 20, 12, 0, 0);
const HOUR = 3600000;
const SIG = 'A'.repeat(86);

async function makeIdentity() {
  const kp = await generateKeyPair();
  return { privateKey: kp.privateKey, pub: await exportPublicKey(kp.publicKey) };
}
const [owner, alice] = await Promise.all([makeIdentity(), makeIdentity()]);
const PUB = alice.pub;

const b64 = (n, fill = 1) => b64url.encode(new Uint8Array(n).fill(fill));
const SEAL = { enc: 'mw-seal-v1', iv: b64(12), ct: b64(1040) };
const FILE = { ih: 'a'.repeat(40), len: 1024, name: 'photo.jpg', mime: 'image/jpeg', t: T0 };
const CK = { v: 2, ledger: SITE, signer: PUB, ek: owner.pub, epoch: 1, exp: T0 + 90 * 86400000, sig: b64(64) };
const LINK = { from: PUB, to: owner.pub, t: T0, sigTo: b64(64) };
const DENY = '_deny/' + b64url.encode(sha256Sync(utf8.encode('file')));
const ROLES = '_roles/' + 'A'.repeat(22);

test('schemaOk: mw.s, mw.files, mw.ck, mw.link lists', () => {
  assert.equal(schemaOk('mw.s', SEAL), true);
  assert.equal(schemaOk('mw.s', { ...SEAL, hint: b64(4) }), true);
  for (const bad of [null, 'x', { ...SEAL, enc: 'mw-seal-v2' }, { ...SEAL, iv: b64(11) }, { ...SEAL, ct: b64(1039) }, { ...SEAL, hint: b64(5) },
    { ...SEAL, extra: 1 }, { enc: SEAL.enc, iv: SEAL.iv }]) assert.equal(schemaOk('mw.s', bad), false, JSON.stringify(bad).slice(0, 60));
  assert.equal(schemaOk('mw.files', FILE), true);
  assert.equal(schemaOk('mw.files', { ...FILE, sha256: 'b'.repeat(64), ws: 'https://seed.example/x' }), true);
  for (const bad of [{ ...FILE, ih: 'A'.repeat(40) }, { ...FILE, ih: 'a'.repeat(39) }, { ...FILE, len: -1 }, { ...FILE, name: '' }, { ...FILE, name: 'x'.repeat(97) },
    { ...FILE, name: 'evil‮gpj.exe' }, { ...FILE, mime: 'image' }, { ...FILE, sha256: 'x' }, { ...FILE, ws: 'ftp://x' }, { ...FILE, t: 1.5 }, { ...FILE, owner: 1 }]) {
    assert.equal(schemaOk('mw.files', bad), false, JSON.stringify(bad).slice(0, 80));
  }
  assert.equal(schemaOk('mw.ck', CK), true);
  for (const bad of [{ ...CK, v: 1 }, { ...CK, signer: 'p256:x' }, { ...CK, sig: b64(63) }, { ...CK, epoch: -1 }, { ...CK, ledger: '' }]) assert.equal(schemaOk('mw.ck', bad), false);
  assert.equal(schemaOk('mw.link', LINK), true);
  for (const bad of [{ ...LINK, to: 'x' }, { ...LINK, sigTo: 'short' }, { ...LINK, t: '1' }]) assert.equal(schemaOk('mw.link', bad), false);
});

test('schemaOk: _mw.cfg, _deny/<b64url sha256>, _roles/<22 chars> keys; null deletes; other names have no schema', () => {
  assert.equal(schemaOk('_mw.cfg', { chat: 'members', files: 'off', media: 'members', records: 'sealed', maxItems: 4, requests: 'on', chatBits: 20 }), true);
  assert.equal(schemaOk('_mw.cfg', { pin: PUB, age: 'none', turn: { urls: ['turns:turn.example:5349'], mode: 'static' } }), true);
  assert.equal(schemaOk('_mw.cfg', {}), true);
  for (const bad of [{ chat: 'everyone' }, { maxItems: 33 }, { maxItems: 0 }, { chatBits: 33 }, { pin: 'nobody' }, { age: 'adult' }, { turn: { urls: [], mode: 'static' } },
    { turn: { urls: ['http://x'], mode: 'static' } }, { security: 'off' }, 'off', [1]]) assert.equal(schemaOk('_mw.cfg', bad), false, JSON.stringify(bad));
  assert.equal(schemaOk('_mw.cfg', null), true, 'deleting the key');
  assert.equal(schemaOk(DENY, { by: PUB, t: T0, reason: 'P0' }), true);
  assert.equal(schemaOk(DENY, { by: PUB, t: T0, reason: 'spam', ref: 'report 12' }), true);
  for (const bad of [{ by: PUB, t: T0, reason: 'dislike' }, { by: PUB, t: T0 }, { by: 'x', t: T0, reason: 'P0' }]) assert.equal(schemaOk(DENY, bad), false);
  assert.equal(schemaOk('_deny/short', { by: PUB, t: T0, reason: 'P0' }), false, 'the key names a b64url sha256');
  assert.equal(schemaOk(ROLES, { role: 'moderator', label: 'Mods', t: T0 }), true);
  assert.equal(schemaOk(ROLES, { role: 'moderator', t: T0 }), false);
  assert.equal(schemaOk('_roles/abc', { role: 'x', label: '', t: T0 }), false);
  // No schema: bare names are not reserved; other _ keys and other lists are free.
  for (const name of ['dm', 'chat', 'pres', 'gb', 'mw.post', 'mw.rep', '_notice', '_mw.other']) assert.equal(schemaOk(name, { anything: [1, 2] }), true, name);
  assert.equal(schemaOk('mw.s', SEAL, 'key'), true, 'a put to the key "mw.s" has no schema');
  assert.equal(schemaOk('_mw.cfg', { chat: 'everyone' }, 'list'), true, 'an append to the list "_mw.cfg" has no schema');
});

test('U-LG-2: a non-matching mw.* item is valid, stored and hidden; the v0.2.1 reducer and the new one agree on everything else', async () => {
  const mk = (identity, op, value, prev, bits = 0) => createBlock({ identity, site: SITE, seq: 1, prev, op, value, ts: T0, bits });
  const G = await mk(owner, { t: 'policy', writers: 'open', bits: 0 }, undefined, []);
  const bad = await mk(alice, { t: 'append', l: 'mw.s' }, { enc: 'plain', text: 'not sealed' }, [G.h]);
  const good = await mk(alice, { t: 'append', l: 'mw.s' }, SEAL, [bad.h]);
  const badCfg = await mk(owner, { t: 'put', k: '_mw.cfg' }, { chat: 'everyone' }, [good.h]);
  const dm = await mk(alice, { t: 'append', l: 'dm' }, { text: 'bare names are not reserved' }, [badCfg.h]);
  for (const b of [G, bad, good, badCfg, dm]) assert.deepEqual(await validateBlock(b, { site: SITE }), { ok: true }, 'valid: ' + b.e.op.t);
  const dag = new Dag();
  for (const b of [G, bad, good, badCfg, dm]) assert.equal(dag.add(b), 'added', 'stored');
  assert.equal(dag.get(bad.h).v.text, 'not sealed', 'the value is kept (stored and relayed)');
  const st = reduce(dag, { genesisOwner: owner.pub });
  assert.deepEqual(st.lists.get('mw.s').map((it) => it.h), [good.h], 'hidden');
  assert.equal(st.kv.has('_mw.cfg'), false, 'a non-matching _mw.cfg has no effect');
  assert.deepEqual(st.lists.get('dm').map((it) => it.v.text), ['bare names are not reserved']);
  assert.ok(!st.effective.has(bad.h) && !st.redacted.has(bad.h), 'hidden, not redacted');
  const old = frozen.reduce(dag, { genesisOwner: owner.pub });
  assert.equal(old.lists.get('mw.s').length, 2, 'the v0.2.1 reducer shows it');
  assert.deepEqual(old.lists.get('dm'), st.lists.get('dm'));
  assert.deepEqual(Array.from(old.redacted), Array.from(st.redacted));
  assert.equal(old.controlBlocks, st.controlBlocks);
});

// ---------------------------------------------------------------------------------------------
// The v0.2.1 reducer and the new one agree on every DAG without freeze-group ops.
// ---------------------------------------------------------------------------------------------

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function shuffle(rand, list) {
  const a = list.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}
let serial = 0;
function synth(author, op, value, prev, bits = 0, ts = T0) {
  serial++;
  let full = op;
  if (op.t === 'put' || op.t === 'append' || op.t === 'profile') full = Object.assign({}, op, { vh: hex.encode(sha256Sync(utf8.encode(canonicalize(value)))) });
  const e = { v: 1, site: SITE, author, seq: serial, prev: Array.from(new Set(prev)).sort(), ts, bits, op: full, nonce: '' };
  const block = { e, h: hex.encode(sha256Sync(utf8.encode(canonicalize(e)))), s: SIG };
  if (value !== undefined) block.v = value;
  return block;
}
function fakeKeys(rand, n) {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
  return Array.from({ length: n }, () => 'p256:B' + Array.from({ length: 86 }, () => alphabet[Math.floor(rand() * 64)]).join(''));
}

// Every v1 op; moderator actions stay under the default hourly cap (60), moderators never
// tombstone owner-standing payload (the owner keys own and own2 write no payload a moderator
// targets) and never write allow blocks (the moderator allow form is a freeze-group rule, D-9),
// so no freeze-group state rule applies. The moderator set is the genesis one ([m1]) throughout:
// since the review round (HUB-4) a moderator acts only with the policy that appointed it in the
// block's causal past, which v0.2.1 did not ask (a grant concurrent with an action counted), so a
// later appointment would be a deliberate difference (chain-v03-review.test.mjs covers it).
function v1Ledger(rand, count) {
  const keys = fakeKeys(rand, 12);
  const [own, own2, m1, m2] = keys;
  const writers = keys.slice(2);
  const spammers = keys.slice(10);
  const blocks = [synth(own, { t: 'policy', writers: 'open', bits: 2, moderators: [m1] }, undefined, [])];
  const payloads = [];
  for (let i = 1; i < count; i++) {
    const ts = T0 + Math.floor(i / 40) * HOUR;
    const lo = Math.max(0, blocks.length - 16);
    const prev = [];
    const k = 1 + Math.floor(rand() * 3);
    for (let j = 0; j < k; j++) prev.push(blocks[lo + Math.floor(rand() * (blocks.length - lo))].h);
    const r = rand();
    const author = writers[Math.floor(rand() * writers.length)];
    const bits = rand() < 0.9 ? 2 : 0;
    let b;
    if (r < 0.45) b = synth(rand() < 0.05 ? own : author, { t: 'append', l: rand() < 0.9 ? 'gb' : '_log' }, { text: 'post ' + i }, prev, bits, ts);
    else if (r < 0.65) b = synth(author, { t: 'put', k: (rand() < 0.1 ? '_' : '') + 'key' + Math.floor(rand() * 40) }, rand() < 0.1 ? null : i, prev, bits, ts);
    else if (r < 0.73) b = synth(author, { t: 'profile' }, 'name ' + (i % 7), prev, bits, ts);
    else if (r < 0.85 && payloads.length > 0) {
      const target = payloads[Math.floor(rand() * payloads.length)];
      const who = target.e.author === own ? own : [own, m1, m2, target.e.author, author][Math.floor(rand() * 5)];
      b = synth(who, { t: 'tombstone', h: rand() < 0.05 ? 'e'.repeat(64) : target.h }, undefined, prev, 2, ts);
    } else if (r < 0.89) b = synth([own, m1, author][Math.floor(rand() * 3)], { t: 'ban', author: spammers[Math.floor(rand() * spammers.length)] }, undefined, prev, 0, ts);
    else if (r < 0.94) {
      const fields = [{ writers: 'allow', allow: writers.slice(0, 6) }, { writers: 'open' }, { bits: 3 }, { bits: 2 }, { moderators: [m1] }, { moderators: [m1] }, { allow: writers.slice(0, 4) }, { maxValueBytes: 12 }];
      b = synth(rand() < 0.8 ? own : author, Object.assign({ t: 'policy' }, fields[Math.floor(rand() * fields.length)]), undefined, prev, 0, ts);
    } else if (r < 0.97) b = synth(rand() < 0.8 ? own : spammers[0], { t: 'allow', add: [writers[Math.floor(rand() * writers.length)]], remove: rand() < 0.3 ? [writers[0]] : [] }, undefined, prev, 0, ts);
    else b = synth(rand() < 0.5 ? own : own2, { t: 'owner', next: rand() < 0.5 ? own2 : own }, undefined, prev, 0, ts);
    if (['put', 'append', 'profile'].includes(b.e.op.t)) payloads.push(b);
    blocks.push(b);
  }
  return { blocks, owner: own, other: own2 };
}

function v021View(st) {
  const snap = snapshot(st);
  delete snap.keychange;
  delete snap.checkpoint;
  for (const f of ['modAllowPerDay', 'modActionsPerHour', 'reservedPool', 'voided']) delete snap.policy[f];
  return JSON.stringify({
    snap,
    tombstoned: Array.from(st.tombstoned).sort(),
    redacted: Array.from(st.redacted).sort(),
    effective: Array.from(st.effective).sort(),
    controlBlocks: st.controlBlocks,
    owner: st.owner,
    ownerConflict: st.ownerConflict,
    keys: st.succession.keys,
    chosen: st.succession.chosen,
    allow: Array.from(st.policy.allow).sort(),
    kvMeta: Array.from(st.kv).map(([k, e]) => [k, e.author, e.h, e.ts]),
  });
}

test('the frozen v0.2.1 reducer agrees with the new reducer on every DAG without freeze-group ops', () => {
  const rand = mulberry32(0x5c4e3a);
  let rounds = 0;
  let conflicts = 0;
  for (let round = 0; round < 16; round++) {
    const { blocks, owner: own, other } = v1Ledger(rand, 150 + Math.floor(rand() * 150));
    for (const expectedOwner of [null, other]) {
      for (const minBits of [0, 1]) {
        const opts = { genesisOwner: own, expectedOwner, minBits };
        for (let s = 0; s < 3; s++) {
          const dag = new Dag({ maxOrphansPerPeer: 1e6, maxOrphans: 1e6 });
          for (const b of s === 0 ? blocks : shuffle(rand, blocks)) dag.add(b);
          const now = reduce(dag, opts);
          const then = frozen.reduce(dag, opts);
          assert.equal(v021View(now), v021View(then), `round ${round} expectedOwner ${!!expectedOwner} minBits ${minBits} shuffle ${s}`);
          if (s === 0) {
            for (const b of blocks) assert.equal(ownerAt(dag, b.h, own, expectedOwner), frozen.ownerAt(dag, b.h, own, expectedOwner));
            if (now.ownerConflict) conflicts++;
          }
        }
      }
    }
    rounds++;
  }
  // Ownerless ledgers too.
  for (let round = 0; round < 4; round++) {
    const { blocks } = v1Ledger(rand, 120);
    const dag = new Dag({ maxOrphansPerPeer: 1e6, maxOrphans: 1e6 });
    for (const b of blocks) dag.add(b);
    assert.equal(v021View(reduce(dag, { genesisOwner: null })), v021View(frozen.reduce(dag, { genesisOwner: null })));
  }
  assert.equal(rounds, 16);
  assert.ok(conflicts > 0, conflicts + ' rounds with an ownerConflict');
});

// Code review v0.3 (conformance M1; the C2-5 test generalised): a key a document or a lane names in _mw.cfg must be one the
// readers' schema takes, or every honest loader hides the whole object (chat, files and media then read as off).
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
function textFiles(dir, exts, out = []) {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name === 'labs' || name.startsWith('.')) continue;
    const p = join(dir, name);
    const st = statSync(p, { throwIfNoEntry: false });
    if (!st) continue;
    if (st.isDirectory()) textFiles(p, exts, out);
    else if (exts.some((e) => name.endsWith(e))) out.push(p);
  }
  return out;
}
const SAMPLE = {
  chat: 'members', files: 'members', media: 'members', records: 'sealed', requests: 'introduced', calls: 'contacts', wall: 'follow',
  maxItems: 4, chatBits: 20, pin: PUB, age: 'none', turn: { urls: ['turns:turn.example:5349'], mode: 'static' }, blockTiers: ['executable', 'installer'],
};

test('every _mw.cfg key a document or lane names (and every value they give it) passes the readers\' schema; ledger-admin writes only those', () => {
  assert.deepEqual(Object.keys(SAMPLE).sort(), CFG_KEYS.slice().sort(), 'a sample value for every schema key');
  for (const [k, v] of Object.entries(SAMPLE)) assert.equal(schemaOk('_mw.cfg', { chat: 'members', [k]: v }, 'key'), true, k);
  const files = textFiles(join(ROOT, 'docs'), ['.md']).filter((f) => !/code-review-/.test(f))
    .concat(textFiles(join(ROOT, 'src'), ['.js']), textFiles(join(ROOT, 'examples'), ['.js', '.html', '.md']));
  const named = new Map();
  const valued = [];
  for (const f of files) {
    const text = readFileSync(f, 'utf8');
    for (const m of text.matchAll(/_mw\.cfg\.([A-Za-z]+)/g)) if (!named.has(m[1])) named.set(m[1], relative(ROOT, f));
    for (const m of text.matchAll(/_mw\.cfg\.([A-Za-z]+)`?\s*={1,3}\s*[`'"]?([A-Za-z]+)/g)) valued.push([m[1], m[2], relative(ROOT, f)]);
  }
  assert.ok(named.size >= 10, 'the scan finds the documented keys');
  for (const [k, where] of named) assert.ok(CFG_KEYS.includes(k), '_mw.cfg.' + k + ' (' + where + ') is not in the readers\' schema');
  for (const [k, v, where] of valued) {
    if (!SAMPLE[k] || typeof SAMPLE[k] !== 'string' || !Object.prototype.hasOwnProperty.call(CFG_ENUMS, k)) continue;
    assert.equal(schemaOk('_mw.cfg', { [k]: v }, 'key'), true, '_mw.cfg.' + k + ' = ' + v + ' (' + where + ')');
  }
  // The files lane reads blockTiers: every kind sniff tells apart may be blocked, nothing else.
  for (const kind of CFG_TIERS) assert.equal(schemaOk('_mw.cfg', { blockTiers: [kind] }, 'key'), true, kind);
  for (const bad of [['exe'], ['executable', 'executable'], 'executable', [1]]) assert.equal(schemaOk('_mw.cfg', { blockTiers: bad }, 'key'), false, JSON.stringify(bad));
  assert.equal(schemaOk('_mw.cfg', { blockTiers: [] }, 'key'), true, 'an empty list blocks nothing');
  assert.equal(schemaOk('_mw.cfg', { wall: 'friends' }, 'key'), false);
  assert.equal(schemaOk('_mw.cfg', { requests: 'maybe' }, 'key'), false);
  // ledger-admin writes nothing the readers hide.
  for (const [k, values] of Object.entries(CFG_ENUMS)) for (const v of values) assert.equal(schemaOk('_mw.cfg', { [k]: v }, 'key'), true, k + ' = ' + v);
});
