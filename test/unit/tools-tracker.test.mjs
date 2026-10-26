// Unit tests for tools/tracker.mjs (ARCHITECTURE section 10, DESIGN-REVIEW item 12(d)).
// Everything runs on 127.0.0.1 with ephemeral ports; every server is closed in after().
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync, utimesSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import WebSocket from 'ws';

import {
  createTracker, createAllowList, hashesFromText, readAllowFile, messageProblem, chatLaneHash, hubLaneHash, CHAT_LANE_PREFIX, HUB_LANE_PREFIX,
} from '../../tools/tracker.mjs';
import { LANE_PREFIX as CHAT_LIMITS_PREFIX } from '../../src/chat/limits.js';
import { LANE_PREFIX as HUB_MULTI_PREFIX, laneInfoHash } from '../../src/chain/multi.js';
import { chatLaneInfoHash } from '../../src/chat/lane.js';
import { UsageError } from '../../tools/lib.mjs';
import { buildSingleFileTorrent } from '../../src/common/torrent-file.js';

const A = 'a'.repeat(40);
const B = 'b'.repeat(40);
const C = 'c'.repeat(40);
const dir = mkdtempSync(join(tmpdir(), 'mw-tracker-test-'));
const trackers = [];
const sockets = [];

after(async () => {
  for (const s of sockets) {
    try { s.terminate(); } catch (_) { /* gone */ }
  }
  for (const t of trackers) await t.close();
  rmSync(dir, { recursive: true, force: true });
});

const bin = (hex) => Buffer.from(hex, 'hex').toString('binary');

async function start(options) {
  const t = await createTracker(Object.assign({ port: 0 }, options));
  trackers.push(t);
  return t;
}

function connect(tracker) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(tracker.url);
    sockets.push(ws);
    ws.once('open', () => resolve(ws));
    ws.once('error', reject);
  });
}

// Sends one request and resolves with the first reply that has an action.
function ask(ws, message) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('no reply from the tracker')), 5000);
    ws.once('message', (data) => {
      clearTimeout(timer);
      resolve(JSON.parse(data.toString('utf8')));
    });
    ws.send(JSON.stringify(message));
  });
}

const announce = (hex, peer = 'p'.repeat(20)) => ({
  action: 'announce', info_hash: bin(hex), peer_id: peer, uploaded: 0, downloaded: 0, left: 0, event: 'started', numwant: 0, offers: [],
});

test('refuses to start without --allow unless --open is given', async () => {
  await assert.rejects(createTracker({ port: 0 }), (err) => err instanceof UsageError && /--allow/.test(err.message) && /--open/.test(err.message));
  await assert.rejects(createTracker({ port: 0, allow: [] }), UsageError);
  const open = await start({ open: true });
  assert.match(open.url, /^ws:\/\/127\.0\.0\.1:\d+$/);
  const allowed = await start({ allow: [A] });
  assert.equal(allowed.allow.size, 1);
});

test('an allow-listed infohash is served; any other is refused with a failure reason', async () => {
  const t = await start({ allow: [A, 'urn:btih:' + B] });
  const ws = await connect(t);
  const ok = await ask(ws, announce(A));
  assert.equal(ok.action, 'announce');
  assert.ok(ok.interval > 0, 'the tracker tells the client when to announce again');
  assert.equal(ok['failure reason'], undefined);
  const refused = await ask(ws, announce(C));
  assert.match(refused['failure reason'], /not allowed/);
  assert.equal(refused.complete, undefined);
});

test('--open serves every infohash', async () => {
  const t = await start({ open: true });
  const ws = await connect(t);
  const ok = await ask(ws, announce(C));
  assert.equal(ok.action, 'announce');
  assert.equal(ok['failure reason'], undefined);
});

test('a scrape must name its infohashes (a bare scrape would list every torrent)', async () => {
  const t = await start({ open: true });
  const ws = await connect(t);
  await ask(ws, announce(A));
  const bare = await ask(ws, { action: 'scrape' });
  assert.equal(bare.action, 'scrape');
  assert.deepEqual(bare.files, {}, 'no torrent is listed');
  const named = await ask(ws, { action: 'scrape', info_hash: bin(A) });
  assert.equal(named.action, 'scrape');
  assert.ok(named.files[bin(A)], 'counts for the infohash that was asked for');
});

