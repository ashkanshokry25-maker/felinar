// Unit tests for src/media/service.js, src/media/lane.js, src/media/session.js, src/files/service.js and
// src/files/lane.js (R 2.8, 2.9, 2.11.2): gating in order (E_HOST_ONLY with no request, E_POLICY,
// E_NEEDS_GESTURE, E_NOT_SIGNED_IN), every error the review lists, and the flows end to end in Node with
// fakes for the ledger node, the torrent seam (a fake swarm that copies pieces between chunk stores),
// the chat service, the sealed-item codec and the prompt, and the real Service Worker route
// (src/sw/media-route.js) behind an in-memory channel. No method result ever carries fk.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createMediaService, cfgOn } from '../../src/media/service.js';
import { createFilesService } from '../../src/files/service.js';
import { MediaSessions } from '../../src/media/session.js';
import { createMediaRoute } from '../../src/sw/media-route.js';
import { MSG, PROTO } from '../../src/sw/protocol.js';
import { memoryBackend, IdbChunkStore } from '../../src/files/store-idb.js';
import { defaultStores } from '../../src/media/service.js';
import { parseTorrentFile } from '../../src/common/torrent-file.js';
import { decode } from '../../src/common/bencode.js';
import { bucketBytes } from '../../src/media/pad.js';
import { b64url, hex } from '../../src/chain/canonical.js';
import { sniff } from '../../src/media/sniff.js';

const ORIGIN = 'https://site.test';
const ME = 'p256:me';
const BO = 'p256:bo';
const CY = 'p256:cy';

// ------------------------------------------------------------------------------------------- fakes

function jpegBytes(n, seed = 1) {
  const u = new Uint8Array(n);
  for (let i = 0; i < n; i++) u[i] = (i * 31 + seed) & 255;
  u.set([0xff, 0xd8, 0xff, 0xe0, 0, 16, 0x4a, 0x46, 0x49, 0x46, 0], 0);
  return u;
}

function fakeNode(author) {
  const lists = new Map();
  let n = 0;
  const node = {
    state: { lists, tombstoned: new Set() },
    appends: [],
    async append(l, v) {
      const h = (++n).toString(16).padStart(64, '0') + author.slice(-2);
      const list = lists.get(l) || [];
      list.push({ h, author, ts: n, v });
      lists.set(l, list);
      node.appends.push({ l, v, h });
      return { h };
    },
    async tombstone(h) {
      for (const [k, list] of lists) lists.set(k, list.filter((it) => it.h !== h));
      node.state.tombstoned.add(h);
      return { h: 'tomb-' + h };
    },
  };
  return node;
}

/** The ledger seen by several devices of one site: every node shares the lists. */
function sharedLedger() {
  const lists = new Map();
  const tombstoned = new Set();
  let n = 0;
  return (author) => ({
    state: { lists, tombstoned },
    async append(l, v) {
      const h = (++n).toString(16).padStart(64, '0');
      const list = lists.get(l) || [];
      list.push({ h, author, ts: n, v });
      lists.set(l, list);
      return { h };
    },
    async tombstone(h) {
      for (const [k, list] of lists) lists.set(k, list.filter((it) => it.h !== h));
      tombstoned.add(h);
      return { h: 't' + h };
    },
  });
}

const sealed = {
  async seal({ kind, data, ledgerId, authorPub }) {
    return { enc: 'mw-seal-v1', iv: 'iv', ct: b64url.encode(data), k: kind, a: authorPub, l: ledgerId };
  },
  async open(v, { authorPub }) {
    if (v.a !== authorPub) throw new Error('not ours');
    return { kind: v.k, data: b64url.decode(v.ct) };
  },
  async sealTo({ kind, data, to }) {
    return { enc: 'mw-seal-v1', iv: 'iv', ct: b64url.encode(data), k: kind, hint: to };
  },
};

/** A swarm: seeders register their store class; leechers copy every piece from a seeder. */
function fakeSwarm() {
  const swarm = { torrents: new Map(), adds: [] };
  swarm.manager = (who) => ({
    async addFileTorrent(opts) {
      swarm.adds.push(Object.assign({ who }, opts));
      const listeners = new Map();
      const handle = {
        destroyed: false,
        downloaded: 0,
        numPeers: 0,
        opts,
        on(e, fn) {
          if (!listeners.has(e)) listeners.set(e, []);
          listeners.get(e).push(fn);
        },
        once(e, fn) {
          handle.on(e, fn);
        },
        fire(e, x) {
          for (const fn of listeners.get(e) || []) fn(x);
        },
        prioritize() {},
        destroy() {
          handle.destroyed = true;
        },
      };
      if (opts.torrentFile) {
        const parsed = await parseTorrentFile(opts.torrentFile);
        handle.infoHash = parsed.infoHash;
        swarm.torrents.set(parsed.infoHash, { torrentFile: opts.torrentFile, Store: opts.store, parsed, who });
        handle.metadata = async () => opts.torrentFile;
        return handle;
      }
      handle.infoHash = opts.infoHash;
      const seed = swarm.torrents.get(opts.infoHash);
      handle.metadata = async () => {
        if (!seed) throw new Error('no peers');
        return swarm.lie && swarm.lie[opts.infoHash] ? swarm.lie[opts.infoHash] : seed.torrentFile;
      };
      if (seed && !swarm.offline) {
        handle.numPeers = 1;
        setTimeout(async () => {
          const p = seed.parsed;
          const from = new seed.Store(p.pieceLength, { length: p.length });
          const to = new opts.store(p.pieceLength, { length: p.length });
          for (let i = 0; i < p.pieceCount; i++) {
            const bytes = await from.getAsync(i);
            if (!bytes) continue;
            const b = swarm.tamper && swarm.tamper[opts.infoHash] ? bytes.map((x) => x ^ 1) : bytes;
            await to.putAsync(i, b);
            handle.downloaded += b.length;
            handle.fire('verified', i);
          }
          handle.fire('done');
        }, 1);
      }
      return handle;
    },
  });
  return swarm;
}

function fakeChat(devices) {
  const sent = [];
  const chat = (from) => ({
    dm: {
      async send(pub, payload) {
        sent.push({ from, to: pub, payload });
        const target = devices[pub];
        if (!target) return { id: String(sent.length), state: 'outbox' };
        if (target.blocked) {
          const e = new Error('blocked');
          e.code = 'E_BLOCKED';
          throw e;
        }
        setTimeout(() => {
          if (payload.grant && payload.grant.t === 'file') target.files.onGrant(from, payload.grant);
          else if (payload.grant) target.media.onGrant(from, payload.grant);
        }, 0);
        return { id: String(sent.length), state: 'delivered' };
      },
    },
  });
  chat.sent = sent;
  return chat;
}

function fakeChannel() {
  const a = { onmessage: null, closed: false };
  const b = { onmessage: null, closed: false };
  const link = (x, y) => {
    x.postMessage = (m) => {
      if (x.closed) return;
      setTimeout(() => y.onmessage && !y.closed && y.onmessage({ data: m }), 0);
    };
    x.close = () => {
      x.closed = true;
    };
    x.start = () => {};
  };
  link(a, b);
  link(b, a);
  return { port1: a, port2: b };
}

function fakeWorker(route, { ready = true } = {}) {
  return {
    ready: () => ready,
    post(msg, transfer) {
      if (msg.type === MSG.sessionRegister) {
        const port = transfer[0];
        route.register(msg, { ports: [port], source: { id: 'engine' } }).then((ack) => port.postMessage(Object.assign({ proto: PROTO, type: 'mw-ack', of: msg.type }, ack)));
      } else if (msg.type === MSG.sessionClose) {
        route.close(msg, { source: { id: 'engine' } });
      }
    },
  };
}

