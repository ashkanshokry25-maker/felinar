// cache.js in Node: the pure helpers and the argument checks that run before IndexedDB. The
// IndexedDB paths themselves run in real Chromium and WebKit in loader-common-browser.test.mjs.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DB_NAME, DB_VERSION, STORES, fileKey, fileKeyBounds, siteRelativePath, identityKeyName, moderatorKeyName,
  buildManifest, saveSite, getSite, requestPersist, estimateUsage, openDb,
} from '../../src/loader/cache.js';
import { parseTorrentFile } from '../../src/common/torrent-file.js';
import { threeFileSite, paddedTorrent, blobMap } from './common-fixtures.test.mjs';

const BTIH = '0123456789abcdef0123456789abcdef01234567';

test('schema constants are the v2 contract shared with the SW reader', () => {
  assert.equal(DB_NAME, 'mw-sites');
  assert.equal(DB_VERSION, 2);
  assert.deepEqual(STORES, {
    sites: 'sites', files: 'files', pointers: 'pointers', pins: 'pins', prefs: 'prefs', keys: 'keys', meta: 'meta', docs: 'docs',
  });
});

test('fileKey and fileKeyBounds select exactly one btih', () => {
  assert.equal(fileKey(BTIH, 'css/app.css'), BTIH + '/css/app.css');
  const [lo, hi] = fileKeyBounds(BTIH);
  const inside = (k) => k >= lo && k < hi;
  for (const p of ['index.html', 'a', 'z/z/z', '￿', '~', ' ']) assert.ok(inside(fileKey(BTIH, p)), p);
  const next = BTIH.slice(0, -1) + '8';
  for (const k of [BTIH, BTIH + '0', next + '/a', BTIH.slice(0, -1) + '6/zzz', BTIH + '.']) assert.ok(!inside(k), k);
  assert.equal(identityKeyName('mw1:abc'), 'identity:mw1:abc');
  assert.equal(moderatorKeyName('btih:' + BTIH), 'moderator:btih:' + BTIH);
});

test('siteRelativePath: strips the torrent name from WebTorrent file paths', () => {
  assert.equal(siteRelativePath('site/index.html', 'site', 3), 'index.html');
  assert.equal(siteRelativePath('site/css/app.css', 'site', 3), 'css/app.css');
  assert.equal(siteRelativePath('site/only.html', 'site', 1), 'only.html', 'multi-file torrent holding one file');
  assert.equal(siteRelativePath('movie.mp4', 'movie.mp4', 1), 'movie.mp4', 'single-file torrent');
  assert.equal(siteRelativePath('site\\img\\a.png', 'site', 2), 'img/a.png');
  assert.equal(siteRelativePath('/other/x', 'site', 2), 'other/x');
  assert.equal(siteRelativePath('site-2/x', 'site', 2), 'site-2/x', 'a prefix that is not the whole segment stays');
});

test('buildManifest: pad files left out, total counts stored bytes, MIME hook', async () => {
  const pt = paddedTorrent();
  const parsed = await parseTorrentFile(pt.torrentFile);
  const m = buildManifest(parsed, { torrentFile: pt.torrentFile, typeFor: (p) => (p.endsWith('.txt') ? 'text/plain' : '') });
  assert.equal(m.btih, parsed.infoHash);
  assert.equal(m.kind, 'site');
  assert.equal(m.name, 'padded');
  assert.equal(m.pieceLength, parsed.pieceLength);
  assert.deepEqual(m.files.map((f) => [f.path, f.length, f.offset, f.type]), [
    ['a.txt', 10000, 0, 'text/plain'], ['b.txt', 20000, 16384, 'text/plain'], ['empty.txt', 0, 49152, 'text/plain'], ['c.txt', 100, 49152, 'text/plain'],
  ]);
  assert.equal(m.total, 30100);
  assert.equal(buildManifest(parsed, { torrentFile: pt.torrentFile, kind: 'assets', name: 'n' }).kind, 'assets');
  assert.throws(() => buildManifest(null), TypeError);
});

