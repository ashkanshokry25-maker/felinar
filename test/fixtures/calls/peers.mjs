// Real chat services (src/chat/service.js) joined by fake BEP 10 wires through a fake TorrentManager seam, each with a
// calls service (src/calls/service.js) on the fake WebRTC of ./fake-webrtc.mjs. SIG frames are really sealed with
// K_pair, stamped and carried over the Noise sessions of the chat lane; only WebRTC is fake. Used by
// test/unit/calls-service.test.mjs and test/unit/calls-mesh.test.mjs.
import assert from 'node:assert/strict';
import { generateKeyPair, exportPublicKey, sign } from '../../../src/chain/crypto.js';
import { createChatService, CHAT_EVENTS } from '../../../src/chat/service.js';
import { generateChatKey } from '../../../src/chat/seal.js';
import { DAY_MS, EXT_NAME } from '../../../src/chat/limits.js';
import { createCallService } from '../../../src/calls/service.js';
import { CALL_EVENTS } from '../../../src/calls/limits.js';

export const LEDGER = 'mw1:callsLedger';
export const T0 = 20381 * DAY_MS + 12 * 3600000;
export const CLICK = Object.freeze({ activation: true, tab: 'leader' });
export const NOCLICK = Object.freeze({ activation: false, tab: 'leader' });

export function fakeClock(start = T0) {
  let t = start;
  let seq = 0;
  const q = [];
  const clock = {
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
    pending: () => q.length,
    async advance(ms) {
      const end = t + ms;
      for (;;) {
        await settle();
        q.sort((a, b) => a.at - b.at || a.seq - b.seq);
        const h = q[0];
        if (!h || h.at > end) break;
        q.shift();
        t = Math.max(t, h.at);
        try { h.fn(); } catch (_) { /* a timer's own failure */ }
      }
      t = end;
      await settle();
    },
  };
  return clock;
}

export async function settle(rounds = 4) {
  for (let i = 0; i < rounds; i++) await new Promise((r) => setTimeout(r, 1));
}

/** until(clock, pred, { ms, step, label }): advances the fake clock in steps until pred() is truthy. */
export async function until(clock, pred, { ms = 30000, step = 50, label = 'condition', real = 20000 } = {}) {
  const end = clock.now() + ms;
  const realEnd = Date.now() + real;
  for (;;) {
    const v = await pred();
    if (v) return v;
    if (clock.now() >= end || Date.now() > realEnd) throw new Error('timed out waiting for ' + label);
    await clock.advance(step);
  }
}

class FakeWire {
  constructor(tap) {
    this.peer = null;
    this.destroyed = false;
    this.handlers = {};
    this.ext = null;
    this.tap = tap;
  }
  use(Ext) { this.ext = new Ext(this); }
  extended(name, buf) {
    assert.equal(name, EXT_NAME);
    const p = this.peer;
    const copy = new Uint8Array(buf);
    if (this.tap) this.tap(copy);
    setImmediate(() => { if (!p.destroyed && p.ext) p.ext.onMessage(copy); });
  }
  once(ev, fn) { this.handlers[ev] = fn; }
  destroy() {
    if (this.destroyed) return;
    this.destroyed = true;
    if (this.handlers.close) this.handlers.close();
    this.peer.destroy();
  }
}

class FakeTM {
  constructor() {
    this.exts = [];
    this.calls = [];
  }
  registerWireExtension(name, handler, opts) {
    this.calls.push(['register', name, opts]);
    this.exts.push(handler);
    return () => { this.calls.push(['unregister', name]); this.exts = []; };
  }
  joinLane(o) {
    this.calls.push(['joinLane', o]);
    return { leave: () => this.calls.push(['leave']) };
  }
}

/** connect(a, b, { tap }) joins two people by one wire; tap(bytes) sees every wire message (Noise-sealed). */
export function connect(a, b, { tap } = {}) {
  const wa = new FakeWire(tap);
  const wb = new FakeWire(tap);
  wa.peer = wb;
  wb.peer = wa;
  for (const h of a.tm.exts) h.onWire(wa, 'rendezvous');
  for (const h of b.tm.exts) h.onWire(wb, 'rendezvous');
  wa.ext.onExtendedHandshake({ m: { [EXT_NAME]: 3 } });
  wb.ext.onExtendedHandshake({ m: { [EXT_NAME]: 3 } });
  return [wa, wb];
}

function memStore() {
  const m = new Map();
  return { m, async get(k) { return m.get(k); }, async set(k, v) { m.set(k, JSON.parse(JSON.stringify(v))); } };
}

function fakeNode() {
  return {
    appended: [],
    syncing: false,
    state: { owner: null, ownerConflict: false, policy: { banned: new Set(), moderators: new Set(), allow: new Set(), writers: 'open' }, lists: new Map() },
    append(l, v) { this.appended.push([l, v]); return { h: 'x' }; },
  };
}

/**
 * person(clock, net, { name, cfg, policy, prefs, answers, browser, callDeps }) -> a signed-in person with chat on
 * and a calls service. answers[kind] is what the loader card for that kind resolves to (default true).
 */
