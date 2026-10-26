// The data layer of examples/social (js/data.js) in Node, against a small fake of the SDK in the shapes docs/SDK.md gives: what the
// template writes back to _mw.cfg, which keys "Delete my page" removes, and what "Download my data" holds. No browser.
// Run: node --test test/example/social-data.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createData } from '../../examples/social/js/data.js';
import { createHub } from '../../examples/social/js/hub.js';
import { createStore } from '../../examples/social/js/store.js';
import { CFG_KEYS, FEATURE_SWITCHES } from '../../examples/social/js/config.js';
import { authorScope } from '../../examples/social/js/ids.js';
import { SIGNED_ENTRIES_NOTE } from '../../examples/social/js/strings.js';
import * as LEDGER_STATE from '../../src/chain/state.js';
import { STRINGS } from '../../src/loader/strings.js';
import { ledgerId, hashOf, pubOf, item } from './social-helpers.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const { schemaOk } = LEDGER_STATE;
const ME = pubOf(1), OTHER = pubOf(9), SITE = ledgerId(1);
const POLICY = { writers: 'owner', bits: 16, maxValueBytes: 2048, maxChainBytes: 8388608, moderators: [], banned: [] };

/**
 * fakeMw({ kv, lists, role }) -> { mw, writes }: mw.ready, mw.db.subscribe (the snapshot of docs/SDK.md: kv is key -> current value) and
 * the writes the template makes; every write pushes a new snapshot, as the loader does.
 */
function fakeMw({ kv = {}, lists = {}, role = 'owner', profiles = { [ME]: 'Ada' } } = {}) {
  const st = { kv: Object.assign({}, kv), lists: JSON.parse(JSON.stringify(lists)), profiles: Object.assign({}, profiles) };
  const subs = new Set();
  const writes = [];
  const snap = () => ({ height: 3, depth: 1, bytes: 1024, capReached: false, kv: Object.assign({}, st.kv), lists: JSON.parse(JSON.stringify(st.lists)), profiles: Object.assign({}, st.profiles),
    policy: POLICY, owner: ME, authors: 1, unmoderated: false, peers: 0, inSync: 0, role });
  const push = () => setTimeout(() => { for (const fn of subs) fn(snap()); }, 1);
  let n = 0;
  const h = () => hashOf('write|' + (++n));
  const mw = {
    async ready() { return { siteId: SITE, mode: 'hub', auth: 'signed-in', identity: { pub: ME, short: 'cafe0001', name: 'Ada', mode: 'hub' }, role, peers: 0 }; },
    db: {
      subscribe(fn) { subs.add(fn); setTimeout(() => fn(snap()), 1); return () => subs.delete(fn); },
      async set(key, value) { writes.push(['set', key, value]); if (value === null) delete st.kv[key]; else st.kv[key] = value; push(); return { h: h() }; },
      async del(key) { return mw.db.set(key, null); },
      async tombstone(hash) { writes.push(['tombstone', hash]); push(); return { h: h() }; },
      async append(name, value) { writes.push(['append', name, value]); (st.lists[name] = st.lists[name] || []).push(item(h(), ME, Date.now(), value)); push(); return { h: h() }; },
    },
  };
  return { mw, writes };
}

async function started(opts) {
  const { mw, writes } = fakeMw(opts);
  const d = createData({ mw, hub: createHub(mw, null), store: createStore(null), env: { now: () => Date.now(), deviceClass: () => 'desktop' }, chat: null });
  await d.start();
  return { d, mw, writes };
}

test('every _mw.cfg key the template knows passes the ledger\'s schema (src/chain/state.js), calls included; the template adds only those', () => {
  const sample = { chat: 'members', files: 'members', media: 'members', records: 'sealed', requests: 'on', calls: 'contacts', maxItems: 8, chatBits: 8, pin: ME, age: 'none', turn: { urls: ['turns:turn.hub.example:443'], mode: 'static' } };
  for (const k of CFG_KEYS) assert.equal(schemaOk('_mw.cfg', { [k]: sample[k] }, 'key'), true, k + ' (with ' + JSON.stringify(sample[k]) + ')');
  assert.equal(schemaOk('_mw.cfg', Object.assign({}, sample), 'key'), true, 'all of them at once');
  assert.equal(schemaOk('_mw.cfg', { chat: 'members', 'no-such-key': 1 }, 'key'), false, 'one unknown key hides the whole object');
  for (const k of Object.keys(FEATURE_SWITCHES)) assert.ok(CFG_KEYS.includes(k), k + ': the template only ever adds a key the schema knows');
  // The ledger's own list, where the chain module exports it: the template's keys are a part of it.
  if (Array.isArray(LEDGER_STATE.CFG_KEYS)) for (const k of CFG_KEYS) assert.ok(LEDGER_STATE.CFG_KEYS.includes(k), k + ' is a key of the ledger\'s schema');
  // Source check of the switch tables, for a chain module that does not export the list: every enum row of the schema is known here or kept.
  const table = /const CFG = \{([\s\S]*?)\n\};/.exec(readFileSync(join(HERE, '../../src/chain/state.js'), 'utf8'));
  assert.ok(table, 'the CFG table of src/chain/state.js');
  assert.ok([...table[1].matchAll(/^\s+(\w+):/gm)].map((m) => m[1]).includes('calls'), 'calls is a switch of the ledger\'s schema (v0.3 C2)');
});

