// Unit tests for src/chat/lane.js and tags.js routing (R 2.7.1, 2.7.3, 2.7.5, 2.7.9; MF-32, MF-33, MF-39):
// U-CH-4 (WANT-TAGS never holds a publicly computable tag), phones relay nothing, decrypt and relay budgets,
// fair queues, hop limits, the day rule, the seen-set, interest routing and the separate lane.
// Lanes talk over in-memory wires; the lanes' timers run on a fake clock.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { hex } from '../../src/chain/canonical.js';
import { publicKeyBytes } from '../../src/chain/crypto.js';
import { ChatLane, chatLaneInfoHash, relayBudget } from '../../src/chat/lane.js';
import { T, encode, envBody, frameId, withHop, withNonce, decode } from '../../src/chat/frames.js';
import { generateChatKey, pairKey } from '../../src/chat/seal.js';
import { buildWant, inboxTag, contactTag, tagKey } from '../../src/chat/tags.js';
import { stampWork, headerDay } from '../../src/chat/stamp.js';
import { DAY_MS, DECRYPT_PER_WIRE_PER_S, DECRYPT_PER_TAG_PER_S, RELAY_BYTES_PER_S_DESKTOP } from '../../src/chat/limits.js';

const LEDGER = 'mw1:routingLedger';
const T0 = 20381 * DAY_MS + 12 * 3600000;

function fakeClock(start = T0) {
  let t = start;
  let seq = 0;
  const q = [];
  return {
    now: () => t,
    setTimeout: (fn, ms) => {
      const h = { at: t + Math.max(0, ms || 0), fn, seq: seq++ };
      q.push(h);
      return h;
    },
    clearTimeout: (h) => {
      const i = q.indexOf(h);
      if (i >= 0) q.splice(i, 1);
    },
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
  };
}

async function settle(rounds = 4) {
  for (let i = 0; i < rounds; i++) await new Promise((r) => setTimeout(r, 1));
}

async function waitFor(pred, ms = 3000) {
  const end = Date.now() + ms;
  while (!pred()) {
    if (Date.now() > end) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 2));
  }
}

let wireN = 0;
function link(a, b, swarm = 'rendezvous') {
  const ia = 'w' + (++wireN);
  const ib = 'w' + (++wireN);
  a.attachWire({ id: ia, swarm, send: (u8) => { setImmediate(() => b.onMessage(ib, new Uint8Array(u8))); return true; }, close: () => setImmediate(() => b.detachWire(ib)) });
  b.attachWire({ id: ib, swarm, send: (u8) => { setImmediate(() => a.onMessage(ia, new Uint8Array(u8))); return true; }, close: () => setImmediate(() => a.detachWire(ia)) });
  return [ia, ib];
}

async function makeLane(clock, opts = {}) {
  const chatKey = await generateChatKey();
  const lane = new ChatLane(Object.assign({
    ledgerId: LEDGER, chatKey, hello: { site: LEDGER }, now: clock.now, setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout,
  }, opts));
  lane.enable();
  lane.envelopes = [];
  lane.on('envelope', (e) => lane.envelopes.push(e));
  return lane;
}

async function connected(...pairs) {
  for (const [a, b] of pairs) link(a, b);
  await waitFor(() => pairs.every(([a, b]) => a.neighbourOf(b.chatKey.pub) && b.neighbourOf(a.chatKey.pub)));
}

let POINT;
async function envFrame(lane, tag, { flags = 0, size = 272 } = {}) {
  if (!POINT) POINT = publicKeyBytes((await generateChatKey()).pub);
  const ct = new Uint8Array(size);
  globalThis.crypto.getRandomValues(ct);
  return lane.stamped(T.ENV, { flags, body: envBody({ tag, epk: POINT, iv: new Uint8Array(12), ct }) });
}

const TAG = Uint8Array.of(0xab, 1, 2, 3, 4, 5, 6, 7);

