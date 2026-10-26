// Unit tests for tools/seed.mjs (ARCHITECTURE section 10): the pieces that need no WebRTC. The
// directory check, the read-only chunk store, the tracker rewrite, the WebRTC loader with a stand-in
// importer, and the dry-run command line.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';

import { verifyDirectory, resolveSeedDir, createDirStoreClass, rewriteAnnounce, loadWebRtc, seedInstructions } from '../../tools/seed.mjs';
import { publish } from '../../tools/publish.mjs';
import { keygen } from '../../tools/keygen.mjs';
import { ROOT } from '../../tools/lib.mjs';
import { parseTorrentFile, sliceForPiece } from '../../src/common/torrent-file.js';

const work = mkdtempSync(join(tmpdir(), 'mw-seed-test-'));
after(() => rmSync(work, { recursive: true, force: true }));

let published;
async function fixture() {
  if (published) return published;
  const site = join(work, 'site');
  mkdirSync(join(site, 'img'), { recursive: true });
  writeFileSync(join(site, 'index.html'), '<!doctype html><title>x</title>' + 'hello '.repeat(300));
  writeFileSync(join(site, 'big.bin'), Buffer.alloc(600000, 7)); // spans three 256 KiB pieces
  writeFileSync(join(site, 'img', 'a.txt'), 'a'.repeat(1000));
  const key = join(work, 'owner.jwk');
  await keygen({ out: key });
  const out = join(work, 'out');
  const res = await publish({ dir: site, name: 'seed-site', scope: 'example.com', key, out, quiet: true, tr: ['wss://t1.example', 'wss://t2.example'] });
  const torrentBytes = new Uint8Array(readFileSync(join(out, 'site.torrent')));
  published = { out, tree: join(out, 'seed-site'), res, torrentBytes, parsed: await parseTorrentFile(torrentBytes) };
  return published;
}

test('verifyDirectory accepts the upload tree and hashes every piece', async () => {
  const f = await fixture();
  const ok = verifyDirectory(f.parsed, f.tree);
  assert.equal(ok.ok, true);
  assert.equal(ok.pieces, f.parsed.pieceCount);
  assert.ok(f.parsed.pieceCount >= 3);
});

test('verifyDirectory names missing files, wrong lengths and corrupted pieces', async () => {
  const f = await fixture();
  const copy = join(work, 'copy');
  mkdirSync(join(copy, 'img'), { recursive: true });
  mkdirSync(join(copy, '.mw'), { recursive: true });
  for (const file of f.parsed.files) writeFileSync(join(copy, ...file.path.split('/')), readFileSync(join(f.tree, ...file.path.split('/'))));
  assert.equal(verifyDirectory(f.parsed, copy).ok, true);
  // one flipped byte in the middle of big.bin: same length, one bad piece
  const big = readFileSync(join(copy, 'big.bin'));
  big[300000] ^= 1;
  writeFileSync(join(copy, 'big.bin'), big);
  const bad = verifyDirectory(f.parsed, copy);
  assert.equal(bad.ok, false);
  assert.deepEqual(bad.badPieces, [1], 'the piece that holds the byte');
  // wrong length
  appendFileSync(join(copy, 'img', 'a.txt'), 'x');
  const longer = verifyDirectory(f.parsed, copy);
  assert.deepEqual(longer.wrongLength, [{ path: 'img/a.txt', want: 1000, got: 1001 }]);
  // missing file
  rmSync(join(copy, 'index.html'));
  const missing = verifyDirectory(f.parsed, copy);
  assert.deepEqual(missing.missing, ['index.html']);
  assert.equal(missing.ok, false);
});

test('resolveSeedDir: the tree itself, or the directory that contains it', async () => {
  const f = await fixture();
  assert.equal(resolveSeedDir(f.parsed, f.tree), f.tree);
  assert.equal(resolveSeedDir(f.parsed, f.out), f.tree, 'the publish output directory holds <name>/');
  assert.equal(resolveSeedDir(f.parsed, join(work, 'nowhere')), join(work, 'nowhere'));
});

