// Unit tests for src/dropin/leader.js: the Web Locks election as a state machine (leader, follower
// promoted when the leader goes away, release for the back/forward cache, degraded modes) and the
// BroadcastChannel link with request/response for forwarded writes. A fake LockManager that queues
// and honours ifAvailable and abort signals; a fake BroadcastChannel hub. No browser.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createClock, flush } from './dropin-fake-timers.mjs';
import { Leadership, TabLink, RemoteNode, validTabMessage, LOCK_PREFIX, CHANNEL_PREFIX, TAB_METHODS } from '../../src/dropin/leader.js';

class FakeLockManager {
  constructor() {
    this.held = new Map();
    this.queues = new Map();
    this.requests = [];
  }

  request(name, a, b) {
    const options = typeof a === 'function' ? {} : a || {};
    const cb = typeof a === 'function' ? a : b;
    this.requests.push({ name, options });
    return new Promise((resolve, reject) => {
      const grant = async () => {
        this.held.set(name, true);
        let out;
        try {
          out = await cb({ name, mode: 'exclusive' });
          resolve(out);
        } catch (e) {
          reject(e);
        } finally {
          this.held.delete(name);
          const q = this.queues.get(name) || [];
          const next = q.shift();
          if (next) next();
        }
      };
      if (!this.held.get(name)) {
        Promise.resolve().then(grant);
        return;
      }
      if (options.ifAvailable) {
        Promise.resolve().then(async () => {
          try {
            resolve(await cb(null));
          } catch (e) {
            reject(e);
          }
        });
        return;
      }
      const entry = () => {
        if (options.signal && options.signal.aborted) return;
        grant();
      };
      if (!this.queues.has(name)) this.queues.set(name, []);
      this.queues.get(name).push(entry);
      if (options.signal) {
        options.signal.addEventListener('abort', () => {
          const q = this.queues.get(name) || [];
          const i = q.indexOf(entry);
          if (i >= 0) q.splice(i, 1);
          reject(Object.assign(new Error('The lock request is aborted'), { name: 'AbortError' }));
        }, { once: true });
      }
    });
  }
}

function makeHub() {
  const channels = [];
  class Channel {
    constructor(name) { this.name = name; this.closed = false; this.onmessage = null; channels.push(this); }
    postMessage(data) {
      for (const c of channels) {
        if (c !== this && c.name === this.name && !c.closed) {
          const copy = JSON.parse(JSON.stringify(data));
          Promise.resolve().then(() => { if (!c.closed && c.onmessage) c.onmessage({ data: copy }); });
        }
      }
    }
    close() { this.closed = true; }
  }
  return { Channel, channels };
}

test('Leadership: the first tab leads, the second follows and is promoted when the leader releases', async () => {
  const locks = new FakeLockManager();
  const seenA = [];
  const seenB = [];
  const a = new Leadership(LOCK_PREFIX + 'mw1:abc', { locks, onChange: (s) => seenA.push(s) });
  const b = new Leadership(LOCK_PREFIX + 'mw1:abc', { locks, onChange: (s) => seenB.push(s) });
  assert.equal(a.state, 'idle');
  assert.equal(await a.start(), true);
  assert.equal(a.isLeader, true);
  assert.equal(await b.start(), false);
  assert.equal(b.state, 'follower');
  let promoted = false;
  b.whenLeader.then(() => { promoted = true; });
  await flush();
  assert.equal(promoted, false);
  a.release();
  assert.equal(a.state, 'released');
  await flush();
  assert.equal(b.state, 'leader', 'promoted without a new request');
  assert.equal(promoted, true);
  assert.deepEqual(seenA, ['candidate', 'leader', 'released']);
  assert.deepEqual(seenB, ['candidate', 'follower', 'leader']);
  assert.equal(locks.requests[0].options.ifAvailable, true);
  assert.equal(locks.requests[0].name, 'mw-swarm-mw1:abc');
});

test('Leadership: a follower that leaves cancels its queued request; nobody takes the lock later', async () => {
  const locks = new FakeLockManager();
  const a = new Leadership('x', { locks });
  const b = new Leadership('x', { locks });
  await a.start();
  await b.start();
  b.release();
  assert.equal(b.state, 'released');
  a.release();
  await flush();
  assert.equal(locks.held.get('x'), undefined, 'the lock is free');
  assert.equal(b.state, 'released', 'the left tab did not take it');
  const c = new Leadership('x', { locks });
  assert.equal(await c.start(), true);
});