test('U-CH-4: WANT-TAGS never holds a publicly computable tag (inbox tags are refused, prefixes come with decoys)', async () => {
  const me = await generateChatKey();
  const peer = await generateChatKey();
  const k = await pairKey(me, peer.pub, LEDGER);
  const ctag = await contactTag(k, 20381);
  const itag = await inboxTag(me.pub, 20381);
  for (let run = 0; run < 50; run++) {
    const entries = buildWant([{ tag: ctag, kind: 'contact' }, { tag: itag, kind: 'inbox' }], { decoys: 4 });
    assert.ok(entries.every((e) => e.length === 1), 'prefixes only');
    assert.ok(entries.length >= 5 && entries.length <= 32);
    assert.ok(entries.some((e) => e[0] === ctag[0]), 'the contact prefix is there');
    assert.ok(!entries.some((e) => e.length === 8 && tagKey(e) === tagKey(itag)));
    const onlyInbox = buildWant([{ tag: itag, kind: 'inbox' }], { decoys: 4 });
    assert.equal(onlyInbox.length, 4, 'an inbox tag adds nothing: only the 4 decoys go out');
    const full = buildWant([{ tag: ctag, kind: 'contact' }, { tag: itag, kind: 'inbox' }, { tag: itag, kind: 'unknown' }], { holderChosen: true });
    assert.deepEqual(full.map(tagKey), [tagKey(ctag)], 'full tags only to a chosen holder, and never the inbox tag');
  }
  // At the lane: the WANT a neighbour receives carries exactly those entries.
  const clock = fakeClock();
  const a = await makeLane(clock);
  const b = await makeLane(clock);
  await connected([a, b]);
  const seen = [];
  const orig = b._onWant.bind(b);
  b._onWant = (w, d) => { seen.push(d.fields); return orig(w, d); };
  const entries = buildWant([{ tag: ctag, kind: 'contact' }, { tag: itag, kind: 'inbox' }]);
  assert.ok(a.sendWant(entries));
  await waitFor(() => seen.length === 1);
  assert.equal(seen[0].mode, 'prefix');
  assert.deepEqual(seen[0].entries.map((e) => e[0]).sort(), entries.map((e) => e[0]).sort());
  a.disable();
  b.disable();
});

test('handshake: HELLO then Noise XX on every wire; each side learns the other chat key; another site is refused', async () => {
  const clock = fakeClock();
  const a = await makeLane(clock);
  const b = await makeLane(clock);
  await connected([a, b]);
  assert.equal(a.peers()[0].remote, b.chatKey.pub);
  assert.equal(b.peers()[0].remote, a.chatKey.pub);
  const other = await makeLane(clock, { hello: { site: 'mw1:otherSite' } });
  const [ia] = link(a, other);
  await waitFor(() => !a.wires.has(ia));
  a.disable();
  b.disable();
  other.disable();
});

async function lineOf(clock, middleOpts) {
  const a = await makeLane(clock);
  const b = await makeLane(clock, middleOpts);
  const c = await makeLane(clock);
  await connected([a, b], [b, c]);
  c.setInterest((tag) => tagKey(tag) === tagKey(TAG));
  return { a, b, c, stop: () => { a.disable(); b.disable(); c.disable(); } };
}

test('relay: a desktop relays after the 0.5 to 3 s jitter; phones relay nothing (iOS never, Android only after "Share on this network")', async () => {
  assert.equal(relayBudget('ios', { shareOnNetwork: true }), null);
  assert.equal(relayBudget('android', {}), null);
  assert.equal(relayBudget('android', { shareOnNetwork: true }).rate, 8192);
  assert.equal(relayBudget('desktop').rate, RELAY_BYTES_PER_S_DESKTOP);
  for (const [opts, expect] of [
    [{ deviceClass: 'desktop' }, 1],
    [{ deviceClass: 'ios', policy: { shareOnNetwork: true } }, 0],
    [{ deviceClass: 'android' }, 0],
    [{ deviceClass: 'android', policy: { shareOnNetwork: true } }, 1],
  ]) {
    const clock = fakeClock();
    const net = await lineOf(clock, opts);
    const f = await envFrame(net.a, TAG);
    const r = net.a.send(f, { tag: TAG });
    assert.equal(r.route, 'flood');
    await clock.advance(400);
    assert.equal(net.c.envelopes.length, 0, 'nothing before the jitter');
    await clock.advance(3000);
    assert.equal(net.c.envelopes.length, expect, JSON.stringify(opts));
    // Own frames leave at a random hop of 0 to 2 (review round, PRIV-1); B adds one.
    if (expect) {
      const hop = decode(net.c.envelopes[0].bytes).header.hop;
      assert.ok(hop >= 1 && hop <= 3, 'hop ' + hop);
    }
    net.stop();
  }
});

