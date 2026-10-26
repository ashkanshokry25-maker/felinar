// Code review v0.3 fixes in the torrent manager and the media route (loader-sw fixer, 2026-10-20): chat, group, file and
// media swarms gather ICE through the site's own STUN servers only, and the chat card names them (conformance, MF-44,
// R 2.7.1; the drop-in reads the list only when a swarm or the chat card needs it); a seek puts its pieces in front of the
// whole-file selection (correctness, R 2.9.6), and a cancelled range stream tells the page (mw-chunk-cancel).
import { test } from 'node:test';
import assert from 'node:assert/strict';
// webtorrent pulls in webrtc-polyfill and the native node-datachannel binding, which a clean install never has
// (install scripts stay off): stub WebRTC first, then load webtorrent (see no-native-webrtc.mjs).
import './no-native-webrtc.mjs';

import { TorrentManager, FileTorrentHandle, laneIceServersOf, OWN_STUN_KINDS } from '../../src/loader/torrent.js';
import { MemoryChunkStore } from '../../src/loader/memory-chunk-store.js';
import { CONFIG } from '../../src/loader/config.js';
import { cardFor, stunNames, promptAdapter, createTorrentSeam } from '../../src/loader/api.js';
import { DropinEngine } from '../../src/dropin/engine.js';
import { cardText } from '../../src/loader/strings.js';
import { createMediaRoute } from '../../src/sw/media-route.js';
import { MSG } from '../../src/sw/protocol.js';

const { default: WebTorrent } = await import('webtorrent');

const BTIH = 'a'.repeat(40);

class Emitter {
  constructor () { this._l = new Map() }
  on (t, fn) { if (!this._l.has(t)) this._l.set(t, []); this._l.get(t).push(fn); return this }
  once (t, fn) { const w = (...a) => { this.removeListener(t, w); fn(...a) }; return this.on(t, w) }
  removeListener (t, fn) { const l = this._l.get(t); if (l) { const i = l.indexOf(fn); if (i !== -1) l.splice(i, 1) } return this }
  emit (t, ...a) { for (const fn of (this._l.get(t) || []).slice()) fn(...a); return true }
}

class FakeTorrent extends Emitter {
  constructor (client, source, opts) { super(); this.client = client; this.source = source; this.opts = opts; this.destroyed = false; this.files = []; this.infoHash = typeof source === 'string' && /^[0-9a-f]{40}$/.test(source) ? source : BTIH }
  // What WebTorrent 3 does: build the discovery's tracker options from client.tracker, synchronously.
  _startDiscovery () { this.seenRtc = this.client.tracker && this.client.tracker.rtcConfig }
  destroy () { this.destroyed = true; this.emit('close') }
  addWebSeed () {}
}

class FakeWebTorrent extends Emitter {
  constructor (opts) { super(); this.opts = opts; this.tracker = opts.tracker; this.torrents = []; FakeWebTorrent.last = this }
  add (source, opts) { const t = new FakeTorrent(this, source, opts); this.torrents.push(t); return t }
  destroy () { for (const t of this.torrents) if (!t.destroyed) t.destroy() }
  throttleUpload () {}
}

const flush = () => new Promise((r) => setImmediate(r));

function manager () {
  const deps = {
    MemoryChunkStore: class { constructor (c, o) { this.chunkLength = c; this.length = o.length } put (i, b, cb) { cb(null) } get (i, o, cb) { cb(null, new Uint8Array(1)) } close (cb) { cb && cb(null) } destroy (cb) { cb && cb(null) } },
    BlobChunkStore: class {},
    parseTorrentFile: async () => ({ infoHash: BTIH, name: 'x', pieceLength: 16384, length: 10, files: [{ path: 'x', length: 10, offset: 0 }], infoBytes: new Uint8Array([0x64, 0x65]) }),
  };
  return new TorrentManager({
    WebTorrent: FakeWebTorrent, config: CONFIG,
    policy: { maxConns: 30, uploadsEnabled: true, uploadLimit: 1048576, hostOnly: false, leaveVersionSwarm: false },
    consent: { peersAllowed: () => true, onChange () {} }, deps,
    timers: { setTimeout: () => 0, clearTimeout () {}, setInterval: () => 0, clearInterval () {}, now: () => 1000 },
    fetch: async () => { throw new TypeError('no network in unit tests') }, baseUrl: 'https://site.example/page', lifecycle: false,
  });
}

