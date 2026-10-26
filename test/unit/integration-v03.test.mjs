// v0.3 wave 1 integration (integrator-owned): the seams between lanes that each lane tested only against
// its own fakes. docs/deviations/integration-v03.md lists the findings these tests pin (I-1 to I-5).
//
//   I-1  redress.js: the ancestor walk skips a real ShadowRoot (nodeType 11, no tagName); getComputedStyle on
//        it threw in Chromium, so every drop-in panel button (Share and load) failed (e2e 10B, OPFS).
//   I-3  torrent.js FileTorrentHandle: the surface the media and files lanes call (on/once/off, 'verified',
//        metadata(), prioritize, downloaded, numPeers, stopSeeding, destroy). Before it, those calls were
//        guarded no-ops: deleted, revoked and unshared files kept seeding and MF-55's metadata check was skipped.
//   I-4  sealed items (idcore) under the freeze lane's schema rule: kinds 1 to 3 pass schemaOk('mw.s'); kinds 4
//        and 5 pass only when the sealed box puts nothing but the 1,040-byte ciphertext in ct (R 2.6.2): the
//        chat lane's sealTo with the sender's own chat key as the ephemeral does, epk || ct (1,105 bytes) is
//        hidden by every v0.3 reducer.
//   I-5  the grant hint: idcore's hintFor(kPair, ms) and the chat lane's hint(kPair, day) agree.
//   I-7  the chat lane's registerChatWire on the real TorrentManager.registerWireExtension and joinLane: mw_chat1 rides
//        chat-lane wires, never web seeds, and the lane sees a wire after the extended handshake.
//   I-8  the chat service takes hostOnly as a function (as the media and files services do) or a boolean.
//
// Run: node --test test/unit/integration-v03.test.mjs
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { checkElement } from '../../src/widget/redress.js';
import { TorrentManager, FileTorrentHandle } from '../../src/loader/torrent.js';
import { CONFIG } from '../../src/loader/config.js';
import { seal, open, hintFor, KINDS, PLAINTEXT_BYTES } from '../../src/identity/sealed.js';
import { schemaOk } from '../../src/chain/state.js';
import { generateChatKey, sealTo, openFrom, rawPoint, pairKey, hint as chatHint } from '../../src/chat/seal.js';
import { b64url, utf8 } from '../../src/chain/canonical.js';

// ---------------------------------------------------------------------------------------------- I-1 redress
describe('I-1 redress: real shadow roots in the ancestor walk', () => {
  // A DOM shaped like Chromium's: elements have nodeType 1 and a tagName; a ShadowRoot is nodeType 11 with no
  // tagName and no parentNode (its host continues the walk); the document is nodeType 9. getComputedStyle
  // throws a TypeError for anything that is not an element, as the real one does.
  function realisticDom() {
    const doc = { nodeType: 9, parentNode: null };
    const html = { nodeType: 1, tagName: 'HTML', parentNode: doc };
    const body = { nodeType: 1, tagName: 'BODY', parentNode: html };
    const host = { nodeType: 1, tagName: 'DIV', parentNode: body };
    const shadow = { nodeType: 11, parentNode: null, host };
    const card = { nodeType: 1, tagName: 'DIV', parentNode: shadow };
    const button = { nodeType: 1, tagName: 'BUTTON', parentNode: card };
    const rect = { x: 10, y: 10, width: 100, height: 30 };
    button.getBoundingClientRect = () => rect;
    shadow.elementFromPoint = () => button;
    button.getRootNode = () => shadow;
    doc.elementFromPoint = () => host;
    const styles = new Map([[button, { opacity: '1', visibility: 'visible', display: 'inline-block', pointerEvents: 'auto' }]]);
    const win = {
      innerWidth: 800,
      innerHeight: 600,
      document: doc,
      getComputedStyle(n) {
        if (!n || n.nodeType !== 1) throw new TypeError("Failed to execute 'getComputedStyle' on 'Window': parameter 1 is not of type 'Element'.");
        return styles.get(n) || { opacity: '1', visibility: 'visible', display: 'block' };
      },
    };
    return { win, doc, host, button, styles, card };
  }

  test('a button inside a closed shadow root passes, and a faded ancestor above the root still fails', () => {
    const d = realisticDom();
    assert.deepEqual(checkElement(d.button, { win: d.win, doc: d.doc, host: d.host, strict: false }), { ok: true });
    assert.deepEqual(checkElement(d.button, { win: d.win, doc: d.doc, host: d.host, strict: true }), { ok: true });
    d.styles.set(d.host, { opacity: '0.2', visibility: 'visible', display: 'block' });
    assert.deepEqual(checkElement(d.button, { win: d.win, doc: d.doc, host: d.host }), { ok: false, reason: 'opacity' }, 'the walk continues past the shadow root to its host');
  });
});