test('relay checks: hop limit 4, the day rule, a stamp below its bits is a strike, the seen-set drops duplicates', async () => {
  const clock = fakeClock();
  const net = await lineOf(clock, {});
  const strikes = [];
  net.b.on('strike', (s) => strikes.push(s));
  // hop 4 reaches B (B could read it) but is not relayed (sent as written: send() would pick its own hop).
  const toB = net.a.peers()[0].id;
  const f4 = withHop(await envFrame(net.a, TAG), 4);
  net.a.sendTo(toB, f4);
  await clock.advance(4000);
  assert.equal(net.c.envelopes.length, 0);
  // A frame dated two days ago is dropped without a strike.
  const old = await net.a.stamped(T.ENV, { day: headerDay(T0 - 2 * DAY_MS), body: envBody({ tag: TAG, epk: POINT, iv: new Uint8Array(12), ct: new Uint8Array(272) }) });
  net.a.sendTo(toB, old);
  await clock.advance(4000);
  assert.equal(net.c.envelopes.length, 0);
  assert.equal(strikes.length, 0);
  assert.ok(net.b.stats.dayDropped >= 1);
  // A frame whose stamp does not meet 10 bits is a strike against the wire.
  let bad = await envFrame(net.a, Uint8Array.of(1, 1, 1, 1, 1, 1, 1, 1));
  for (let n = 0; n < 4096; n++) {
    const nonce = new Uint8Array(8);
    new DataView(nonce.buffer).setUint32(4, n);
    if (stampWork(frameId(bad), nonce) < 10) { bad = withNonce(bad, nonce); break; }
  }
  net.a.sendTo(toB, bad);
  await waitFor(() => strikes.length === 1);
  assert.equal(strikes[0].reason, 'stamp');
  // The same frame twice: C sees it once.
  const f = await envFrame(net.a, TAG);
  net.a.send(f, {});
  net.a.seen.map.clear();
  net.a.send(f, {});
  await clock.advance(4000);
  assert.equal(net.c.envelopes.length, 1);
  assert.ok(net.b.stats.dropped >= 1);
  net.stop();
});

test('decrypt budgets: at most 50 per wire per second and 200 per tag per second', async () => {
  const clock = fakeClock();
  const b = await makeLane(clock, { deviceClass: 'ios' });
  b.setInterest(() => true);
  const senders = [];
  for (let i = 0; i < 5; i++) senders.push(await makeLane(clock));
  await connected(...senders.map((s) => [s, b]));
  // One wire, 60 frames in one second: 50 reach the service.
  const s0 = senders[0];
  for (let i = 0; i < 60; i++) s0.send(await envFrame(s0, TAG), { to: b.chatKey.pub });
  await waitFor(() => b.stats.overBudget + b.envelopes.length >= 60);
  assert.equal(b.envelopes.length, DECRYPT_PER_WIRE_PER_S);
  // Next second, five wires and one tag, 50 each: the tag budget stops at 200.
  await clock.advance(1000);
  const before = b.envelopes.length;
  const over = b.stats.overBudget;
  for (const s of senders) for (let i = 0; i < 50; i++) s.send(await envFrame(s, TAG), { to: b.chatKey.pub });
  await waitFor(() => (b.envelopes.length - before) + (b.stats.overBudget - over) >= 250);
  assert.equal(b.envelopes.length - before, DECRYPT_PER_TAG_PER_S);
  b.disable();
  for (const s of senders) s.disable();
});

