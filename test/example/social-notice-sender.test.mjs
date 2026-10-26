// SYB-12: a notice's `from` (a ledger id) is typed by its sender. The social template must judge a chat notice by the key the loader
// authenticated (msg.from.pub, src/chat/service.js), not by the ledger the notice names: otherwise a contact claims a ledger the reader
// follows and the reader's own client signs an mw.ok for the contact's block (examples/social/js/data.js handleNotice, mw.ok in queueOk).
// The data layer runs in Node against a small fake of the SDK (as in social-data.test.mjs). No browser.
//
// The fix belongs to examples/social/js/data.js, which this round's examples fixer may not edit (docs/deviations/review-round-examples.md,
// Requests). Until it lands the forged-notice tests run as `todo` (reported, not failing); they arm themselves when handleNotice takes the
// chat message as its second argument (the fix's signature, `handleNotice(n, msg)`). MW_SOCIAL_DIR points the tests at another copy of the
// template, as in social-browser-lib.mjs.
// Run: node --test test/example/social-notice-sender.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { ledgerId, hashOf, pubOf, item, snapshot } from './social-helpers.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const SOCIAL = process.env.MW_SOCIAL_DIR ? resolve(process.env.MW_SOCIAL_DIR) : resolve(HERE, '../../examples/social');
const load = (p) => import(pathToFileURL(join(SOCIAL, 'js', p)).href);
const { createData } = await load('data.js');
const { createHub } = await load('hub.js');
const { createStore } = await load('store.js');
const { encodeNotice, decodeNotice } = await load('notices.js');

const SAM = pubOf(1), HOME = ledgerId(1); // the reader, on his own page
const FIONA = pubOf(5), FIONA_L = ledgerId(5); // a ledger Sam follows (wall mode 'follow', the default: config.js DEFAULT_WALL)
const MALLORY = pubOf(9), MALLORY_L = ledgerId(9); // a contact Sam does not follow
const POLICY = { writers: 'owner', bits: 16, maxValueBytes: 2048, maxChainBytes: 8388608, moderators: [], banned: [] };

/** A signed-in owner on his own page who follows Fiona through the hub; chat delivers what deliver() hands it. */
async function sam() {
  const st = { lists: { 'mw.f': [item(hashOf('f1'), SAM, Date.now() - 1000, { l: FIONA_L })] }, profiles: { [SAM]: 'Sam' } };
  const subs = new Set(), writes = [];
  let n = 0;
  const own = () => ({ height: 3, depth: 1, bytes: 1024, capReached: false, kv: {}, lists: JSON.parse(JSON.stringify(st.lists)), profiles: Object.assign({}, st.profiles),
    policy: POLICY, owner: SAM, authors: 1, unmoderated: false, peers: 0, inSync: 0, role: 'owner' });
  const fiona = () => snapshot({ owner: FIONA, profiles: { [FIONA]: 'Fiona' }, lists: { 'mw.post': [] } });
  const push = () => setTimeout(() => { for (const fn of subs) fn(own()); }, 1);
  const mw = {
    async ready() { return { siteId: HOME, mode: 'hub', auth: 'signed-in', identity: { pub: SAM, short: 'cafe0001', name: 'Sam', mode: 'hub' }, role: 'owner', peers: 0 }; },
    hub: { async follow(t) { return { ledger: t, following: true }; }, async unfollow(l) { return { ledger: l }; }, async list() { return [{ ledger: FIONA_L }]; } },
    db: {
      subscribe(fn, opts) {
        if (opts && opts.ledger) { setTimeout(() => fn(opts.ledger === FIONA_L ? fiona() : snapshot({ owner: null })), 1); return () => {}; }
        subs.add(fn); setTimeout(() => fn(own()), 1); return () => subs.delete(fn);
      },
      async set(k, v) { writes.push(['set', k, v]); push(); return { h: hashOf('w' + (++n)) }; },
      async del(k) { return mw.db.set(k, null); },
      async tombstone(h) { writes.push(['tombstone', h]); push(); return { h: hashOf('w' + (++n)) }; },
      async append(name, value) { writes.push(['append', name, value]); (st.lists[name] = st.lists[name] || []).push(item(hashOf('w' + (++n)), SAM, Date.now(), value)); push(); return { h: hashOf('w' + n) }; },
    },
  };
  let handler = null;
  const chat = { onNotice(fn) { handler = fn; return () => {}; }, async block() {}, async unblock() {}, async sendNotice() { return true; } };
  const d = createData({ mw, hub: createHub(mw, null), store: createStore(null), env: { now: () => Date.now(), deviceClass: () => 'desktop' }, chat });
  await d.start();
  for (let i = 0; i < 100 && !(d.viewOf(FIONA_L) && d.viewOf(FIONA_L).owner); i++) await new Promise((r) => setTimeout(r, 5));
  const deliver = (notice, fromPub) => {
    const text = encodeNotice(notice);
    assert.ok(text, 'a well-formed notice');
    handler(decodeNotice(text), { id: 'm' + Math.random(), from: { pub: fromPub, name: '', short: 'x' }, dir: 'in', text });
  };
  const okRefs = async () => {
    for (let i = 0; i < 20; i++) await d.flushOk(); // one flush runs at a time; the page's timer would run the rest every 10 s
    return writes.filter((w) => w[0] === 'append' && w[1] === 'mw.ok').flatMap((w) => w[2].refs);
  };
  return { d, deliver, okRefs };
}
const ARMED = await (async () => { const { d } = await sam(); try { return d.handleNotice.length >= 2; } finally { d.stop(); } })();
const forged = { todo: ARMED ? false : 'SYB-12: needs the examples/social/js/data.js fix in docs/deviations/review-round-examples.md (Requests)' };