// ---------------------------------------------------------------------------------------------- I-3 torrent handle
class Emitter {
  constructor() { this._l = new Map(); }
  on(t, fn) { if (!this._l.has(t)) this._l.set(t, []); this._l.get(t).push(fn); return this; }
  once(t, fn) { const w = (...a) => { this.removeListener(t, w); fn(...a); }; return this.on(t, w); }
  removeListener(t, fn) { const l = this._l.get(t); if (l) { const i = l.indexOf(fn); if (i !== -1) l.splice(i, 1); } return this; }
  emit(t, ...a) { for (const fn of (this._l.get(t) || []).slice()) fn(...a); return true; }
}
const FILE = 'f'.repeat(40);
const INFO = new Uint8Array([0x64, 0x31, 0x3a, 0x61, 0x69, 0x31, 0x65, 0x65]); // d1:ai1ee
const TORRENT = new Uint8Array([9, 9, 9]);
const PARSED = { infoHash: FILE, name: 'm', pieceLength: 65536, length: 131072, files: [], infoBytes: INFO, announce: [], urlList: [] };

class FakeTorrent extends Emitter {
  constructor(source, opts) { super(); this.source = source; this.opts = opts; this.destroyed = false; this.infoHash = FILE; this.critical_ = []; this.downloaded = 4096; this.numPeers = 2; }
  destroy(opts) { this.destroyed = true; this.destroyOpts = opts; this.emit('close'); }
  critical(a, b) { this.critical_.push([a, b]); }
}
class FakeWebTorrent extends Emitter {
  constructor(opts) { super(); this.opts = opts; this.torrents = []; }
  add(source, opts) { const t = new FakeTorrent(source, opts); this.torrents.push(t); return t; }
  destroy() { for (const t of this.torrents) if (!t.destroyed) t.destroy(); }
  throttleUpload() {}
}
class FakeClock {
  constructor() { this.t = 1000; this.timers = new Map(); this.id = 0; }
  setTimeout(fn, ms) { const id = ++this.id; this.timers.set(id, { fn, at: this.t + ms }); return id; }
  clearTimeout(id) { this.timers.delete(id); }
  setInterval(fn, ms) { const id = ++this.id; this.timers.set(id, { fn, at: this.t + ms, every: ms }); return id; }
  clearInterval(id) { this.timers.delete(id); }
  now() { return this.t; }
  fire(ms) {
    this.t += ms;
    for (const [id, tm] of Array.from(this.timers)) if (tm.at <= this.t && !tm.every) { this.timers.delete(id); tm.fn(); }
  }
}
class FakeStore {
  constructor(chunkLength) { this.chunkLength = chunkLength; this.data = new Map(); this.destroyed = false; }
  put(i, b, cb) { this.data.set(i, b); if (cb) cb(null); }
  get(i, o, cb) { if (typeof o === 'function') cb = o; cb(null, this.data.get(i)); }
  close(cb) { if (cb) cb(null); }
  destroy(cb) { this.destroyed = true; if (cb) cb(null); }
}
const flush = () => new Promise((resolve) => setImmediate(resolve));

function manager(clock = new FakeClock()) {
  const tm = new TorrentManager({
    WebTorrent: FakeWebTorrent,
    config: CONFIG,
    policy: { maxConns: 30, uploadsEnabled: true, uploadLimit: 1048576, hostOnly: false, leaveVersionSwarm: false },
    consent: { peersAllowed: () => true, onChange() {} },
    deps: {
      MemoryChunkStore: class {},
      BlobChunkStore: class {},
      parseTorrentFile: async (u8) => {
        if (u8 && u8.length === 3 && u8[0] === 9) return PARSED;
        throw new Error('not a torrent');
      },
    },
    timers: clock,
    fetch: async () => { throw new Error('no network in this test'); },
    baseUrl: 'http://127.0.0.1:1/',
    lifecycle: false,
  });
  return { tm, clock };
}