test('saveSite: argument checks happen before any IndexedDB work', async () => {
  const site = await threeFileSite();
  const parsed = await parseTorrentFile(site.torrentFile);
  const manifest = buildManifest(parsed, { torrentFile: site.torrentFile });
  const blobs = blobMap(site.files);
  await assert.rejects(saveSite(Object.assign({}, manifest, { btih: 'x' }), blobs), TypeError);
  await assert.rejects(saveSite(Object.assign({}, manifest, { torrentFile: 'x' }), blobs), TypeError);
  await assert.rejects(saveSite(Object.assign({}, manifest, { files: [{ path: '/abs', length: 1 }] }), blobs), TypeError);
  await assert.rejects(saveSite(Object.assign({}, manifest, { files: [{ path: 'a', length: 1 }, { path: 'a', length: 1 }] }), blobs), /duplicate/);
  await assert.rejects(saveSite(manifest, {}), /Map/);
  const missing = new Map(blobs);
  missing.delete('img/a.png');
  await assert.rejects(saveSite(manifest, missing), /no data for img\/a.png/);
  const wrong = new Map(blobs);
  wrong.set('index.html', new Blob(['short']));
  await assert.rejects(saveSite(manifest, wrong), /index.html is 5 bytes, expected 10000/);
  // valid input in Node reaches openDb and fails cleanly: there is no IndexedDB here
  await assert.rejects(saveSite(manifest, blobs), (err) => err.code === 'E_NO_IDB');
  await assert.rejects(openDb(), (err) => err.code === 'E_NO_IDB');
  assert.equal(await getSite('not-a-btih'), null, 'invalid keys short-circuit');
});

test('requestPersist and estimateUsage degrade without StorageManager or IndexedDB', async () => {
  assert.equal(await requestPersist(), false);
  const u = await estimateUsage();
  assert.equal(u.sites, 0);
  assert.equal(u.siteBytes, 0);
});

// A minimal IDBFactory double: enough of open/transaction/objectStore(get, put) for the retry
// logic. `failures` is a list of DOMException-like names thrown by the next db.transaction()
// calls, in order.
function fakeFactory(failures) {
  const data = new Map();
  const queue = failures.slice();
  const stats = { opens: 0, closes: 0, transactions: 0 };
  const factory = {
    stats,
    open(name, version) {
      stats.opens++;
      const req = {};
      setTimeout(() => {
        req.result = {
          version,
          objectStoreNames: { contains: () => true },
          close() {
            stats.closes++;
          },
          transaction() {
            stats.transactions++;
            if (queue.length) {
              const err = new Error('simulated ' + queue[0]);
              err.name = queue.shift();
              throw err;
            }
            const tx = {
              objectStore(store) {
                if (!data.has(store)) data.set(store, new Map());
                const m = data.get(store);
                return {
                  get(key) {
                    const r = {};
                    setTimeout(() => {
                      r.result = m.get(key);
                      if (r.onsuccess) r.onsuccess();
                      setTimeout(() => tx.oncomplete && tx.oncomplete());
                    });
                    return r;
                  },
                  put(value, key) {
                    m.set(key, value);
                    setTimeout(() => tx.oncomplete && tx.oncomplete());
                    return {};
                  },
                };
              },
            };
            return tx;
          },
        };
        if (req.onsuccess) req.onsuccess();
      });
      return req;
    },
  };
  return factory;
}

test('IndexedDB errors: UnknownError is retried once on a fresh connection, others are not', async () => {
  const { setIndexedDbFactory, setPref, getPref } = await import('../../src/loader/cache.js');
  try {
    const once = fakeFactory(['UnknownError']);
    setIndexedDbFactory(once);
    await setPref('uploads', false);
    assert.equal(await getPref('uploads', true), false);
    assert.equal(once.stats.opens, 2, 'the connection was reopened');
    assert.equal(once.stats.closes, 1, 'the old connection was closed');

    const always = fakeFactory(['UnknownError', 'UnknownError']);
    setIndexedDbFactory(always);
    await assert.rejects(setPref('x', 1), (err) => err.name === 'UnknownError');
    assert.equal(always.stats.transactions, 2, 'exactly one retry');

    const quota = fakeFactory(['QuotaExceededError']);
    setIndexedDbFactory(quota);
    await assert.rejects(setPref('x', 1), (err) => err.name === 'QuotaExceededError');
    assert.equal(quota.stats.transactions, 1, 'no retry for other errors');

    const closing = fakeFactory(['InvalidStateError']);
    setIndexedDbFactory(closing);
    await setPref('y', 2);
    assert.equal(await getPref('y'), 2, 'a connection closed under us is reopened');
  } finally {
    setIndexedDbFactory(null);
  }
});
