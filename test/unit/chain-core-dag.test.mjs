// Unit tests for src/chain/dag.js: deterministic order, depth, heads, root, depth windows,
// ancestors, orphan pool (backfill, caps, eviction), byte accounting. Blocks are synthetic (h is
// the real sha256 of canonical(e); signatures are not checked by the Dag). References are
// computed independently, with WebCrypto for the digests.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Dag, WINDOW_SIZE, MAX_ORPHANS_PER_PEER, MAX_ORPHANS } from '../../src/chain/dag.js';
import { sha256Sync } from '../../src/chain/sha256-sync.js';
import { canonicalize, utf8, hex, byteLength } from '../../src/chain/canonical.js';
import { blockBytes } from '../../src/chain/block.js';

const SITE = 'mw1:dagtestsite00000000000000';
const T0 = Date.UTC(2026, 9, 17, 12, 0, 0);
const AUTHOR = 'p256:B' + 'A'.repeat(86); // algorithm-tagged key shape (v0.2.1 A2); the Dag never verifies it
// A fixed value salt for the synthetic blocks (v0.2.1 A1): vh = sha256("mw-vh-v1\n" + z + "\n" + canonical(v)).
const ZSALT = 'AQIDBAUGBwgJCgsMDQ4PEA';
const SIG = 'A'.repeat(86);

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
    const t = a[i];
    a[i] = a[j];
    a[j] = t;
  }
  return a;
}

const sha = (str) => hex.encode(sha256Sync(utf8.encode(str)));

let serial = 0;
function makeBlock(prev, { value = serial, op } = {}) {
  serial++;
  const v = value;
  const e = {
    v: 1, site: SITE, author: AUTHOR, seq: serial, prev: Array.from(new Set(prev)).sort(), ts: T0, bits: 0,
    op: op || { t: 'put', k: 'k' + serial, vh: sha('mw-vh-v1\n' + ZSALT + '\n' + canonicalize(v)) }, nonce: '',
  };
  const block = { e, h: sha(canonicalize(e)), s: SIG };
  if (!op || ['put', 'append', 'profile'].includes(op.t)) {
    block.v = v;
    block.z = ZSALT;
  }
  return block;
}

// A concurrent DAG: `roots` roots, then each block picks 1..maxPrev parents among the last
// `window` blocks, so several blocks share each depth.
function randomDag(rand, count, { roots = 3, maxPrev = 3, window = 8 } = {}) {
  const blocks = [];
  for (let i = 0; i < count; i++) {
    if (i < roots) {
      blocks.push(makeBlock([]));
      continue;
    }
    const k = 1 + Math.floor(rand() * maxPrev);
    const prev = [];
    const lo = Math.max(0, blocks.length - window);
    for (let j = 0; j < k; j++) prev.push(blocks[lo + Math.floor(rand() * (blocks.length - lo))].h);
    blocks.push(makeBlock(prev));
  }
  return blocks;
}

async function digestHex(sortedHashes) {
  const bytes = new Uint8Array(sortedHashes.length * 32);
  sortedHashes.forEach((h, i) => bytes.set(hex.decode(h), i * 32));
  return hex.encode(new Uint8Array(await globalThis.crypto.subtle.digest('SHA-256', bytes)));
}

// Independent reference: blocks are in creation order, which is topological.
async function reference(blocks) {
  const depth = new Map();
  const hasChild = new Set();
  for (const b of blocks) {
    let d = 0;
    for (const p of b.e.prev) {
      d = Math.max(d, depth.get(p) + 1);
      hasChild.add(p);
    }
    depth.set(b.h, d);
  }
  const order = blocks.map((b) => b.h).sort((a, b) => (depth.get(a) - depth.get(b)) || (a < b ? -1 : 1));
  const heads = blocks.map((b) => b.h).filter((h) => !hasChild.has(h))
    .sort((a, b) => (depth.get(b) - depth.get(a)) || (a < b ? -1 : 1));
  const maxDepth = Math.max(-1, ...depth.values());
  const windows = [];
  for (let k = 0; k <= Math.floor(maxDepth / WINDOW_SIZE); k++) {
    const hs = blocks.map((b) => b.h).filter((h) => Math.floor(depth.get(h) / WINDOW_SIZE) === k).sort();
    windows.push({ k, dg: await digestHex(hs), n: hs.length });
  }
  return { depth, order, heads, root: await digestHex(blocks.map((b) => b.h).sort()), windows, maxDepth };
}