test('SYB-12 control: an honest wall notice from the owner of a followed ledger is accepted (the fixture works)', async () => {
  const { d, deliver, okRefs } = await sam();
  try {
    assert.equal(d.isHome(), true);
    assert.equal(d.viewOf(FIONA_L).owner, FIONA, 'Sam holds Fiona\'s ledger');
    const ref = { l: FIONA_L, h: hashOf('fiona-wall-post') };
    deliver({ k: 'wall', from: FIONA_L, ref }, FIONA);
    assert.deepEqual(await okRefs(), [ref]);
    assert.ok(d.notices().some((x) => x.k === 'wall' && x.from === FIONA_L));
  } finally { d.stop(); }
});

test('SYB-12: a wall notice naming a followed ledger but sent by another key is ignored: no mw.ok, no alert', forged, async () => {
  const { d, deliver, okRefs } = await sam();
  try {
    deliver({ k: 'wall', from: FIONA_L, ref: { l: MALLORY_L, h: hashOf('mallory-post') } }, MALLORY);
    deliver({ k: 'wall', from: FIONA_L, ref: { l: FIONA_L, h: hashOf('fiona-post-claimed') } }, MALLORY);
    assert.deepEqual(await okRefs(), []);
    assert.deepEqual(d.notices(), []);
  } finally { d.stop(); }
});

test('SYB-12: a forged reply notice (a followed ledger as from, another key as sender) is not accepted as a comment', forged, async () => {
  const { d, deliver, okRefs } = await sam();
  try {
    deliver({ k: 'reply', from: FIONA_L, ref: { l: MALLORY_L, h: hashOf('mallory-comment') }, target: { l: HOME, h: hashOf('sam-post') } }, MALLORY);
    assert.deepEqual(await okRefs(), []);
    assert.deepEqual(d.notices(), []);
  } finally { d.stop(); }
});

test('SYB-12: "X followed you" cannot be forged with another ledger\'s id, nor sent for a ledger this browser cannot check', forged, async () => {
  const { d, deliver } = await sam();
  try {
    deliver({ k: 'follow', from: FIONA_L }, MALLORY);
    deliver({ k: 'follow', from: ledgerId(77) }, MALLORY); // a ledger Sam does not hold: its owner cannot be checked
    assert.deepEqual(d.notices(), []);
  } finally { d.stop(); }
});

test('SYB-12: the owner of a followed ledger cannot get another ledger\'s block accepted (the ref must be on the sender\'s ledger)', forged, async () => {
  const { d, deliver, okRefs } = await sam();
  try {
    deliver({ k: 'wall', from: FIONA_L, ref: { l: MALLORY_L, h: hashOf('someone-elses-post') } }, FIONA);
    assert.deepEqual(await okRefs(), []);
  } finally { d.stop(); }
});

test('SYB-12: a blocked key is dropped whatever ledger its notice names', forged, async () => {
  const { d, deliver, okRefs } = await sam();
  try {
    d.block(FIONA);
    deliver({ k: 'wall', from: FIONA_L, ref: { l: FIONA_L, h: hashOf('blocked-post') } }, FIONA);
    d.block(MALLORY);
    deliver({ k: 'follow', from: MALLORY_L }, MALLORY);
    assert.deepEqual(await okRefs(), []);
    assert.deepEqual(d.notices(), []);
  } finally { d.stop(); }
});

test('SYB-12: 200 wall notices from one key put at most 20 refs an hour into mw.ok', forged, async () => {
  const { d, deliver, okRefs } = await sam();
  try {
    for (let i = 0; i < 200; i++) deliver({ k: 'wall', from: FIONA_L, ref: { l: FIONA_L, h: hashOf('flood' + i) } }, FIONA);
    const refs = await okRefs();
    assert.ok(refs.length > 0 && refs.length <= 20, refs.length + ' refs');
  } finally { d.stop(); }
});