test('oversized WebSocket messages are rejected (maxPayload)', async () => {
  const t = await start({ open: true, maxPayload: 2048 });
  const ws = await connect(t);
  const closed = new Promise((resolve) => ws.once('close', (code) => resolve(code)));
  ws.send('x'.repeat(4096));
  assert.equal(await closed, 1009);
});

test('GET / and /healthz answer 200, /stats.json counts without listing infohashes, other paths 404', async () => {
  const t = await start({ allow: [A] });
  const base = t.url.replace(/^ws:/, 'http:');
  assert.equal((await fetch(base + '/')).status, 200);
  assert.equal(await (await fetch(base + '/healthz')).text(), 'ok\n');
  const ws = await connect(t);
  await ask(ws, announce(A));
  const stats = await (await fetch(base + '/stats.json')).json();
  assert.deepEqual(Object.keys(stats).sort(), ['allowed', 'open', 'peers', 'torrents', 'unlisted', 'uploads']);
  assert.equal(stats.allowed, 1);
  assert.equal(stats.torrents, 1);
  assert.equal(JSON.stringify(stats).includes(A), false);
  assert.equal((await fetch(base + '/nope')).status, 404);
  assert.equal((await fetch(base + '/', { method: 'POST' })).status, 405);
});

test('hashesFromText reads publish summary.json, magnet links, pointers and plain lists', () => {
  const summary = JSON.stringify({ btih: A, anchorBtih: B, files: [{ path: 'x', sha256: C }], tr: [] });
  assert.deepEqual(Array.from(hashesFromText(summary)).sort(), [A, B]);
  const list = ['# my torrents', A.toUpperCase() + '   # shouted', '', 'magnet:?xt=urn:btih:' + B + '&dn=x', 'v=mw1; btih=' + C + '; dn=site'].join('\n');
  assert.deepEqual(Array.from(hashesFromText(list)).sort(), [A, B, C]);
  assert.equal(hashesFromText('not an infohash\n').size, 0);
});

test('readAllowFile reads a .torrent file, and --allow files are re-read when they change', async () => {
  const built = await buildSingleFileTorrent({ name: 'one', content: new TextEncoder().encode('hello'), pieceLength: 16384 });
  const torrentPath = join(dir, 'one.torrent');
  writeFileSync(torrentPath, built.torrentFile);
  assert.deepEqual(Array.from(await readAllowFile(torrentPath)), [built.infoHash]);

  const listPath = join(dir, 'allow.txt');
  writeFileSync(listPath, A + '\n');
  const t = await start({ allow: [listPath] });
  const ws = await connect(t);
  assert.match((await ask(ws, announce(B)))['failure reason'], /not allowed/);
  writeFileSync(listPath, A + '\n' + B + '\n');
  const later = new Date(Date.now() + 5000);
  utimesSync(listPath, later, later);
  await new Promise((r) => setTimeout(r, 1100)); // the file is checked at most once per second
  await ask(ws, announce(B)).catch(() => null); // the first request after the change triggers the re-read
  await new Promise((r) => setTimeout(r, 200));
  const reply = await ask(ws, announce(B));
  assert.equal(reply['failure reason'], undefined, 'the new infohash is served after the file changed');
});

test('createAllowList rejects a spec that is neither an infohash nor a readable file', async () => {
  await assert.rejects(createAllowList(['no-such-file-' + Date.now()]), UsageError);
  const list = await createAllowList([A, 'magnet:?xt=urn:btih:' + B]);
  assert.equal(list.size, 2);
  assert.ok(list.has(A) && list.has(B) && !list.has(C));
});

test('a malformed offers list is refused instead of crashing the tracker', async () => {
  const t = await start({ open: true });
  const a = await connect(t);
  await ask(a, announce(A, 'a'.repeat(20)));
  const b = await connect(t);
  // bittorrent-tracker 11 throws from a timer on offers: [null] when another peer is in the swarm
  const bad = await ask(b, Object.assign(announce(A, 'b'.repeat(20)), { left: 1, offers: [null] }));
  assert.match(bad['failure reason'], /offers/);
  const worse = await ask(b, Object.assign(announce(A, 'b'.repeat(20)), { left: 1, offers: 'xxxxx' }));
  assert.match(worse['failure reason'], /offers/);
  const alive = await ask(b, announce(A, 'b'.repeat(20)));
  assert.equal(alive.action, 'announce', 'the tracker still answers');
  assert.equal(alive['failure reason'], undefined);
});