let seedCounter = 0;
function rng() {
  let s = ++seedCounter * 7919;
  return (n) => {
    const u = new Uint8Array(n);
    for (let i = 0; i < n; i++) u[i] = (s = (s * 1103515245 + 12345) >>> 0) >>> 24;
    return u;
  };
}

/**
 * device({ pub, ... }) -> { media, files, prompts, route, node, ... }: one signed-in person with the real
 * services, a real worker route, and fakes elsewhere.
 */
function device(o) {
  const prompts = [];
  const answers = o.answers || {};
  const route = createMediaRoute({ env: { now: () => 1000, clients: { async get(id) { return { id }; }, async matchAll() { return []; } } }, limits: { reregisterWaitMs: 50 } });
  const backend = memoryBackend();
  const stores = defaultStores(backend);
  const random = rng();
  const sessions = new MediaSessions({ sw: o.noWorker ? null : fakeWorker(route), channel: fakeChannel, random, capBytes: o.capBytes || 25 * 1024 * 1024, URL: { createObjectURL: (b) => { const u = 'blob:' + ORIGIN + '/' + (++seedCounter); blobs.set(u, b); return u; }, revokeObjectURL: (u) => blobs.delete(u) }, keyTransfer: o.keyTransfer || 'cryptokey' });
  const blobs = new Map();
  const downloads = [];
  const cfgValue = Object.assign({ media: 'members', files: 'members' }, o.cfg || {});
  const deps = {
    keys: o.signedOut ? null : { pub: o.keysPub || o.pub, own: { k: 'own' } },
    ledgerId: 'mw1:test',
    node: o.node,
    cfg: () => cfgValue,
    deviceClass: o.deviceClass || 'desktop',
    hostOnly: () => Boolean(o.hostOnly),
    ownTracker: o.noTracker ? null : 'ws://127.0.0.1:8000',
    torrents: o.swarm.manager(o.pub),
    chat: o.chat(o.pub),
    sealed,
    isDenied: o.isDenied || (async () => false),
    prompt: async (card) => {
      prompts.push(card);
      const a = answers[card.kind];
      return a === undefined ? true : typeof a === 'function' ? a(card) : a;
    },
    swPort: null,
    sessions,
    makeStore: stores.makeStore,
    storeClass: stores.storeClass,
    random,
    now: () => 1792500000000,
    strip: o.strip || {
      async stripImage(blob) {
        return { blob: new Blob([await blob.arrayBuffer()], { type: 'image/jpeg' }), removed: ['exif', 'icc', 'thumbnail'], mime: 'image/jpeg', w: 64, h: 48 };
      },
      async stripMp4(blob) {
        return { blob, removed: ['moov/udta'] };
      },
      async stripWebm(blob) {
        return { blob, removed: ['Tags'] };
      },
    },
    faststart: async (blob) => ({ blob, moved: false }),
    makePoster: o.makePoster || (async () => ({ blob: new Blob([jpegBytes(3000, 5)], { type: 'image/jpeg' }), mime: 'image/jpeg', w: 64, h: 48 })),
    canPlay: () => true,
    download: async (url, name) => downloads.push({ url, name }),
    pin: o.pin,
    chunkWaitMs: 2000,
    doneWaitMs: 2000,
    pollMs: 5,
  };
  const media = createMediaService(deps);
  const files = createFilesService(deps);
  return { media, files, prompts, route, backend, sessions, deps, blobs, downloads, cfg: cfgValue };
}

function world(extra = {}) {
  const swarm = fakeSwarm();
  const devices = {};
  const chat = fakeChat(devices);
  const ledger = sharedLedger();
  const make = (pub, o = {}) => {
    const d = device(Object.assign({ pub, swarm, chat, node: ledger(pub) }, extra, o));
    devices[pub] = d;
    return d;
  };
  return { swarm, devices, chat, make };
}

const ACT = { activation: true };
const code = (c) => (e) => {
  assert.equal(e.code, c, 'expected ' + c + ', got ' + e.code + ' (' + e.message + ')');
  return true;
};
const settle = (ms = 20) => new Promise((r) => setTimeout(r, ms));

async function get(route, path, headers = {}) {
  const url = new URL(ORIGIN + path);
  return route.handle({}, { url: url.href, headers: new Headers(headers) }, url);
}

function noKey(value, fk) {
  const s = JSON.stringify(value);
  for (const form of [b64url.encode(fk), hex.encode(fk)]) assert.ok(s.indexOf(form) < 0, 'a result carries fk');
}

// ------------------------------------------------------------------------------------------- gating

test('gating order: E_HOST_ONLY with no prompt and no torrent; E_POLICY; E_NEEDS_GESTURE; E_NOT_SIGNED_IN; E_NO_OWN_TRACKER', async () => {
  const w = world();
  const file = new Blob([jpegBytes(5000)], { type: 'image/jpeg' });
  const h = w.make(ME, { hostOnly: true });
  await assert.rejects(h.media.methods['media.upload']({ file }, ACT), code('E_HOST_ONLY'));
  await assert.rejects(h.media.methods['media.share']({ id: 'x', to: [BO] }, ACT), code('E_HOST_ONLY'));
  await assert.rejects(h.files.methods['files.share']({ file, public: true }, ACT), code('E_HOST_ONLY'));
  await assert.rejects(h.files.methods['files.fetch']({ ref: 'a'.repeat(40) }, {}), code('E_HOST_ONLY'));
  assert.equal(h.prompts.length, 0, 'no card');
  assert.equal(w.swarm.adds.length, 0, 'no request');
  assert.deepEqual(await h.media.methods['media.list']({}, {}), [], 'reading still works host-only');
  const off = w.make(BO, { cfg: { media: 'off', files: 'off' } });
  await assert.rejects(off.media.methods['media.upload']({ file }, ACT), code('E_POLICY'));
  await assert.rejects(off.media.methods['media.list']({}, {}), code('E_POLICY'));
  await assert.rejects(off.files.methods['files.list']({}, {}), code('E_POLICY'));
  const on = w.make(CY);
  for (const m of ['media.upload', 'media.share', 'media.revoke', 'media.delete', 'media.keepAvailable']) {
    await assert.rejects(on.media.methods[m]({ file, id: 'x' }, {}), code('E_NEEDS_GESTURE'), m);
  }
  for (const m of ['files.share', 'files.save', 'files.keepSharing', 'files.enable', 'files.remove']) {
    await assert.rejects(on.files.methods[m]({ file, ref: 'x', public: true }, { activation: false }), code('E_NEEDS_GESTURE'), m);
  }
  const out = w.make('p256:out', { signedOut: true });
  await assert.rejects(out.media.methods['media.upload']({ file }, ACT), code('E_NOT_SIGNED_IN'));
  await assert.rejects(out.media.methods['media.open']({ id: 'x' }, {}), code('E_NOT_SIGNED_IN'));
  const nt = w.make('p256:nt', { noTracker: true });
  await assert.rejects(nt.media.methods['media.upload']({ file }, ACT), code('E_NO_OWN_TRACKER'));
  assert.equal(cfgOn({ media: 'members' }, 'media'), true);
  assert.equal(cfgOn({ media: 'off' }, 'media'), false);
  assert.equal(cfgOn({}, 'media'), false);
});

