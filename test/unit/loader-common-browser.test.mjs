// Runs the IndexedDB, identity, chunk-store and DoH code in real browser engines (Playwright
// Chromium and WebKit, headless), served from a loopback HTTP server. WebKit matters most: it
// auto-commits IndexedDB transactions that wait on anything, which Chromium tolerates. A browser
// that cannot be launched is skipped, never failed.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join, normalize, extname, sep } from 'node:path';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { chromium, webkit } from 'playwright';
import { threeFileSite } from './common-fixtures.test.mjs';
import { CHROMIUM_LOCAL_ONLY_ARGS } from '../e2e/browser-args.mjs';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const SRC = join(ROOT, 'src') + sep;
const BTIH = '0123456789abcdef0123456789abcdef01234567';

function startServer() {
  const dohLog = [];
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    if (url.pathname === '/dns') {
      dohLog.push({ method: req.method, headers: req.headers });
      const cors = { 'access-control-allow-origin': '*' };
      if (req.method === 'OPTIONS') {
        res.writeHead(204, Object.assign({ 'access-control-allow-headers': '*', 'access-control-allow-methods': 'GET' }, cors));
        res.end();
        return;
      }
      const data = '"v=mw1; btih=' + BTIH + '" "; dn=My%20Site"';
      res.writeHead(200, Object.assign({ 'content-type': 'application/dns-json' }, cors));
      res.end(JSON.stringify({ Status: 0, AD: true, Answer: [{ name: url.searchParams.get('name'), type: 16, TTL: 120, data }] }));
      return;
    }
    if (url.pathname === '/') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end('<!doctype html><meta charset="utf-8"><title>loader-common</title><body>ok</body>');
      return;
    }
    const file = normalize(join(ROOT, decodeURIComponent(url.pathname)));
    if (!file.startsWith(SRC) || extname(file) !== '.js') {
      res.writeHead(404);
      res.end();
      return;
    }
    try {
      const body = await readFile(file);
      res.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8', 'cache-control': 'no-store' });
      res.end(body);
    } catch (_) {
      res.writeHead(404);
      res.end();
    }
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port, dohLog }));
  });
}

// ---------------------------------------------------------------------------------------------
// page-side scenarios (serialised by Playwright: no closures over Node variables)
// ---------------------------------------------------------------------------------------------

async function installHelpers() {
  window.__h = {
    dec(b64) {
      return Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
    },
    async fresh() {
      const cache = await import('/src/loader/cache.js');
      cache.closeDb();
      await new Promise((resolve, reject) => {
        const r = indexedDB.deleteDatabase('mw-sites');
        r.onsuccess = () => resolve();
        r.onerror = () => reject(r.error);
        r.onblocked = () => resolve();
      });
      return cache;
    },
    async site(args) {
      const tf = await import('/src/common/torrent-file.js');
      const cache = await import('/src/loader/cache.js');
      const torrentFile = window.__h.dec(args.torrentB64);
      const parsed = await tf.parseTorrentFile(torrentFile);
      const blobs = new Map(args.files.map((f) => [f.path, new Blob([window.__h.dec(f.b64)])]));
      return { parsed, torrentFile, blobs, manifest: cache.buildManifest(parsed, { torrentFile }) };
    },
  };
  return typeof crypto.subtle === 'object' && typeof indexedDB === 'object';
}