test('relay budget: at most 64 KiB/s per neighbour on desktop (bucket of one second), the rest drains later', async () => {
  const clock = fakeClock();
  const a1 = await makeLane(clock);
  const b = await makeLane(clock);
  const c = await makeLane(clock);
  await connected([a1, b], [b, c]);
  c.setInterest(() => true);
  const T1 = Uint8Array.of(1, 0, 0, 0, 0, 0, 0, 1);
  c.sendWant([Uint8Array.of(1)]); // route toward C so B forwards to C only
  await settle(8);
  const start = clock.now();
  for (let i = 0; i < 200; i++) a1.send(await envFrame(a1, T1, { size: 1040 }), {});
  await waitFor(() => b.seen.size >= 200);
  for (const at of [1000, 2000, 3001, 4000]) {
    await clock.advance(at - (clock.now() - start));
    await settle(6);
    const bytes = (c.envelopes.length + c.stats.overBudget) * 1139;
    const elapsed = (clock.now() - start) / 1000;
    assert.ok(bytes <= RELAY_BYTES_PER_S_DESKTOP * elapsed + 1139, at + ' ms: ' + c.envelopes.length + ' frames');
  }
  // C itself opens at most 50 a second from one wire (its decrypt budget); count what arrived either way.
  const arrived = () => c.envelopes.length + c.stats.overBudget;
  for (let i = 0; i < 6 && arrived() < 200; i++) await clock.advance(1000);
  assert.equal(arrived(), 200, 'everything drains at the budget');
  assert.equal(b.stats.relayed, 200);
  for (const l of [a1, b, c]) l.disable();
});

test('fair queues: frames to one neighbour are sent round robin over the neighbours that fed them', async () => {
  const clock = fakeClock();
  const lane = await makeLane(clock);
  const sent = [];
  const w = {
    id: 'dst', closed: false, session: { encrypt: async (x) => x }, handle: { send: (u8) => sent.push(u8[0]) },
    queues: new Map(), srcBytes: new Map(), rr: [], queueBytes: 0, tokens: 0, lastFill: clock.now(), sendChain: Promise.resolve(),
  };
  lane.wires.set('dst', w);
  const frame = (mark) => { const u = new Uint8Array(1139); u[0] = mark; return u; };
  for (let i = 0; i < 100; i++) lane._enqueue(w, 'busy', frame(1));
  for (let i = 0; i < 5; i++) lane._enqueue(w, 'quiet', frame(2));
  await clock.advance(200); // 0.2 s of budget: about 11 frames
  await settle(4);
  assert.ok(sent.length >= 10 && sent.length <= 12, sent.length + ' frames');
  const first10 = sent.slice(0, 10);
  assert.equal(first10.filter((m) => m === 2).length, 5, 'the quiet source is not stuck behind the busy one: ' + first10.join(''));
  lane.disable();
});

test('interest routing: after a WANT-TAGS prefix, frames go toward that neighbour and a random half of the others; the sender goes direct to a neighbour', async () => {
  const clock = fakeClock();
  const a = await makeLane(clock);
  const b = await makeLane(clock);
  const others = [];
  for (let i = 0; i < 4; i++) others.push(await makeLane(clock));
  await connected([a, b], ...others.map((o) => [b, o]));
  for (const o of others) o.setInterest(() => true);
  const target = others[0];
  target.sendWant([Uint8Array.of(TAG[0])]);
  await settle(8);
  a.send(await envFrame(a, TAG), {});
  await clock.advance(3500);
  assert.equal(target.envelopes.length, 1);
  // Review round (DS-1, MP-4, SYB-3): a route adds a path and never replaces the flood: 2 of the 3 others get it too.
  assert.equal(others.slice(1).reduce((n, o) => n + o.envelopes.length, 0), 2);
  // Without a route, B floods to a random half (2 of 4).
  const T3 = Uint8Array.of(0x33, 0, 0, 0, 0, 0, 0, 0);
  a.send(await envFrame(a, T3), {});
  await clock.advance(3500);
  const got = others.reduce((n, o) => n + o.envelopes.filter((e) => e.decoded.fields.tag[0] === 0x33).length, 0);
  assert.equal(got, 2);
  // A direct neighbour: one wire only.
  const r = a.send(await envFrame(a, TAG), { to: b.chatKey.pub });
  assert.equal(r.route, 'direct');
  assert.equal(r.reached, 1);
  for (const l of [a, b, ...others]) l.disable();
});