test('upload errors: E_MEDIA_TYPE, E_LIMIT (phone cap), E_USER_CANCELLED, E_MEDIA_STRIP and "Upload anyway"', async () => {
  const w = world();
  const a = w.make(ME, { deviceClass: 'mobileMetered' });
  await assert.rejects(a.media.methods['media.upload']({ file: new Blob(['<svg onload=alert(1)>']) }, ACT), code('E_MEDIA_TYPE'));
  await assert.rejects(a.media.methods['media.upload']({ file: new Blob(['plain text']) }, ACT), code('E_MEDIA_TYPE'));
  const big = new Blob([jpegBytes(16), new Uint8Array(25 * 1024 * 1024)]);
  await assert.rejects(a.media.methods['media.upload']({ file: big }, ACT), code('E_LIMIT'));
  const b = w.make(BO, { answers: { 'media-upload': false } });
  await assert.rejects(b.media.methods['media.upload']({ file: new Blob([jpegBytes(5000)]) }, ACT), code('E_USER_CANCELLED'));
  const failing = { async stripImage() { const e = new Error('cannot decode'); e.code = 'E_MEDIA_STRIP'; throw e; } };
  const c = w.make(CY, { strip: failing, answers: { 'media-strip-failed': false } });
  await assert.rejects(c.media.methods['media.upload']({ file: new Blob([jpegBytes(5000)]) }, ACT), code('E_MEDIA_STRIP'));
  assert.equal(c.prompts[0].choice, 'Upload anyway (may include your location)');
  const d = w.make('p256:dd', { strip: failing });
  const r = await d.media.methods['media.upload']({ file: new Blob([jpegBytes(5000)]) }, ACT);
  assert.equal(r.kind, 'image', 'the person chose to upload anyway');
  assert.equal(d.prompts.find((p) => p.kind === 'media-upload').stripFailed, true);
});

// ------------------------------------------------------------------------------------------- media flows

test('media upload: ciphertext only in the store, padded to the bucket, sealed own-index item, own tracker only', async () => {
  const w = world();
  const a = w.make(ME);
  const events = [];
  a.media.on('progress', (p) => events.push(p.phase));
  const src = jpegBytes(300000, 9);
  const r = await a.media.methods['media.upload']({ file: new Blob([src], { type: 'image/jpeg' }) }, ACT);
  assert.deepEqual(Object.keys(r).sort(), ['h', 'id', 'kind', 'len', 'mime', 'w'].sort());
  assert.equal(r.kind, 'image');
  assert.equal(r.len, src.length);
  for (const phase of ['strip', 'poster', 'encrypt', 'seed']) assert.ok(events.includes(phase), phase);
  const card = a.prompts.find((p) => p.kind === 'media-upload');
  assert.equal(card.text, 'Location and camera details removed');
  const add = w.swarm.adds[0];
  assert.deepEqual(add.announce, ['ws://127.0.0.1:8000']);
  assert.equal(add.retain, true);
  const info = decode(add.torrentFile).value.info;
  assert.equal(info.private, 1);
  assert.equal(info['x-mw-nonce'].length, 16);
  assert.equal(info.length, bucketBytes(info.length), 'the torrent is a bucket');
  const rec = a.media.lane.items.get(r.id);
  for (let i = 0; i < rec.M.total; i++) {
    const ct = await rec.store.getAsync(i);
    assert.equal(ct.length, rec.M.P);
    assert.ok(!(ct[0] === 0xff && ct[1] === 0xd8), 'no JPEG magic at a chunk start');
  }
  const own = a.deps.node.state.lists.get('mw.s');
  assert.equal(own.length, 1);
  assert.equal(own[0].v.k, 3, 'kind 3: media-own');
  noKey(r, rec.fk);
  noKey(await a.media.methods['media.list']({}, {}), rec.fk);
  const list = await a.media.methods['media.list']({ from: 'mine' }, {});
  assert.equal(list[0].available, 'online');
  assert.equal(list[0].from, 'mine');
});

test('media playback: open gives /_mw/media/<sid>; the worker route serves the decrypted bytes with Range; close ends it', async () => {
  const w = world();
  const a = w.make(ME);
  const src = jpegBytes(200000, 3);
  const r = await a.media.methods['media.upload']({ file: new Blob([src]) }, ACT);
  const o = await a.media.methods['media.open']({ id: r.id }, {});
  assert.match(o.url, /^\/_mw\/media\/[0-9a-f]{32}$/);
  assert.equal(o.mime, 'image/jpeg');
  noKey(o, a.media.lane.items.get(r.id).fk);
  const res = await get(a.route, o.url);
  assert.equal(res.status, 200);
  assert.deepEqual(new Uint8Array(await res.arrayBuffer()), src);
  const part = await get(a.route, o.url, { Range: 'bytes=0-1' });
  assert.equal(part.status, 206);
  assert.deepEqual(new Uint8Array(await part.arrayBuffer()), src.subarray(0, 2));
  const poster = await a.media.methods['media.open']({ id: r.id, part: 'poster' }, {});
  const pres = await get(a.route, poster.url);
  assert.deepEqual(new Uint8Array(await pres.arrayBuffer()), jpegBytes(3000, 5));
  await a.media.methods['media.close']({ id: r.id }, {});
  await settle();
  assert.equal((await get(a.route, o.url)).status, 410, 'the sid is gone after close');
});

test('raw key transfer (the CryptoKey clone fallback of G-MD-6) plays the same', async () => {
  const w = world();
  const a = w.make(ME, { keyTransfer: 'raw' });
  const src = jpegBytes(70000, 4);
  const r = await a.media.methods['media.upload']({ file: new Blob([src]) }, ACT);
  const o = await a.media.methods['media.open']({ id: r.id }, {});
  assert.deepEqual(new Uint8Array(await (await get(a.route, o.url)).arrayBuffer()), src);
});

test('no worker: the Blob fallback up to the class cap, E_LIMIT above it', async () => {
  const w = world();
  const a = w.make(ME, { noWorker: true, capBytes: 1024 * 1024 });
  const src = jpegBytes(100000, 6);
  const r = await a.media.methods['media.upload']({ file: new Blob([src]) }, ACT);
  const o = await a.media.methods['media.open']({ id: r.id }, {});
  assert.match(o.url, /^blob:/);
  assert.equal(o.note, 'Played from memory on this browser.');
  const blob = a.blobs.get(o.url);
  assert.equal(blob.type, 'image/jpeg');
  assert.deepEqual(new Uint8Array(await blob.arrayBuffer()), src);
  const big = w.make(BO, { noWorker: true, capBytes: 50000 });
  const r2 = await big.media.methods['media.upload']({ file: new Blob([src]) }, ACT);
  await assert.rejects(big.media.methods['media.open']({ id: r2.id }, {}), code('E_LIMIT'));
});

test('share, offer, accept, play from the swarm; revoke makes open() E_REVOKED; never auto-accepted', async () => {
  const w = world();
  const a = w.make(ME);
  const b = w.make(BO);
  const c = w.make(CY, { answers: { 'media-offer': false } });
  const src = jpegBytes(150000, 8);
  const r = await a.media.methods['media.upload']({ file: new Blob([src]) }, ACT);
  const received = [];
  b.media.on('received', (x) => received.push(x));
  const s = await a.media.methods['media.share']({ id: r.id, to: [BO, CY, 'p256:offline'] }, ACT);
  assert.deepEqual(s.granted, [BO, CY]);
  assert.deepEqual(s.held, ['p256:offline']);
  await settle(30);
  await b.media.settled();
  await c.media.settled();
  assert.equal(received.length, 1);
  assert.equal(received[0].from, ME);
  assert.ok(b.prompts.some((p) => p.kind === 'media-offer' && p.from === ME), 'the offer card');
  assert.ok(c.prompts.some((p) => p.kind === 'media-offer'));
  assert.deepEqual(await c.media.methods['media.list']({}, {}), [], 'a declined offer leaves nothing');
  assert.ok(!w.swarm.adds.some((x) => x.who === CY), 'a declined offer fetches nothing');
  const list = await b.media.methods['media.list']({ from: 'received' }, {});
  assert.equal(list.length, 1);
  assert.equal(list[0].from, ME);
  const leech = w.swarm.adds.find((x) => x.who === BO);
  assert.equal(leech.infoHash, a.media.lane.items.get(r.id).M.ih);
  assert.deepEqual(leech.announce, ['ws://127.0.0.1:8000']);
  await settle(30);
  const o = await b.media.methods['media.open']({ id: r.id }, {});
  assert.deepEqual(new Uint8Array(await (await get(b.route, o.url)).arrayBuffer()), src);
  const grant = w.chat.sent.find((m) => m.to === BO).payload.grant;
  assert.equal(grant.t, 'media');
  assert.equal(grant.G.to, BO);
  const rv = await a.media.methods['media.revoke']({ id: r.id, from: [BO] }, ACT);
  assert.deepEqual(rv, { revoked: [BO], reencrypted: false, id: r.id });
  assert.ok(a.prompts.some((p) => p.kind === 'media-revoke' && /may have kept a copy/.test(p.text)));
  await settle(20);
  await assert.rejects(b.media.methods['media.open']({ id: r.id }, {}), code('E_REVOKED'));
  assert.equal((await get(b.route, o.url)).status, 410, 'the session ended with the key');
});