test('1 000 random shuffles of a 60-block concurrent DAG give identical order(), root(), heads(), windows()', async () => {
  const rand = mulberry32(0xda6);
  const blocks = randomDag(rand, 60);
  const ref = await reference(blocks);
  const depths = new Set(ref.depth.values());
  assert.ok(depths.size < 60, 'the DAG is concurrent: several blocks share a depth');
  let orphansSeen = 0;
  for (let iter = 0; iter < 1000; iter++) {
    const dag = new Dag();
    const order = shuffle(rand, blocks);
    order.forEach((b, i) => {
      const r = dag.add(b, 'peer' + (i % 3));
      if (r === 'orphan') orphansSeen++;
      else assert.equal(r, 'added');
    });
    assert.equal(dag.size, 60);
    assert.equal(dag.orphanCount, 0);
    assert.deepEqual(dag.missing(), []);
    assert.deepEqual(dag.order().map((b) => b.h), ref.order);
    assert.equal(dag.root(), ref.root);
    assert.deepEqual(dag.heads({ limit: Infinity }), ref.heads);
    assert.deepEqual(dag.windows(), ref.windows);
    assert.equal(dag.maxDepth(), ref.maxDepth);
    if (iter % 50 === 0) for (const b of blocks) assert.equal(dag.depth(b.h), ref.depth.get(b.h));
  }
  assert.ok(orphansSeen > 1000, 'shuffled arrival exercised the orphan pool');
});