async function scenarioSites(args) {
  const cache = await window.__h.fresh();
  const { parsed, blobs, manifest } = await window.__h.site(args);
  const out = {};
  out.blobSupport = await cache.blobStorageSupported();
  const saved = await cache.saveSite(manifest, blobs);
  const db = await cache.openDb();
  out.storedType = await new Promise((resolve) => {
    const req = db.transaction(['files']).objectStore('files').get(parsed.infoHash + '/index.html');
    req.onsuccess = () => resolve(Object.prototype.toString.call(req.result));
  });
  out.cssIsBlob = (await cache.getFile(parsed.infoHash, 'css/app.css')) instanceof Blob;
  out.version = db.version;
  out.stores = Array.from(db.objectStoreNames).sort();
  const got = await cache.getSite(parsed.infoHash);
  out.manifest = { btih: got.btih, kind: got.kind, name: got.name, total: got.total, complete: got.complete, files: got.files, torrentIsBytes: got.torrentFile instanceof Uint8Array, savedAtSet: got.savedAt > 0 && got.lastVisit === got.savedAt };
  const css = await cache.getFile(parsed.infoHash, '/css/app.css');
  out.cssBytes = Array.from(new Uint8Array(await css.arrayBuffer()).subarray(0, 8));
  out.cssSize = css.size;
  out.missingFile = await cache.getFile(parsed.infoHash, 'nope.html');
  out.listed = (await cache.listSites()).map((s) => s.btih);
  out.touched = await cache.touchSite(parsed.infoHash, saved.savedAt + 5000);
  out.lastVisit = (await cache.getSite(parsed.infoHash)).lastVisit - saved.savedAt;
  out.touchedMissing = await cache.touchSite('f'.repeat(40));
  // a second site and offline documents for both, then delete the first
  const other = Object.assign({}, manifest, { btih: 'f'.repeat(40), name: 'other' });
  await cache.saveSite(other, blobs);
  await new Promise((resolve, reject) => {
    const tx = db.transaction(['docs'], 'readwrite');
    // bodies as bytes: WebKit ephemeral sessions refuse Blobs (see cache.js)
    tx.objectStore('docs').put({ btih: parsed.infoHash, body: new Uint8Array([97]), savedAt: 1 }, 'https://x/a.html');
    tx.objectStore('docs').put({ btih: 'f'.repeat(40), body: new Uint8Array([98]), savedAt: 1 }, 'https://x/b.html');
    tx.oncomplete = () => resolve();
    tx.onabort = () => reject(tx.error || new Error('docs transaction aborted'));
  });
  await cache.deleteSite(parsed.infoHash);
  out.afterDelete = {
    site: await cache.getSite(parsed.infoHash),
    file: await cache.getFile(parsed.infoHash, 'index.html'),
    otherFile: (await cache.getFile('f'.repeat(40), 'index.html')).size,
    sites: (await cache.listSites()).map((s) => s.btih),
    docs: await new Promise((resolve) => {
      const req = db.transaction(['docs']).objectStore('docs').getAllKeys();
      req.onsuccess = () => resolve(req.result);
    }),
  };
  // re-saving replaces the file set (stale paths are gone)
  const slim = Object.assign({}, other, { files: other.files.slice(0, 1) });
  await cache.saveSite(slim, blobs);
  out.resaved = { kept: (await cache.getFile('f'.repeat(40), slim.files[0].path)) !== null, dropped: await cache.getFile('f'.repeat(40), other.files[2].path) };
  return out;
}

async function scenarioBudget(args) {
  const cache = await window.__h.fresh();
  const { blobs, manifest } = await window.__h.site(args);
  const ids = ['a', 'b', 'c', 'd'].map((ch) => ch.repeat(40));
  for (let i = 0; i < ids.length; i++) {
    await cache.saveSite(Object.assign({}, manifest, { btih: ids[i] }), blobs);
    await cache.touchSite(ids[i], 1000 + i); // a oldest ... d newest
  }
  const each = manifest.total;
  const r1 = await cache.enforceBudget({ budgetBytes: each * 4 });
  const r2 = await cache.enforceBudget({ budgetBytes: each * 2, keep: ['a'.repeat(40)] });
  const left = (await cache.listSites()).map((s) => s.btih).sort();
  const usage = await cache.estimateUsage();
  const persisted = await cache.requestPersist();
  return { r1, r2, left, each, usage: { sites: usage.sites, siteBytes: usage.siteBytes, quotaIsNumber: typeof usage.quota === 'number' }, persistedType: typeof persisted };
}