test('messageProblem: valid frames pass, shapes the library would dereference are refused', () => {
  const offer = { offer_id: 'o'.repeat(20), offer: { type: 'offer', sdp: 'v=0' } };
  assert.equal(messageProblem(JSON.stringify({ action: 'announce', offers: [offer] })), null);
  assert.equal(messageProblem(JSON.stringify({ action: 'announce' })), null);
  assert.equal(messageProblem(JSON.stringify({ action: 'scrape' })), null);
  assert.equal(messageProblem('not json at all'), null, 'left to the library, which answers with a failure reason');
  assert.match(messageProblem('[1,2]'), /invalid/);
  assert.match(messageProblem(JSON.stringify({ action: 'announce', offers: [null] })), /offers/);
  assert.match(messageProblem(JSON.stringify({ action: 'announce', offers: [{ offer_id: 'x' }] })), /offers/);
  assert.match(messageProblem(JSON.stringify({ action: 'announce', offers: new Array(21).fill(offer) })), /offers/);
  assert.match(messageProblem(JSON.stringify({ action: 'announce', answer: { type: 'answer' }, to_peer_id: 5, offer_id: 'x' })), /answer/);
  assert.equal(messageProblem(Buffer.from(JSON.stringify({ action: 'announce', offers: [offer] }))), null);
});

test('--tls serves wss:// with the certificate files given; mkcert-less machines get instructions', async (t) => {
  const { spawnSync } = await import('node:child_process');
  const certDir = join(dir, 'tls');
  const { mkdirSync, readFileSync } = await import('node:fs');
  mkdirSync(certDir);
  const made = spawnSync('openssl', ['req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:prime256v1', '-nodes', '-keyout', join(certDir, 'key.pem'),
    '-out', join(certDir, 'cert.pem'), '-days', '1', '-subj', '/CN=localhost', '-addext', 'subjectAltName=DNS:localhost,IP:127.0.0.1'], { encoding: 'utf8' });
  const saved = process.env.PATH;
  process.env.PATH = '';
  try {
    await assert.rejects(createTracker({ port: 0, open: true, tls: true }), /mkcert/);
  } finally {
    process.env.PATH = saved;
  }
  if (made.status !== 0) {
    t.skip('openssl is not available');
    return;
  }
  const cert = readFileSync(join(certDir, 'cert.pem'));
  const tracker = await start({ open: true, tls: { cert: join(certDir, 'cert.pem'), key: join(certDir, 'key.pem') } });
  assert.match(tracker.url, /^wss:\/\/127\.0\.0\.1:\d+$/);
  const ws = await new Promise((resolve, reject) => {
    const socket = new WebSocket(tracker.url, { ca: cert, servername: 'localhost' });
    sockets.push(socket);
    socket.once('open', () => resolve(socket));
    socket.once('error', reject);
  });
  const reply = await ask(ws, announce(A));
  assert.equal(reply.action, 'announce');
  assert.equal(reply['failure reason'], undefined);
});

// ---------------------------------------------------------------------------------------------- review round (SCALE-2, SCALE-10)

const randomHex = (i) => createHash('sha1').update('swarm-' + i + '-' + Math.random()).digest('hex');
const writeAllow = (name, text) => {
  const file = join(dir, name);
  writeFileSync(file, text);
  return file;
};

test('SCALE-2: the lane prefixes match the loader, so the derived lanes are the infohashes it announces', async () => {
  assert.equal(CHAT_LANE_PREFIX, CHAT_LIMITS_PREFIX);
  assert.equal(HUB_LANE_PREFIX, HUB_MULTI_PREFIX);
  assert.equal(chatLaneHash('ledger-xyz'), await chatLaneInfoHash('ledger-xyz'));
  assert.equal(hubLaneHash('Hub.Example.'), await laneInfoHash('hub.example', 0));
});