test('revoke with reencrypt: a new fk, fid and torrent; the remaining recipient gets the new item', async () => {
  const w = world();
  const a = w.make(ME);
  const b = w.make(BO);
  const c = w.make(CY);
  const src = jpegBytes(80000, 2);
  const r = await a.media.methods['media.upload']({ file: new Blob([src]) }, ACT);
  await a.media.methods['media.share']({ id: r.id, to: [BO, CY] }, ACT);
  await settle(30);
  const oldIh = a.media.lane.items.get(r.id).M.ih;
  const oldFk = a.media.lane.items.get(r.id).fk;
  const shared = [];
  a.media.on('shared', (x) => shared.push(x));
  const rv = await a.media.methods['media.revoke']({ id: r.id, from: [BO], reencrypt: true }, ACT);
  assert.equal(rv.reencrypted, true);
  // The item moved to idOf(new M): the id recipients and a later restore() key it by (code review v0.3).
  assert.notEqual(rv.id, r.id);
  assert.equal(a.media.lane.items.has(r.id), false);
  const rec = a.media.lane.items.get(rv.id);
  assert.equal(rec.id, rv.id);
  assert.deepEqual(shared.find((x) => x.replaces === r.id), { id: rv.id, kind: 'own', replaces: r.id }, 'the site hears the new id');
  assert.notEqual(rec.M.ih, oldIh);
  assert.notDeepEqual(rec.fk, oldFk);
  assert.equal((await a.media.methods['media.list']({ from: 'mine' }, {}))[0].id, rv.id);
  await settle(40);
  await c.media.settled();
  const cl = await c.media.methods['media.list']({}, {});
  assert.equal(cl.length, 2, 'the old grant and the new one');
  const newId = cl.map((x) => x.id).find((id) => id !== r.id);
  assert.equal(newId, rv.id, 'the recipient keys the new grant by the same id');
  await settle(30);
  const o = await c.media.methods['media.open']({ id: newId }, {});
  assert.deepEqual(new Uint8Array(await (await get(c.route, o.url)).arrayBuffer()), src);
  const own = a.deps.node.state.lists.get('mw.s');
  assert.equal(own.filter((x) => x.author === ME && x.v.k === 3).length, 1, 'the old own-index item was tombstoned');
  // A later revoke reaches the remaining recipient under every id it holds the item by; the old id still works here.
  const rv2 = await a.media.methods['media.revoke']({ id: r.id, from: [CY] }, ACT);
  assert.deepEqual(rv2.revoked, [CY]);
  await settle(30);
  await assert.rejects(c.media.methods['media.open']({ id: newId }, {}), code('E_REVOKED'));
  await assert.rejects(c.media.methods['media.open']({ id: r.id }, {}), code('E_REVOKED'));
  assert.deepEqual(await c.media.methods['media.list']({}, {}), []);
  void b;
});

test('delete: tombstones the own-index item, revokes every grant, drops the store; restore() on another device', async () => {
  const w = world();
  const a = w.make(ME);
  const r = await a.media.methods['media.upload']({ file: new Blob([jpegBytes(9000)]) }, ACT);
  const a2 = w.make('p256:me2', { keysPub: ME });
  assert.equal(await a2.media.restore(), 1, 'the own copy opens on a linked device');
  assert.equal((await a2.media.methods['media.list']({}, {}))[0].id, r.id);
  await a.media.methods['media.share']({ id: r.id, to: [BO] }, ACT);
  const d = await a.media.methods['media.delete']({ id: r.id }, ACT);
  assert.deepEqual(d, { deleted: true });
  assert.equal(a.deps.node.state.lists.get('mw.s').filter((x) => x.v.k === 3).length, 0);
  assert.ok(w.chat.sent.some((m) => m.to === BO && m.payload.grant.t === 'revoke'));
  await assert.rejects(a.media.methods['media.open']({ id: r.id }, {}), code('E_FILE_UNAVAILABLE'));
});

test('keepAvailable shows the IP sentence; pinRequest needs a pin node; an offline uploader gives E_FILE_UNAVAILABLE', async () => {
  const w = world();
  const pins = [];
  const a = w.make(ME, { pin: { request: async (x) => pins.push(x) } });
  const r = await a.media.methods['media.upload']({ file: new Blob([jpegBytes(9000)]) }, ACT);
  assert.deepEqual(await a.media.methods['media.keepAvailable']({ id: r.id, on: true }, ACT), { on: true });
  assert.ok(a.prompts.some((p) => p.kind === 'media-keep-available' && p.text === 'Others can see your IP address next to this file.'));
  assert.deepEqual(await a.media.methods['media.pinRequest']({ id: r.id }, {}), { requested: true });
  assert.deepEqual(Object.keys(pins[0]).sort(), ['author', 'ih', 'size']);
  const b = w.make(BO);
  await assert.rejects(b.media.methods['media.pinRequest']({ id: r.id }, {}), code('E_FILE_UNAVAILABLE'));
  await a.media.methods['media.share']({ id: r.id, to: [BO] }, ACT);
  w.swarm.offline = true;
  await settle(30);
  await b.media.settled();
  const o = await b.media.methods['media.open']({ id: r.id }, {});
  const res = await get(b.route, o.url);
  await assert.rejects(res.arrayBuffer(), 'nobody holds the ciphertext');
});

test('a grant from the wrong sender, to someone else, or for a denied infohash is ignored', async () => {
  const w = world();
  const a = w.make(ME);
  const r = await a.media.methods['media.upload']({ file: new Blob([jpegBytes(9000)]) }, ACT);
  const rec = a.media.lane.items.get(r.id);
  const G = { M: rec.M, fk: b64url.encode(rec.fk), from: ME, to: BO };
  const b = w.make(BO, { isDenied: async (h) => h === 'deny-me' });
  assert.equal(await b.media.onGrant(CY, { t: 'media', G }), null, 'from is not the sender');
  assert.equal(await b.media.onGrant(ME, { t: 'media', G: Object.assign({}, G, { to: CY }) }), null, 'not for me');
  assert.equal(await b.media.onGrant(ME, { t: 'media', G: Object.assign({}, G, { fk: 'AAAA' }) }), null, 'a short key');
  const c = w.make(CY, { isDenied: async (h) => h === rec.M.ih });
  assert.equal(await c.media.onGrant(ME, { t: 'media', G: Object.assign({}, G, { to: CY }) }), null, 'a denied infohash');
});

// ------------------------------------------------------------------------------------------- files flows