async function scenarioKv() {
  const cache = await window.__h.fresh();
  const out = {};
  await cache.savePointer('example.com', { record: { btih: 'x', xs: ['u'] }, raw: 'v=mw1', source: 'meta', ttlUntil: 5 });
  const p = await cache.getPointer('example.com');
  out.pointer = { raw: p.raw, source: p.source, savedAt: typeof p.savedAt, xs: p.record.xs };
  out.noPointer = await cache.getPointer('nope.example');
  const pin1 = await cache.savePin('example.com', 'OWNER1', { decidedAt: 100 });
  const pin2 = await cache.savePin('example.com', 'OWNER2', { reason: 'rot' });
  out.pins = { first: pin1, secondOwner: pin2.owner, firstSeenKept: pin2.firstSeen === pin1.firstSeen, reason: pin2.reason, stored: (await cache.getPin('example.com')).owner };
  await cache.setPref('uploads', false);
  out.prefs = { uploads: await cache.getPref('uploads', true), missing: await cache.getPref('hostOnly', 'dflt') };
  await cache.setMeta('current', { btih: 'b'.repeat(40), ledgerId: 'mw1:x', routing: { spa: true } });
  out.meta = { current: await cache.getMeta('current'), none: await cache.getMeta('clients') };
  let shapeError = null;
  try {
    await cache.saveKey('identity:x', { privateKey: 1 });
  } catch (err) {
    shapeError = err.name;
  }
  out.shapeError = shapeError;
  await cache.saveKey('identity:x', { kind: 'jwk', jwk: { kty: 'EC' }, pub: 'P' });
  out.key = (await cache.getKey('identity:x')).pub;
  await cache.deleteKey('identity:x');
  out.keyDeleted = await cache.getKey('identity:x');
  // Code review round 1 (identity race): addKey never replaces an existing key.
  out.added = [
    await cache.addKey('identity:y', { kind: 'jwk', jwk: { kty: 'EC' }, pub: 'A' }),
    await cache.addKey('identity:y', { kind: 'jwk', jwk: { kty: 'EC' }, pub: 'B' }),
  ];
  out.addedKept = (await cache.getKey('identity:y')).pub;
  return out;
}

async function scenarioIdentity() {
  const cache = await window.__h.fresh();
  const crypto2 = await import('/src/chain/crypto.js');
  const msg = new TextEncoder().encode('hello');
  const out = {};
  const a = await cache.createIdentity('identity:mw1:test');
  const loadedA = await cache.loadIdentity('identity:mw1:test');
  out.a = {
    kind: a.kind, loadedKind: loadedA.kind, samePub: loadedA.pub === a.pub, extractable: loadedA.privateKey.extractable,
    signs: await crypto2.verify(a.pub, msg, await crypto2.sign(loadedA.privateKey, msg)),
  };
  const b = await cache.createIdentity('identity:mw1:jwk', { forceJwk: true });
  const stored = await cache.getKey('identity:mw1:jwk');
  const loadedB = await cache.loadIdentity('identity:mw1:jwk');
  out.b = {
    kind: b.kind, storedKind: stored.kind, storedHasD: typeof stored.jwk.d === 'string', loadedKind: loadedB.kind,
    extractable: loadedB.privateKey.extractable,
    signs: await crypto2.verify(b.pub, msg, await crypto2.sign(loadedB.privateKey, msg)),
  };
  out.none = await cache.loadIdentity('identity:missing');
  return out;
}

async function scenarioMigration() {
  const cache = await window.__h.fresh();
  await new Promise((resolve, reject) => {
    const r = indexedDB.open('mw-sites', 1);
    r.onupgradeneeded = () => {
      const db = r.result;
      db.createObjectStore('sites', { keyPath: 'btih' });
      db.createObjectStore('files');
      db.createObjectStore('pointers');
      db.createObjectStore('pins');
      db.createObjectStore('prefs');
      db.createObjectStore('identity');
    };
    r.onsuccess = () => {
      const db = r.result;
      const tx = db.transaction(['sites', 'pins', 'prefs', 'identity'], 'readwrite');
      tx.objectStore('sites').put({ btih: 'a'.repeat(40), files: [] });
      tx.objectStore('pins').put({ owner: 'O', decidedAt: 1 }, 'example.com');
      tx.objectStore('prefs').put('yes', 'consent');
      tx.objectStore('identity').put({ pub: 'P' }, 'me');
      tx.oncomplete = () => {
        db.close();
        resolve();
      };
      tx.onerror = () => reject(tx.error);
    };
    r.onerror = () => reject(r.error);
  });
  const db = await cache.openDb();
  return {
    version: db.version,
    stores: Array.from(db.objectStoreNames).sort(),
    sitesKeyPath: db.transaction(['sites']).objectStore('sites').keyPath,
    pin: await cache.getPin('example.com'),
    pref: await cache.getPref('consent'),
    sites: (await cache.listSites()).length,
  };
}