test('separate chat lane: joined only below 2 rendezvous neighbours, only through the site\'s own tracker', async () => {
  const clock = fakeClock();
  const calls = [];
  let left = 0;
  const tm = { joinLane: (o) => { calls.push(o); return { leave: () => { left++; } }; } };
  const a = await makeLane(clock, { torrentManager: tm, ownTracker: 'wss://tracker.example.test' });
  await settle(4);
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].announce, ['wss://tracker.example.test']);
  assert.equal(calls[0].kind, 'chat');
  assert.equal(calls[0].infoHash, await chatLaneInfoHash(LEDGER));
  assert.match(calls[0].infoHash, /^[0-9a-f]{40}$/);
  const b = await makeLane(clock);
  const c = await makeLane(clock);
  await connected([a, b], [a, c]);
  await settle(4);
  assert.equal(left, 1, 'left once two rendezvous neighbours speak mw_chat1');
  const noTracker = await makeLane(clock, { torrentManager: tm, ownTracker: null });
  await settle(4);
  assert.equal(calls.length, 1, 'never without the site\'s own tracker');
  for (const l of [a, b, c, noTracker]) l.disable();
});

test('sealed transport: after the handshake a frame injected in clear is a strike', async () => {
  const clock = fakeClock();
  const a = await makeLane(clock);
  const b = await makeLane(clock);
  const [ia, ib] = link(a, b);
  await waitFor(() => a.neighbourOf(b.chatKey.pub) && b.neighbourOf(a.chatKey.pub));
  const strikes = [];
  b.on('strike', (s) => strikes.push(s.reason));
  await b.onMessage(ib, await envFrame(a, TAG));
  assert.deepEqual(strikes, ['aead']);
  assert.equal(ia.length > 0, true);
  a.disable();
  b.disable();
});

// ---------------------------------------------------------------------------------------------------------------------------
// Review round (R 5.3, 2026-10-24; docs/deviations/review-round-chat.md)
// ---------------------------------------------------------------------------------------------------------------------------

function wireTo(lane, other) {
  const p = lane.peers().find((x) => x.remote === other.chatKey.pub);
  return p ? p.id : null;
}

test('review round (DS-1, MP-4, SYB-3): a neighbour that advertises all 256 prefixes is one more path, never the only one', async () => {
  const clock = fakeClock();
  const a = await makeLane(clock);
  const r = await makeLane(clock);
  const m = await makeLane(clock); // Mallory, a neighbour of both
  const x = await makeLane(clock); // the recipient, behind R only
  await connected([a, r], [a, m], [r, x], [r, m]);
  x.setInterest((tag) => tagKey(tag) === tagKey(TAG));
  m.setInterest(() => true);
  // Mallory claims every bucket on both wires: 8 WANT frames of 32 prefixes each.
  const { wantBody } = await import('../../src/chat/frames.js');
  for (const victim of [a, r]) {
    for (let k = 0; k < 8; k++) {
      const entries = [];
      for (let i = 0; i < 32; i++) entries.push(Uint8Array.of(k * 32 + i));
      m.sendTo(wireTo(m, victim), encode(T.WANT, { day: headerDay(clock.now()) }, wantBody(entries)));
    }
  }
  await settle(12);
  // Only Mallory's latest WANT counts for her wire: at most 32 buckets, not 256.
  let claimed = 0;
  for (const mp of a.prefixRoutes.values()) if (mp.has(wireTo(a, m))) claimed++;
  assert.ok(claimed <= 32, claimed + ' buckets claimed by one wire');
  // A frame whose bucket she claims still reaches R, and through R the recipient. (WANT frames over the per-wire budget
  // were dropped, so the claim is the one of the last WANT that got through.)
  let claim = null;
  for (const [byte, mp] of a.prefixRoutes) if (mp.has(wireTo(a, m))) claim = byte;
  assert.notEqual(claim, null);
  const bucket = Uint8Array.of(claim, 1, 2, 3, 4, 5, 6, 7);
  x.setInterest((tag) => tagKey(tag) === tagKey(bucket));
  const s = a.send(await envFrame(a, bucket), { tag: bucket });
  assert.equal(s.route, 'routed');
  assert.ok(s.reached >= 2, 'reached ' + s.reached + ': the routed wire and at least one more');
  await clock.advance(8000);
  assert.equal(x.envelopes.length, 1, 'the recipient behind the relay got the frame');
  for (const l of [a, r, m, x]) l.disable();
});

