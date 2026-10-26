// Unit tests for src/chat/replay.js (R 2.7.4, MF-36): U-CH-5 (replay window, persisted Bloom filter,
// day - 1 to day + 1, counter gaps).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ReplayGuard } from '../../src/chat/replay.js';
import { listenDays } from '../../src/chat/tags.js';
import { REPLAY_PAST_MS, REPLAY_FUTURE_MS, DAY_MS } from '../../src/chat/limits.js';

const T0 = 20381 * DAY_MS + 12 * 3600000;

function id(n) {
  const u = new Uint8Array(16);
  new DataView(u.buffer).setUint32(0, n);
  return u;
}

function memStore() {
  const m = new Map();
  return {
    m,
    async get(k) { return m.has(k) ? JSON.parse(JSON.stringify(m.get(k))) : undefined; },
    async set(k, v) { m.set(k, JSON.parse(JSON.stringify(v))); },
  };
}

test('U-CH-5: the window is [now - 7 d - 5 min, now + 5 min], edges included', () => {
  const g = new ReplayGuard({ now: () => T0 });
  assert.equal(REPLAY_PAST_MS, 7 * DAY_MS + 300000);
  assert.equal(REPLAY_FUTURE_MS, 300000);
  assert.equal(g.accept('s', { id: id(1), t: T0 - REPLAY_PAST_MS }).ok, true);
  assert.equal(g.accept('s', { id: id(2), t: T0 - REPLAY_PAST_MS - 1 }).reason, 'window');
  assert.equal(g.accept('s', { id: id(3), t: T0 + REPLAY_FUTURE_MS }).ok, true);
  assert.equal(g.accept('s', { id: id(4), t: T0 + REPLAY_FUTURE_MS + 1 }).reason, 'window');
  for (const t of [-1, 0, Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER + 2, 1.5, NaN, '1']) {
    assert.equal(g.accept('s', { id: id(9), t }).reason, 'window', String(t));
  }
});

test('U-CH-5: a replay is refused, a new message older than the high-water mark is accepted', () => {
  const g = new ReplayGuard({ now: () => T0 });
  assert.equal(g.accept('alice', { id: id(1), t: T0 }).ok, true);
  assert.equal(g.accept('alice', { id: id(1), t: T0 }).reason, 'replay');
  assert.equal(g.accept('alice', { id: id(2), t: T0 - 60000 }).ok, true, 'late but new');
  assert.equal(g.accept('alice', { id: id(2), t: T0 - 60000 }).reason, 'replay');
  assert.equal(g.accept('bob', { id: id(1), t: T0 }).ok, true, 'ids are per sender');
  assert.equal(g.check('alice', { id: id(1), t: T0 }).reason, 'replay');
  assert.equal(g.check('alice', { id: id(3), t: T0 }).ok, true, 'check() does not record');
  assert.equal(g.check('alice', { id: id(3), t: T0 }).ok, true);
});

test('U-CH-5: the Bloom filter and high-water marks survive a reload through the sealed store', async () => {
  const store = memStore();
  let now = T0;
  const g1 = new ReplayGuard({ store, now: () => now });
  for (let i = 0; i < 100; i++) assert.equal(g1.accept('alice', { id: id(i), t: T0 - i * 3600000 }).ok, true);
  assert.equal(await g1.save(), true);
  assert.equal(await g1.save(), false, 'nothing new to save');
  const g2 = new ReplayGuard({ store, now: () => now });
  assert.equal(await g2.load(), true);
  for (let i = 0; i < 100; i++) assert.equal(g2.accept('alice', { id: id(i), t: T0 - i * 3600000 }).reason, 'replay', 'id ' + i);
  assert.equal(g2.accept('alice', { id: id(1000), t: T0 }).ok, true);
  // Eight days later the old filters are gone and the old messages are outside the window anyway.
  now = T0 + 8 * DAY_MS;
  const g3 = new ReplayGuard({ store, now: () => now });
  await g3.load();
  assert.equal(g3.accept('alice', { id: id(0), t: T0 }).reason, 'window');
  // A malformed stored value is ignored.
  const bad = memStore();
  await bad.set('mw-chat-replay', { v: 2 });
  assert.equal(await new ReplayGuard({ store: bad }).load(), false);
  await bad.set('mw-chat-replay', { v: 1, days: { 1: 'not base64!' } });
  assert.equal(await new ReplayGuard({ store: bad }).load(), false);
  assert.equal(await new ReplayGuard({}).load(), false);
});