async function scenarioVersionChange() {
  const cache = await window.__h.fresh();
  await cache.openDb();
  const t0 = performance.now();
  const upgraded = await new Promise((resolve) => {
    const r = indexedDB.open('mw-sites', 3);
    let blocked = false;
    r.onblocked = () => {
      blocked = true;
    };
    r.onupgradeneeded = () => {};
    r.onsuccess = () => {
      r.result.close();
      resolve({ ok: true, blocked });
    };
    r.onerror = () => resolve({ ok: false, error: String(r.error) });
    setTimeout(() => resolve({ ok: false, error: 'timeout', blocked }), 5000);
  });
  const ms = performance.now() - t0;
  let reopenError = null;
  try {
    await cache.openDb();
  } catch (err) {
    reopenError = err.name;
  }
  await window.__h.fresh();
  return { upgraded, fast: ms < 4000, reopenError };
}

async function scenarioChunkStore(args) {
  const cache = await window.__h.fresh();
  const { BlobChunkStore } = await import('/src/loader/blob-chunk-store.js');
  const verify = await import('/src/loader/verify.js');
  const { parsed, blobs, manifest, torrentFile } = await window.__h.site(args);
  await cache.saveSite(manifest, blobs);
  const lazy = (path) => cache.getFile(parsed.infoHash, path);
  const out = {};
  out.infoHash = await verify.verifyInfoHash((await cache.getSite(parsed.infoHash)).torrentFile, parsed.infoHash);
  const verified = new Set();
  out.files = [];
  for (const f of manifest.files) out.files.push(await verify.verifyFile(parsed, lazy, f.path, verified));
  out.verified = Array.from(verified).sort();
  const get = (store, i, opts) => new Promise((resolve, reject) => store.get(i, opts || null, (err, buf) => (err ? reject(err) : resolve(buf))));
  const store = new BlobChunkStore(parsed.pieceLength, { parsed, blobs: lazy });
  const p1 = await get(store, 1, { offset: 100, length: 50 });
  out.pieceSlice = Array.from(p1.subarray(0, 4));
  // tamper with one stored Blob (same size) and read through a fresh store
  const css = new Uint8Array(await (await cache.getFile(parsed.infoHash, 'css/app.css')).arrayBuffer());
  css[9000] ^= 1;
  const tampered = new Map(blobs);
  tampered.set('css/app.css', new Blob([css]));
  await cache.saveSite(manifest, tampered);
  const failed = [];
  const bad = new BlobChunkStore(parsed.pieceLength, { parsed, blobs: lazy, onVerifyFailed: (i) => failed.push(i) });
  try {
    await get(bad, 1);
    out.badRead = 'returned bytes';
  } catch (err) {
    out.badRead = err.message + '/' + err.code;
  }
  out.failed = failed;
  out.verifyFileAfterTamper = await verify.verifyFile(parsed, lazy, 'css/app.css', new Set());
  out.torrentLen = torrentFile.length;
  const t0 = performance.now();
  await verify.verifyFile(parsed, lazy, 'index.html', new Set());
  out.verifyMs = performance.now() - t0;
  return out;
}

async function scenarioDoh(args) {
  const doh = await import('/src/loader/doh.js');
  const pointer = await import('/src/common/pointer.js');
  const res = await doh.resolveTxt('_magnet.example.com', { override: args.template });
  const parsed = pointer.parsePointer(res.strings[0]);
  return { resolver: res.resolver, strings: res.strings, ad: res.ad, ttl: res.ttl, status: res.status, dn: parsed.ok && parsed.record.dn };
}