test('the read-only chunk store returns the pieces of the files, whole or sliced, and never writes', async () => {
  const f = await fixture();
  const Store = createDirStoreClass(f.parsed, f.tree);
  const store = new Store(f.parsed.pieceLength);
  const whole = Buffer.concat(f.parsed.files.map((file) => readFileSync(join(f.tree, ...file.path.split('/')))));
  for (let i = 0; i < f.parsed.pieceCount; i++) {
    const piece = await new Promise((resolve, reject) => store.get(i, (err, buf) => (err ? reject(err) : resolve(buf))));
    assert.equal(Buffer.from(piece).equals(whole.subarray(i * f.parsed.pieceLength, Math.min(whole.length, (i + 1) * f.parsed.pieceLength))), true, 'piece ' + i);
    assert.ok(sliceForPiece(f.parsed, i).length >= 1);
  }
  const part = await new Promise((resolve, reject) => store.get(0, { offset: 10, length: 5 }, (err, buf) => (err ? reject(err) : resolve(buf))));
  assert.equal(Buffer.from(part).equals(whole.subarray(10, 15)), true);
  const err = await new Promise((resolve) => store.get(999, (e) => resolve(e)));
  assert.ok(err instanceof Error);
  await new Promise((resolve) => store.put(0, Buffer.alloc(1), resolve));
  const unchanged = await new Promise((resolve, reject) => store.get(0, (e, buf) => (e ? reject(e) : resolve(buf))));
  assert.equal(Buffer.from(unchanged).equals(whole.subarray(0, f.parsed.pieceLength)), true, 'put is ignored');
  await new Promise((resolve) => store.destroy(resolve));
});

test('rewriteAnnounce replaces the tracker lists and leaves the infohash alone', async () => {
  const f = await fixture();
  assert.deepEqual(f.parsed.announce, ['wss://t1.example', 'wss://t2.example']);
  const local = await parseTorrentFile(rewriteAnnounce(f.torrentBytes, ['ws://127.0.0.1:8000']));
  assert.deepEqual(local.announce, ['ws://127.0.0.1:8000']);
  assert.equal(local.infoHash, f.parsed.infoHash);
  assert.deepEqual(local.urlList, f.parsed.urlList, 'the web seeds stay');
  const none = await parseTorrentFile(rewriteAnnounce(f.torrentBytes, []));
  assert.deepEqual(none.announce, []);
  assert.equal(none.infoHash, f.parsed.infoHash);
});

test('loadWebRtc installs the polyfill globals from the first importer that works; otherwise it says why', async () => {
  class PC {}
  class SD {}
  class IC {}
  const target = {};
  const tried = [];
  const ok = await loadWebRtc({
    target,
    importer: async (name) => {
      tried.push(name);
      if (name === 'node-datachannel/polyfill') throw new Error('Cannot find package');
      return { default: { RTCPeerConnection: PC, RTCSessionDescription: SD, RTCIceCandidate: IC } };
    },
  });
  assert.deepEqual(ok, { ok: true, source: 'webrtc-polyfill' });
  assert.deepEqual(tried, ['node-datachannel/polyfill', 'webrtc-polyfill']);
  assert.equal(target.RTCPeerConnection, PC);
  assert.equal(target.WRTC.RTCSessionDescription, SD);
  const first = {};
  await loadWebRtc({ target: first, importer: async () => ({ RTCPeerConnection: PC, RTCSessionDescription: SD, RTCIceCandidate: IC }) });
  assert.equal(first.RTCIceCandidate, IC);
  const absent = await loadWebRtc({ target: {}, importer: async (name) => { throw new Error('cannot load ' + name); } });
  assert.equal(absent.ok, false);
  assert.match(absent.reason, /node-datachannel\/polyfill: cannot load node-datachannel\/polyfill; webrtc-polyfill: cannot load webrtc-polyfill/);
  const text = seedInstructions({ torrent: 'site.torrent', dir: '/srv/site', reason: absent.reason });
  assert.match(text, /npm rebuild node-datachannel --ignore-scripts=false/, 'the pinned version, and only its script (SUP-1)');
  assert.doesNotMatch(text, /npm install node-datachannel/);
  assert.match(text, /tools\/pin\.mjs/);
  assert.match(text, /tools\/demo\.mjs/);
  assert.match(text, /still loads from its web seed/);
});

test('command line: --dry-run verifies and exits 0; a wrong directory exits 1 with the remedy; usage errors exit 2', async () => {
  const f = await fixture();
  const run = (...args) => spawnSync(process.execPath, ['tools/seed.mjs', ...args], { cwd: ROOT, encoding: 'utf8' });
  const ok = run(join(f.out, 'site.torrent'), f.out, '--dry-run');
  assert.equal(ok.status, 0, ok.stderr);
  assert.match(ok.stdout, /seed seed-site \(btih [0-9a-f]{40}/);
  assert.match(ok.stdout, /all \d+ pieces match the torrent/);
  const wrong = run(join(f.out, 'site.torrent'), join(ROOT, 'examples', 'peer-guestbook'), '--dry-run');
  assert.equal(wrong.status, 1);
  assert.match(wrong.stdout + wrong.stderr, /does not match the torrent/);
  assert.match(wrong.stdout, /upload tree that publish wrote/);
  assert.equal(run(join(f.out, 'site.torrent')).status, 2);
  assert.equal(run(join(work, 'missing.torrent'), f.out, '--dry-run').status, 1);
});