test('public file: share lists it (schema, sniffed type, random name), fetch needs the click card, verifies SHA-256, never re-seeds', async () => {
  const w = world();
  const a = w.make(ME);
  const b = w.make(BO);
  const data = new TextEncoder().encode('hello public world\n'.repeat(5000));
  const s = await a.files.methods['files.share']({ file: new Blob([data]), public: true }, ACT);
  assert.equal(s.listed, true);
  const listing = a.deps.node.state.lists.get('mw.files')[0].v;
  assert.deepEqual(Object.keys(listing).sort(), ['ih', 'len', 'mime', 'name', 'sha256', 't']);
  assert.match(listing.name, /^note-[a-z2-7]{4}\.txt$/);
  assert.equal(listing.mime, 'text/plain');
  const list = await b.files.methods['files.list']({}, {});
  assert.equal(list.length, 1);
  assert.equal(list[0].fetched, false, 'nothing fetched before a click');
  assert.equal(w.swarm.adds.filter((x) => x.who === BO).length, 0);
  const cancelled = w.make(CY, { answers: { 'file-fetch': false } });
  await assert.rejects(cancelled.files.methods['files.fetch']({ ref: s.ref }, {}), code('E_USER_CANCELLED'));
  assert.equal(w.swarm.adds.filter((x) => x.who === CY).length, 0, 'a cancelled card fetches nothing');
  const h = await b.files.methods['files.fetch']({ ref: s.ref }, {});
  assert.ok(b.prompts.some((p) => p.kind === 'file-fetch' && p.note === 'Fetching also shares it with others while this page is open'));
  assert.equal(h.mime, 'application/octet-stream');
  const blob = await h.blob();
  assert.equal(blob.type, 'application/octet-stream');
  assert.deepEqual(new Uint8Array(await blob.arrayBuffer()), data);
  const leech = w.swarm.adds.find((x) => x.who === BO);
  assert.deepEqual(leech.announce, ['ws://127.0.0.1:8000']);
  assert.equal(b.files.lane.files.get(s.ref).handle, null, 'left the torrent after the fetch (no re-seed)');
  await b.files.methods['files.keepSharing']({ ref: s.ref, on: true }, ACT);
  assert.ok(b.prompts.some((p) => p.kind === 'file-help-share' && p.text === 'Others can see your IP address next to this file.'));
  const pv = await b.files.methods['files.preview']({ ref: s.ref }, {});
  assert.equal(pv.kind, 'text');
  const saved = await b.files.methods['files.save']({ ref: s.ref }, ACT);
  assert.equal(saved.mode, 'worker');
  assert.match(b.downloads[0].url, /^\/_mw\/f\/[0-9a-f]{32}$/);
  const res = await get(b.route, b.downloads[0].url, { Range: 'bytes=65530-65545' });
  assert.equal(res.status, 206);
  assert.equal(res.headers.get('Content-Type'), 'application/octet-stream');
  assert.deepEqual(new Uint8Array(await res.arrayBuffer()), data.subarray(65530, 65546));
});

test('public file errors: E_DENIED before any request, E_FILE_HASH on tampered bytes or a lying length (hidden after), E_LIMIT caps', async () => {
  const w = world();
  const a = w.make(ME);
  const data = new TextEncoder().encode('x'.repeat(40000));
  const s = await a.files.methods['files.share']({ file: new Blob([data]), public: true, name: 'notes.txt' }, ACT);
  const sha = a.deps.node.state.lists.get('mw.files')[0].v.sha256;
  const denied = w.make(BO, { isDenied: async (h) => h === sha });
  await assert.rejects(denied.files.methods['files.fetch']({ ref: s.ref }, {}), code('E_DENIED'));
  assert.equal(w.swarm.adds.filter((x) => x.who === BO).length, 0);
  assert.equal(denied.prompts.length, 0, 'no card for a denied file');
  w.swarm.tamper = { [s.ref]: true };
  const c = w.make(CY);
  await assert.rejects(c.files.methods['files.fetch']({ ref: s.ref }, {}), code('E_FILE_HASH'));
  assert.equal((await c.files.methods['files.list']({}, {})).length, 0, 'the listing is hidden after a mismatch');
  w.swarm.tamper = {};
  // a listing whose len lies: the torrent says 40,000 bytes
  await a.deps.node.append('mw.files', { ih: s.ref, len: 1000, name: 'liar.txt', mime: 'text/plain', t: 1 });
  const d = w.make('p256:dd');
  const lists = d.deps.node.state.lists.get('mw.files');
  lists.splice(0, 1); // only the lying copy is effective for this test
  await assert.rejects(d.files.methods['files.fetch']({ ref: s.ref }, {}), (e) => e.code === 'E_FILE_HASH' && e.reason === 'length');
  await assert.rejects(a.files.methods['files.share']({ file: new Blob([new Uint8Array(25 * 1024 * 1024 + 1)]), public: true }, ACT), code('E_LIMIT'));
  const phone = w.make('p256:ph', { deviceClass: 'mobileUnknown' });
  await assert.rejects(phone.files.methods['files.share']({ file: new Blob([new Uint8Array(25 * 1024 * 1024 + 1)]), to: [ME] }, ACT), code('E_LIMIT'));
});

test('public uploads strip metadata or are refused (E_MEDIA_STRIP); per-author listing cap of 20', async () => {
  const w = world();
  const failing = { async stripImage() { const e = new Error('x'); e.code = 'E_MEDIA_STRIP'; throw e; } };
  const a = w.make(ME, { strip: failing });
  await assert.rejects(a.files.methods['files.share']({ file: new Blob([jpegBytes(5000)]), public: true }, ACT), code('E_MEDIA_STRIP'));
  const b = w.make(BO);
  for (let i = 0; i < 20; i++) await b.files.methods['files.share']({ file: new Blob(['file ' + i]), public: true }, ACT);
  await assert.rejects(b.files.methods['files.share']({ file: new Blob(['one more']), public: true }, ACT), code('E_LIMIT'));
});

test('private file (F2): STREAM records in a private swarm, a grant through chat, the recipient decrypts; others get ciphertext only', async () => {
  const w = world();
  const a = w.make(ME);
  const b = w.make(BO);
  const data = new Uint8Array(150000).map((_, i) => (i * 7) & 255);
  data.set([0x4d, 0x5a], 0); // an executable: saving needs the second confirmation
  const s = await a.files.methods['files.share']({ file: new Blob([data]), to: [BO] }, ACT);
  assert.equal(s.listed, false);
  assert.equal(a.deps.node.state.lists.get('mw.files'), undefined, 'no listing for a private file');
  const info = decode(w.swarm.adds[0].torrentFile).value.info;
  assert.equal(info.private, 1);
  assert.equal(info['x-mw-nonce'].length, 16);
  await settle(20);
  const rec = await b.files.methods['files.received']({}, {});
  assert.equal(rec.length, 1);
  assert.equal(rec[0].from, ME);
  const h = await b.files.methods['files.fetch']({ ref: rec[0].ref }, {});
  assert.deepEqual(new Uint8Array(await (await h.blob()).arrayBuffer()), data);
  noKey(h, a.files.lane.files.get(s.ref).fk);
  noKey(rec, a.files.lane.files.get(s.ref).fk);
  const stranger = new IdbChunkStore(65536, { name: 'p-' + s.ref, length: 262144, backend: a.backend });
  const first = await stranger.getAsync(0);
  assert.ok(first && sniff(first).kind !== 'executable', 'the swarm carries ciphertext: no MZ header');
  await assert.rejects(b.files.methods['files.save']({ ref: rec[0].ref }, ACT).then(() => {
    throw Object.assign(new Error('saved'), { code: 'SAVED' });
  }), (e) => e.code === 'SAVED');
  const card = b.prompts.find((p) => p.kind === 'file-risk');
  assert.equal(card.warning, 'This file could harm your device. felinar cannot check what it does.');
  assert.match(b.downloads[0].name, /\.exe$/, 'the sniffed extension is appended');
  const res = await get(b.route, b.downloads[0].url, { Range: 'bytes=65000-70000' });
  assert.deepEqual(new Uint8Array(await res.arrayBuffer()), data.subarray(65000, 70001));
  const declined = w.make(CY, { answers: { 'file-risk': false } });
  void declined;
});

// ------------------------------------------------------------------------------------------- code review v0.3