test('chat, group, file and media swarms use the site\'s own STUN servers; the ledger and content swarms keep the defaults', async () => {
  assert.deepEqual([...OWN_STUN_KINDS], ['chat', 'group', 'file']);
  assert.deepEqual(laneIceServersOf(['stun:stun.site.test:3478', { urls: 'stuns:s2.site.test' }, 'turn:x', 'http://evil', 5]), [{ urls: 'stun:stun.site.test:3478' }, { urls: 'stuns:s2.site.test' }]);
  const tm = manager();
  const lane = tm.joinLane({ kind: 'chat', infoHash: 'c'.repeat(40), announce: ['wss://own.site.test'] });
  const chatTorrent = lane.torrent;
  assert.ok(chatTorrent);
  chatTorrent._startDiscovery();
  assert.deepEqual(chatTorrent.seenRtc.iceServers, [], 'no STUN named yet: host candidates only, never the shared defaults');
  const shared = FakeWebTorrent.last.tracker.rtcConfig;
  assert.notEqual(chatTorrent.seenRtc, shared);
  assert.equal(FakeWebTorrent.last.tracker.rtcConfig, shared, 'the client keeps its shared config after the call');
  tm.setLaneIceServers(['stun:stun.site.test:3478']);
  const group = tm.joinLane({ kind: 'group', infoHash: 'd'.repeat(40), announce: ['wss://own.site.test'] }).torrent;
  group._startDiscovery();
  assert.deepEqual(group.seenRtc.iceServers, [{ urls: 'stun:stun.site.test:3478' }]);
  assert.deepEqual(chatTorrent.seenRtc.iceServers, [{ urls: 'stun:stun.site.test:3478' }], 'a lane already running follows the change (one shared lane object)');
  const handle = await tm.addFileTorrent({ infoHash: 'e'.repeat(40), store: MemoryChunkStore, announce: ['wss://own.site.test'] });
  handle.torrent._startDiscovery();
  assert.deepEqual(handle.torrent.seenRtc.iceServers, [{ urls: 'stun:stun.site.test:3478' }], 'files and private media too');
  assert.ok(!JSON.stringify(handle.torrent.seenRtc).includes('cloudflare') && !JSON.stringify(handle.torrent.seenRtc).includes('twilio'));
  // The site swarm: the shared, probe-gated defaults.
  tm.download({ record: { btih: BTIH, signed: true, tr: ['wss://own.site.test'] } }).catch(() => {});
  await flush(); await flush();
  const site = FakeWebTorrent.last.torrents.find((t) => t.source !== 'c'.repeat(40) && t.source !== 'd'.repeat(40) && t.source !== 'e'.repeat(40) && !String(t.source).startsWith('magnet:'));
  if (site) {
    site._startDiscovery();
    assert.equal(site.seenRtc, shared);
  }
  assert.deepEqual(tm.laneIceServers, [{ urls: 'stun:stun.site.test:3478' }]);
  tm.destroy();
});

test('the chat card names the STUN servers the chat lane really uses, never an empty name', () => {
  const data = { ledgerCopy: false, tracker: 'wss://t.site.test' }; // what src/chat/service.js passes
  const card = cardFor('chat.enable', data, { stun: ['stun:stun.site.test:3478'] });
  const text = cardText(card.data.card, 'en', card.data.params);
  assert.ok(text.includes('wss://t.site.test and stun.site.test.'), text);
  assert.ok(!text.includes(' and .'));
  const none = cardText('turnOnChat', 'en', cardFor('chat.enable', data, { stun: [] }).data.params);
  assert.ok(none.includes('and no STUN server.'), none);
  assert.equal(stunNames(['stun:a.example', 'stun:b.example:3478', 'stuns:c.example'], 'en'), 'a.example, b.example and c.example');
  assert.equal(stunNames([], 'fr'), 'aucun serveur STUN');
});

