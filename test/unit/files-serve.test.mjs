// Unit tests for src/files/serve.js and the /_mw/f/ route of src/sw/media-route.js and core.js (R 2.8.5,
// MF-48; U-FI-2): for every extension of the site extension map, a shared file named with it is
// answered application/octet-stream as an attachment with filename*, nosniff, the sandbox CSP, CORP
// same-origin, no-store and Accept-Ranges, through the route and through the core's navigation path.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { contentDisposition, fileHeaders, mediaHeaders, ROUTE_CSP, OCTET } from '../../src/files/serve.js';
import { createMediaRoute } from '../../src/sw/media-route.js';
import { createCore } from '../../src/sw/core.js';
import { MIME_TYPES } from '../../src/sw/lib.js';
import { MSG, PROTO } from '../../src/sw/protocol.js';

const ORIGIN = 'https://site.test';
const BLOCK = 4096;

function filePage(data) {
  const port = {
    onmessage: null,
    postMessage(m) {
      if (m.type !== MSG.chunkNeed) return;
      const slice = data.slice(m.i * BLOCK, Math.min(data.length, (m.i + 1) * BLOCK));
      setTimeout(() => port.onmessage && port.onmessage({ data: { type: MSG.chunk, req: m.req, i: m.i, data: slice.buffer } }), 0);
    },
  };
  return port;
}

const sid = (n) => n.toString(16).padStart(32, '0');

function checkFileHeaders(res, label) {
  assert.equal(res.headers.get('Content-Type'), OCTET, label + ': octet-stream');
  assert.match(res.headers.get('Content-Disposition'), /^attachment; filename\*=UTF-8''/, label);
  assert.equal(res.headers.get('X-Content-Type-Options'), 'nosniff', label);
  assert.equal(res.headers.get('Content-Security-Policy'), "sandbox; default-src 'none'", label);
  assert.equal(res.headers.get('Cross-Origin-Resource-Policy'), 'same-origin', label);
  assert.equal(res.headers.get('Cache-Control'), 'no-store', label);
  assert.equal(res.headers.get('Accept-Ranges'), 'bytes', label);
}

test('U-FI-2 the /_mw/f/ route: every extension of the map is an octet-stream attachment', async () => {
  const route = createMediaRoute({ env: { now: () => 1 } });
  const data = new TextEncoder().encode('<script>alert(document.cookie)</script><svg onload=alert(1)>');
  const exts = Object.keys(MIME_TYPES);
  assert.ok(exts.length >= 50);
  let n = 0;
  for (const ext of exts) {
    const id = sid(++n);
    const ack = await route.register({ sid: id, kind: 'file', file: { name: 'upload.' + ext, size: data.length, block: BLOCK } }, { ports: [filePage(data)] });
    assert.equal(ack.ok, true);
    const url = new URL(ORIGIN + '/_mw/f/' + id);
    const res = await route.handle({}, { url: url.href, headers: new Headers() }, url);
    assert.equal(res.status, 200, ext);
    checkFileHeaders(res, ext);
    assert.equal(res.headers.get('Content-Disposition'), "attachment; filename*=UTF-8''upload." + ext);
    assert.deepEqual(new Uint8Array(await res.arrayBuffer()), data, ext);
  }
});