test('SCALE-2: a summary.json allows the site chat lane (from its ledgerId); files or media on turn uploads mode on', async () => {
  const ledgerId = 'k3xample-ledger-id';
  const chatOnly = writeAllow('chat-summary.json', JSON.stringify({ btih: A, rendezvousBtih: B, ledgerId, features: ['chat'] }));
  const t = await start({ allow: [chatOnly] });
  const ws = await connect(t);
  assert.equal((await ask(ws, announce(chatLaneHash(ledgerId))))['failure reason'], undefined, 'the chat lane is served');
  assert.match((await ask(ws, announce(C)))['failure reason'], /not allowed/, 'without files or media nothing unlisted is served');
  assert.equal(t.stats().uploads, false);

  const withFiles = writeAllow('files-summary.json', JSON.stringify({ btih: A, rendezvousBtih: B, ledgerId, features: ['chat', 'files'] }));
  const u = await start({ allow: [withFiles] });
  const ws2 = await connect(u);
  assert.equal(u.stats().uploads, true);
  assert.equal((await ask(ws2, announce(randomHex(1))))['failure reason'], undefined, 'a file swarm (a new infohash per upload) is served');
  // the text form: an "uploads" line and a "hub <suffix>" line
  const text = writeAllow('allow.txt', A + '\nuploads\nhub hub.example\n');
  const h = await start({ allow: [text] });
  assert.equal(h.stats().uploads, true);
  assert.equal(h.allow.has(hubLaneHash('hub.example')), true);
  const viaFlag = await start({ allow: [A], hubs: ['hub.example'] });
  assert.equal(viaFlag.allow.has(hubLaneHash('hub.example')), true);
  assert.equal(viaFlag.stats().uploads, false);
});

test('SCALE-10: one connection is capped in unlisted swarms; a second connection still creates one; listed swarms are never refused', async () => {
  const t = await start({ allow: [A], uploads: true, maxSwarmsPerSocket: 5 });
  const flood = await connect(t);
  for (let i = 0; i < 5; i++) assert.equal((await ask(flood, announce(randomHex(i))))['failure reason'], undefined, 'swarm ' + i);
  assert.match((await ask(flood, announce(randomHex(99))))['failure reason'], /too many swarms on this connection/);
  assert.equal((await ask(flood, announce(A)))['failure reason'], undefined, 'the listed site swarm is not counted or refused');
  const other = await connect(t);
  assert.equal((await ask(other, announce(randomHex(100), 'q'.repeat(20))))['failure reason'], undefined, 'another connection is not affected');
});

test('SCALE-10: a full tracker refuses new unlisted swarms but still serves the listed ones', async () => {
  const t = await start({ allow: [A], uploads: true, maxTorrents: 3 });
  const ws = await connect(t);
  for (let i = 0; i < 3; i++) assert.equal((await ask(ws, announce(randomHex(i))))['failure reason'], undefined);
  assert.match((await ask(ws, announce(randomHex(7))))['failure reason'], /this tracker is full/);
  assert.equal((await ask(ws, announce(A)))['failure reason'], undefined, 'the site swarm is served on a full tracker');
  assert.equal(t.stats().unlisted, 3);
});

test('SCALE-10: a closed connection takes every peer id it announced, so its swarms empty and are pruned', async () => {
  const t = await start({ open: true, maxTorrents: 3 });
  const ws = await connect(t);
  const hashes = [randomHex(1), randomHex(2), randomHex(3)];
  for (let i = 0; i < 3; i++) await ask(ws, announce(hashes[i], String(i).repeat(20)));
  assert.equal(t.stats().peers, 3);
  const closed = new Promise((resolve) => ws.once('close', resolve));
  ws.close();
  await closed;
  for (let i = 0; i < 50 && t.stats().peers > 0; i++) await new Promise((r) => setTimeout(r, 20));
  assert.equal(t.stats().peers, 0, 'no phantom peer is left behind');
  assert.equal(t.prune(), 3);
  const again = await connect(t);
  assert.equal((await ask(again, announce(randomHex(4))))['failure reason'], undefined, 'the tracker has room again');
});