test('Leadership: restart() after release asks again (pageshow after a back/forward-cache restore)', async () => {
  const locks = new FakeLockManager();
  const a = new Leadership('y', { locks });
  assert.equal(await a.start(), true);
  assert.equal(await a.start(), true, 'start() is idempotent while leading');
  a.release();
  await flush();
  assert.equal(locks.held.get('y'), undefined, 'releasing the page frees the lock');
  assert.equal(await a.restart(), true);
  assert.equal(a.state, 'leader');
  let again = false;
  a.whenLeader.then(() => { again = true; });
  await flush();
  assert.equal(again, true, 'whenLeader works again after a restart');
  assert.equal(await a.restart(), true, 'restart() while leading changes nothing');
  a.release();
  a.release();
  await flush();
});

test('Leadership: releasing a tab that was promoted gives the lock to the next follower', async () => {
  const locks = new FakeLockManager();
  const [a, b, c] = [new Leadership('z', { locks }), new Leadership('z', { locks }), new Leadership('z', { locks })];
  await a.start();
  await b.start();
  await c.start();
  a.release();
  await flush();
  assert.equal(b.state, 'leader', 'first in the queue');
  assert.equal(c.state, 'follower');
  b.release();
  await flush();
  assert.equal(c.state, 'leader');
});

test('Leadership: release() while the first answer is pending resolves start() with false', async () => {
  const hang = { request: () => new Promise(() => {}) };
  const l = new Leadership('h', { locks: hang });
  const started = l.start();
  l.release();
  assert.equal(await started, false);
  assert.equal(l.state, 'released');
});

test('Leadership: without Web Locks, or when they fail, the tab leads', async () => {
  assert.equal(await new Leadership('n', { locks: null }).start(), true);
  const throwing = new Leadership('n', { locks: { request() { throw new Error('SecurityError'); } } });
  assert.equal(await throwing.start(), true);
  assert.equal(throwing.state, 'leader');
  const rejecting = new Leadership('n', { locks: { request: () => Promise.reject(new Error('NotSupportedError')) } });
  assert.equal(await rejecting.start(), true);
  assert.equal(rejecting.state, 'leader');
});

test('Leadership: a listener that throws does not break the machine', async () => {
  const l = new Leadership('t', { locks: new FakeLockManager(), onChange() { throw new Error('page bug'); } });
  assert.equal(await l.start(), true);
  l.release();
});

test('validTabMessage: the structural contract of every message type', () => {
  const m = (o) => Object.assign({ mw: 1, from: 'tab1' }, o);
  assert.equal(validTabMessage(m({ t: 'leader' })), true);
  assert.equal(validTabMessage(m({ t: 'need-state' })), true);
  assert.equal(validTabMessage(m({ t: 'state', snap: { height: 1 } })), true);
  assert.equal(validTabMessage(m({ t: 'state' })), false);
  assert.equal(validTabMessage(m({ t: 'site', btih: 'ab'.repeat(20) })), true);
  assert.equal(validTabMessage(m({ t: 'version', btih: 'xyz' })), false);
  for (const state of ['accepted', 'host-only', 'pending']) assert.equal(validTabMessage(m({ t: 'consent', state })), true);
  assert.equal(validTabMessage(m({ t: 'consent', state: 'sure' })), false);
  for (const method of TAB_METHODS) assert.equal(validTabMessage(m({ t: 'call', id: 'a:1', method, args: ['k', 'v'] })), true, method);
  assert.equal(validTabMessage(m({ t: 'call', id: 'a:1', method: 'close', args: [] })), false, 'only ledger writes can be forwarded');
  assert.equal(validTabMessage(m({ t: 'call', id: 'a:1', method: 'put', args: [1, 2, 3] })), false);
  assert.equal(validTabMessage(m({ t: 'call', id: 5, method: 'put', args: [] })), false);
  assert.equal(validTabMessage(m({ t: 'result', id: 'a:1', to: 'tab2' })), true);
  assert.equal(validTabMessage(m({ t: 'result', id: 'a:1' })), false);
  assert.equal(validTabMessage(m({ t: 'bogus' })), false);
  assert.equal(validTabMessage({ t: 'leader', from: 'x' }), false, 'mw: 1 marker');
  assert.equal(validTabMessage(null), false);
  assert.equal(validTabMessage('leader'), false);
  assert.equal(validTabMessage(m({ t: 'leader', from: 5 })), false);
});

