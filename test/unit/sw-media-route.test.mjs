// Unit tests for src/sw/media-route.js (R 2.9.6; U-MD-3): Range mapping from byte offsets to chunks,
// single, open-ended, suffix and bytes=0-1 ranges answered 206, several ranges answered 200, 416 when
// unsatisfiable, streamed 200 without Range, the poster part, the headers, at most 4 decrypted chunks
// in flight, re-registration after a worker restart, 410 when the engine page is gone or the session
// expired. The engine page is simulated on the session's private port with real encrypted chunks.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createMediaRoute, GONE_TEXT, SESSION_MAX_MS } from '../../src/sw/media-route.js';
import { MSG, PROTO } from '../../src/sw/protocol.js';
import { plan, encryptChunk, buildManifest, newSecrets, REGION, regionOf } from '../../src/media/format.js';
import { b64url } from '../../src/chain/canonical.js';

const ORIGIN = 'https://site.test';
const SID = 'ab'.repeat(16);

function bytes(n, seed) {
  const o = new Uint8Array(n);
  for (let i = 0; i < n; i++) o[i] = (i * 13 + seed) & 255;
  return o;
}

/** An encrypted item: media plaintext, poster plaintext, chunks, manifest, key. */
async function item({ mediaBytes = 300000, posterBytes = 1000 } = {}) {
  const s = newSecrets();
  const media = bytes(mediaBytes, 3);
  const poster = bytes(posterBytes, 9);
  const p = plan({ posterBytes, mediaBytes });
  const M = buildManifest({ fid: s.fid, kind: 'video', mime: 'video/mp4', len: mediaBytes, w: 2, h: 2, P: p.P, base: s.base, regions: p.regions, total: p.total, ih: 'c'.repeat(40), name: 'video-abcd.mp4', t: 1, plen: posterBytes, pmime: 'image/jpeg' });
  const chunks = [];
  for (let i = 0; i < p.total; i++) {
    const region = regionOf(M, i);
    const pt = new Uint8Array(p.C);
    const src = region === REGION.poster ? poster : region === REGION.media ? media : null;
    const off = region === REGION.poster ? (i - p.regions.poster[0]) * p.C : (i - p.regions.media[0]) * p.C;
    if (src) pt.set(src.subarray(off, Math.min(src.length, off + p.C)));
    chunks.push(await encryptChunk(s.fk, s.base, s.fid, i, p.total, region, pt));
  }
  return { s, media, poster, p, M, chunks };
}

/** A fake engine page: answers mw-chunk-need on the port, optionally after a delay. */
function pagePort(provide, { delayMs = 0 } = {}) {
  const page = { needs: [], outstanding: 0, maxOutstanding: 0, acks: [] };
  const port = {
    onmessage: null,
    started: false,
    start() {
      port.started = true;
    },
    postMessage(m) {
      if (m.type === MSG.ack || m.type === 'mw-ack') {
        page.acks.push(m);
        return;
      }
      if (m.type !== MSG.chunkNeed) return;
      page.needs.push(m.i);
      page.outstanding++;
      page.maxOutstanding = Math.max(page.maxOutstanding, page.outstanding);
      setTimeout(() => {
        page.outstanding--;
        let answer;
        try {
          const data = provide(m.i);
          answer = data ? { type: MSG.chunk, req: m.req, i: m.i, data: data.slice().buffer } : { type: MSG.chunk, req: m.req, i: m.i, error: 'E_FILE_UNAVAILABLE' };
        } catch (_) {
          answer = { type: MSG.chunk, req: m.req, i: m.i, error: 'E_FILE_UNAVAILABLE' };
        }
        if (port.onmessage) port.onmessage({ data: answer });
      }, delayMs);
    },
    close() {
      port.closed = true;
    },
  };
  page.port = port;
  return page;
}

function clientsFake(ids = ['engine-1']) {
  const posted = [];
  const c = {
    ids: new Set(ids),
    posted,
    onPost: null,
    async get(id) {
      return c.ids.has(id) ? { id } : undefined;
    },
    async matchAll() {
      return Array.from(c.ids).map((id) => ({
        id,
        postMessage(m) {
          posted.push(m);
          if (c.onPost) c.onPost(m);
        },
      }));
    },
  };
  return c;
}