export async function person(clock, net, o = {}) {
  const kp = await generateKeyPair();
  const pub = await exportPublicKey(kp.publicKey);
  const chat = await generateChatKey();
  const tm = new FakeTM();
  const cfg = Object.assign({ chat: 'open', requests: 'off', chatBits: 10, calls: 'contacts' }, o.cfg || {});
  const chatSvc = createChatService({
    keys: { pub, sign: (b) => sign(kp.privateKey, b), chat },
    ledgerId: LEDGER, node: fakeNode(), cfg: () => cfg, deviceClass: 'desktop', hostOnly: false, ownTracker: 'wss://tracker.example.test',
    wires: tm, store: memStore(), prompt: async () => true,
    now: clock.now, setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout, random: Math.random,
    ckShare: 'reason', // review round R 5.3 (PRIV-2): the policy the loader passes
  });
  await chatSvc.methods['chat.enable']({}, CLICK);
  const browser = net.browser(o.name || 'p', o.browser || {});
  const prompts = [];
  const answers = Object.assign({}, o.answers || {});
  const state = { hostOnly: false, policy: Object.assign({ class: 'desktop', metered: false }, o.policy || {}), prefs: Object.assign({ sameLan: false, hideIp: false }, o.prefs || {}), yields: [] };
  const calls = createCallService(Object.assign({
    chat: chatSvc.sig,
    keys: { pub },
    cfg: () => cfg,
    policy: () => state.policy,
    hostOnly: () => state.hostOnly,
    stun: ['stun:stun.example.test:3478'],
    turn: null,
    prefs: () => state.prefs,
    RTCPeerConnection: browser.RTCPeerConnection,
    mediaDevices: browser.mediaDevices,
    wakeLock: browser.wakeLock,
    mediaSession: browser.mediaSession,
    prompt: async (kind, data) => {
      prompts.push([kind, data]);
      const a = answers[kind];
      return typeof a === 'function' ? a(data) : (a === undefined ? true : a);
    },
    deviceClass: 'desktop',
    now: clock.now, setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout,
    onSeedYield: (s) => state.yields.push(s),
  }, o.callDeps || {}));
  const events = {};
  for (const e of CALL_EVENTS) {
    events[e] = [];
    calls.on(e, (x) => events[e].push(x));
  }
  const chatEvents = {};
  for (const e of CHAT_EVENTS) {
    chatEvents[e] = [];
    chatSvc.on(e, (x) => chatEvents[e].push(x));
  }
  return {
    name: o.name || 'p', pub, chat, tm, chatSvc, calls, events, chatEvents, prompts, answers, browser, cfg, state,
    call: (m, p, ctx = CLICK) => calls.methods[m](p, ctx),
    async close() {
      await calls.destroy();
      await chatSvc.destroy();
    },
  };
}

/**
 * Waits until a and b hold each other's chat key. Review round R 5.3 (PRIV-2): with ckShare 'reason' a neighbour that is
 * not a contact gets no CK frame, so a side that does not have the other's key yet is handed it as a ledger copy (mw.ck)
 * would hand it (sig.learn); contacts get theirs over the wire.
 */
export async function knowEachOther(clock, a, b) {
  const both = () => a.chatSvc.sig.ckOf(b.pub) && b.chatSvc.sig.ckOf(a.pub);
  try {
    await until(clock, both, { ms: 3000, label: 'chat keys over the wire' });
    return;
  } catch (_) { /* not contacts: no reason to send a CK */ }
  for (const [x, y] of [[a, b], [b, a]]) {
    if (x.chatSvc.sig.ckOf(y.pub)) continue;
    const ck = y.chatSvc.sig.ckOf(y.pub);
    if (ck) await x.chatSvc.sig.learn(ck);
  }
  await until(clock, () => a.chatSvc.sig.ckOf(b.pub) && b.chatSvc.sig.ckOf(a.pub), { label: 'chat keys exchanged' });
}

/** people(n, ...) -> n people, every pair joined by a wire, every pair contacts of each other (unless contacts: false). */
export async function people(clock, net, n, { contacts = true, wire = true, opts = [] } = {}) {
  const list = [];
  for (let i = 0; i < n; i++) list.push(await person(clock, net, Object.assign({ name: 'P' + i }, opts[i] || {})));
  // Review round R 5.3 (PRIV-2): with ckShare 'reason' a CK goes only to a contact or to a key this tab looks for, so the
  // contacts come first; without contacts each side learns the other's CK directly (as calls-service.test.mjs does).
  if (contacts) {
    for (const a of list) for (const b of list) if (a !== b) await a.chatSvc.methods['chat.contacts.add']({ pub: b.pub, nick: b.name }, CLICK);
  }
  if (wire) {
    for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) connect(list[i], list[j]);
    for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) await knowEachOther(clock, list[i], list[j]);
  }
  return list;
}

export async function code(p) {
  try {
    await p;
  } catch (e) {
    return e.code || ('no-code: ' + e.message);
  }
  return null;
}