test('the drop-in reads the site\'s STUN list only when a swarm or the chat card needs it, from its copy before the host', async () => {
  // The seam settles beforeSwarm() before a lane or a file swarm starts.
  const order = [];
  const tm = { joinLane: (o) => { order.push('join'); return { o } }, addFileTorrent: async () => { order.push('file'); return {} } };
  const seam = createTorrentSeam({ get: () => tm, ensure: async () => tm, beforeSwarm: async () => { await flush(); order.push('stun') } });
  await seam.joinLane({ kind: 'chat' });
  await seam.addFileTorrent({ infoHash: 'e'.repeat(40) });
  assert.deepEqual(order, ['stun', 'join', 'stun', 'file']);
  // The chat card waits for a late list; other cards never ask for it.
  let asked = 0;
  let shown = null;
  const ui = { prompt: async (kind, data) => { shown = { kind, data }; return true } };
  const prompt = promptAdapter(ui, { stun: async () => { asked++; await flush(); return ['stun:late.site.test'] } });
  assert.equal(await prompt('chat.enable', { ledgerCopy: false, tracker: 'wss://t.site.test' }), true);
  assert.ok(cardText(shown.data.card, 'en', shown.data.params).includes('wss://t.site.test and late.site.test.'));
  await prompt('file-share', { public: false, name: 'a.txt', size: 3 });
  assert.equal(asked, 1, 'only the chat card reads the STUN list');
  // DropinEngine.laneStun(): the copy is the site, so a copy answers without a request.
  const make = (copy) => {
    const e = Object.create(DropinEngine.prototype);
    const fetched = [];
    const set = { tm: null, api: null };
    e.copy = copy;
    e.laneStunList = null;
    e.laneStunPromise = null;
    e.tm = { setLaneIceServers: (l) => { set.tm = l } };
    e.api = { setLaneStun: (l) => { set.api = l } };
    e.win = { fetch: async (url) => { fetched.push(String(url)); return new Response(JSON.stringify({ stun: ['stun:host.site.test'] }), { status: 200 }) } };
    return { e, fetched, set };
  };
  const withFile = make({ blobs: new Map([['.mw/site.json', new Blob([JSON.stringify({ stun: ['stun:copy.site.test:3478'] })])]]) });
  assert.deepEqual(await withFile.e.laneStun(), ['stun:copy.site.test:3478']);
  assert.deepEqual(withFile.fetched, [], 'no request: the stored copy has the list');
  assert.deepEqual(withFile.set.tm, ['stun:copy.site.test:3478']);
  assert.deepEqual(withFile.set.api, ['stun:copy.site.test:3478']);
  await withFile.e.laneStun();
  assert.deepEqual(withFile.fetched, []);
  const noFile = make({ blobs: new Map([['index.html', new Blob(['x'])]]) });
  assert.deepEqual(await noFile.e.laneStun(), [], 'a copy without .mw/site.json: the site names no STUN');
  assert.deepEqual(noFile.fetched, []);
  const noCopy = make(null);
  assert.deepEqual(await noCopy.e.laneStun(), ['stun:host.site.test']);
  assert.deepEqual(noCopy.fetched, ['/.mw/site.json'], 'no copy yet: the host\'s own file, once');
  await noCopy.e.laneStun();
  assert.equal(noCopy.fetched.length, 1);
});