// Code review round 1: limited mode (render.js mountDegraded) with a module graph that has a cycle
// (Rollup/Vite code splitting: a lazy chunk imports the entry), and the written frame's URL.
async function scenarioLimitedModules() {
  const render = await import('/src/loader/render.js');
  const files = {
    'index.html': '<!doctype html><html><head><title>cycle</title></head><body><div id="out">...</div><script type="module" src="./js/index.js"></script></body></html>',
    'js/util.js': "export const helper = () => 'helper'\n",
    'js/index.js': "import { helper } from './util.js'\nwindow.__entryRuns = (window.__entryRuns || 0) + 1\nexport const shared = 'shared'\nimport('./route.js').then((m) => { document.getElementById('out').textContent = m.route() + ':' + helper() + ' (entry ran ' + window.__entryRuns + 'x)' }).catch((e) => { document.getElementById('out').textContent = 'error: ' + e.message })\n",
    'js/route.js': "import { shared } from './index.js'\nexport const route = () => shared + ':route ok'\n",
  };
  const blobs = new Map();
  const list = [];
  for (const [path, text] of Object.entries(files)) {
    blobs.set(path, new Blob([text], { type: path.endsWith('.html') ? 'text/html' : 'text/javascript' }));
    list.push({ path, length: text.length, pad: false });
  }
  const container = document.createElement('div');
  document.body.appendChild(container);
  const mount = await render.mountDegraded({ container, parsed: { files: list }, blobs, path: '/' });
  const frame = mount.iframe;
  let out = '...';
  for (let i = 0; i < 100 && (out === '...' || !out); i++) {
    await new Promise((r) => setTimeout(r, 50));
    try { out = frame.contentDocument.getElementById('out').textContent; } catch (_) { out = '...'; }
  }
  let pushed = null;
  try {
    frame.contentWindow.history.pushState({}, '', '/about');
    pushed = frame.contentWindow.location.pathname;
  } catch (err) {
    pushed = 'threw ' + err.name;
  }
  const importMaps = !!(HTMLScriptElement.supports && HTMLScriptElement.supports('importmap'));
  mount.destroy();
  return { out, pathname: location.pathname, frameStart: '/', pushed, importMaps };
}

// ---------------------------------------------------------------------------------------------

// Each page.evaluate gets its own deadline, so an engine bug that never settles fails one
// sub-test quickly instead of holding the whole run.
function evaluate(page, fn, arg, ms = 20000) {
  let timer;
  return Promise.race([
    page.evaluate(fn, arg),
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error('page.evaluate did not settle within ' + ms + ' ms')), ms);
    }),
  ]).finally(() => clearTimeout(timer));
}

async function launchEphemeral(browserType) {
  const browser = await browserType.launch({ headless: true, args: browserType.name() === 'chromium' ? CHROMIUM_LOCAL_ONLY_ARGS : [] });
  const context = await browser.newContext();
  return { context, close: () => browser.close() };
}