async function setup(o = {}) {
  const it = await item(o.item);
  const clients = o.clients || clientsFake();
  let t = 1000;
  const route = createMediaRoute({ env: { clients, now: () => t }, limits: Object.assign({ reregisterWaitMs: 200 }, o.limits || {}) });
  const page = pagePort((i) => it.chunks[i], o.page);
  const reg = (extra = {}) => route.register(Object.assign({ proto: PROTO, type: MSG.sessionRegister, sid: SID, kind: 'media', M: it.M, fk: it.s.fk, exp: t + 60000 }, extra), { ports: [page.port], source: { id: 'engine-1' } });
  return { it, route, page, clients, reg, advance: (ms) => { t += ms; } };
}

function get(route, path, headers = {}) {
  const url = new URL(ORIGIN + path);
  return route.handle({}, { url: url.href, headers: new Headers(headers) }, url);
}

const body = async (res) => new Uint8Array(await res.arrayBuffer());

test('U-MD-3 headers and the full body: 200 streamed without Range, content type from the allow-list', async () => {
  const { route, reg, it, page } = await setup();
  const ack = await reg();
  assert.equal(ack.ok, true);
  assert.equal(page.port.started, true);
  const res = await get(route, '/_mw/media/' + SID);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('Content-Type'), 'video/mp4');
  assert.equal(res.headers.get('Accept-Ranges'), 'bytes');
  assert.equal(res.headers.get('Cache-Control'), 'no-store');
  assert.equal(res.headers.get('X-Content-Type-Options'), 'nosniff');
  assert.equal(res.headers.get('Cross-Origin-Resource-Policy'), 'same-origin');
  assert.equal(res.headers.get('Content-Security-Policy'), "sandbox; default-src 'none'");
  assert.equal(res.headers.get('Content-Length'), String(it.media.length));
  assert.deepEqual(await body(res), it.media);
});

test('U-MD-3 Range mapping: single, open-ended, suffix, bytes=0-1 (206), across chunk boundaries', async () => {
  const { route, reg, it } = await setup();
  await reg();
  const C = it.p.C;
  const len = it.media.length;
  const cases = [
    ['bytes=0-1', 0, 1],
    ['bytes=100-200', 100, 200],
    [`bytes=${C - 5}-${C + 5}`, C - 5, C + 5],
    [`bytes=${2 * C}-`, 2 * C, len - 1],
    ['bytes=-500', len - 500, len - 1],
    [`bytes=${len - 1}-${len + 1000}`, len - 1, len - 1],
  ];
  for (const [h, a, b] of cases) {
    const res = await get(route, '/_mw/media/' + SID, { Range: h });
    assert.equal(res.status, 206, h);
    assert.equal(res.headers.get('Content-Range'), `bytes ${a}-${b}/${len}`, h);
    assert.equal(res.headers.get('Content-Length'), String(b - a + 1), h);
    assert.deepEqual(await body(res), it.media.subarray(a, b + 1), h);
  }
});

test('U-MD-3 several ranges get the whole body as 200; an unsatisfiable range gets 416 with bytes */len', async () => {
  const { route, reg, it } = await setup();
  await reg();
  const many = await get(route, '/_mw/media/' + SID, { Range: 'bytes=0-1,5-9' });
  assert.equal(many.status, 200);
  assert.deepEqual(await body(many), it.media);
  const bad = await get(route, '/_mw/media/' + SID, { Range: 'bytes=' + (it.media.length + 10) + '-' });
  assert.equal(bad.status, 416);
  assert.equal(bad.headers.get('Content-Range'), 'bytes */' + it.media.length);
  assert.equal(bad.headers.get('Content-Type'), 'video/mp4');
});

test('the poster part: ?part=poster answers the poster region only, typed by its own mime', async () => {
  const { route, reg, it, page } = await setup();
  await reg();
  const res = await get(route, '/_mw/media/' + SID + '?part=poster');
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('Content-Type'), 'image/jpeg');
  assert.deepEqual(await body(res), it.poster);
  assert.deepEqual(page.needs, [0], 'only the poster chunk was asked for');
});