test('review round (MP-3, SYB-9, MP-8): WANT frames are rate-limited per wire; full-tag routes only at a holder, at most 16 per wire', async () => {
  const clock = fakeClock();
  const { wantBody } = await import('../../src/chat/frames.js');
  const { Holder } = await import('../../src/chat/holder.js');
  for (const holder of [null, new Holder({ now: clock.now })]) {
    const v = await makeLane(clock, { holder });
    const atk = await makeLane(clock);
    await connected([atk, v]);
    const w = wireTo(atk, v);
    for (let n = 0; n < 400; n++) {
      const entries = [];
      for (let i = 0; i < 32; i++) {
        const t = new Uint8Array(8);
        globalThis.crypto.getRandomValues(t);
        entries.push(t);
      }
      atk.sendTo(w, encode(T.WANT, { day: headerDay(clock.now()) }, wantBody(entries)));
    }
    await waitFor(() => v.peers().length === 0, 5000);
    assert.ok(v.tagRoutes.size <= 16, v.tagRoutes.size + ' full-tag routes');
    if (!holder) assert.equal(v.tagRoutes.size, 0, 'a lane that holds nothing keeps no full-tag routes');
    assert.ok(v.stats.rated >= 1, 'over-budget WANT frames are struck');
    assert.equal(v.peers().length, 0, 'the flooding wire is closed after 20 strikes');
    v.disable();
    atk.disable();
  }
});

test('review round (MP-8, SYB-10): CK, PRES and ICHAL frames have per-wire budgets; an honest rate passes', async () => {
  const clock = fakeClock();
  const { ckBody, presBody, ichalBody } = await import('../../src/chat/frames.js');
  const v = await makeLane(clock);
  const atk = await makeLane(clock);
  await connected([atk, v]);
  const got = { ck: 0, pres: 0, ichal: 0 };
  v.on('ck', () => { got.ck++; });
  v.on('pres', () => { got.pres++; });
  v.on('ichal', () => { got.ichal++; });
  const w = wireTo(atk, v);
  const day = headerDay(clock.now());
  const pres = encode(T.PRES, { day }, presBody({ mode: 0, slots: Array.from({ length: 8 }, () => new Uint8Array(8)), status: 1, auth: new Uint8Array(64) }));
  const ichal = encode(T.ICHAL, { day }, ichalBody({ challenge: new Uint8Array(32), hepk: publicKeyBytes((await generateChatKey()).pub) }));
  // An honest neighbour: one PRES and one ICHAL now, one PRES 30 s later.
  atk.sendTo(w, pres);
  atk.sendTo(w, ichal);
  await settle(8);
  await clock.advance(30000);
  atk.sendTo(w, pres);
  await settle(8);
  assert.deepEqual([got.pres, got.ichal], [2, 1]);
  assert.equal(v.stats.rated, 0, 'no strike at an honest rate');
  // A flood: 200 PRES and 200 ICHAL frames in one moment reach the service a handful of times, then the wire closes.
  for (let i = 0; i < 200; i++) {
    atk.sendTo(w, pres);
    atk.sendTo(w, ichal);
  }
  await waitFor(() => v.peers().length === 0, 5000);
  assert.ok(got.pres <= 2 + 4 && got.ichal <= 1 + 2, JSON.stringify(got));
  v.disable();
  atk.disable();
});

test('review round (PRIV-1, STALK-7): own frames leave after the first-send jitter, to a random half, at a random hop', async () => {
  const clock = fakeClock();
  const a = await makeLane(clock);
  const leaves = [];
  for (let i = 0; i < 4; i++) leaves.push(await makeLane(clock));
  await connected(...leaves.map((l) => [a, l]));
  for (const l of leaves) l.setInterest(() => true);
  const hops = new Set();
  for (let run = 0; run < 30; run++) {
    const tag = Uint8Array.of(0x40, run, 0, 0, 0, 0, 0, 0);
    const before = leaves.reduce((n, l) => n + l.envelopes.length, 0);
    const r = a.send(await envFrame(a, tag), { tag });
    assert.equal(r.route, 'flood');
    assert.equal(r.reached, 2, 'a random half of 4 neighbours');
    await clock.advance(450);
    assert.equal(leaves.reduce((n, l) => n + l.envelopes.length, 0), before, 'nothing before 0.5 s');
    await clock.advance(3000);
    const fresh = [];
    for (const l of leaves) for (const e of l.envelopes) if (e.decoded.fields.tag[1] === run) fresh.push(e);
    assert.equal(fresh.length, 2);
    for (const e of fresh) hops.add(e.decoded.header.hop);
  }
  assert.ok(hops.size > 1, 'the first hop is not always 0: ' + Array.from(hops).join(','));
  for (const h of hops) assert.ok(h >= 0 && h <= 2);
  // To a direct neighbour a frame still goes at once, on one wire.
  const d = a.send(await envFrame(a, TAG), { to: leaves[0].chatKey.pub });
  assert.equal(d.route, 'direct');
  for (const l of [a, ...leaves]) l.disable();
});