describe('I-3 FileTorrentHandle: the surface of the media and files lanes', () => {
  test('on/once/off map the EventTarget events; verified gives the piece index; prioritize, downloaded, numPeers use the live torrent', async () => {
    const { tm } = manager();
    const store = new FakeStore(65536);
    const h = await tm.addFileTorrent({ torrentFile: TORRENT, store, announce: ['ws://127.0.0.1:9/announce'] });
    assert.ok(h instanceof FileTorrentHandle);
    const t = h.torrent;
    assert.ok(t, 'the torrent is added at once with consent');
    const verified = [];
    const fn = (i) => verified.push(i);
    h.on('verified', fn);
    let dones = 0;
    h.once('done', () => { dones++; });
    t.emit('verified', 3);
    t.emit('verified', 7);
    h.off('verified', fn);
    t.emit('verified', 9);
    assert.deepEqual(verified, [3, 7], 'piece indexes until off()');
    t.emit('done');
    t.emit('done');
    assert.equal(dones, 1, 'once');
    h.prioritize(0, 2);
    assert.deepEqual(t.critical_, [[0, 2]]);
    assert.equal(h.downloaded, 4096);
    assert.equal(h.numPeers, 2);
    tm.destroy();
  });

  test('metadata(): at once for a handle added from a .torrent, after the swarm sent it for one added by infohash', async () => {
    const { tm } = manager();
    const a = await tm.addFileTorrent({ torrentFile: TORRENT, store: new FakeStore(65536), announce: ['ws://127.0.0.1:9/announce'] });
    const bytes = await a.metadata();
    assert.equal(utf8.decode(bytes), 'd4:infod1:ai1eee', 'the info dictionary in a minimal .torrent');
    const ih = 'e'.repeat(40);
    const b = await tm.addFileTorrent({ infoHash: ih, store: new FakeStore(65536), announce: ['ws://127.0.0.1:9/announce'] });
    let got = null;
    // WebTorrent builds a torrentFile as soon as a magnet is added, without an info dictionary (v0.3 final integration:
    // metadata() took those bytes and every fetch by infohash failed 'missing info dictionary', E-FI-1 and E-MD-4).
    b.torrent.torrentFile = new Uint8Array([100, 101]);
    const p = b.metadata().then((x) => { got = x; });
    await flush();
    assert.equal(got, null, 'nothing before the info dictionary arrives, even with WebTorrent\'s early torrentFile');
    b.torrent.info = { a: 1 };
    b.torrent.torrentFile = new Uint8Array([100, 102]);
    b.torrent.emit('metadata');
    await p;
    assert.deepEqual(Array.from(got), [100, 102]);
    tm.destroy();
  });

  test('metadata() fails with E_FILE_UNAVAILABLE when the handle leaves first or nobody sends it in time', async () => {
    const { tm, clock } = manager();
    const ih = 'd'.repeat(40);
    const h = await tm.addFileTorrent({ infoHash: ih, store: new FakeStore(65536), announce: ['ws://127.0.0.1:9/announce'] });
    const left = h.metadata();
    await h.leave({ now: true });
    await assert.rejects(left, (err) => err.code === 'E_FILE_UNAVAILABLE');
    const h2 = await tm.addFileTorrent({ infoHash: 'c'.repeat(40), store: new FakeStore(65536), announce: ['ws://127.0.0.1:9/announce'] });
    const late = h2.metadata({ timeoutMs: 5000 });
    clock.fire(5001);
    await assert.rejects(late, (err) => err.code === 'E_FILE_UNAVAILABLE');
    tm.destroy();
  });

  test('stopSeeding() and destroy() leave the swarm at once and never destroy the store (the lanes own it)', async () => {
    const { tm } = manager();
    const store = new FakeStore(65536);
    const h = await tm.addFileTorrent({ torrentFile: TORRENT, store, announce: ['ws://127.0.0.1:9/announce'] });
    const t = h.torrent;
    let leftEvents = 0;
    h.on('left', () => { leftEvents++; });
    assert.equal(await h.destroy({ keepStore: false }), true);
    assert.equal(h.left, true);
    assert.equal(t.destroyed, true);
    assert.deepEqual(t.destroyOpts, { destroyStore: false });
    assert.equal(store.destroyed, false);
    assert.equal(leftEvents, 1);
    const h2 = await tm.addFileTorrent({ infoHash: 'b'.repeat(40), store: new FakeStore(65536), announce: ['ws://127.0.0.1:9/announce'] });
    const t2 = h2.torrent;
    await h2.stopSeeding();
    assert.equal(t2.destroyed, true, 'a received item that is not kept stops seeding');
    tm.destroy();
  });
});