test('TabLink: messages reach other tabs of the same ledger only, never the sender', async () => {
  const { Channel } = makeHub();
  const a = new TabLink('mw1:abc', { Channel });
  const b = new TabLink('mw1:abc', { Channel });
  const other = new TabLink('mw1:other', { Channel });
  const gotB = [];
  const gotA = [];
  const gotOther = [];
  b.on((m) => gotB.push(m));
  a.on((m) => gotA.push(m));
  other.on((m) => gotOther.push(m));
  assert.equal(a.send('consent', { state: 'accepted' }), true);
  await flush();
  assert.equal(gotB.length, 1);
  assert.equal(gotB[0].state, 'accepted');
  assert.equal(gotB[0].from, a.id);
  assert.equal(gotA.length, 0);
  assert.equal(gotOther.length, 0, 'other ledgers are other channels');
  assert.equal(new Channel('x').name, 'x');
  assert.equal(CHANNEL_PREFIX + 'mw1:abc', 'mw-mw1:abc');
});

test('TabLink: garbage on the channel is ignored and a throwing handler does not stop the others', async () => {
  const { Channel } = makeHub();
  const a = new TabLink('l', { Channel });
  const raw = new Channel('mw-l');
  let ok = 0;
  a.on(() => { throw new Error('first handler bug'); });
  a.on(() => { ok++; });
  raw.postMessage({ t: 'call', method: 'close' });
  raw.postMessage('junk');
  raw.postMessage({ mw: 1, t: 'leader', from: 'z' });
  await flush();
  assert.equal(ok, 1, 'only the valid message got through, and the second handler still ran');
});

test('TabLink.call: a follower\'s write is answered by the leader (result and error)', async () => {
  const { Channel } = makeHub();
  const leader = new TabLink('l', { Channel });
  const follower = new TabLink('l', { Channel });
  leader.on((m) => {
    if (m.t !== 'call') return;
    if (m.method === 'put' && m.args[0] === 'bad') leader.send('result', { id: m.id, to: m.from, ok: false, error: { code: 'E_POLICY', message: 'only the owner writes' } });
    else leader.send('result', { id: m.id, to: m.from, ok: true, result: { h: 'f'.repeat(64) } });
  });
  assert.deepEqual(await follower.call('put', ['k', { a: 1 }]), { h: 'f'.repeat(64) });
  await assert.rejects(follower.call('put', ['bad', 1]), (e) => e.code === 'E_POLICY' && /owner/.test(e.message));
  // a result addressed to somebody else is not ours
  const third = new TabLink('l', { Channel });
  const p = third.call('del', ['x']);
  leader.send('result', { id: 'nope:1', to: third.id, ok: true, result: {} });
  leader.send('result', { id: third.id + ':1', to: 'someone-else', ok: true, result: {} });
  leader.send('result', { id: third.id + ':1', to: third.id, ok: true, result: { h: 'a'.repeat(64) } });
  assert.deepEqual(await p, { h: 'a'.repeat(64) });
});

test('TabLink.call: times out, and close() fails what is pending at once', async () => {
  const { Channel } = makeHub();
  const clock = createClock();
  const lonely = new TabLink('l', { Channel, timeoutMs: 5000, setTimeoutFn: clock.setTimeout, clearTimeoutFn: clock.clearTimeout });
  const p = lonely.call('append', ['guestbook', 'hello']);
  p.catch(() => {});
  clock.advance(5000);
  await assert.rejects(p, (e) => e.code === 'E_INTERNAL' && /did not answer/.test(e.message));
  const q = lonely.call('put', ['k', 1]);
  q.catch(() => {});
  lonely.close();
  await assert.rejects(q, (e) => e.code === 'E_INTERNAL' && /closed/.test(e.message));
  assert.equal(clock.pending(), 0, 'no timer left behind');
  assert.equal(lonely.send('leader'), false, 'a closed link sends nothing');
  await assert.rejects(lonely.call('put', ['k', 1]), (e) => e.code === 'E_IDENTITY');
  lonely.open();
  assert.equal(lonely.send('leader'), true, 'open() reopens after pageshow');
  lonely.close();
});

