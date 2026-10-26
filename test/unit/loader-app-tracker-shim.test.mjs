// The B1 tracker shim (src/loader/torrent.js installTrackerShim) against the REAL bittorrent-tracker
// WebSocketTracker and a real tracker on 127.0.0.1 (tools/tracker.mjs): two swarms of one page share
// one tracker socket (bittorrent-tracker's socket pool), as the site torrent and the ledger rendezvous
// swarm do. Regression tests for two bugs the v0.2.1 verifier found (docs/deviations/harden-verify.md):
//  1. after a tracker blip, an instance whose reconnect timer fired while the other instance's new socket
//     was still connecting joined the pooled socket without a 'connect' callback and never re-announced;
//  2. after any reconnect the regular announce interval stayed stopped (destroy() clears it, the shim's
//     "same interval" shortcut then refused to start it again).
// No WebRTC is needed: announces carry numwant 0, so the client creates no offers.
import { test } from 'node:test';
import assert from 'node:assert/strict';
// bittorrent-tracker/client pulls in webrtc-polyfill and the native node-datachannel binding, which a clean
// install never has (install scripts stay off): stub WebRTC first, then load the client (see no-native-webrtc.mjs).
import './no-native-webrtc.mjs';

import { createTracker } from '../../tools/tracker.mjs';
import { installTrackerShim } from '../../src/loader/torrent.js';

const { default: Client } = await import('bittorrent-tracker/client');

const PEER = '2d4d5730323031' + 'aa'.repeat(13); // 20 bytes, hex
const A = '1'.repeat(40);
const B = '2'.repeat(40);

function until(cond, { timeoutMs = 4000, stepMs = 10, label = 'condition' } = {}) {
  const end = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const tick = () => {
      let v = null;
      try { v = cond(); } catch (_) { v = null; }
      if (v) return resolve(v);
      if (Date.now() > end) return reject(new Error(label + ': not reached within ' + timeoutMs + ' ms'));
      setTimeout(tick, stepMs);
    };
    tick();
  });
}

/** Manual reconnect timers: the test decides when (and in which order) the shim's reconnects fire. */
function manualTimers() {
  const pending = new Map();
  let next = 0;
  return {
    pending,
    setTimeout(fn) { const id = ++next; pending.set(id, fn); return id; },
    clearTimeout(id) { pending.delete(id); },
    fireAll() {
      const fns = Array.from(pending.values());
      pending.clear();
      for (const fn of fns) fn(); // one synchronous turn: the second open joins a socket that is still connecting
    },
  };
}

test('B1 shim: two swarms on one tracker socket both re-announce after a blip, and the regular interval runs again', async () => {
  const tracker = await createTracker({ port: 0, open: true, quiet: true, interval: 60000 });
  const seen = [];
  for (const ev of ['start', 'update', 'complete', 'stop']) tracker.server.on(ev, (_addr, params) => seen.push({ t: Date.now(), ev, btih: params.info_hash }));
  const clients = [A, B].map((infoHash) => new Client({ infoHash, peerId: PEER, announce: [tracker.url], port: 6881, wrtc: {}, getAnnounceOpts: () => ({ numwant: 0 }) }));
  const timers = manualTimers();
  const instances = clients.map((c) => c._trackers[0]);
  const starts = new Map(instances.map((t) => [t, 0]));
  try {
    for (const t of instances) {
      assert.equal(t.constructor.name, 'WebSocketTracker');
      const realSetInterval = t.setInterval;
      t.setInterval = function (ms) { if (ms) starts.set(this, starts.get(this) + 1); return realSetInterval.call(this, ms); };
      assert.equal(installTrackerShim(t, { timers, random: () => 0 }), true);
    }
    assert.equal(instances[0].socket, instances[1].socket, 'one pooled socket for both swarms');
    for (const c of clients) c.start();
    await until(() => [A, B].every((h) => seen.some((s) => s.btih === h && s.ev === 'start')), { label: 'both swarms started' });
    await until(() => instances.every((t) => starts.get(t) >= 1), { label: 'the regular interval started after the first response' });
    const startsBefore = instances.map((t) => starts.get(t));

    // The blip: every WebSocket is terminated; the server keeps listening.
    const dropAt = Date.now();
    assert.equal(tracker.dropConnections(), 1, 'one pooled socket for both swarms');
    await until(() => instances.every((t) => t.reconnecting) && timers.pending.size >= 2, { label: 'both instances wait to reconnect' });
    timers.fireAll();
    await until(() => [A, B].every((h) => seen.some((s) => s.btih === h && s.t > dropAt && s.ev !== 'stop')), { timeoutMs: 3000, label: 'both swarms re-announced after the blip' });
    assert.ok(instances.every((t) => !t.reconnecting), 'neither instance is left waiting');
    assert.equal(instances[0].socket, instances[1].socket, 'still one pooled socket');
    // The response to the re-announce restarts the regular interval (it stayed stopped before the fix).
    await until(() => instances.every((t, i) => starts.get(t) > startsBefore[i]), { label: 'regular interval restarted' });
  } finally {
    for (const c of clients) { try { c.destroy(); } catch (_) { /* closing */ } }
    await tracker.close();
  }
});

test('B1 shim: after a reconnect the regular announce interval starts again (one swarm, no pool race)', async () => {
  const tracker = await createTracker({ port: 0, open: true, quiet: true, interval: 60000 });
  const seen = [];
  tracker.server.on('update', (_addr, params) => seen.push({ t: Date.now(), btih: params.info_hash }));
  const client = new Client({ infoHash: A, peerId: PEER, announce: [tracker.url], port: 6881, wrtc: {}, getAnnounceOpts: () => ({ numwant: 0 }) });
  const timers = manualTimers();
  const t = client._trackers[0];
  let starts = 0;
  try {
    const realSetInterval = t.setInterval;
    t.setInterval = function (ms) { if (ms) starts++; return realSetInterval.call(this, ms); };
    installTrackerShim(t, { timers, random: () => 0 });
    client.start();
    await until(() => starts >= 1, { label: 'interval after the first response' });
    const before = starts;
    const dropAt = Date.now();
    assert.equal(tracker.dropConnections(), 1);
    await until(() => t.reconnecting && timers.pending.size >= 1, { label: 'waiting to reconnect' });
    timers.fireAll();
    await until(() => seen.some((s) => s.t > dropAt && s.btih === A), { label: 're-announced' });
    await until(() => starts > before, { label: 'the regular interval runs again after the reconnect' });
    assert.ok(t.interval, 'a live interval');
  } finally {
    try { client.destroy(); } catch (_) { /* closing */ }
    await tracker.close();
  }
});