test('review round (SYB-7): a copy sent first at the hop limit does not stop the honest copy', async () => {
  const clock = fakeClock();
  const a = await makeLane(clock);
  const r = await makeLane(clock);
  const m = await makeLane(clock);
  const c = await makeLane(clock);
  await connected([a, r], [m, r], [r, c]);
  c.setInterest((tag) => tagKey(tag) === tagKey(TAG));
  c.sendWant([Uint8Array.of(TAG[0])]); // R routes toward C (and a random half of the rest)
  await settle(8);
  const f = await envFrame(a, TAG);
  m.sendTo(wireTo(m, r), withHop(f, 4)); // Mallory forwards it at once, at the limit
  await settle(8);
  a.sendTo(wireTo(a, r), withHop(f, 1)); // the honest copy, later
  await clock.advance(4000);
  assert.equal(c.envelopes.length, 1, 'the honest copy went on');
  assert.equal(decode(c.envelopes[0].bytes).header.hop, 2);
  assert.ok(r.stats.rerelayed >= 1);
  // Once it went out it never goes out again.
  a.sendTo(wireTo(a, r), withHop(f, 0));
  await clock.advance(4000);
  assert.equal(c.envelopes.length, 1);
  for (const l of [a, r, m, c]) l.disable();
});

test('review round (SYB-8): a full relay queue drops from the source holding the most bytes, so a quiet source still gets in', async () => {
  const clock = fakeClock();
  const lane = await makeLane(clock);
  const sent = [];
  const w = {
    id: 'dst', closed: false, session: { encrypt: async (x) => x }, handle: { send: (u8) => sent.push(u8[0]) },
    queues: new Map(), srcBytes: new Map(), rr: [], queueBytes: 0, tokens: 0, lastFill: clock.now(), sendChain: Promise.resolve(),
  };
  lane.wires.set('dst', w);
  for (const size of [371, 1139]) {
    sent.length = 0;
    const frame = (mark, n) => { const u = new Uint8Array(n); u[0] = mark; return u; };
    for (let i = 0; i < 1000; i++) lane._enqueue(w, 'busy', frame(1, size));
    assert.ok(w.queueBytes <= 262144);
    for (let i = 0; i < 5; i++) lane._enqueue(w, 'quiet', frame(2, 1139));
    assert.equal((w.queues.get('quiet') || []).length, 5, 'every quiet frame admitted (busy frames of ' + size + ' bytes)');
    await clock.advance(200);
    await settle(4);
    assert.equal(sent.slice(0, 10).filter((x) => x === 2).length, 5, 'sent among the first 10: ' + sent.slice(0, 10).join(''));
    await clock.advance(10000);
    await settle(4);
  }
  lane.disable();
});