test('U-FI-2 through the core: a top-level navigation to /_mw/f/<id> is answered by the route, never the shell', async () => {
  const core = createCore({
    buildId: 't', limits: { persistDelayMs: 0 },
    storage: { async getSite() {}, async listSites() { return []; }, async getFile() {}, async getMeta() {}, async setMeta() {}, async deleteSite() {}, async getDoc() {}, async putDoc() {} },
    env: { origin: ORIGIN, caches: null, clients: { async matchAll() { return []; }, async get(id) { return { id }; }, async claim() {} }, fetch: async () => new Response('host page', { status: 200 }), log() {} },
  });
  const data = new TextEncoder().encode('<html><script>parent.steal()</script></html>');
  for (const [i, name] of [['1', 'page.html'], ['2', 'icon.svg'], ['3', 'run.js'], ['4', 'doc.xhtml']]) {
    const replies = [];
    const waits = [];
    core.message({ data: { proto: PROTO, type: MSG.sessionRegister, sid: sid(Number(i)), kind: 'file', file: { name, size: data.length, block: BLOCK } }, source: { id: 'engine' }, ports: [filePage(data)], waitUntil: (p) => waits.push(p) });
    for (const w of waits) await w;
    const request = { url: ORIGIN + '/_mw/f/' + sid(Number(i)), method: 'GET', mode: 'navigate', destination: 'document', headers: new Headers(), cache: 'default' };
    const event = { request, clientId: '', resultingClientId: 'x', waitUntil() {} };
    assert.equal(core.owns(event), true, name);
    const res = await core.handle(event);
    assert.equal(res.status, 200, name);
    checkFileHeaders(res, name);
    assert.notEqual(await res.text(), 'host page');
  }
  assert.equal(core.inspect().media.sessions, 4);
});

test('contentDisposition: UTF-8 percent-encoded, bidi and control characters stripped, path characters replaced', () => {
  assert.equal(contentDisposition('report.pdf'), "attachment; filename*=UTF-8''report.pdf");
  assert.equal(contentDisposition('été 2026.txt'), "attachment; filename*=UTF-8''%C3%A9t%C3%A9%202026.txt");
  assert.equal(contentDisposition('invoice‮txt.exe'), "attachment; filename*=UTF-8''invoicetxt.exe", 'the right-to-left override is gone');
  assert.equal(contentDisposition('../../etc/passwd'), "attachment; filename*=UTF-8''_.._etc_passwd");
  assert.equal(contentDisposition('a"b;c\r\nSet-Cookie: x'), "attachment; filename*=UTF-8''a_b%3BcSet-Cookie_%20x", 'CR and LF removed: no header injection');
  assert.equal(contentDisposition(''), "attachment; filename*=UTF-8''file");
});

test('fileHeaders and mediaHeaders: ranges, lengths, a type outside the media allow-list becomes octet-stream', () => {
  const h = fileHeaders({ name: 'a.bin', size: 100, range: { start: 10, end: 19 } });
  assert.equal(h['Content-Range'], 'bytes 10-19/100');
  assert.equal(h['Content-Length'], '10');
  assert.equal(h['Content-Security-Policy'], ROUTE_CSP);
  assert.equal(mediaHeaders({ mime: 'text/html', size: 5 })['Content-Type'], OCTET);
  assert.equal(mediaHeaders({ mime: 'image/svg+xml', size: 5 })['Content-Type'], OCTET);
  assert.equal(mediaHeaders({ mime: 'video/webm', size: 5 })['Content-Type'], 'video/webm');
});

test('a file range through the route: 206 with the right bytes; the extension map is never consulted', async () => {
  const route = createMediaRoute({ env: { now: () => 1 } });
  const data = new Uint8Array(10000).map((_, i) => i & 255);
  await route.register({ sid: sid(99), kind: 'file', file: { name: 'clip.mp4', size: data.length, block: BLOCK } }, { ports: [filePage(data)] });
  const url = new URL(ORIGIN + '/_mw/f/' + sid(99));
  const res = await route.handle({}, { url: url.href, headers: new Headers({ Range: 'bytes=4090-4100' }) }, url);
  assert.equal(res.status, 206);
  assert.equal(res.headers.get('Content-Type'), OCTET, 'not video/mp4');
  assert.deepEqual(new Uint8Array(await res.arrayBuffer()), data.subarray(4090, 4101));
  for (const f of ['src/files/serve.js', 'src/sw/media-route.js']) {
    assert.doesNotMatch(readFileSync(new URL('../../' + f, import.meta.url), 'utf8'), /import[^;]*mimeFor|mimeFor\s*\(/, f + ' never imports or calls the extension map');
  }
});
