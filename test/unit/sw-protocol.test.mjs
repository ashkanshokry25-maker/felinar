// Unit tests for src/sw/protocol.js, the versioned page <-> Service Worker protocol (v0.2.1 D1): the
// message builder, the proto check, every page message type a worker of this PROTO understands, and
// the keep-alive pinger a page runs while it depends on the worker.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { PROTO, MSG, PAGE_TYPES, KEEPALIVE_MS, KEEPALIVE_PATH, message, checkProto, isProtocolMessage, createKeepAlive } from '../../src/sw/protocol.js';
import { createCore, PROTO as CORE_PROTO } from '../../src/sw/core.js';
import { PROTO as SWREG_PROTO } from '../../src/dropin/swreg.js';

test('message, checkProto and isProtocolMessage', () => {
  assert.equal(PROTO, 1);
  assert.equal(CORE_PROTO, PROTO, 'the worker re-exports the protocol version');
  assert.equal(SWREG_PROTO, PROTO, 'the drop-in runtime speaks the same version');
  assert.deepEqual(message(MSG.ping), { proto: PROTO, type: 'mw-ping' });
  assert.deepEqual(message(MSG.mapClient, { btih: 'b', type: 'x', proto: 9 }), { btih: 'b', proto: PROTO, type: 'mw-map-client' }, 'type and proto always win');
  assert.deepEqual(checkProto({ proto: PROTO }), { ok: true, expected: PROTO });
  assert.deepEqual(checkProto({ proto: PROTO + 1 }), { ok: false, expected: PROTO });
  assert.equal(checkProto(null).ok, false);
  assert.equal(isProtocolMessage({ type: 'mw-ping' }), true);
  assert.equal(isProtocolMessage({ type: 'ping' }), false);
  assert.equal(isProtocolMessage('mw-ping'), false);
  assert.ok(KEEPALIVE_MS <= 20000, 'pings at most every 20 s');
  assert.equal(KEEPALIVE_PATH, '/_mw/keepalive');
  // v0.3: media and file sessions (R 2.9.6)
  assert.equal(MSG.sessionRegister, 'mw-session-register');
  assert.equal(MSG.sessionClose, 'mw-session-close');
  assert.equal(MSG.sessionLost, 'mw-session-lost');
  assert.equal(MSG.chunkNeed, 'mw-chunk-need');
  assert.equal(MSG.chunk, 'mw-chunk');
  assert.ok(PAGE_TYPES.includes(MSG.sessionRegister) && PAGE_TYPES.includes(MSG.sessionClose));
  assert.ok(!PAGE_TYPES.includes(MSG.chunk), 'chunks travel on the session port, not as page messages');
});

test('a worker of this PROTO understands every page message type of the protocol', async () => {
  const core = createCore({
    buildId: 'p', limits: { persistDelayMs: 0 },
    storage: { async getSite() {}, async listSites() { return []; }, async getFile() {}, async getMeta() {}, async setMeta() {}, async deleteSite() {}, async getDoc() {}, async putDoc() {} },
    env: { origin: 'https://site.test', caches: null, clients: { async matchAll() { return []; }, async get() {}, async claim() {} }, fetch: async () => new Response('x'), log() {} },
  });
  for (const type of PAGE_TYPES) {
    const replies = [];
    const waits = [];
    core.message({ data: { proto: PROTO, type, btih: 'a'.repeat(40) }, source: { id: 'c1' }, ports: [{ postMessage: (m) => replies.push(m) }], waitUntil: (p) => waits.push(p) });
    for (const w of waits) await w;
    assert.equal(replies.length, 1, type + ' gets one reply');
    assert.notEqual(replies[0].error, 'unknown-type', type + ' is understood');
    assert.equal(replies[0].proto, PROTO);
  }
});

test('createKeepAlive: pings at once and then on the interval while held, stops when released, clamps the interval', () => {
  const timers = [];
  const posts = [];
  const ka = createKeepAlive({
    post: () => posts.push(1),
    intervalMs: 60000,
    setIntervalFn: (fn, ms) => {
      timers.push({ fn, ms, live: true });
      return timers.length - 1;
    },
    clearIntervalFn: (id) => {
      timers[id].live = false;
    },
  });
  assert.equal(ka.active, false);
  assert.equal(ka.hold(), 1);
  assert.equal(posts.length, 1, 'a ping at once');
  assert.equal(timers[0].ms, KEEPALIVE_MS, 'a longer interval is clamped to 20 s');
  assert.equal(ka.hold(), 2);
  assert.equal(timers.length, 1, 'one timer for any number of holds');
  timers[0].fn();
  timers[0].fn();
  assert.equal(posts.length, 3);
  assert.equal(ka.release(), 1);
  assert.equal(ka.active, true);
  assert.equal(ka.release(), 0);
  assert.equal(ka.active, false);
  assert.equal(timers[0].live, false);
  assert.equal(ka.release(), 0, 'an extra release is harmless');
  const throwing = createKeepAlive({ post: () => { throw new Error('gone'); }, setIntervalFn: () => 1, clearIntervalFn: () => {} });
  assert.doesNotThrow(() => throwing.hold(), 'a failed ping is ignored');
  throwing.stop();
  assert.equal(throwing.active, false);
});