/** An in-memory IndexedDB with the compound keys and key ranges src/files/store-idb.js uses (one per "browser"). */
function fakeIdb() {
  const dbs = new Map();
  const cmp = (a, b) => {
    if (Array.isArray(a) && Array.isArray(b)) {
      for (let i = 0; i < Math.min(a.length, b.length); i++) {
        const c = cmp(a[i], b[i]);
        if (c) return c;
      }
      return a.length - b.length;
    }
    return a < b ? -1 : a > b ? 1 : 0;
  };
  const isRange = (x) => x && typeof x === 'object' && !Array.isArray(x) && 'lower' in x;
  const inRange = (k, r) => cmp(k, r.lower) >= 0 && cmp(k, r.upper) <= 0;
  return {
    open(name) {
      const req = {};
      setImmediate(() => {
        let db = dbs.get(name);
        const fresh = !db;
        if (!db) {
          db = new Map();
          dbs.set(name, db);
        }
        req.result = {
          objectStoreNames: { contains: (n) => db.has(n) },
          createObjectStore: (n) => db.set(n, new Map()),
          close() {},
          transaction(storeName) {
            const data = db.get(storeName);
            const t = { oncomplete: null, onabort: null, onerror: null, error: null };
            let pending = 0;
            let ended = false;
            const end = () => {
              if (pending || ended) return;
              ended = true;
              setImmediate(() => t.oncomplete && t.oncomplete());
            };
            const request = (fn) => {
              const r = { onsuccess: null, onerror: null };
              pending++;
              setImmediate(() => {
                try {
                  r.result = fn();
                  pending--;
                  if (r.onsuccess) r.onsuccess();
                } catch (err) {
                  pending--;
                  r.error = err;
                  if (r.onerror) r.onerror();
                }
                end();
              });
              return r;
            };
            t.objectStore = () => ({
              get: (k) => request(() => {
                const e = data.get(JSON.stringify(k));
                return e ? e.value.slice() : undefined;
              }),
              put: (v, k) => request(() => data.set(JSON.stringify(k), { key: k, value: v.slice() })),
              delete: (k) => request(() => {
                if (isRange(k)) for (const [kk, e] of Array.from(data)) if (inRange(e.key, k)) data.delete(kk);
                else data.delete(JSON.stringify(k));
              }),
              getAllKeys: (rg) => request(() => Array.from(data.values()).filter((e) => !rg || inRange(e.key, rg)).map((e) => e.key)),
            });
            return t;
          },
        };
        if (fresh && req.onupgradeneeded) req.onupgradeneeded();
        if (req.onsuccess) req.onsuccess();
      });
      return req;
    },
  };
}

/** Working keys as the services see them, with the sealed per-origin cache (saveLocal / loadLocal) in a Map. */
function cachedKeys(pub, cache) {
  return {
    pub,
    own: { k: 'own' },
    async saveLocal(name, value) {
      cache.set(name, JSON.parse(JSON.stringify(value)));
      return {};
    },
    async loadLocal(name) {
      return cache.has(name) ? JSON.parse(JSON.stringify(cache.get(name))) : null;
    },
  };
}

test('code review v0.3 (critical): through mountV03Services, a reader\'s own upload and an accepted grant survive a remount', async () => {
  const { mountV03Services } = await import('../../src/loader/api.js');
  const { resolveObjectURL } = await import('node:buffer');
  const saved = { indexedDB: globalThis.indexedDB, IDBKeyRange: globalThis.IDBKeyRange };
  globalThis.IDBKeyRange = { bound: (lower, upper) => ({ lower, upper }) };
  const idbA = fakeIdb();
  const idbB = fakeIdb();
  const swarm = fakeSwarm();
  const keysA = cachedKeys(ME, new Map());
  const keysB = cachedKeys(BO, new Map());
  const readerNode = () => {
    const node = fakeNode('ra');
    node.role = 'reader'; // a signed-in reader on a writers: 'owner' site (R 2.5.4): no ledger copy
    return node;
  };
  const mounts = [];
  const mount = async (keys, node) => {
    const services = new Map();
    const api = {
      node,
      identity: { keys: () => keys },
      cfg: () => ({ media: 'members', files: 'members' }),
      hostOnly: () => false,
      prompt: async () => true,
      dropin: () => false,
      service: (n) => services.get(n) || null,
      mount: (n, s) => services.set(n, s),
    };
    const r = await mountV03Services(api, { modules: { media: { createMediaService } }, deps: { ledgerId: 'mw1:test', torrents: swarm.manager(keys.pub), ownTracker: 'ws://127.0.0.1:8000', deviceClass: 'desktop' } });
    assert.deepEqual(r.errors, {});
    assert.deepEqual(r.mounted, ['media']);
    const svc = services.get('media');
    mounts.push(svc);
    return svc;
  };
  const read = async (url) => new Uint8Array(await resolveObjectURL(url).arrayBuffer());
  try {
    globalThis.indexedDB = idbA;
    const nodeA = readerNode();
    let a = await mount(keysA, nodeA);
    const src = jpegBytes(120000, 4);
    const up = await a.methods['media.upload']({ file: new Blob([src]) }, ACT);
    assert.equal(nodeA.appends.length, 0, 'a reader writes no ledger copy');
    const rec = a.lane.items.get(up.id);
    const G = { M: rec.M, fk: b64url.encode(rec.fk), from: ME, to: BO };
    a.destroy();
    // The page reloads: new services on the same stores.
    a = await mount(keysA, nodeA);
    const mine = await a.methods['media.list']({ from: 'mine' }, {});
    assert.deepEqual(mine.map((x) => x.id), [up.id], 'the own item is still listed');
    // Code review v0.3 (round 2, loader-sw request #11): the own item kept on this device joins its swarm again in lane K (the
    // kept lane), so the people it was shared with can fetch it after the reload.
    await settle(10);
    assert.ok(swarm.adds.some((x) => x.who === ME && x.infoHash === rec.M.ih && x.lane === 'K' && !x.torrentFile), 'reseeded in lane K: ' + JSON.stringify(swarm.adds.map((x) => [x.who, x.lane, !!x.torrentFile])));
    const o = await a.methods['media.open']({ id: up.id }, {});
    assert.equal(o.note, 'Played from memory on this browser.');
    assert.deepEqual(await read(o.url), src, 'and it still decrypts');
    // A recipient accepts the grant, then reloads.
    globalThis.indexedDB = idbB;
    let b = await mount(keysB, readerNode());
    await b.onGrant(ME, { t: 'media', G });
    await b.settled();
    await settle(30);
    assert.equal((await b.methods['media.list']({ from: 'received' }, {})).length, 1);
    b.destroy();
    b = await mount(keysB, readerNode());
    const got = await b.methods['media.list']({ from: 'received' }, {});
    assert.deepEqual(got.map((x) => [x.id, x.from]), [[up.id, ME]], 'the accepted grant is still listed');
    const ob = await b.methods['media.open']({ id: up.id }, {});
    assert.deepEqual(await read(ob.url), src, 'and it still opens');
    // The same grant arriving again is not offered again.
    const offers = [];
    b.on('received', (x) => offers.push(x));
    await b.onGrant(ME, { t: 'media', G });
    assert.deepEqual(offers, []);
    // Deleting forgets the kept copy too.
    globalThis.indexedDB = idbA;
    await a.methods['media.delete']({ id: up.id }, ACT);
    a.destroy();
    a = await mount(keysA, nodeA);
    assert.deepEqual(await a.methods['media.list']({ from: 'mine' }, {}), []);
  } finally {
    for (const s of mounts) s.destroy();
    globalThis.indexedDB = saved.indexedDB;
    globalThis.IDBKeyRange = saved.IDBKeyRange;
  }
});