async function launchPersistent(browserType) {
  const dir = mkdtempSync(join(tmpdir(), 'mw-loader-common-'));
  const context = await browserType.launchPersistentContext(dir, { headless: true, args: browserType.name() === 'chromium' ? CHROMIUM_LOCAL_ONLY_ARGS : [] });
  return {
    context,
    close: async () => {
      await context.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

async function runBrowser(t, name, browserType, launch, expectBlobs) {
  let session;
  try {
    session = await launch(browserType);
  } catch (err) {
    t.skip(name + ' could not be launched: ' + String(err.message).split('\n')[0]);
    return;
  }
  const { server, port, dohLog } = await startServer();
  // The DoH stub on a second 127.0.0.1 listener: cross-origin (another port), and WebKit only ever
  // loads http://127.0.0.1 URLs (docs/DEV-NETWORK.md; code review round 1: it used http://localhost).
  const doh = await startServer();
  const site = await threeFileSite();
  const args = {
    torrentB64: Buffer.from(site.torrentFile).toString('base64'),
    files: site.files.map((f) => ({ path: f.path, b64: Buffer.from(f.data).toString('base64') })),
  };
  try {
    const page = await session.context.newPage();
    const pageErrors = [];
    page.on('pageerror', (err) => pageErrors.push(String(err)));
    await page.goto('http://127.0.0.1:' + port + '/');
    assert.equal(await evaluate(page, installHelpers), true, 'secure context with crypto.subtle and indexedDB');

    await t.test(name + ': saveSite, getSite, getFile, touchSite, deleteSite (with its docs)', async () => {
      const r = await evaluate(page, scenarioSites, args);
      assert.equal(r.blobSupport, expectBlobs, 'Blob storage probe');
      assert.equal(r.storedType, expectBlobs ? '[object Blob]' : '[object ArrayBuffer]');
      assert.equal(r.cssIsBlob, true, 'getFile always returns a Blob');
      assert.equal(r.version, 2);
      assert.deepEqual(r.stores, ['docs', 'files', 'keys', 'meta', 'pins', 'pointers', 'prefs', 'sites']);
      assert.equal(r.manifest.kind, 'site');
      assert.equal(r.manifest.name, 'site');
      assert.equal(r.manifest.total, 35000);
      assert.equal(r.manifest.complete, true);
      assert.equal(r.manifest.torrentIsBytes, true);
      assert.equal(r.manifest.savedAtSet, true);
      assert.deepEqual(r.manifest.files.map((f) => [f.path, f.length, f.offset]), [['index.html', 10000, 0], ['css/app.css', 20000, 10000], ['img/a.png', 5000, 30000]]);
      assert.deepEqual(r.cssBytes, Array.from(site.files[1].data.subarray(0, 8)));
      assert.equal(r.cssSize, 20000);
      assert.equal(r.missingFile, null);
      assert.equal(r.listed.length, 1);
      assert.equal(r.touched, true);
      assert.equal(r.lastVisit, 5000);
      assert.equal(r.touchedMissing, false);
      assert.equal(r.afterDelete.site, null);
      assert.equal(r.afterDelete.file, null);
      assert.equal(r.afterDelete.otherFile, 10000, 'the other site keeps its files');
      assert.deepEqual(r.afterDelete.sites, ['f'.repeat(40)]);
      assert.deepEqual(r.afterDelete.docs, ['https://x/b.html'], 'documents stamped with the deleted btih are gone');
      assert.deepEqual(r.resaved, { kept: true, dropped: null });
    });

    await t.test(name + ': enforceBudget evicts least recently visited, never kept sites', async () => {
      const r = await evaluate(page, scenarioBudget, args);
      assert.deepEqual(r.r1, { evicted: [], total: r.each * 4 });
      assert.deepEqual(r.r2.evicted, ['b'.repeat(40), 'c'.repeat(40)], 'a is kept although it is the oldest');
      assert.deepEqual(r.left, ['a'.repeat(40), 'd'.repeat(40)]);
      assert.equal(r.usage.sites, 2);
      assert.equal(r.usage.siteBytes, r.each * 2);
      assert.equal(r.usage.quotaIsNumber, true);
      assert.equal(r.persistedType, 'boolean');
    });

    await t.test(name + ': pointers, pins (firstSeen survives a key change), prefs, meta, keys', async () => {
      const r = await evaluate(page, scenarioKv);
      assert.deepEqual(r.pointer, { raw: 'v=mw1', source: 'meta', savedAt: 'number', xs: ['u'] });
      assert.equal(r.noPointer, null);
      assert.equal(r.pins.first.owner, 'OWNER1');
      assert.equal(r.pins.first.decidedAt, 100);
      assert.equal(r.pins.secondOwner, 'OWNER2');
      assert.equal(r.pins.firstSeenKept, true);
      assert.equal(r.pins.reason, 'rot');
      assert.equal(r.pins.stored, 'OWNER2');
      assert.deepEqual(r.prefs, { uploads: false, missing: 'dflt' });
      assert.deepEqual(r.meta, { current: { btih: 'b'.repeat(40), ledgerId: 'mw1:x', routing: { spa: true } }, none: null });
      assert.equal(r.shapeError, 'TypeError');
      assert.equal(r.key, 'P');
      assert.equal(r.keyDeleted, null);
      assert.deepEqual(r.added, [true, false], 'addKey: the second tab is told the key exists');
      assert.equal(r.addedKept, 'A');
    });

    await t.test(name + ': identity CryptoKey round trip, and the JWK fallback path still signs', async () => {
      const r = await evaluate(page, scenarioIdentity);
      assert.equal(r.a.kind, 'cryptokey');
      assert.equal(r.a.loadedKind, 'cryptokey');
      assert.equal(r.a.samePub, true);
      assert.equal(r.a.extractable, false);
      assert.equal(r.a.signs, true);
      assert.deepEqual(r.b, { kind: 'jwk', storedKind: 'jwk', storedHasD: true, loadedKind: 'jwk', extractable: false, signs: true });
      assert.equal(r.none, null);
    });

    await t.test(name + ': v1 database upgrades to v2 (identity store dropped, pins and prefs kept)', async () => {
      const r = await evaluate(page, scenarioMigration);
      assert.equal(r.version, 2);
      assert.deepEqual(r.stores, ['docs', 'files', 'keys', 'meta', 'pins', 'pointers', 'prefs', 'sites']);
      assert.equal(r.sitesKeyPath, null, 'out-of-line keys');
      assert.deepEqual(r.pin, { owner: 'O', decidedAt: 1 });
      assert.equal(r.pref, 'yes');
      assert.equal(r.sites, 0);
    });

    await t.test(name + ': our connection steps aside on versionchange', async () => {
      const r = await evaluate(page, scenarioVersionChange);
      assert.equal(r.upgraded.ok, true, JSON.stringify(r.upgraded));
      assert.equal(r.fast, true);
      assert.equal(r.reopenError, 'VersionError', 'a newer schema is reported, not silently used');
    });

    await t.test(name + ': BlobChunkStore and verifyFile over Blobs read back from IndexedDB', async () => {
      const r = await evaluate(page, scenarioChunkStore, args);
      assert.equal(r.infoHash, true);
      assert.deepEqual(r.files, [true, true, true]);
      assert.deepEqual(r.verified, [0, 1, 2]);
      const all = Buffer.concat(site.files.map((f) => Buffer.from(f.data)));
      assert.deepEqual(r.pieceSlice, Array.from(all.subarray(16384 + 100, 16384 + 104)));
      assert.equal(r.badRead, 'piece verification failed/E_VERIFY');
      assert.deepEqual(r.failed, [1]);
      assert.equal(r.verifyFileAfterTamper, false);
      t.diagnostic(name + ' verifyFile(index.html) from IndexedDB: ' + r.verifyMs.toFixed(1) + ' ms');
    });

    await t.test(name + ': limited mode: a module graph with a cycle links once per module; the frame has the page URL and pushState works', async () => {
      const r = await evaluate(page, scenarioLimitedModules);
      if (r.importMaps) assert.equal(r.out, 'shared:route ok:helper (entry ran 1x)');
      else t.diagnostic(name + ' has no import maps: the recursive rewrite keeps its cycle limit (' + r.out + ')');
      assert.equal(r.pushed, '/about', 'history.pushState in the limited-mode frame');
    });

    await t.test(name + ': DoH fetch is a simple CORS GET (no preflight, Accept only, no referrer)', async () => {
      doh.dohLog.length = 0;
      const template = 'http://127.0.0.1:' + doh.port + '/dns?name={name}&type={type}';
      const r = await evaluate(page, scenarioDoh, { template });
      assert.deepEqual(r, { resolver: 'override', strings: ['v=mw1; btih=' + BTIH + '; dn=My%20Site'], ad: true, ttl: 120, status: 0, dn: 'My Site' });
      assert.deepEqual(doh.dohLog.map((e) => e.method), ['GET'], 'no OPTIONS preflight');
      const h = doh.dohLog[0].headers;
      assert.equal(h.accept, 'application/dns-json');
      assert.equal(h.referer, undefined);
      assert.equal(h.cookie, undefined);
      assert.equal(h.origin, 'http://127.0.0.1:' + port, 'cross-origin request');
    });

    assert.deepEqual(pageErrors, []);
  } finally {
    await session.close();
    for (const s of [server, doh.server]) {
      s.closeAllConnections();
      await new Promise((resolve) => s.close(resolve));
    }
  }
}

test('Chromium: cache.js, chunk stores and DoH in a real browser', { timeout: 120000 },
  (t) => runBrowser(t, 'chromium', chromium, launchEphemeral, true));
test('WebKit, persistent profile: cache.js, chunk stores and DoH', { timeout: 120000 },
  (t) => runBrowser(t, 'webkit-persistent', webkit, launchPersistent, true));
test('WebKit, ephemeral session (Safari Private Browsing): no Blobs in IndexedDB, bytes fallback', { timeout: 120000 },
  (t) => runBrowser(t, 'webkit-ephemeral', webkit, launchEphemeral, false));