test('U-CH-5: false positives stay rare at the stated load (6,800 ids a day, about 1 percent)', () => {
  const g = new ReplayGuard({ now: () => T0 });
  for (let i = 0; i < 6800; i++) g.accept('s', { id: id(i), t: T0 - 1000 - (i % 1000) });
  let fp = 0;
  for (let i = 100000; i < 102000; i++) if (g.check('s', { id: id(i), t: T0 - 5000 }).reason === 'replay') fp++;
  assert.ok(fp < 60, 'false positives ' + fp + ' of 2,000');
});

test('U-CH-5: recipients listen on day - 1, day and day + 1', () => {
  assert.deepEqual(listenDays(20381), [20380, 20381, 20382]);
});

test('U-CH-5: per-conversation counters report gaps ("Earlier messages may still arrive")', () => {
  const g = new ReplayGuard({ now: () => T0 });
  assert.equal(g.accept('a', { id: id(1), t: T0, n: 0, conv: 'c' }).gap, false);
  assert.equal(g.accept('a', { id: id(2), t: T0, n: 1, conv: 'c' }).gap, false);
  assert.equal(g.accept('a', { id: id(4), t: T0, n: 3, conv: 'c' }).gap, true, 'n = 2 missing');
  assert.equal(g.accept('a', { id: id(3), t: T0, n: 2, conv: 'c' }).gap, false, 'filled');
  assert.equal(g.accept('b', { id: id(9), t: T0, n: 5, conv: 'd' }).gap, true, 'a conversation seen from n = 5 misses 0 to 4');
  assert.equal(g.gap('c'), false);
  assert.equal(g.gap('nobody'), false);
});

// ---------------------------------------------------------------------------------------------------------------------------
// Review round (R 5.3, 2026-10-24; DS-6, SYB-6)
// ---------------------------------------------------------------------------------------------------------------------------

test('review round (DS-6, SYB-6): a flooder fills nothing for others: first messages of new senders always pass; the flooder is capped', () => {
  const g = new ReplayGuard({ now: () => T0 });
  let accepted = 0;
  let capped = 0;
  for (let i = 0; i < 40000; i++) {
    const r = g.accept('g|flooder', { id: id(i), t: T0 - 1000 + (i % 1000) });
    if (r.ok) accepted++;
    else if (r.reason === 'sender-cap') capped++;
  }
  assert.equal(accepted, 5000, 'one sender adds at most 5,000 ids a day');
  assert.equal(capped, 35000);
  for (let s = 0; s < 1000; s++) {
    assert.equal(g.accept('new' + s, { id: id(1000000 + s), t: T0 - 5000 }).ok, true, 'a new sender\'s first message');
  }
});

test('review round (DS-6): an older message with a known counter is decided by the counter, not the shared filter', () => {
  const g = new ReplayGuard({ now: () => T0 });
  // Saturate the day's filter with many senders (each under its cap).
  for (let s = 0; s < 40; s++) for (let i = 0; i < 1500; i++) g.accept('s' + s, { id: id(s * 100000 + i), t: T0 - 100 });
  const bits = g.days.get(Math.floor(T0 / DAY_MS));
  let set = 0;
  for (const b of bits) for (let k = 0; k < 8; k++) if (b & (1 << k)) set++;
  assert.ok(set / (bits.length * 8) > 0.9, 'the filter is nearly full');
  // Bo sends n = 0, 1, 2 out of order: n = 1 arrives after n = 2 and is older than Bo's high-water mark.
  assert.equal(g.accept('bo', { id: id(9000000), t: T0 - 10, n: 0, conv: 'bo' }).ok, true);
  assert.equal(g.accept('bo', { id: id(9000002), t: T0 - 5, n: 2, conv: 'bo' }).ok, true);
  assert.equal(g.accept('bo', { id: id(9000001), t: T0 - 8, n: 1, conv: 'bo' }).ok, true, 'not dropped as a Bloom false positive');
  assert.equal(g.accept('bo', { id: id(9000001), t: T0 - 8, n: 1, conv: 'bo' }).reason, 'replay', 'the real replay is still refused');
});

test('review round (DS-6): a sender pushed out of the high-water map is checked against the filter again (floor)', async () => {
  const store = memStore();
  const g = new ReplayGuard({ now: () => T0, store });
  g.accept('old', { id: id(1), t: T0 - 1000 });
  g.floor = T0 - 500; // as if 'old' and newer senders had been evicted
  g.high.delete('old');
  assert.equal(g.check('old', { id: id(1), t: T0 - 1000 }).reason, 'replay');
  await g.save();
  const g2 = new ReplayGuard({ now: () => T0, store });
  await g2.load();
  assert.equal(g2.floor, T0 - 500, 'the floor is kept with the filter');
});