test('code review v0.3: private file keys (own shares and received grants) survive a reload of the files service', async () => {
  const w = world();
  const cacheA = new Map();
  const cacheB = new Map();
  const a = w.make(ME);
  a.deps.keys = cachedKeys(ME, cacheA);
  const files = createFilesService(a.deps);
  w.devices[ME].files = files;
  const b = w.make(BO);
  const bDeps = Object.assign({}, b.deps, { keys: cachedKeys(BO, cacheB) });
  let bFiles = createFilesService(bDeps);
  w.devices[BO].files = bFiles;
  const data = new Uint8Array(70000).map((_, i) => (i * 13) & 255);
  const s = await files.methods['files.share']({ file: new Blob([data]), to: [BO] }, ACT);
  await settle(20);
  assert.equal((await bFiles.methods['files.received']({}, {})).length, 1);
  bFiles.destroy();
  bFiles = createFilesService(bDeps);
  const rec = await bFiles.methods['files.received']({}, {});
  assert.deepEqual(rec.map((x) => [x.ref, x.from]), [[s.ref, ME]], 'the grant came back from the sealed cache');
  const h = await bFiles.methods['files.fetch']({ ref: s.ref }, {});
  assert.deepEqual(new Uint8Array(await (await h.blob()).arrayBuffer()), data);
  // The sharer's own key came back too, and remove() forgets it.
  files.destroy();
  const again = createFilesService(a.deps);
  await again.methods['files.received']({}, {});
  assert.equal(again.lane.files.get(s.ref).mine, true);
  await again.methods['files.remove']({ ref: s.ref }, ACT);
  await settle();
  const third = createFilesService(a.deps);
  await third.methods['files.received']({}, {});
  assert.equal(third.lane.files.has(s.ref), false);
});

test('code review v0.3: a grant naming a script-capable or mismatched type is refused; the Blob fallback is never script-typed', async () => {
  const { blobType } = await import('../../src/media/session.js');
  const w = world();
  const a = w.make(ME);
  const b = w.make(BO, { noWorker: true });
  const r = await a.media.methods['media.upload']({ file: new Blob([jpegBytes(9000)]) }, ACT);
  const rec = a.media.lane.items.get(r.id);
  for (const [mime, kind] of [['text/html', 'image'], ['image/svg+xml', 'image'], ['application/xhtml+xml', 'image'], ['video/mp4', 'image'], ['image/jpeg', 'video']]) {
    const G = { M: Object.assign({}, rec.M, { mime, kind }), fk: b64url.encode(rec.fk), from: ME, to: BO };
    assert.equal(await b.media.onGrant(ME, { t: 'media', G }), null, mime + ' as ' + kind);
  }
  const badPoster = { M: Object.assign({}, rec.M, { pmime: 'text/html' }), fk: b64url.encode(rec.fk), from: ME, to: BO };
  assert.equal(await b.media.onGrant(ME, { t: 'media', G: badPoster }), null, 'a poster typed text/html');
  assert.deepEqual(await b.media.methods['media.list']({}, {}), []);
  const html = new TextEncoder().encode('<script>alert(document.domain)</script>');
  assert.equal(blobType('text/html', html), 'application/octet-stream');
  assert.equal(blobType('image/jpeg', html), 'application/octet-stream', 'bytes that do not sniff as the stated type');
  assert.equal(blobType('image/jpeg', jpegBytes(64)), 'image/jpeg');
  // MediaSessions types a Blob from the allow-list and the decrypted bytes, whatever manifest it is given.
  const blobs = new Map();
  const sessions = new MediaSessions({ sw: null, URL: { createObjectURL: (x) => { const u = 'blob:t/' + blobs.size; blobs.set(u, x); return u; }, revokeObjectURL() {} } });
  const o = await sessions.open('z', { M: Object.assign({}, rec.M, { mime: 'text/html' }), fk: rec.fk, readChunk: (i) => rec.store.getAsync(i) });
  assert.equal(blobs.get(o.url).type, 'application/octet-stream');
  const ok = await sessions.open('y', { M: rec.M, fk: rec.fk, readChunk: (i) => rec.store.getAsync(i) });
  assert.equal(blobs.get(ok.url).type, 'image/jpeg');
  assert.equal(blobs.get(ok.poster).type, 'image/jpeg');
});

test('code review v0.3: a worker that never answers a register carrying a CryptoKey gets the raw key once; the choice is kept', async () => {
  const w = world();
  const a = w.make(ME);
  const src = jpegBytes(70000, 2);
  const r = await a.media.methods['media.upload']({ file: new Blob([src]) }, ACT);
  const rec = a.media.lane.items.get(r.id);
  const route = createMediaRoute({ env: { now: () => 1000, clients: { async get(id) { return { id }; }, async matchAll() { return []; } } }, limits: { reregisterWaitMs: 50 } });
  const posts = [];
  const sw = {
    ready: () => true,
    post(msg, transfer) {
      posts.push(msg);
      if (msg.type !== MSG.sessionRegister) return;
      // The key arrives as a CryptoKey that does not deserialize here: a 'messageerror' in the worker, no answer.
      if (msg.fk && !(msg.fk instanceof Uint8Array) && typeof msg.fk.type === 'string') return;
      const port = transfer[0];
      route.register(msg, { ports: [port], source: { id: 'engine' } }).then((ack) => port.postMessage(Object.assign({ proto: PROTO, type: 'mw-ack', of: msg.type }, ack)));
    },
  };
  const sessions = new MediaSessions({ sw, channel: fakeChannel, random: rng(), keyTransfer: 'cryptokey', registerTimeoutMs: 300 });
  const t0 = Date.now();
  const o = await sessions.open(r.id, { M: rec.M, fk: rec.fk, readChunk: (i) => rec.store.getAsync(i) });
  assert.equal(o.mode, 'worker', 'the worker route, not the capped Blob path');
  assert.equal(sessions.keyTransfer, 'raw');
  assert.ok(Date.now() - t0 < 300 + 250, 'within about one timeout');
  assert.deepEqual(new Uint8Array(await (await get(route, o.url)).arrayBuffer()), src);
  const t1 = Date.now();
  sessions.close(r.id);
  const o2 = await sessions.open(r.id, { M: rec.M, fk: rec.fk, readChunk: (i) => rec.store.getAsync(i) });
  assert.equal(o2.mode, 'worker');
  assert.ok(Date.now() - t1 < 250, 'the next open does not wait for a timeout again');
  assert.equal(posts.filter((m) => m.type === MSG.sessionRegister).length, 3);
  sessions.closeAll();
});

test('code review v0.3 round 2: mw-message-error from the worker ends a CryptoKey register at once; open() retries with the raw key', async () => {
  const w = world();
  const a = w.make(ME);
  const src = jpegBytes(70000, 3);
  const r = await a.media.methods['media.upload']({ file: new Blob([src]) }, ACT);
  const rec = a.media.lane.items.get(r.id);
  const route = createMediaRoute({ env: { now: () => 1000, clients: { async get(id) { return { id }; }, async matchAll() { return []; } } }, limits: { reregisterWaitMs: 50 } });
  let push = null;
  const sw = {
    ready: () => true,
    onMessage(fn) { push = fn; return () => {}; },
    post(msg, transfer) {
      if (msg.type !== MSG.sessionRegister) return;
      if (msg.fk && !(msg.fk instanceof Uint8Array) && typeof msg.fk.type === 'string') {
        // The worker could not read it: its 'messageerror' listener tells the page (src/sw/core.js messageError).
        setTimeout(() => push && push({ proto: PROTO, type: MSG.messageError }), 5);
        return;
      }
      const port = transfer[0];
      route.register(msg, { ports: [port], source: { id: 'engine' } }).then((ack) => port.postMessage(Object.assign({ proto: PROTO, type: 'mw-ack', of: msg.type }, ack)));
    },
  };
  const sessions = new MediaSessions({ sw, channel: fakeChannel, random: rng(), keyTransfer: 'cryptokey', registerTimeoutMs: 5000 });
  const t0 = Date.now();
  const o = await sessions.open(r.id, { M: rec.M, fk: rec.fk, readChunk: (i) => rec.store.getAsync(i) });
  assert.equal(o.mode, 'worker');
  assert.equal(sessions.keyTransfer, 'raw');
  assert.ok(Date.now() - t0 < 1000, 'retried at once, not after the 5 s timeout: ' + (Date.now() - t0) + ' ms');
  assert.deepEqual(new Uint8Array(await (await get(route, o.url)).arrayBuffer()), src);
  sessions.closeAll();
});