test('ensureFeature keeps every key the page\'s _mw.cfg already has: a first private photo does not switch calls off', async () => {
  const { d, writes } = await started({ kv: { '_mw.cfg': { calls: 'contacts', chat: 'members', maxItems: 8 } } });
  try {
    assert.equal(d.isHome(), true);
    assert.equal(await d.ensureFeature('media'), true);
    const cfg = writes.filter((w) => w[0] === 'set' && w[1] === '_mw.cfg');
    assert.equal(cfg.length, 1);
    assert.deepEqual(cfg[0][2], { calls: 'contacts', chat: 'members', maxItems: 8, media: 'members' });
    assert.equal(schemaOk('_mw.cfg', cfg[0][2], 'key'), true, 'what is written back passes the ledger\'s schema');
    assert.equal(await d.ensureFeature('media'), false, 'a switch that is on is not written again');
    assert.equal(await d.ensureFeature('chat'), false, 'chat was on already');
    await assert.rejects(() => d.ensureFeature('calls'), (e) => e.code === 'E_BAD_REQUEST', 'the template turns on only chat, files and media');
  } finally { d.stop(); }
});

test('ownKeys: your reactions, your author-scoped keys and your plain keys; never the loader\'s _ keys or another author\'s scope', async () => {
  const react = 're/' + ledgerId(2) + '/' + hashOf('p'), mine = authorScope(ME) + 'vote', theirs = authorScope(OTHER) + 'vote';
  // The SDK's snapshot (docs/SDK.md): kv is key -> current value, no author and no entry hash.
  let r = await started({ kv: { [react]: { r: 'heart' }, [mine]: 1, [theirs]: 2, topic: 'doors', '_mw.cfg': { chat: 'members' }, '_deny/x': { by: ME }, gone: null } });
  try {
    assert.deepEqual(r.d.ownKeys(), [{ key: mine, h: null }, { key: react, h: null }, { key: 'topic', h: null }].sort((a, b) => (a.key < b.key ? -1 : 1)));
  } finally { r.d.stop(); }
  // A snapshot that names the entries ({ v, author, h, ts }): only your own, with the hash so their bytes can be tombstoned too.
  const RH = hashOf('react-entry');
  r = await started({ kv: { [react]: { v: { r: '+1' }, author: ME, h: RH, ts: 1 }, topic: { v: 'x', author: OTHER, h: hashOf('t'), ts: 1 } } });
  try {
    assert.deepEqual(r.d.ownKeys(), [{ key: react, h: RH }]);
  } finally { r.d.stop(); }
  // Not your own page (a reader here): nothing to remove.
  r = await started({ kv: { [react]: { r: 'heart' } }, role: 'reader' });
  try {
    assert.deepEqual(r.d.ownKeys(), []);
    assert.deepEqual(r.d.ownPayloads(), []);
  } finally { r.d.stop(); }
});

test('exportData: the lists, keys and names, the private record when it was read for the file, and where the signed entries are', async () => {
  const { d } = await started({ lists: { 'mw.post': [item(hashOf('p1'), ME, 1, { text: 'hello' })] }, kv: { topic: 'doors' } });
  try {
    const withRecord = d.exportData({ record: { notes: 'x' } });
    assert.equal(withRecord.ledger, SITE);
    assert.equal(withRecord.lists['mw.post'][0].v.text, 'hello');
    assert.deepEqual(withRecord.keys, { topic: 'doors' });
    assert.deepEqual(withRecord.privateRecord, { notes: 'x' });
    assert.equal(withRecord.privateRecordNote, undefined);
    assert.equal(withRecord.signedEntries, SIGNED_ENTRIES_NOTE);
    const without = d.exportData({ recordError: 'You cancelled.' });
    assert.equal(without.privateRecord, undefined);
    assert.match(without.privateRecordNote, /^Your private record is not in this file \(You cancelled\.\)\./);
  } finally { d.stop(); }
  // The note names the loader's own buttons by their labels (src/loader/strings.js).
  assert.ok(SIGNED_ENTRIES_NOTE.includes(STRINGS.settingsLedger + ', ' + STRINGS.settingsExportLedger), SIGNED_ENTRIES_NOTE);
});