// ---------------------------------------------------------------------------------------------- I-4 sealed items
describe('I-4 sealed items under the freeze schema rule (R 2.6.2: ct is exactly 1,040 bytes)', () => {
  const ledgerId = 'mw1:ZMEMZC5pWJAiSBavcxQ6rUTngUo';

  test('kinds 1 to 3 (a media own-index item as the media lane writes it) pass schemaOk and open', async () => {
    const key = globalThis.crypto.getRandomValues(new Uint8Array(32));
    const authorPub = 'p256:' + b64url.encode(new Uint8Array(65).fill(4));
    const data = utf8.encode(JSON.stringify({ M: { v: 1, fid: 'x'.repeat(22), name: 'video-1.mp4' }, fk: b64url.encode(new Uint8Array(32)) }));
    const v = await seal({ kind: KINDS.MEDIA_OWN, data, key, ledgerId, authorPub });
    assert.equal(b64url.decode(v.ct).length, PLAINTEXT_BYTES + 16);
    assert.equal(schemaOk('mw.s', v), true);
    const back = await open({ value: v, ledgerId, authorPub, key });
    assert.equal(back.kind, KINDS.MEDIA_OWN);
    assert.deepEqual(Array.from(back.data), Array.from(data));
  });

  test('kinds 4 and 5: the chat sealed box with the sender\'s chat key as the ephemeral gives 1,040 bytes; epk || ct is hidden', async () => {
    const alice = await generateChatKey();
    const bob = await generateChatKey();
    const authorPub = alice.pub; // any tagged key; the AAD binds it
    // Adapters as the wiring must build them (sealed.js calls sealTo(theirChatPub, plaintext, { aad, iv })):
    const sealToStatic = async (theirChatPub, plain, { aad, iv }) =>
      (await sealTo({ myChat: alice, theirChatPub, ledgerId, data: plain, aad, ephemeral: alice, iv })).ct;
    const openFromStatic = (me, senderPub) => async (ct, { aad, iv }) =>
      openFrom({ myChat: me, theirChatPub: senderPub, ledgerId, epk: rawPoint(senderPub), iv, ct, aad });
    const grant = utf8.encode(JSON.stringify({ t: 'media', G: { from: alice.pub, to: bob.pub } }));
    const v = await seal({ kind: KINDS.GRANT, data: grant, ledgerId, authorPub, sealTo: sealToStatic, theirChatPub: bob.pub });
    assert.equal(b64url.decode(v.ct).length, 1040);
    assert.equal(schemaOk('mw.s', v), true, 'the grant is visible to a v0.3 reducer');
    const opened = await open({ value: v, ledgerId, authorPub, openFrom: openFromStatic(bob, alice.pub) });
    assert.ok(opened && opened.kind === KINDS.GRANT, 'the recipient opens it with the sender\'s chat key');
    assert.deepEqual(Array.from(opened.data), Array.from(grant));
    // A third key cannot open it.
    const eve = await generateChatKey();
    assert.equal(await open({ value: v, ledgerId, authorPub, openFrom: openFromStatic(eve, alice.pub) }), null);
    // The tempting adapter: a fresh ephemeral packed in front of the ciphertext. sealed.js accepts it (ct >= 1,024),
    // but the freeze schema hides it, so nobody would ever see the grant.
    const sealToPacked = async (theirChatPub, plain, { aad, iv }) => {
      const r = await sealTo({ myChat: alice, theirChatPub, ledgerId, data: plain, aad, iv });
      const out = new Uint8Array(r.epk.length + r.ct.length);
      out.set(r.epk, 0);
      out.set(r.ct, r.epk.length);
      return out;
    };
    const packed = await seal({ kind: KINDS.GRANT, data: grant, ledgerId, authorPub, sealTo: sealToPacked, theirChatPub: bob.pub });
    assert.equal(b64url.decode(packed.ct).length, 1105);
    assert.equal(schemaOk('mw.s', packed), false);
  });
});

// ---------------------------------------------------------------------------------------------- I-5 hints
test('I-5 the grant hint: sealed.hintFor(kPair, ms) equals chat seal.hint(kPair, day) for the same day', async () => {
  const a = await generateChatKey();
  const b = await generateChatKey();
  const kPair = await pairKey(a, b.pub, 'mw1:ZMEMZC5pWJAiSBavcxQ6rUTngUo');
  const ms = Date.UTC(2026, 9, 20, 15, 0, 0);
  const day = Math.floor(ms / 86400000);
  assert.deepEqual(Array.from(await hintFor(kPair, ms)), Array.from(await chatHint(kPair, day)));
});