test('review round (SEC-7): chatBits is read live; a relayed stranger frame under the requirement is dropped without a strike', async () => {
  const { stampWork: work } = await import('../../src/chat/stamp.js');
  const { FLAG_STRANGER } = await import('../../src/chat/limits.js');
  const clock = fakeClock();
  let bits = 20;
  const a = await makeLane(clock);
  const r = await makeLane(clock, { chatBits: () => bits });
  const c = await makeLane(clock, { chatBits: () => bits });
  await connected([a, r], [r, c]);
  c.setInterest(() => true);
  const strikes = [];
  r.on('strike', (s) => strikes.push(s.reason));
  async function strangerAt(min, max, tagByte) {
    // mint() is deterministic (the first counter that meets the bits), so every try needs a new body.
    for (let tries = 0; tries < 1000; tries++) {
      const ct = new Uint8Array(272);
      globalThis.crypto.getRandomValues(ct);
      const f = await a.stamped(T.ENV, { flags: FLAG_STRANGER, bits: min, body: envBody({ tag: Uint8Array.of(tagByte, 0, 0, 0, 0, 0, 0, 0), epk: POINT || publicKeyBytes((await generateChatKey()).pub), iv: new Uint8Array(12), ct }) });
      const d = decode(f);
      if (work(frameId(f), d.header.stampNonce) < max) return f;
    }
    throw new Error('no frame with a stamp in [' + min + ', ' + max + ')');
  }
  const f16 = await strangerAt(16, 20, 1);
  a.sendTo(wireTo(a, r), withHop(f16, 1));
  await clock.advance(4000);
  assert.equal(c.envelopes.length, 0, 'under 20 bits: not relayed');
  assert.deepEqual(strikes, [], 'and not a strike: the relay that sent it may be honest');
  assert.ok(r.stats.understamped >= 1);
  bits = 16; // the owner lowers chatBits; the lane reads it at once
  const g16 = await strangerAt(16, 20, 2);
  a.sendTo(wireTo(a, r), withHop(g16, 1));
  await clock.advance(4000);
  assert.equal(c.envelopes.length, 1, 'at the new requirement the frame goes on');
  const low = await strangerAt(10, 16, 3);
  a.sendTo(wireTo(a, r), low); // hop 0: the neighbour wrote it
  await waitFor(() => strikes.length === 1);
  assert.deepEqual(strikes, ['stamp']);
  // Below the 10 bits no setting goes under, a relayed copy is a strike too (no honest relay forwards it).
  const { withNonce: wn } = await import('../../src/chat/frames.js');
  let junk = await strangerAt(16, 20, 4);
  for (let n = 0; n < 4096; n++) {
    const nonce = new Uint8Array(8);
    new DataView(nonce.buffer).setUint32(4, n);
    if (work(frameId(junk), nonce) < 10) { junk = wn(junk, nonce); break; }
  }
  a.sendTo(wireTo(a, r), withHop(junk, 2));
  await waitFor(() => strikes.length === 2);
  for (const l of [a, r, c]) l.disable();
});

test('review round (SYB-10): ROOM frames reach the signature check at most 20 a second per wire', async () => {
  const { roomBody } = await import('../../src/chat/frames.js');
  const { exportPublicKey, generateKeyPair } = await import('../../src/chain/crypto.js');
  const clock = fakeClock();
  const v = await makeLane(clock);
  const atk = await makeLane(clock);
  await connected([atk, v]);
  let checks = 0;
  v.setRoomFilter(async () => { checks++; return false; });
  const author = await exportPublicKey((await generateKeyPair()).publicKey);
  const sig = 'A'.repeat(86);
  const w = wireTo(atk, v);
  for (let i = 0; i < 60; i++) {
    const idb = new Uint8Array(16);
    globalThis.crypto.getRandomValues(idb);
    const id = hex.encode(idb) && Buffer.from(idb).toString('base64url');
    atk.sendTo(w, await atk.stamped(T.ROOM, { body: roomBody({ room: 'Lobby', id, t: clock.now(), text: 'x' + i, author, sig }) }));
  }
  await waitFor(() => v.stats.overBudget + checks >= 60, 5000);
  assert.equal(checks, 20);
  v.disable();
  atk.disable();
});

test('review round (MP-5, SYB-10): 100 CK frames in a moment from one wire reach the service at most 4 times; the wire is closed', async () => {
  const { ckBody } = await import('../../src/chat/frames.js');
  const { makeCk } = await import('../../src/chat/ck.js');
  const { generateKeyPair, exportPublicKey, sign } = await import('../../src/chain/crypto.js');
  const clock = fakeClock();
  const v = await makeLane(clock);
  const atk = await makeLane(clock);
  await connected([atk, v]);
  let cks = 0;
  v.on('ck', () => { cks++; });
  const kp = await generateKeyPair();
  const pub = await exportPublicKey(kp.publicKey);
  const ck = await makeCk({ signer: { pub, sign: (b) => sign(kp.privateKey, b) }, ledger: LEDGER, ek: atk.chatKey.pub, now: clock.now() });
  const f = encode(T.CK, { day: headerDay(clock.now()) }, ckBody(ck));
  const w = wireTo(atk, v);
  for (let i = 0; i < 100; i++) atk.sendTo(w, f);
  await waitFor(() => v.peers().length === 0, 5000);
  assert.ok(cks <= 4, cks + ' CK frames reached the service');
  v.disable();
  atk.disable();
});