test('a cancelled range stream sends mw-chunk-cancel for the chunks still requested', async () => {
  const route = createMediaRoute({ env: { setTimeout: (fn, ms) => setTimeout(fn, ms), clearTimeout: (t) => clearTimeout(t) } });
  const posted = [];
  const port = { postMessage: (m) => posted.push(m), start () {} };
  const sid = 'f'.repeat(32);
  const reg = await route.register({ sid, kind: 'file', file: { name: 'a.bin', size: 4 * 1024, block: 1024 } }, { ports: [port] });
  assert.equal(reg.ok, true);
  const res = await route.handle({}, new Request('https://site.test/_mw/f/' + sid, { headers: { Range: 'bytes=0-4095' } }), new URL('https://site.test/_mw/f/' + sid));
  assert.equal(res.status, 206);
  const reader = res.body.getReader();
  const first = reader.read();
  await flush();
  const needs = posted.filter((m) => m.type === MSG.chunkNeed);
  assert.ok(needs.length >= 1);
  // Answer the first chunk, then the player lets go of the stream (a seek elsewhere).
  port.onmessage({ data: { type: MSG.chunk, req: needs[0].req, i: needs[0].i, data: new Uint8Array(1024).buffer } });
  await first;
  await reader.cancel();
  await flush();
  const cancels = posted.filter((m) => m.type === MSG.chunkCancel);
  assert.ok(cancels.length >= 1, 'the page hears which chunks nobody waits for');
  for (const c of cancels) {
    assert.equal(c.sid, sid);
    assert.ok(needs.some((n) => n.req === c.req && n.i === c.i));
    assert.notEqual(c.req, needs[0].req, 'never for a chunk already answered');
  }
});

test('a seek puts its piece in front of the whole file: two WebTorrent clients over loopback, the seeder at 256 KiB/s', { timeout: 60000 }, async () => {
  const opts = { dht: false, tracker: false, lsd: false, natUpnp: false, natPmp: false, utp: false, webSeeds: false };
  const seeder = new WebTorrent(Object.assign({}, opts, { uploadLimit: 262144 }));
  const leecher = new WebTorrent(opts);
  try {
    const P = 65536;
    const N = 64;
    const buf = new Uint8Array(P * N);
    for (let i = 0; i < buf.length; i++) buf[i] = (i * 31 + (i >> 16)) & 255;
    const st = await new Promise((resolve) => seeder.seed(Buffer.from(buf), { name: 'v.bin', pieceLength: P, announce: [], private: true }, resolve));
    await new Promise((resolve) => (seeder.listening ? resolve() : seeder.once('listening', resolve)));
    const t0 = Date.now();
    const lt = leecher.add(st.torrentFile, { announce: [], private: true, store: MemoryChunkStore });
    const fakeTm = { _t: { now: () => Date.now() }, _applyFileLock () {}, _applyUploadThrottle () {}, _seedReplanSoon () {} };
    const h = new FileTorrentHandle(fakeTm, { infoHash: lt.infoHash || 'b'.repeat(40), parsed: null, announce: [], store: MemoryChunkStore, retain: true, uploadException: false });
    h._torrent = lt;
    const SEEK = 60;
    const order = [];
    let seekAt = null;
    lt.on('ready', () => {
      h.prioritize(SEEK, SEEK);
      assert.deepEqual(h.priorityRanges, [{ from: SEEK, to: SEEK }]);
    });
    lt.on('verified', (i) => {
      order.push(i);
      if (i === SEEK) seekAt = Date.now() - t0;
      h.dispatchEvent(new CustomEvent('verified', { detail: { index: i } }));
    });
    const addIt = () => lt.addPeer('127.0.0.1:' + seeder.torrentPort);
    if (lt.infoHash) addIt(); else lt.once('infoHash', addIt);
    await new Promise((resolve) => { const iv = setInterval(() => { if (seekAt !== null) { clearInterval(iv); resolve(); } }, 20); });
    assert.ok(order.indexOf(SEEK) <= 3, 'the seek piece came among the first: ' + order.slice(0, 8).join(','));
    assert.ok(seekAt < 8000, 'within ' + seekAt + ' ms, not after the 59 pieces before it');
    assert.deepEqual(h.priorityRanges, [], 'the range left the front once its piece verified');
    // deprioritize drops a range nobody waits for.
    h.prioritize(10, 12);
    h.deprioritize(11, 11);
    assert.deepEqual(h.priorityRanges, []);
  } finally {
    await new Promise((r) => leecher.destroy(r));
    await new Promise((r) => seeder.destroy(r));
  }
});