// ---------------------------------------------------------------------------------------------- I-7 chat wire seam
// The chat lane registers mw_chat1 through the harden-loader seam; both lanes tested against fakes of the other.
describe('I-7 chat wire on the real TorrentManager seam', () => {
  function chatWire({ type = 'webrtc', peerId = 'p1' } = {}) {
    const w = new Emitter();
    w.type = type;
    w.peerId = peerId;
    w.destroyed = false;
    w.used = [];
    w.sentExtended = [];
    w._onMessageLength = function () { return 'orig'; };
    w._parse = function () {};
    w.choke = function () {};
    w.unchoke = function () {};
    w.setTimeout = function () {};
    w.setKeepAlive = function () {};
    w.use = function (Ext) { const e = new Ext(this); this.used.push(e); return e; };
    w.extended = function (name, bytes) { this.sentExtended.push([name, bytes.length]); };
    w.destroy = function () { if (this.destroyed) return; this.destroyed = true; this.emit('close'); };
    return w;
  }

  test('registerChatWire(tm, lane) attaches mw_chat1 to chat-lane wires; the lane sees the wire after the extended handshake', async () => {
    const { registerChatWire } = await import('../../src/chat/wire.js');
    const { tm } = manager();
    const attached = [];
    const lane = {
      attachWire: (w) => attached.push(w),
      detachWire: () => {},
      onMessage: () => undefined,
      strike: () => {},
    };
    const off = registerChatWire(tm, lane);
    const handle = tm.joinLane({ kind: 'chat', infoHash: 'c'.repeat(40), announce: ['ws://127.0.0.1:9/announce'] });
    assert.ok(handle.torrent, 'the chat lane swarm is joined (consent given, own tracker)');
    const w = chatWire();
    handle.torrent.emit('wire', w);
    assert.equal(w.used.length, 1, 'mw_chat1 was put on the chat-lane wire');
    assert.equal(w.used[0].name, 'mw_chat1');
    w.used[0].onExtendedHandshake({ m: { mw_chat1: 3 } });
    assert.equal(attached.length, 1);
    assert.equal(attached[0].swarm, 'chat');
    assert.equal(attached[0].send(new Uint8Array(10)), true);
    assert.deepEqual(w.sentExtended, [['mw_chat1', 10]]);
    const web = chatWire({ type: 'webSeed' });
    handle.torrent.emit('wire', web);
    assert.equal(web.used.length, 0, 'web seeds never get the chat extension');
    off();
    tm.destroy();
  });
});

// ---------------------------------------------------------------------------------------------- I-8 live host-only
// The SVC deps of the media and files services take hostOnly as a function; the chat service read it as a value, so a
// function always looked "on" and a boolean snapshot missed a later host-only choice. It now takes either.
test('I-8 chat service: hostOnly as a function counts at each call; a boolean still works', async () => {
  const { createChatService } = await import('../../src/chat/service.js');
  let hostOnly = false;
  const chat = await generateChatKey();
  const kp = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign', 'verify']);
  const raw = new Uint8Array(await crypto.subtle.exportKey('raw', kp.publicKey));
  const pub = 'p256:' + b64url.encode(raw);
  const prompts = [];
  const make = (h) => createChatService({
    keys: { pub, sign: async () => new Uint8Array(64), chat },
    ledgerId: 'mw1:ZMEMZC5pWJAiSBavcxQ6rUTngUo',
    node: { syncing: false, state: { owner: null, policy: { banned: new Set(), moderators: new Set(), allow: new Set(), writers: 'open' }, lists: new Map() }, append: () => ({ h: 'x' }) },
    cfg: () => ({ chat: 'open' }),
    hostOnly: h,
    ownTracker: null,
    wires: null,
    store: { async get() { return undefined; }, async set() {} },
    prompt: async (kind) => { prompts.push(kind); return false; },
  });
  const live = make(() => hostOnly);
  const codeOf = (p) => p.then(() => null, (e) => e.code);
  assert.notEqual(await codeOf(live.methods['chat.enable']({}, { activation: true })), 'E_HOST_ONLY', 'host-only off: not refused for host-only');
  hostOnly = true;
  assert.equal(await codeOf(live.methods['chat.enable']({}, { activation: true })), 'E_HOST_ONLY', 'a later host-only choice counts at once');
  assert.equal((await live.methods['chat.state']({}, {})).hostOnly, true);
  const fixed = make(true);
  assert.equal(await codeOf(fixed.methods['chat.enable']({}, { activation: true })), 'E_HOST_ONLY', 'a boolean works as before');
  await live.destroy();
  await fixed.destroy();
});