test('code review v0.3 round 2: mw-chunk-cancel stops the page answering that chunk and takes its piece out of the front (cancelChunk)', async () => {
  let workerPort = null;
  const sw = {
    ready: () => true,
    post(msg, transfer) {
      if (msg.type !== MSG.sessionRegister) return;
      workerPort = transfer[0];
      setTimeout(() => workerPort.postMessage({ proto: PROTO, type: 'mw-ack', of: msg.type, ok: true, sid: msg.sid, exp: msg.exp }), 0);
    },
  };
  const sessions = new MediaSessions({ sw, channel: fakeChannel, random: rng(), keyTransfer: 'raw' });
  const w = world();
  const a = w.make(ME);
  const r = await a.media.methods['media.upload']({ file: new Blob([jpegBytes(70000, 4)]) }, ACT);
  const rec = a.media.lane.items.get(r.id);
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const cancelled = [];
  const replies = [];
  const o = await sessions.open('c', { M: rec.M, fk: rec.fk, readChunk: async (i) => { await gate; return rec.store.getAsync(i); }, cancelChunk: (i) => cancelled.push(i) });
  assert.equal(o.mode, 'worker');
  workerPort.onmessage = (e) => replies.push(e.data);
  workerPort.postMessage({ proto: PROTO, type: MSG.chunkNeed, sid: o.sid, req: 7, i: 1 });
  workerPort.postMessage({ proto: PROTO, type: MSG.chunkNeed, sid: o.sid, req: 8, i: 2 });
  await new Promise((resolve) => setTimeout(resolve, 10));
  workerPort.postMessage({ proto: PROTO, type: MSG.chunkCancel, sid: o.sid, req: 7, i: 1 });
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.deepEqual(cancelled, [1], 'the piece of the cancelled chunk leaves the front of the download');
  release();
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.deepEqual(replies.filter((m) => m.type === MSG.chunk).map((m) => m.req), [8], 'only the chunk still wanted is answered');
  sessions.closeAll();
});

test('code review v0.3: a failed IndexedDB request rejects the call and leaves no unhandled rejection behind', async () => {
  const { idbBackend } = await import('../../src/files/store-idb.js');
  const failing = {
    open() {
      const req = {};
      setImmediate(() => {
        req.result = {
          objectStoreNames: { contains: () => true },
          transaction() {
            const t = {};
            t.objectStore = () => ({
              put() {
                const r = {};
                setImmediate(() => {
                  r.error = Object.assign(new Error('quota'), { name: 'QuotaExceededError' });
                  if (r.onerror) r.onerror();
                  setImmediate(() => { if (t.onerror) t.onerror(); });
                });
                return r;
              },
            });
            return t;
          },
        };
        req.onsuccess();
      });
      return req;
    },
  };
  const seen = [];
  const onUnhandled = (e) => seen.push(e);
  process.on('unhandledRejection', onUnhandled);
  try {
    const b = idbBackend({ indexedDB: failing, IDBKeyRange: { bound: (lower, upper) => ({ lower, upper }) } });
    await assert.rejects(b.put('x', 0, new Uint8Array(4)), (e) => e.name === 'QuotaExceededError');
    await settle(30);
    assert.deepEqual(seen, [], 'nothing unhandled');
  } finally {
    process.off('unhandledRejection', onUnhandled);
  }
});

test('rows lane (E-MD-6): accepting a grant while nobody who has it is online keeps the grant, emits unavailable, and plays once a holder is back', async () => {
  const w = world();
  const a = w.make(ME);
  const b = w.make(BO);
  // b's swarm seam: while noHolder is on, no peer sends the info dictionary (FileTorrentHandle.metadata rejects E_FILE_UNAVAILABLE).
  let noHolder = true;
  const seam = b.media.lane.d.torrents;
  const leaves = [];
  b.media.lane.d.torrents = {
    async addFileTorrent(opts) {
      const h = await seam.addFileTorrent(opts);
      if (noHolder) {
        h.metadata = async () => { throw Object.assign(new Error('no peer sent the info dictionary in 60000 ms'), { code: 'E_FILE_UNAVAILABLE' }); };
        const destroy = h.destroy;
        h.destroy = (o) => { leaves.push(o); return destroy.call(h, o); };
      }
      return h;
    },
  };
  const unavailable = [];
  b.media.on('unavailable', (x) => unavailable.push(x));
  const src = jpegBytes(70000, 11);
  const r = await a.media.methods['media.upload']({ file: new Blob([src]) }, ACT);
  await a.media.methods['media.share']({ id: r.id, to: [BO] }, ACT);
  await settle(30);
  await b.media.settled();
  assert.deepEqual(unavailable, [{ id: r.id }], 'unavailable for the accepted item');
  assert.deepEqual(leaves, [{ keepStore: true }], 'the swarm was left, the store kept');
  const list = await b.media.methods['media.list']({ from: 'received' }, {});
  assert.equal(list.length, 1, 'the grant is kept (before the fix it was forgotten, with its vault copy)');
  assert.equal(list[0].id, r.id);
  // Still nobody: open() checks the swarm again and answers with the sentence of R 2.9.8.
  await assert.rejects(b.media.methods['media.open']({ id: r.id }, {}), (e) => e.code === 'E_FILE_UNAVAILABLE' && e.message === 'Nobody who has this video is online right now.');
  assert.equal((await b.media.methods['media.list']({ from: 'received' }, {})).length, 1, 'still kept');
  // A holder is back: open() validates the swarm and plays.
  noHolder = false;
  const o = await b.media.methods['media.open']({ id: r.id }, {});
  await settle(30);
  assert.deepEqual(new Uint8Array(await (await get(b.route, o.url)).arrayBuffer()), src);
});

test('rows lane: a swarm that does not match the grant still drops it, on accept and on a later open', async () => {
  const w = world();
  const a = w.make(ME);
  const b = w.make(BO);
  const r = await a.media.methods['media.upload']({ file: new Blob([jpegBytes(70000, 12)]) }, ACT);
  const other = await a.media.methods['media.upload']({ file: new Blob([jpegBytes(5000, 13)]) }, ACT);
  const ih = a.media.lane.items.get(r.id).M.ih;
  w.swarm.lie = { [ih]: w.swarm.torrents.get(a.media.lane.items.get(other.id).M.ih).torrentFile };
  await a.media.methods['media.share']({ id: r.id, to: [BO] }, ACT);
  await settle(30);
  await b.media.settled();
  assert.deepEqual(await b.media.methods['media.list']({ from: 'received' }, {}), [], 'a lying swarm drops the grant');
  await assert.rejects(b.media.methods['media.open']({ id: r.id }, {}), code('E_FILE_UNAVAILABLE'));
});

test('integrator (MAL53-10): 50 offers from one sender leave at most 3 cards open; 20 in all; the rest are declined and counted', async () => {
  const w = world();
  const b = w.make(BO);
  let cards = 0;
  b.media.lane.d.prompt = (p) => { if (p && p.kind === 'media-offer') cards++; return new Promise(() => {}); };
  for (let i = 0; i < 50; i++) b.media.lane.emit('received', { id: 'm' + i, from: ME, size: 1, kind: 'image' });
  assert.equal(cards, 3, 'three open offers from one sender');
  assert.equal(b.media.offersDropped, 47);
  for (let s = 0; s < 10; s++) for (let i = 0; i < 3; i++) b.media.lane.emit('received', { id: 's' + s + '-' + i, from: 'p256:sender' + s, size: 1, kind: 'image' });
  assert.equal(cards, 20, 'twenty open offers in all');
});