test('depth, heads (limit, ordering), maxDepth, ancestors on small shapes', () => {
  const dag = new Dag();
  assert.equal(dag.maxDepth(), -1);
  assert.deepEqual(dag.heads(), []);
  assert.deepEqual(dag.order(), []);
  assert.deepEqual(dag.windows(), []);
  assert.equal(dag.root(), 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855', 'sha256 of nothing');
  const a = makeBlock([]);
  const b = makeBlock([a.h]);
  const c = makeBlock([a.h]);
  const d = makeBlock([b.h, c.h]);
  const r2 = makeBlock([]);
  for (const x of [a, b, c, d, r2]) assert.equal(dag.add(x), 'added');
  assert.equal(dag.depth(a.h), 0);
  assert.equal(dag.depth(b.h), 1);
  assert.equal(dag.depth(c.h), 1);
  assert.equal(dag.depth(d.h), 2);
  assert.equal(dag.depth(r2.h), 0);
  assert.equal(dag.depth('f'.repeat(64)), undefined);
  assert.equal(dag.maxDepth(), 2);
  assert.deepEqual(dag.heads(), [d.h, r2.h], 'depth desc');
  assert.deepEqual(dag.heads({ limit: 1 }), [d.h]);
  assert.deepEqual(dag.heads({ limit: 0 }), []);
  assert.deepEqual([...dag.ancestors(d.h)].sort(), [a.h, b.h, c.h].sort());
  assert.deepEqual([...dag.ancestors(a.h)], []);
  assert.deepEqual([...dag.ancestors('0'.repeat(64))], []);
  const anc = dag.ancestors(d.h);
  anc.clear();
  assert.equal(dag.ancestors(d.h).size, 3, 'a fresh Set every call');
  assert.equal(dag.add(b), 'duplicate');
  assert.deepEqual(dag.lastAdded, []);
  assert.equal(dag.has(d.h), true);
  assert.equal(dag.get(d.h), d);
  assert.deepEqual(Array.from(dag.blocks()).map((x) => x.h), [a.h, b.h, c.h, d.h, r2.h]);
  // order() is cached but hands out copies.
  const o1 = dag.order();
  o1.reverse();
  assert.deepEqual(dag.order().map((x) => x.h), [a.h, r2.h].sort().concat([b.h, c.h].sort(), [d.h]));
  const v = dag.version;
  dag.add(makeBlock([d.h]));
  assert.equal(dag.version, v + 1);
  assert.equal(dag.order().length, 6);
});

test('heads stay bounded by the limit and sorted (depth desc, h asc) with many concurrent heads', () => {
  const dag = new Dag();
  const root = makeBlock([]);
  dag.add(root);
  const kids = [];
  for (let i = 0; i < 300; i++) {
    const k = makeBlock([root.h]);
    kids.push(k);
    dag.add(k);
  }
  const deep = makeBlock([kids[0].h]);
  dag.add(deep);
  const heads = dag.heads();
  assert.equal(heads.length, 32);
  assert.equal(heads[0], deep.h);
  const rest = kids.slice(1).map((k) => k.h).sort();
  assert.deepEqual(heads.slice(1), rest.slice(0, 31));
  assert.equal(dag.heads({ limit: Infinity }).length, 300);
});

test('depth windows: 64-level windows with stable digests over raw hash bytes', async () => {
  const rand = mulberry32(64);
  // About 230 depth levels with some width: 4 windows.
  const blocks = [makeBlock([])];
  for (let i = 0; i < 400; i++) {
    const tip = blocks[blocks.length - 1];
    const side = blocks[Math.max(0, blocks.length - 1 - Math.floor(rand() * 4))];
    blocks.push(makeBlock(rand() < 0.6 ? [tip.h] : [side.h]));
  }
  const ref = await reference(blocks);
  const expectedWindows = Math.floor(ref.maxDepth / WINDOW_SIZE) + 1;
  assert.ok(expectedWindows >= 3);
  let first = null;
  for (let iter = 0; iter < 30; iter++) {
    const dag = new Dag({ maxOrphansPerPeer: 1000 });
    for (const b of shuffle(rand, blocks)) dag.add(b);
    const w = dag.windows();
    assert.equal(w.length, expectedWindows);
    assert.deepEqual(w, ref.windows);
    assert.equal(w.reduce((n, x) => n + x.n, 0), blocks.length);
    for (const { k } of w) {
      const hs = dag.hashesInWindow(k);
      assert.deepEqual(hs, [...hs].sort());
      assert.equal(await digestHex(hs), w[k].dg);
      for (const h of hs) assert.equal(Math.floor(dag.depth(h) / WINDOW_SIZE), k);
    }
    if (first === null) first = dag;
  }
  const copy = first.hashesInWindow(0);
  copy.length = 0;
  assert.ok(first.hashesInWindow(0).length > 0, 'hashesInWindow returns a copy');
  assert.deepEqual(first.hashesInWindow(99), []);
  // Adding a block changes only its own window's digest.
  const before = first.windows();
  const tipHash = first.heads()[0];
  first.add(makeBlock([tipHash]));
  const after = first.windows();
  const k = Math.floor(first.maxDepth() / WINDOW_SIZE);
  for (const w of before) if (w.k !== k) assert.deepEqual(after[w.k], w);
  assert.notEqual(after[k].dg, before[k] ? before[k].dg : null);
});

test('orphans: backfill when parents arrive, chains, lastAdded, onAdd, missing(), orphanSender()', () => {
  const seen = [];
  const dag = new Dag({ onAdd: (block, peer) => seen.push([block.h, peer]) });
  const a = makeBlock([]);
  const b = makeBlock([a.h]);
  const c = makeBlock([b.h]);
  const x = makeBlock([a.h, c.h]);
  assert.equal(dag.add(c, 'p1'), 'orphan');
  assert.equal(dag.add(x, 'p2'), 'orphan');
  assert.equal(dag.add(b, 'p3'), 'orphan');
  assert.equal(dag.add(c, 'p9'), 'duplicate', 'already pooled');
  assert.equal(dag.orphanCount, 3);
  assert.equal(dag.size, 0);
  assert.equal(dag.hasOrphan(c.h), true);
  assert.equal(dag.has(c.h), false);
  assert.deepEqual(dag.missing(), [a.h], 'pooled orphans are not reported missing');
  assert.equal(dag.orphanSender(c.h), 'p1');
  assert.equal(dag.orphanSender(b.h), 'p3');
  assert.ok(['p2', 'p3'].includes(dag.orphanSender(a.h)), 'a missing parent maps to a waiting orphan sender');
  assert.equal(dag.orphanSender('0'.repeat(64)), null);
  assert.equal(dag.add(a, 'p4'), 'added');
  assert.deepEqual(dag.lastAdded, [a.h, b.h, c.h, x.h]);
  assert.deepEqual(seen, [[a.h, 'p4'], [b.h, 'p3'], [c.h, 'p1'], [x.h, 'p2']]);
  assert.equal(dag.orphanCount, 0);
  assert.deepEqual(dag.missing(), []);
  assert.equal(dag.depth(x.h), 3);
  // A throwing hook does not break insertion.
  const d2 = new Dag({ onAdd: () => { throw new Error('hook bug'); } });
  d2.add(b);
  assert.equal(d2.add(a), 'added');
  assert.deepEqual(d2.lastAdded, [a.h, b.h]);
  assert.throws(() => dag.add({ h: 'nope' }), TypeError);
  assert.throws(() => dag.add(null), TypeError);
  const self = makeBlock([]);
  assert.throws(() => dag.add({ ...self, e: { ...self.e, prev: [self.h] } }), TypeError, 'a block cannot be its own parent');
});

test('orphan pool caps: 256 per peer, 2 000 in total, oldest evicted; dropOrphansFrom', () => {
  assert.equal(MAX_ORPHANS_PER_PEER, 256);
  assert.equal(MAX_ORPHANS, 2000);
  const parentOf = () => makeBlock([]); // never added: each orphan waits on its own parent
  const dag = new Dag();
  const fromP1 = [];
  const parents = [];
  for (let i = 0; i < 300; i++) {
    const p = parentOf();
    parents.push(p);
    const o = makeBlock([p.h]);
    fromP1.push(o);
    assert.equal(dag.add(o, 'p1'), 'orphan');
  }
  assert.equal(dag.orphanCount, 256);
  for (let i = 0; i < 44; i++) assert.equal(dag.hasOrphan(fromP1[i].h), false, 'oldest evicted');
  for (let i = 44; i < 300; i++) assert.equal(dag.hasOrphan(fromP1[i].h), true);
  assert.equal(dag.missing().length, 256, 'evicted orphans no longer ask for parents');
  // An evicted orphan's parent arriving inserts nothing more; re-sending the orphan works.
  assert.equal(dag.add(parents[0], 'p1'), 'added');
  assert.deepEqual(dag.lastAdded, [parents[0].h]);
  assert.equal(dag.add(fromP1[0], 'p1'), 'added');
  assert.equal(dag.add(parents[100], 'p2'), 'added');
  assert.deepEqual(dag.lastAdded, [parents[100].h, fromP1[100].h]);

  const total = new Dag();
  const first = [];
  for (let peer = 0; peer < 8; peer++) {
    for (let i = 0; i < 250; i++) {
      const o = makeBlock([parentOf().h]);
      if (i === 0) first.push(o);
      total.add(o, 'q' + peer);
    }
  }
  assert.equal(total.orphanCount, 2000);
  const extra = makeBlock([parentOf().h]);
  assert.equal(total.add(extra, 'q8'), 'orphan');
  assert.equal(total.orphanCount, 2000);
  assert.equal(total.hasOrphan(first[0].h), false, 'globally oldest evicted');
  assert.equal(total.hasOrphan(first[1].h), true);
  assert.equal(total.hasOrphan(extra.h), true);
  assert.equal(total.dropOrphansFrom('q1'), 250);
  assert.equal(total.orphanCount, 1750);
  assert.equal(total.dropOrphansFrom('q1'), 0);
  assert.equal(total.dropOrphansFrom('nobody'), 0);
  assert.equal(total.missing().length, 1750);

  const small = new Dag({ maxOrphansPerPeer: 2, maxOrphans: 3 });
  const s = [];
  for (let i = 0; i < 3; i++) s.push(makeBlock([parentOf().h]));
  s.forEach((o) => small.add(o, 'x'));
  assert.equal(small.orphanCount, 2);
  assert.equal(small.hasOrphan(s[0].h), false);
  small.add(makeBlock([parentOf().h]), 'y');
  small.add(makeBlock([parentOf().h]), 'z');
  assert.equal(small.orphanCount, 3);
  const none = new Dag({ maxOrphans: 0 });
  assert.equal(none.add(makeBlock([parentOf().h]), 'x'), 'orphan');
  assert.equal(none.orphanCount, 0, 'a zero cap stores nothing');
});

test('a 20 000-block chain: depth and ancestors without recursion, in order and in reverse', () => {
  const chain = [makeBlock([])];
  for (let i = 1; i < 20000; i++) chain.push(makeBlock([chain[i - 1].h]));
  const tip = chain[chain.length - 1];
  const forward = new Dag();
  for (const b of chain) forward.add(b);
  assert.equal(forward.depth(tip.h), 19999);
  assert.equal(forward.ancestors(tip.h).size, 19999);
  assert.equal(forward.order()[19999].h, tip.h);
  assert.equal(forward.windows().length, Math.ceil(20000 / WINDOW_SIZE));
  const reverse = new Dag({ maxOrphansPerPeer: 30000, maxOrphans: 30000 });
  for (let i = chain.length - 1; i > 0; i--) assert.equal(reverse.add(chain[i], 'p'), 'orphan');
  assert.equal(reverse.orphanCount, 19999);
  assert.equal(reverse.add(chain[0], 'p'), 'added');
  assert.equal(reverse.lastAdded.length, 20000);
  assert.equal(reverse.orphanCount, 0);
  assert.equal(reverse.root(), forward.root());
  assert.equal(reverse.depth(tip.h), 19999);
});

test('byte accounting, redact() and attachValue()', () => {
  const dag = new Dag();
  const a = makeBlock([], { value: { text: 'hello world' } });
  const b = makeBlock([a.h], { value: 'x'.repeat(500) });
  const pol = makeBlock([a.h], { op: { t: 'policy', writers: 'open' } });
  for (const x of [a, b, pol]) dag.add(x);
  assert.equal(dag.bytes, blockBytes(a) + blockBytes(b) + blockBytes(pol));
  assert.equal(dag.valueBytes(b.h), byteLength(canonicalize(b.v)));
  assert.equal(dag.valueBytes(pol.h), 0);
  const root = dag.root();
  const v0 = dag.version;
  assert.equal(dag.redact(b.h), true);
  assert.equal(dag.get(b.h).v, undefined);
  assert.equal(b.v, 'x'.repeat(500), 'the caller-owned block object is not mutated');
  assert.equal(dag.bytes, blockBytes(a) + byteLength(canonicalize(b.e)) + blockBytes(pol));
  assert.equal(dag.valueBytes(b.h), 0);
  assert.equal(dag.redact(b.h), false, 'nothing left to drop');
  assert.equal(dag.redact(pol.h), false, 'control blocks hold no value');
  assert.equal(dag.root(), root, 'redaction does not change the hash set');
  assert.ok(dag.version > v0);
  assert.equal(dag.order().find((x) => x.h === b.h).v, undefined, 'order() reflects the redacted copy');
  assert.equal(dag.get(b.h).z, undefined, 'the salt goes with the value (A1)');
  assert.equal(dag.attachValue(b.h, 'y'.repeat(500), b.z), false, 'the value must match vh');
  assert.equal(dag.attachValue(b.h, 'x'.repeat(500)), false, 'no salt, no value');
  assert.equal(dag.attachValue(b.h, 'x'.repeat(500), 'A'.repeat(22)), false, 'the salt is part of vh');
  assert.equal(dag.attachValue(b.h, 'x'.repeat(500), 'short'), false);
  assert.equal(dag.attachValue(pol.h, 1, b.z), false);
  assert.equal(dag.attachValue(a.h, a.v, a.z), false, 'already holds its value');
  assert.equal(dag.attachValue(b.h, 'x'.repeat(500), b.z), true);
  assert.equal(dag.get(b.h).v, 'x'.repeat(500));
  assert.equal(dag.get(b.h).z, b.z);
  assert.equal(dag.bytes, blockBytes(a) + blockBytes(b) + blockBytes(pol));
  assert.equal(dag.valueBytes(b.h), byteLength(canonicalize(b.v)), 'valueBytes is canonical(v) alone (the maxValueBytes rule)');
  assert.equal(dag.attachValue('0'.repeat(64), 1, b.z), false);
});