test('TabLink: without BroadcastChannel there is no link, and calls fail clearly', async () => {
  const link = new TabLink('l', { Channel: null });
  assert.equal(link.available, false);
  assert.equal(link.send('leader'), false);
  await assert.rejects(link.call('put', ['k', 1]), (e) => e.code === 'E_IDENTITY');
  link.close();
  const broken = new TabLink('l', { Channel: class { constructor() { throw new Error('SecurityError'); } } });
  assert.equal(broken.channel, null);
});

test('RemoteNode: state from the leader, subscribers notified, writes forwarded', async () => {
  const calls = [];
  const link = { call: (method, args) => { calls.push([method, args]); return Promise.resolve({ h: 'b'.repeat(64) }); } };
  const node = new RemoteNode(link);
  assert.equal(node.snapshot(), null);
  assert.equal(node.role, 'reader');
  const seen = [];
  const off = node.subscribe((snap, info) => seen.push([snap.height, info.reason]));
  node.apply({ snap: { height: 7, kv: {} }, peers: 3, inSync: 2, role: 'writer', identity: { pub: 'p', short: 's' } });
  assert.equal(node.height, 7);
  assert.equal(node.peers, 3);
  assert.equal(node.inSyncPeers, 2);
  assert.equal(node.role, 'writer');
  assert.deepEqual(node.identity, { pub: 'p', short: 's' });
  assert.deepEqual(seen, [[7, 'remote']]);
  off();
  node.apply({ snap: { height: 8 } });
  assert.equal(seen.length, 1);
  assert.equal(node.state, null);
  await node.put('k', 1);
  await node.del('k');
  await node.append('l', 'v');
  await node.profile('Ash');
  await node.tombstone('h');
  await node.ban('pub');
  assert.deepEqual(calls.map((c) => c[0]), ['put', 'del', 'append', 'profile', 'tombstone', 'ban']);
  assert.deepEqual(calls[0][1], ['k', 1]);
});

test('code review round 1: a forwarded write hears the fee progress (its timeout waits) and the leader cancels it when the follower gives up or aborts', async () => {
  const { installTabLink } = await import('../../src/dropin/ledger.js');
  const { Channel } = makeHub();
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const leaderLink = new TabLink('l', { Channel, timeoutMs: 200 });
  const followerLink = new TabLink('l', { Channel, timeoutMs: 200 });
  const jobs = [];
  const node = {
    role: 'writer',
    append: (l, v, opts) => new Promise((resolve, reject) => {
      const job = { l, v, opts, resolve, aborted: false };
      opts.signal.addEventListener('abort', () => { job.aborted = true; reject(Object.assign(new Error('aborted'), { name: 'AbortError', code: 'E_POW_ABORTED' })); });
      jobs.push(job);
    }),
  };
  const E = { link: leaderLink, isLeader: true, node, followerNode: null, consent: { state: () => 'accepted' }, binding: { push() {} }, log() {} };
  installTabLink(E);
  const remote = new RemoteNode(followerLink);
  try {
    assert.equal(validTabMessage({ mw: 1, t: 'cancel', from: 'f', id: 'f:1' }), true);
    assert.equal(validTabMessage({ mw: 1, t: 'pow', from: 'l', id: 'f:1', to: 'f', hashes: 10 }), true);
    const seen = [];
    const p = remote.append('gb', 'hi', { onProgress: (x) => seen.push(x.hashes) });
    while (jobs.length < 1) await sleep(5);
    for (let i = 1; i <= 3; i++) {
      await sleep(150);
      jobs[0].opts.onProgress({ hashes: i * 100, bits: 8 });
    }
    await sleep(20);
    assert.deepEqual(seen, [100, 200, 300], 'progress reaches the follower and keeps its call alive');
    jobs[0].resolve({ h: 'c'.repeat(64) });
    assert.deepEqual(await p, { h: 'c'.repeat(64) });
    const q = remote.append('gb', 'lost');
    const gaveUp = assert.rejects(q, (e) => e.code === 'E_INTERNAL');
    while (jobs.length < 2) await sleep(5);
    await gaveUp;
    await sleep(20);
    assert.equal(jobs[1].aborted, true, 'the leader stopped the write the follower gave up on');
    const ac = new AbortController();
    const r = remote.append('gb', 'never', { signal: ac.signal });
    while (jobs.length < 3) await sleep(5);
    ac.abort();
    await assert.rejects(r, (e) => e.code === 'E_POW_ABORTED');
    await sleep(20);
    assert.equal(jobs[2].aborted, true);
    assert.equal(E.tabCalls.size, 0);
  } finally {
    leaderLink.close();
    followerLink.close();
  }
});
