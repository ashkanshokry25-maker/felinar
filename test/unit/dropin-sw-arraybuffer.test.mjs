// The Service Worker core serves a drop-in site from IndexedDB. Where the browser cannot keep Blobs
// there (WebKit private browsing; Playwright's default WebKit context, found by the drop-in smoke
// test) src/loader/cache.js stores every file as an ArrayBuffer, and the worker used to treat the
// site as unusable and send everything to the host. This test pins the fix in src/sw/core.js:
// files stored as ArrayBuffers are served exactly like Blobs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createCore } from '../../src/sw/core.js';
import { encode } from '../../src/common/bencode.js';

const te = new TextEncoder();
const sha1 = (u8) => new Uint8Array(createHash('sha1').update(u8).digest());

function buildTorrent(files, { name = 'site', pieceLength = 16384 } = {}) {
  const list = files.map((f) => ({ path: f.path, data: te.encode(f.data) }));
  let total = 0;
  for (const f of list) total += f.data.length;
  const all = new Uint8Array(total);
  let off = 0;
  for (const f of list) { all.set(f.data, off); off += f.data.length; }
  const count = Math.ceil(total / pieceLength);
  const pieces = new Uint8Array(count * 20);
  for (let i = 0; i < count; i++) pieces.set(sha1(all.subarray(i * pieceLength, Math.min(total, (i + 1) * pieceLength))), i * 20);
  const info = { files: list.map((f) => ({ length: f.data.length, path: f.path.split('/') })), name, 'piece length': pieceLength, pieces };
  return { torrentFile: encode({ info }), infoHash: Buffer.from(sha1(encode(info))).toString('hex'), list };
}

const ORIGIN = 'https://site.test';

function setup(files, store) {
  const t = buildTorrent(files);
  const storage = {
    getMeta: async () => null,
    setMeta: async () => {},
    listSites: async () => [{ btih: t.infoHash, kind: 'site', name: 'site', torrentFile: t.torrentFile, files: t.list.map((f) => ({ path: f.path, length: f.data.length, type: '' })), complete: true }],
    getSite: async (btih) => (btih === t.infoHash ? { btih, kind: 'site', name: 'site', torrentFile: t.torrentFile, files: t.list.map((f) => ({ path: f.path, length: f.data.length, type: '' })), complete: true } : null),
    getFile: async (btih, path) => store(path, t.list.find((f) => f.path === path)),
    deleteSite: async () => {},
    getDoc: async () => null,
    putDoc: async () => {},
  };
  const fetched = [];
  const core = createCore({ buildId: 'test', storage, env: { origin: ORIGIN, caches: null, clients: null, fetch: async (req) => { fetched.push(typeof req === 'string' ? req : req.url); return new Response('from the host'); }, log() {} } });
  return { core, t, fetched };
}

async function serve(core, t, path, { clientId = 'c1' } = {}) {
  await core.init();
  const ack = [];
  const event = { data: { proto: 1, type: 'mw-map-client', clientId, btih: t.infoHash }, source: { id: clientId, postMessage: (m) => ack.push(m) }, waitUntil() {} };
  core.message(event);
  await new Promise((r) => setTimeout(r, 10));
  const fe = { request: new Request(ORIGIN + '/' + path, { method: 'GET' }), clientId, waitUntil() {} };
  Object.defineProperty(fe.request, 'destination', { value: 'style' });
  const owned = core.owns(fe);
  const res = owned ? await core.handle(fe) : null;
  return { owned, res, ack };
}

const FILES = [{ path: 'css/app.3f2a1b.css', data: 'body { color: #123 }' }, { path: 'data.json', data: '{"a":1}' }];

test('a site stored as Blobs is served from IndexedDB (the baseline)', async () => {
  const { core, t, fetched } = setup(FILES, (path, f) => new Blob([f.data]));
  const out = await serve(core, t, 'css/app.3f2a1b.css');
  assert.equal(out.owned, true);
  assert.equal(await out.res.text(), 'body { color: #123 }');
  assert.deepEqual(fetched, [], 'nothing went to the host');
});

test('a site stored as ArrayBuffers (no Blob support in IndexedDB) is served the same way, not sent to the host', async () => {
  const { core, t, fetched } = setup(FILES, (path, f) => f.data.buffer.slice(f.data.byteOffset, f.data.byteOffset + f.data.byteLength));
  const out = await serve(core, t, 'css/app.3f2a1b.css');
  assert.equal(out.owned, true);
  assert.equal(out.res.status, 200);
  assert.equal(await out.res.text(), 'body { color: #123 }');
  assert.deepEqual(fetched, [], 'nothing went to the host: the ArrayBuffer was wrapped in a Blob');
  assert.equal(core.inspect().bad.length, 0, 'the site was not marked unusable');
  const second = await serve(core, t, 'data.json');
  assert.equal(await second.res.text(), '{"a":1}');
  assert.deepEqual(fetched, []);
});

test('typed-array views stored by an engine are wrapped too', async () => {
  const { core, t, fetched } = setup(FILES, (path, f) => f.data);
  const out = await serve(core, t, 'data.json');
  assert.equal(await out.res.text(), '{"a":1}');
  assert.deepEqual(fetched, []);
});