test('at most 4 chunks in flight per stream, whatever the range', async () => {
  const { route, reg, it, page } = await setup({ item: { mediaBytes: 12 * 65520 }, page: { delayMs: 5 } });
  await reg();
  const res = await get(route, '/_mw/media/' + SID);
  const got = await body(res);
  assert.deepEqual(got, it.media);
  assert.ok(page.needs.length >= 12);
  assert.ok(page.maxOutstanding <= 4, 'in flight: ' + page.maxOutstanding);
  assert.ok(route.inspect().stats.maxInFlight <= 4);
});

test('a restarted worker: the page is asked to register again (mw-session-lost) and the request is answered', async () => {
  const { route, reg, clients } = await setup();
  clients.onPost = (m) => {
    if (m.type === MSG.sessionLost && m.sid === SID) setTimeout(() => reg(), 10);
  };
  const res = await get(route, '/_mw/media/' + SID, { Range: 'bytes=0-1' });
  assert.equal(res.status, 206);
  assert.equal(clients.posted[0].type, 'mw-session-lost');
  assert.equal(clients.posted[0].proto, PROTO);
});

test('410 when nobody registers again, when the engine page is gone, after expiry; 404 for a bad id', async () => {
  const s1 = await setup();
  const none = await get(s1.route, '/_mw/media/' + SID);
  assert.equal(none.status, 410);
  assert.equal(await none.text(), GONE_TEXT);
  const s2 = await setup();
  await s2.reg();
  s2.clients.ids.clear();
  assert.equal((await get(s2.route, '/_mw/media/' + SID)).status, 410, 'the engine page closed');
  assert.equal(s2.route.inspect().sessions, 0);
  const s3 = await setup();
  await s3.reg();
  s3.advance(61000);
  assert.equal((await get(s3.route, '/_mw/media/' + SID)).status, 410, 'expired');
  assert.equal((await get(s3.route, '/_mw/media/not-a-sid')).status, 404);
  const s4 = await setup();
  const ack = await s4.reg({ exp: 1000 + SESSION_MAX_MS * 3 });
  assert.equal(ack.exp, 1000 + SESSION_MAX_MS, 'sessions last at most 12 hours');
});

test('a session with the wrong key or a bad manifest: the stream fails (E_DECRYPT), registration refuses', async () => {
  const { route, reg, it } = await setup();
  const other = newSecrets().fk;
  await reg({ fk: other });
  const res = await get(route, '/_mw/media/' + SID, { Range: 'bytes=0-10' });
  assert.equal(res.status, 206);
  await assert.rejects(res.arrayBuffer());
  const bad = Object.assign({}, it.M, { total: 3 });
  assert.equal((await reg({ M: bad })).error, 'manifest');
  assert.equal((await reg({ sid: 'x' })).error, 'sid');
  assert.equal((await route.register({ sid: SID, kind: 'media', M: it.M, fk: it.s.fk }, { ports: [] })).error, 'port');
});

test('close ends one session or every session of the sender; a file id on the media route is not found', async () => {
  const { route, reg, it } = await setup();
  await reg();
  assert.deepEqual(route.close({ sid: SID }), { ok: true, closed: 1 });
  await reg();
  assert.deepEqual(route.close({ all: true }, { source: { id: 'engine-1' } }), { ok: true, closed: 1 });
  await reg();
  assert.equal((await get(route, '/_mw/f/' + SID)).status, 404, 'a media session is not a file');
  void it;
});

test('the chunk index mapping: a seek to offset o asks for chunk regionStart + floor(o / C) first', async () => {
  const { route, reg, it, page } = await setup({ item: { mediaBytes: 8 * 65520 } });
  await reg();
  const o = 5 * it.p.C + 7;
  const res = await get(route, '/_mw/media/' + SID, { Range: 'bytes=' + o + '-' + (o + 10) });
  await body(res);
  assert.deepEqual(page.needs, [it.M.regions.media[0] + 5]);
  assert.equal(b64url.decode(it.M.fid).length, 16);
});
