// Unit tests for tools/check-webseed.mjs and tools/check-site.mjs (ARCHITECTURE section 10,
// DESIGN-REVIEW items 14 and S13). They run the library functions against servers on 127.0.0.1
// (the dev server, the tracker, small custom handlers) and against fake fetch/WebSocket objects;
// nothing leaves the machine and no browser is started.
import { test, after, before } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, cpSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { gzipSync } from 'node:zlib';
import { createHash } from 'node:crypto';

import { checkWebseed, webseedUrl, webseedTargets, verifyHostFiles, browserAccept, pieceIndices, PREFLIGHT_SETS } from '../../tools/check-webseed.mjs';
import { checkSite, probeTracker, describeReason } from '../../tools/check-site.mjs';
import { publish } from '../../tools/publish.mjs';
import { keygen } from '../../tools/keygen.mjs';
import { createDevServer } from '../../tools/dev-server.mjs';
import { createTracker } from '../../tools/tracker.mjs';
import { build } from '../../build.mjs';
import { ROOT } from '../../tools/lib.mjs';
import { parseTorrentFile } from '../../src/common/torrent-file.js';
import { parsePointer } from '../../src/common/pointer.js';

const work = mkdtempSync(join(tmpdir(), 'mw-check-test-'));
const closers = [];
after(async () => {
  for (const c of closers.reverse()) await c();
  rmSync(work, { recursive: true, force: true });
});

let counter = 0;
const fresh = (label) => {
  const dir = join(work, label + '-' + ++counter);
  mkdirSync(dir, { recursive: true });
  return dir;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function listen(handler) {
  const server = http.createServer(handler);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const entry = { url: 'http://127.0.0.1:' + server.address().port, close: () => new Promise((r) => { server.closeAllConnections(); server.close(r); }) };
  closers.push(entry.close);
  return entry;
}

// ---------------------------------------------------------------------------------------------- a published site on local servers

const SITE_FILES = {
  'index.html': '<!doctype html><html><head><title>Home</title></head><body><h1>Home</h1></body></html>\n',
  '404.html': '<!doctype html><html><head><title>Gone</title></head><body>gone</body></html>\n',
  'css/app.css': 'body { margin: 0 }\n'.repeat(40),
  'js/app.js': 'console.log("hi");\n'.repeat(60),
};
let published;
let distDir;
let siteDir;
let keyFile;

before(async () => {
  siteDir = fresh('site');
  for (const [p, c] of Object.entries(SITE_FILES)) {
    mkdirSync(join(siteDir, ...p.split('/').slice(0, -1)), { recursive: true });
    writeFileSync(join(siteDir, ...p.split('/')), c);
  }
  distDir = join(work, 'dist');
  await build({ outDir: distDir, quiet: true });
  keyFile = join(work, 'owner.jwk');
  await keygen({ out: keyFile });
});

// Starts the dev server (shell + web seed) and an open tracker, publishes for them, hands the dev
// server the pointer. Returns handles to break things afterwards.
async function startSite({ exp = 90, cs = null, now = Date.now() } = {}) {
  const out = fresh('out');
  const tracker = await createTracker({ port: 0, open: true });
  closers.push(() => tracker.close());
  const dev = await createDevServer({ root: distDir, webseed: out, port: 0, quiet: true });
  closers.push(() => dev.close());
  const pub = await publish({
    dir: siteDir, name: 'check-site-test', scope: '127.0.0.1', key: keyFile, out, quiet: true, now, exp,
    tr: [tracker.url], ws: [dev.url + 'ws/'], cs: cs || undefined,
  });
  dev.setPointer(pub.pointer);
  return { out, tracker, dev, pub };
}

test('check-site: a healthy local site passes every check and prints its targets first', async () => {
  const s = await startSite();
  const lines = [];
  const r = await checkSite(s.dev.url, { log: (l) => lines.push(l), timeoutMs: 5000 });
  assert.equal(r.ok, true, JSON.stringify(r.results.filter((x) => x.level === 'fail')));
  assert.equal(r.failures, 0);
  const steps = r.results.filter((x) => x.level === 'ok').map((x) => x.step);
  for (const step of ['page', '/mw-sw.js', '/_mw/boot.js', '/_mw/loader.js', 'meta pointer', 'xs', 'web seed', 'tracker']) assert.ok(steps.includes(step), step + ' passed: ' + steps.join(', '));
  assert.equal(r.record.btih, s.pub.btih);
  assert.equal(r.torrent.infoHash, s.pub.btih);
  const text = lines.join('\n');
  assert.match(text, /-> GET http:\/\/127\.0\.0\.1:\d+\//, 'the page target is logged');
  assert.match(text, /-> WebSocket ws:\/\/127\.0\.0\.1:\d+ .*scrape/, 'the tracker target is logged');
  assert.match(text, /-> web seed http:\/\/127\.0\.0\.1:\d+\/ws\/: OPTIONS and GET/, 'the web seed target is logged');
  assert.ok(text.indexOf('-> GET') < text.indexOf('[ok]'), 'targets come before results');
  assert.ok(r.results.some((x) => x.step === 'dns pointer' && x.level === 'info' && /not a public DNS name/.test(x.message)), 'DoH is skipped for IP addresses');
  assert.ok(r.results.some((x) => x.step === 'page' && /loader shell/.test(x.message)));
  assert.ok(r.results.some((x) => x.step === '/_mw/loader.js' && /matches the integrity attribute/.test(x.message)));
});

test('check-site: removing the web seed turns the check red (DESIGN-REVIEW S13 acceptance)', async () => {
  const s = await startSite();
  const good = await checkSite(s.dev.url, { doh: false, timeoutMs: 5000 });
  assert.equal(good.ok, true);
  rmSync(join(s.out, 'check-site-test', 'js', 'app.js'));
  const bad = await checkSite(s.dev.url, { doh: false, timeoutMs: 5000 });
  assert.equal(bad.ok, false);
  const fail = bad.results.find((x) => x.level === 'fail' && x.step === 'web seed');
  assert.ok(fail, 'the web seed failure is reported');
  assert.match(fail.message, /js\/app\.js/);
  assert.match(fail.message, /not uploaded/);
});

test('check-site: a missing or wrong .torrent at xs= fails; a dead tracker fails unless tolerated', async () => {
  const s = await startSite();
  const torrentFile = join(s.out, 'check-site-test.torrent');
  const original = readFileSync(torrentFile);
  rmSync(torrentFile);
  const noXs = await checkSite(s.dev.url, { doh: false, timeoutMs: 5000 });
  assert.equal(noXs.ok, false);
  assert.ok(noXs.results.some((x) => x.step === 'xs' && x.level === 'fail' && /HTTP 404/.test(x.message)));
  assert.ok(noXs.results.some((x) => x.step === 'web seed' && x.level === 'fail' && /without the \.torrent/.test(x.message)));
  // another site's torrent under the same name
  const other = await publish({ dir: siteDir, name: 'other-name', scope: '127.0.0.1', key: keyFile, out: fresh('out'), quiet: true });
  writeFileSync(torrentFile, other.torrentFile);
  const wrong = await checkSite(s.dev.url, { doh: false, timeoutMs: 5000 });
  assert.ok(wrong.results.some((x) => x.step === 'xs' && x.level === 'fail' && /the pointer says/.test(x.message)));
  writeFileSync(torrentFile, original);
  assert.equal((await checkSite(s.dev.url, { doh: false, timeoutMs: 5000 })).ok, true, 'restored');

  await s.tracker.close();
  const dead = await checkSite(s.dev.url, { doh: false, timeoutMs: 3000 });
  assert.equal(dead.ok, false);
  assert.ok(dead.results.some((x) => x.step === 'tracker' && x.level === 'fail'));
  const tolerated = await checkSite(s.dev.url, { doh: false, timeoutMs: 3000, tolerateTrackers: 1 });
  assert.equal(tolerated.ok, true, 'one tracker failure is tolerated on request');
  assert.ok(tolerated.results.some((x) => x.step === 'tracker' && x.level === 'warn'));
});

test('check-site: a tracker that does not allow the torrent says so; one that does reports who is online', async () => {
  const s = await startSite();
  const { default: WebSocket } = await import('ws');
  const factory = { kind: 'ws', WebSocket };
  const origin = s.dev.url.replace(/\/$/, '');
  const closed = await createTracker({ port: 0, allow: ['f'.repeat(40)] });
  closers.push(() => closed.close());
  const refused = await probeTracker(closed.url, { btih: s.pub.btih, origin, timeoutMs: 3000, factory });
  assert.equal(refused.ok, false);
  assert.match(refused.error, /refuses this torrent: torrent not allowed on this tracker/);
  const allowed = await createTracker({ port: 0, allow: [s.pub.btih] });
  closers.push(() => allowed.close());
  const empty = await probeTracker(allowed.url, { btih: s.pub.btih, origin, timeoutMs: 3000, factory });
  assert.equal(empty.ok, true);
  assert.deepEqual([empty.seeders, empty.leechers], [0, 0]);
  assert.ok(empty.ms >= 0 && empty.url === allowed.url);
  // a seeder is online: announce as a seeder and keep the socket open
  const seeder = new WebSocket(allowed.url);
  await new Promise((r) => seeder.once('open', r));
  seeder.send(JSON.stringify({ action: 'announce', info_hash: Buffer.from(s.pub.btih, 'hex').toString('latin1'), peer_id: 's'.repeat(20), left: 0, event: 'started', numwant: 0, offers: [] }));
  await new Promise((r) => seeder.once('message', r));
  const busy = await probeTracker(allowed.url, { btih: s.pub.btih, origin, timeoutMs: 3000, factory });
  assert.equal(busy.ok, true);
  assert.equal(busy.seeders, 1, 'the probe itself registers no peer');
  assert.equal(busy.leechers, 0);
  seeder.terminate();
  const live = await probeTracker(s.tracker.url, { btih: s.pub.btih, origin: 'http://127.0.0.1', timeoutMs: 3000, factory });
  assert.equal(live.ok, true);
  const nowhere = await probeTracker('ws://127.0.0.1:1', { btih: s.pub.btih, origin, timeoutMs: 1500, factory });
  assert.equal(nowhere.ok, false);
  const noClient = await probeTracker('ws://127.0.0.1:1', { btih: s.pub.btih, origin, timeoutMs: 500, factory: null });
  assert.match(noClient.error, /no WebSocket client/);
});

test('check-site: expired and soon-expiring pointers', async () => {
  const s = await startSite({ exp: 30 });
  const soon = await checkSite(s.dev.url, { doh: false, timeoutMs: 5000, now: Date.now() + 25 * 86400000 });
  const warn = soon.results.find((x) => x.step === 'meta pointer');
  assert.equal(warn.level, 'warn');
  assert.match(warn.message, /days left; publish again soon/);
  assert.equal(soon.ok, true, 'a warning is not a failure');
  const expired = await checkSite(s.dev.url, { doh: false, timeoutMs: 5000, now: Date.now() + 31 * 86400000 });
  assert.equal(expired.ok, false);
  assert.match(expired.results.find((x) => x.step === 'meta pointer' && x.level === 'fail').message, /expired/);
});

test('check-site: a page without a pointer, and a 404, fail with a clear message', async () => {
  const plain = await listen((req, res) => {
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end('<!doctype html><html><head></head><body>plain</body></html>');
  });
  const r = await checkSite(plain.url + '/', { doh: false, timeoutMs: 3000 });
  assert.equal(r.ok, false);
  assert.ok(r.results.some((x) => x.step === 'pointer' && /no usable pointer/.test(x.message)));
  const gone = await listen((req, res) => { res.writeHead(404); res.end('no'); });
  const g = await checkSite(gone.url + '/', { doh: false, timeoutMs: 3000 });
  assert.equal(g.ok, false);
  assert.ok(g.results.some((x) => x.step === 'page' && /HTTP 404/.test(x.message)));
  await assert.rejects(checkSite('ftp://example.com/', {}), /http/);
  await assert.rejects(checkSite('not a url', {}), /not a URL/);
  const down = await checkSite('http://127.0.0.1:1/', { doh: false, timeoutMs: 1000 });
  assert.equal(down.ok, false);
  assert.ok(down.results.some((x) => x.step === 'page' && /cannot fetch/.test(x.message)));
});

test('code review round 1: check-site reports a non-root deployment (the shell under /repo/, the origin root has no loader)', async () => {
  const shellHtml = readFileSync(join(distDir, 'index.html'));
  const boot = readFileSync(join(distDir, '_mw', 'boot.js'));
  const sub = await listen((req, res) => {
    const path = new URL(req.url, 'http://x').pathname;
    if (path === '/repo/' || path === '/repo/index.html') { res.writeHead(200, { 'content-type': 'text/html' }); res.end(shellHtml); return; }
    if (path === '/repo/_mw/boot.js') { res.writeHead(200, { 'content-type': 'text/javascript' }); res.end(boot); return; }
    res.writeHead(404, { 'content-type': 'text/plain' });
    res.end('not found');
  });
  const r = await checkSite(sub.url + '/repo/', { doh: false, timeoutMs: 3000 });
  assert.equal(r.ok, false);
  const dep = r.results.find((x) => x.step === 'deployment');
  assert.ok(dep, JSON.stringify(r.results));
  assert.equal(dep.level, 'fail');
  assert.match(dep.message, /non-root deployment: the page is under \/repo\/ and the loader files are at \/repo\/_mw\/boot\.js/);
  assert.match(dep.message, /visitors stay on "Starting\.\.\."/);
  // A root deployment never gets that line.
  const s2 = await startSite();
  const ok = await checkSite(s2.dev.url, { timeoutMs: 5000 });
  assert.equal(ok.results.some((x) => x.step === 'deployment'), false);
});

test('check-site: stale CDN (SRI mismatch) and a long-cached /mw-sw.js are reported', async () => {
  const s = await startSite();
  const bootPath = join(distDir, '_mw', 'boot.js');
  const original = readFileSync(bootPath);
  // a dev server on a copy of dist whose boot.js differs from the hash in index.html
  const stale = fresh('stale-dist');
  cpSync(distDir, stale, { recursive: true });
  writeFileSync(join(stale, '_mw', 'boot.js'), Buffer.concat([original, Buffer.from('\n// changed after the page was built\n')]));
  const dev = await createDevServer({ root: stale, port: 0, quiet: true, pointer: s.pub.pointer });
  closers.push(() => dev.close());
  const r = await checkSite(dev.url, { doh: false, timeoutMs: 4000, extraTrackers: [] });
  const sri = r.results.find((x) => x.step === '/_mw/boot.js' && x.level === 'fail');
  assert.ok(sri, 'SRI mismatch is a failure');
  assert.match(sri.message, /stale CDN or half-finished deploy/);

  // /mw-sw.js with a day of caching, through a proxy in front of the dev server
  const proxy = await listen(async (req, res) => {
    const upstream = await fetch(s.dev.url.replace(/\/$/, '') + req.url, { headers: req.headers.range ? { range: req.headers.range } : {} });
    const headers = Object.fromEntries(upstream.headers.entries());
    delete headers['content-encoding'];
    if (req.url === '/mw-sw.js') headers['cache-control'] = 'public, max-age=86400';
    const body = Buffer.from(await upstream.arrayBuffer());
    headers['content-length'] = String(body.length);
    res.writeHead(upstream.status, headers);
    res.end(body);
  });
  const cached = await checkSite(proxy.url + '/', { doh: false, timeoutMs: 4000 });
  const warn = cached.results.find((x) => x.step === '/mw-sw.js' && x.level === 'warn');
  assert.ok(warn, JSON.stringify(cached.results.filter((x) => x.step === '/mw-sw.js')));
  assert.match(warn.message, /no-cache/);
});

test('check-site: ledger snapshot (cs=) is fetched, unzipped and must hold the genesis block', async () => {
  const csHolder = { body: null };
  const snapshot = await listen((req, res) => {
    if (!csHolder.body) {
      res.writeHead(404);
      return res.end();
    }
    res.writeHead(200, { 'content-type': 'application/octet-stream', 'access-control-allow-origin': '*' });
    return res.end(csHolder.body);
  });
  const s = await startSite({ cs: snapshot.url + '/ledger.json.gz' });
  const missing = await checkSite(s.dev.url, { doh: false, timeoutMs: 4000 });
  assert.ok(missing.results.some((x) => x.step === 'snapshot' && x.level === 'fail' && /HTTP 404/.test(x.message)));
  const genesis = JSON.parse(readFileSync(join(s.out, 'genesis.json'), 'utf8'));
  csHolder.body = gzipSync(Buffer.from(JSON.stringify(genesis)));
  const ok = await checkSite(s.dev.url, { doh: false, timeoutMs: 4000 });
  assert.ok(ok.results.some((x) => x.step === 'snapshot' && x.level === 'ok' && /genesis block is there/.test(x.message)), JSON.stringify(ok.results.filter((x) => x.step === 'snapshot')));
  csHolder.body = Buffer.from(JSON.stringify([]));
  const empty = await checkSite(s.dev.url, { doh: false, timeoutMs: 4000 });
  assert.ok(empty.results.some((x) => x.step === 'snapshot' && x.level === 'fail' && /not the genesis block/.test(x.message)));
  csHolder.body = Buffer.from('{"not":"an array"}');
  const bad = await checkSite(s.dev.url, { doh: false, timeoutMs: 4000 });
  assert.ok(bad.results.some((x) => x.step === 'snapshot' && x.level === 'fail' && /not a JSON array/.test(x.message)));
});

// ---------------------------------------------------------------------------------------------- DNS through a fake DoH resolver

function dohJson(name, strings, { ad = false, ttl = 300 } = {}) {
  return JSON.stringify({
    Status: 0, AD: ad, Answer: strings.map((s) => ({ name, type: 16, TTL: ttl, data: '"' + s.replace(/(.{1,200})/g, '$1" "').replace(/" "$/, '').replace(/\\/g, '\\\\') + '"' })),
  });
}

test('check-site: DNS TXT pointer through DoH is compared with the meta tag (seq ahead, behind, other key)', async () => {
  const s = await startSite();
  const metaRec = parsePointer(s.pub.pointer).record;
  const newer = await publish({ dir: siteDir, name: 'check-site-test', scope: '127.0.0.1', key: keyFile, out: s.out, quiet: true, seq: metaRec.seq + 5, tr: [s.tracker.url], ws: [s.dev.url + 'ws/'] });
  const older = await publish({ dir: siteDir, name: 'check-site-test', scope: '127.0.0.1', key: keyFile, out: s.out, quiet: true, seq: metaRec.seq - 5, tr: [s.tracker.url], ws: [s.dev.url + 'ws/'] });
  s.dev.setPointer(s.pub.pointer); // the meta tag stays at the original seq
  const doh = (strings) => ({
    override: 'http://doh.invalid/dns?name={name}&type={type}',
    // the fake fetch below answers it
    strings,
  });
  const realFetch = globalThis.fetch;
  let txt = [];
  const fakeFetch = (url, init) => {
    if (String(url).startsWith('http://doh.invalid/')) {
      return Promise.resolve(new Response(dohJson('_magnet.127.0.0.1', txt, { ad: true }), { status: 200, headers: { 'content-type': 'application/dns-json' } }));
    }
    return realFetch(url, init);
  };
  const run = async (records) => {
    txt = records;
    return checkSite(s.dev.url, { fetch: fakeFetch, doh: doh(records), timeoutMs: 4000 });
  };

  const ahead = await run([newer.pointer]);
  const aheadMsg = ahead.results.find((x) => x.step === 'dns pointer' && x.level === 'info');
  assert.ok(aheadMsg && /ahead of the meta tag/.test(aheadMsg.message), JSON.stringify(ahead.results.filter((x) => x.step === 'dns pointer')));
  assert.equal(ahead.record.seq, metaRec.seq + 5, 'the higher seq is probed');
  assert.ok(ahead.results.some((x) => x.step === 'dns pointer' && x.level === 'ok' && /DNSSEC validated/.test(x.message)));

  const behind = await run([older.pointer]);
  assert.ok(behind.results.some((x) => x.step === 'dns pointer' && x.level === 'warn' && /behind the meta tag/.test(x.message)));
  assert.equal(behind.record.seq, metaRec.seq);

  const other = await keygen({ out: join(work, 'other-owner.jwk') });
  const foreign = await publish({ dir: siteDir, name: 'check-site-test', scope: '127.0.0.1', key: join(work, 'other-owner.jwk'), out: fresh('out'), quiet: true, seq: metaRec.seq + 9, tr: [s.tracker.url], ws: [s.dev.url + 'ws/'] });
  assert.ok(other.pub && foreign.pointer);
  const keyChange = await run([foreign.pointer]);
  assert.equal(keyChange.ok, false);
  assert.ok(keyChange.results.some((x) => x.step === 'dns pointer' && x.level === 'fail' && /another key/.test(x.message)));

  const garbage = await run(['v=mw1; btih=zz']);
  assert.ok(garbage.results.some((x) => x.step === 'dns pointer' && x.level === 'fail' && /does not parse/.test(x.message)));

  const none = await run([]);
  assert.ok(none.results.some((x) => x.step === 'dns pointer' && x.level === 'info' && /no TXT record/.test(x.message)));
  assert.equal(none.ok, true);

  const offline = await checkSite(s.dev.url, { fetch: (url, init) => (String(url).startsWith('http://doh.invalid/') ? Promise.reject(new Error('offline')) : realFetch(url, init)), doh: doh([]), timeoutMs: 2000 });
  assert.ok(offline.results.some((x) => x.step === 'dns pointer' && x.level === 'fail' && /no DNS-over-HTTPS resolver answered/.test(x.message)));
});

test('describeReason names every verifyPointer failure in plain words', () => {
  for (const reason of ['unsigned', 'no-btih', 'bad-owner', 'missing-exp', 'missing-seq', 'bad-sig', 'expired', 'exp-too-far']) {
    assert.ok(describeReason(reason, 'example.com').length > 10, reason);
  }
  assert.match(describeReason('bad-sig', 'example.com'), /example\.com/);
});

// ---------------------------------------------------------------------------------------------- check-webseed

async function publishFor(label) {
  const out = fresh(label);
  const pub = await publish({ dir: siteDir, name: 'ws-test', scope: '127.0.0.1', key: keyFile, out, quiet: true, ws: ['http://127.0.0.1:9/ws/'] });
  return { out, pub, torrent: await parseTorrentFile(new Uint8Array(pub.torrentFile)) };
}

const CORS_ALL = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-expose-headers': 'Content-Range, Content-Length, Accept-Ranges, ETag' };

// A configurable web seed over a publish output directory.
async function customSeed(dir, opts = {}) {
  const o = Object.assign({ range: true, options: 204, allowHeaders: '*', expose: CORS_ALL['access-control-expose-headers'], lengthDelta: 0, missing: [], corrupt: null, log: null }, opts);
  return listen((req, res) => {
    if (o.log) o.log.push({ method: req.method, url: req.url, headers: req.headers });
    const rel = decodeURIComponent(new URL(req.url, 'http://x').pathname).replace(/^\/ws\//, '');
    const cors = { 'access-control-allow-origin': '*' };
    if (o.expose) cors['access-control-expose-headers'] = o.expose;
    if (req.method === 'OPTIONS') {
      if (o.options >= 400) {
        res.writeHead(o.options);
        return res.end();
      }
      const h = { 'access-control-allow-origin': '*' };
      if (o.allowHeaders) h['access-control-allow-headers'] = o.allowHeaders;
      res.writeHead(o.options, h);
      return res.end();
    }
    if (o.missing.includes(rel)) {
      res.writeHead(404, cors);
      return res.end();
    }
    let data;
    try {
      data = readFileSync(join(dir, ...rel.split('/')));
    } catch (_) {
      res.writeHead(404, cors);
      return res.end();
    }
    if (o.corrupt && rel.endsWith(o.corrupt)) {
      data = Buffer.from(data);
      data[data.length - 1] ^= 0xff; // same length, other bytes: a file overwritten in place, an edge transform
    }
    const m = /^bytes=(\d+)-(\d*)$/.exec(req.headers.range || '');
    if (m && o.range) {
      const start = Number(m[1]);
      const end = m[2] ? Math.min(Number(m[2]), data.length - 1) : data.length - 1;
      res.writeHead(206, Object.assign({ 'content-range': 'bytes ' + start + '-' + end + '/' + (data.length + o.lengthDelta), 'content-length': String(end - start + 1) }, cors));
      return res.end(data.subarray(start, end + 1));
    }
    res.writeHead(200, Object.assign({ 'content-length': String(data.length) }, cors));
    return res.end(data);
  });
}

test('webseedUrl: BEP 19 URLs <base>/<name>/<path> with encoded segments; single-file torrents use the name', async () => {
  const torrent = { multiFile: true, name: 'my site' };
  assert.equal(webseedUrl('https://h.example/ws/', torrent, { path: 'a b/c#d.txt' }), 'https://h.example/ws/my%20site/a%20b/c%23d.txt');
  assert.equal(webseedUrl('https://h.example/ws', torrent, { path: 'x.js' }), 'https://h.example/ws/my%20site/x.js');
  assert.equal(webseedUrl('https://h.example/f/', { multiFile: false, name: 'one.bin' }, { path: 'one.bin' }), 'https://h.example/f/one.bin');
  const t = webseedTargets('https://h.example/ws/', { files: [{ pad: false }, { pad: true }, { pad: false }] }, ['https://x.example/a.torrent']);
  assert.deepEqual(t, { origins: ['https://h.example', 'https://x.example'], files: 2, xs: 1 });
});

test('check-webseed passes against the dev server (OPTIONS, Range 206, CORS, xs) and names each failure on a bad host', async () => {
  const { out, torrent } = await publishFor('ws-ok');
  const dev = await createDevServer({ root: distDir, webseed: out, port: 0, quiet: true });
  closers.push(() => dev.close());
  const ok = await checkWebseed({ wsBase: dev.url + 'ws/', torrent, xs: [dev.url + 'ws/ws-test.torrent'], origin: 'https://example.com', timeoutMs: 4000 });
  assert.equal(ok.ok, true, JSON.stringify(ok.results.filter((r) => !r.ok)));
  // v0.2.1 B4: one result per file and per xs URL, plus the SHA-1 of the first and the last piece
  assert.equal(ok.results.filter((r) => r.kind === 'file').length, torrent.files.length);
  assert.equal(ok.results.filter((r) => r.kind === 'xs').length, 1);
  assert.deepEqual(ok.results.filter((r) => r.kind === 'piece').map((r) => r.info.piece), pieceIndices(torrent));
  assert.equal(ok.verdict, 'PASS');
  assert.equal(ok.stock.checked && ok.stock.ok, true, 'the dev server also answers the stock header set');
  assert.equal(ok.btih, torrent.infoHash);

  // 1. a host that ignores Range and answers 200
  const noRange = await customSeed(out, { range: false });
  const r1 = await checkWebseed({ wsBase: noRange.url + '/ws/', torrent, origin: 'https://example.com', timeoutMs: 4000 });
  assert.equal(r1.ok, false);
  assert.match(r1.results[0].problems.join(' '), /Web seed misconfigured \(no Range support\)/);
  assert.equal(r1.verdict, 'FAIL-range-ignored');

  // 2. no answer to OPTIONS
  const noOptions = await customSeed(out, { options: 404 });
  const r2 = await checkWebseed({ wsBase: noOptions.url + '/ws/', torrent, origin: 'https://example.com', timeoutMs: 4000 });
  assert.match(r2.results[0].problems.join(' '), /OPTIONS answered 404.*preflight/);

  // 3. Allow-Headers: range only. v0.2.1 B3: felinar's patched client sends only Range, so this host
  //    passes; the stock WebTorrent header set (cache-control, user-agent) is probed and reported as failing.
  const narrow = await customSeed(out, { allowHeaders: 'range' });
  const r3 = await checkWebseed({ wsBase: narrow.url + '/ws/', torrent, origin: 'https://example.com', timeoutMs: 4000 });
  assert.equal(r3.ok, true, JSON.stringify(r3.results.filter((r) => !r.ok)));
  assert.equal(r3.verdict, 'PASS-needs-patched-client');
  assert.equal(r3.stock.ok, false);
  assert.match(r3.stock.problems.join(' '), /does not allow cache-control, user-agent/);
  const rangeless = await customSeed(out, { allowHeaders: 'cache-control' });
  const r3b = await checkWebseed({ wsBase: rangeless.url + '/ws/', torrent, origin: 'https://example.com', timeoutMs: 4000 });
  assert.equal(r3b.ok, false, 'Allow-Headers without range fails the patched set');
  assert.match(r3b.results[0].problems.join(' '), /does not allow range/);
  assert.equal(r3b.verdict, 'FAIL-cors');
  const listed = await customSeed(out, { allowHeaders: 'Range, Cache-Control, User-Agent' });
  assert.equal((await checkWebseed({ wsBase: listed.url + '/ws/', torrent, origin: 'https://example.com', timeoutMs: 4000 })).ok, true, 'a list that covers them passes without *');

  // 4. Content-Range not exposed: v0.2.1, a warning only (WebTorrent and the loader never read Content-Range)
  const hidden = await customSeed(out, { expose: '' });
  const r4 = await checkWebseed({ wsBase: hidden.url + '/ws/', torrent, origin: 'https://example.com', timeoutMs: 4000 });
  assert.equal(r4.ok, true);
  assert.match(r4.results[0].warnings.join(' '), /Expose-Headers does not include Content-Range/);

  // 5. a file that is not uploaded, and a file of another length
  const partial = await customSeed(out, { missing: ['ws-test/js/app.js'] });
  const r5 = await checkWebseed({ wsBase: partial.url + '/ws/', torrent, origin: 'https://example.com', timeoutMs: 4000 });
  assert.equal(r5.failed, 1);
  assert.match(r5.results.find((r) => !r.ok).problems.join(' '), /not uploaded at this URL/);
  const longer = await customSeed(out, { lengthDelta: 5 });
  const r6 = await checkWebseed({ wsBase: longer.url + '/ws/', torrent, origin: 'https://example.com', timeoutMs: 4000 });
  assert.match(r6.results[0].problems.join(' '), /host serves another version/);

  // 6. a wrong .torrent at xs=
  const other = await publish({ dir: siteDir, name: 'ws-test', scope: '127.0.0.1', key: keyFile, out: fresh('o2'), quiet: true, ignore: ['css'] });
  writeFileSync(join(out, 'ws-test.torrent'), other.torrentFile);
  const r7 = await checkWebseed({ wsBase: dev.url + 'ws/', torrent, xs: [dev.url + 'ws/ws-test.torrent'], origin: 'https://example.com', timeoutMs: 4000 });
  assert.match(r7.results.find((r) => r.kind === 'xs').problems.join(' '), /has infohash/);

  // 7. the host is down
  const closed = await listen(() => {});
  const url = closed.url + '/ws/';
  await closed.close();
  closers.pop();
  const r8 = await checkWebseed({ wsBase: url, torrent, origin: 'https://example.com', timeoutMs: 1500 });
  assert.match(r8.results[0].problems.join(' '), /network error/);
});

test('check-webseed: a web seed on the page origin needs no CORS; bad arguments are usage errors', async () => {
  const { out, torrent } = await publishFor('ws-same');
  const plain = await listen((req, res) => {
    // no CORS headers at all
    const rel = decodeURIComponent(new URL(req.url, 'http://x').pathname).replace(/^\/ws\//, '');
    const data = readFileSync(join(out, ...rel.split('/')));
    const m = /^bytes=(\d+)-(\d*)$/.exec(req.headers.range || '');
    if (m) {
      const start = Number(m[1]);
      const end = m[2] ? Number(m[2]) : data.length - 1;
      res.writeHead(206, { 'content-range': 'bytes ' + start + '-' + end + '/' + data.length });
      return res.end(data.subarray(start, end + 1));
    }
    res.writeHead(200);
    return res.end(data);
  });
  const cross = await checkWebseed({ wsBase: plain.url + '/ws/', torrent, origin: 'https://example.com', timeoutMs: 4000 });
  assert.equal(cross.ok, false, 'cross-origin: CORS headers are missing');
  const same = await checkWebseed({ wsBase: plain.url + '/ws/', torrent, origin: plain.url, timeoutMs: 4000 });
  assert.equal(same.ok, true, JSON.stringify(same.results.filter((r) => !r.ok)));
  await assert.rejects(checkWebseed({ wsBase: 'ftp://x/', torrent }), /http\(s\) URL/);
});

test('check-webseed command line: prints what it will contact first, exit 0 / 1 / 2', async () => {
  const { out } = await publishFor('ws-cli');
  const dev = await createDevServer({ root: distDir, webseed: out, port: 0, quiet: true });
  closers.push(() => dev.close());
  const torrentFile = join(out, 'site.torrent');
  const run = (...args) => new Promise((resolve) => {
    import('node:child_process').then(({ spawn }) => {
      const child = spawn(process.execPath, ['tools/check-webseed.mjs', ...args], { cwd: ROOT });
      let stdout = '';
      let stderr = '';
      child.stdout.on('data', (d) => { stdout += d; });
      child.stderr.on('data', (d) => { stderr += d; });
      child.on('close', (status) => resolve({ status, stdout, stderr }));
    });
  });
  const ok = await run(dev.url + 'ws/', torrentFile, '--xs', dev.url + 'ws/ws-test.torrent');
  assert.equal(ok.status, 0, ok.stdout + ok.stderr);
  const lines = ok.stdout.split('\n');
  assert.match(lines[0], /^check-webseed ws-test \(btih [0-9a-f]{40}, \d+ files\)$/);
  assert.match(lines[1], /^Will contact http:\/\/127\.0\.0\.1:\d+: OPTIONS and GET/);
  assert.match(ok.stdout, /Web seed OK: \d+ checks passed\./);
  rmSync(join(out, 'ws-test', 'index.html'));
  const bad = await run(dev.url + 'ws/', torrentFile);
  assert.equal(bad.status, 1);
  assert.match(bad.stdout, /FAIL .*index\.html/);
  assert.match(bad.stdout, /1 of \d+ checks failed/);
  assert.equal((await run(dev.url + 'ws/')).status, 2);
  assert.equal((await run(dev.url + 'ws/', join(out, 'nope.torrent'))).status, 1);
});

test('check-site command line: usage error without a URL; --json output parses', async () => {
  const none = spawnSync(process.execPath, ['tools/check-site.mjs'], { cwd: ROOT, encoding: 'utf8' });
  assert.equal(none.status, 2);
  const s = await startSite();
  const { spawn } = await import('node:child_process');
  const res = await new Promise((resolve) => {
    const child = spawn(process.execPath, ['tools/check-site.mjs', s.dev.url, '--json', '--timeout', '4000'], { cwd: ROOT });
    let stdout = '';
    child.stdout.on('data', (d) => { stdout += d; });
    child.on('close', (status) => resolve({ status, stdout }));
  });
  assert.equal(res.status, 0, res.stdout);
  const parsed = JSON.parse(res.stdout);
  assert.equal(parsed.ok, true);
  assert.ok(parsed.results.length >= 8);
  assert.equal(createHash('sha256').update('x').digest('hex').length, 64);
  await sleep(1);
});

// ---------------------------------------------------------------------------------------------- a drop-in deploy copy

test('check-site on a drop-in site: the host files are the web seed, each with the length the torrent states', async () => {
  const fakeDist = fresh('fake-dist');
  mkdirSync(join(fakeDist, '_mw'));
  writeFileSync(join(fakeDist, 'mw-sw.js'), '// service worker\n');
  writeFileSync(join(fakeDist, 'mw-sw-kill.js'), '// kill\n');
  writeFileSync(join(fakeDist, '_mw', 'mw.js'), '// runtime\n');
  const existing = fresh('existing-site');
  mkdirSync(join(existing, 'css'));
  mkdirSync(join(existing, 'js'));
  writeFileSync(join(existing, 'index.html'), '<!doctype html><html><head><meta charset="utf-8"><title>Home</title></head><body><h1>Home</h1></body></html>\n');
  writeFileSync(join(existing, 'css', 'app.3f2a1b.css'), 'body { margin: 0 }\n'.repeat(20));
  writeFileSync(join(existing, 'js', 'app.9c0d2e.js'), 'console.log(1);\n'.repeat(20));
  const tracker = await createTracker({ port: 0, open: true });
  closers.push(() => tracker.close());
  const out = fresh('out-dropin');
  const pub = await publish({
    dir: existing, name: 'existing', scope: '127.0.0.1', key: keyFile, out, quiet: true, dropin: true, injectScript: true, dist: fakeDist, tr: [tracker.url],
  });
  const dev = await createDevServer({ root: join(out, 'site'), port: 0, quiet: true });
  closers.push(() => dev.close());
  assert.equal(dev.spa, false, 'a drop-in host keeps its own 404');

  const good = await checkSite(dev.url, { doh: false, timeoutMs: 4000 });
  assert.equal(good.ok, true, JSON.stringify(good.results.filter((r) => r.level === 'fail')));
  assert.ok(good.results.some((r) => r.step === 'page' && /drop-in page/.test(r.message)));
  assert.ok(good.results.some((r) => r.step === 'xs' && r.level === 'ok' && r.message.includes('/_mw/t/' + pub.btih + '.torrent')), 'the relative xs= is resolved against the page');
  assert.ok(good.results.some((r) => r.step === 'host files' && r.level === 'ok'));
  assert.equal(good.results.some((r) => r.step === 'web seed'), false, 'no ws=: the engine adds /_mw/ws/ itself');
  assert.equal(good.record.btih, pub.btih);

  // a file missing from the host, then a file of another length (another version deployed)
  const css = join(out, 'site', 'css', 'app.3f2a1b.css');
  const original = readFileSync(css);
  rmSync(css);
  const missing = await checkSite(dev.url, { doh: false, timeoutMs: 4000 });
  assert.equal(missing.ok, false);
  assert.ok(missing.results.some((r) => r.step === 'host files' && r.level === 'fail' && /\/css\/app\.3f2a1b\.css answered HTTP 404/.test(r.message)));
  writeFileSync(css, Buffer.concat([original, Buffer.from('/* newer */')]));
  const wrong = await checkSite(dev.url, { doh: false, timeoutMs: 4000 });
  assert.ok(wrong.results.some((r) => r.step === 'host files' && r.level === 'fail' && /another version is deployed/.test(r.message)));
  writeFileSync(css, original);
  assert.equal((await checkSite(dev.url, { doh: false, timeoutMs: 4000 })).ok, true);
});

// ---------------------------------------------------------------------------------------------- v0.2.1 B3/B4: the verification gate

test('B4 seed mode: wrong bytes in a 206 fail the piece SHA-1 (FAIL-wrong-bytes); a missing file skips the piece checks', async () => {
  const { out, torrent } = await publishFor('ws-wrong');
  const bad = await customSeed(out, { corrupt: 'js/app.js' });
  const r = await checkWebseed({ wsBase: bad.url + '/ws/', torrent, origin: 'https://example.com', timeoutMs: 4000 });
  assert.equal(r.ok, false);
  assert.equal(r.verdict, 'FAIL-wrong-bytes');
  const piece = r.results.find((x) => x.kind === 'piece' && !x.ok);
  assert.ok(piece, 'a piece check failed');
  assert.match(piece.problems.join(' '), /SHA-1 of the bytes served differs from the torrent/);
  assert.ok(r.results.filter((x) => x.kind === 'file').every((x) => x.ok), 'every 0-0 probe passed: only the hash catches it');
  const missing = await customSeed(out, { missing: ['ws-test/index.html'] });
  const r2 = await checkWebseed({ wsBase: missing.url + '/ws/', torrent, origin: 'https://example.com', timeoutMs: 4000 });
  assert.equal(r2.results.some((x) => x.kind === 'piece'), false, 'no piece checks over a missing file');
  assert.equal(r2.verdict, 'FAIL');
});

test('B4 seed mode: requests are sent the way a browser sends them (preflight for range only, GET with Range, identity, Origin, no Cache-Control)', async () => {
  const { out, torrent } = await publishFor('ws-headers');
  const log = [];
  const seed = await customSeed(out, { log });
  const r = await checkWebseed({ wsBase: seed.url + '/ws/', torrent, origin: 'https://example.com', timeoutMs: 4000 });
  assert.equal(r.ok, true, JSON.stringify(r.results.filter((x) => !x.ok)));
  const options = log.filter((e) => e.method === 'OPTIONS');
  assert.ok(options.length >= torrent.files.length);
  const sets = new Set(options.map((e) => e.headers['access-control-request-headers']));
  assert.deepEqual(Array.from(sets).sort(), [PREFLIGHT_SETS.patched.join(','), PREFLIGHT_SETS.stock.join(',')].sort(), 'the patched set per file, the stock set once');
  assert.equal(options.filter((e) => e.headers['access-control-request-headers'] === PREFLIGHT_SETS.stock.join(',')).length, 1);
  const gets = log.filter((e) => e.method === 'GET');
  assert.ok(gets.length > 0);
  for (const g of gets) {
    assert.match(String(g.headers.range), /^bytes=\d+-\d+$/);
    assert.equal(g.headers['accept-encoding'], 'identity');
    assert.equal(g.headers.origin, 'https://example.com');
    assert.equal(g.headers['cache-control'], undefined, 'no Cache-Control: the patched client does not send it');
    assert.equal(/WebTorrent/i.test(String(g.headers['user-agent'] || '')), false);
  }
});

test('B4 seed mode: an OPTIONS 405 host (GitHub Pages) fails by default; --allow-no-preflight passes it as PASS-no-preflight', async () => {
  const { out, torrent } = await publishFor('ws-405');
  const ghp = await customSeed(out, { options: 405 });
  const strict = await checkWebseed({ wsBase: ghp.url + '/ws/', torrent, origin: 'https://example.com', timeoutMs: 4000 });
  assert.equal(strict.ok, false);
  assert.equal(strict.verdict, 'FAIL-cors');
  assert.match(strict.results[0].problems.join(' '), /OPTIONS answered 405/);
  const lax = await checkWebseed({ wsBase: ghp.url + '/ws/', torrent, origin: 'https://example.com', timeoutMs: 4000, allowNoPreflight: true });
  assert.equal(lax.ok, true, JSON.stringify(lax.results.filter((x) => !x.ok)));
  assert.equal(lax.verdict, 'PASS-no-preflight');
  assert.match(lax.results[0].warnings.join(' '), /OPTIONS answered 405/);
});

test('B4 seed mode: a torrent of several pieces checks the first and the last; pieces all checks every one', async () => {
  const dir = fresh('big-site');
  writeFileSync(join(dir, 'index.html'), '<!doctype html><title>x</title>\n');
  const big = Buffer.alloc(700 * 1024);
  for (let i = 0; i < big.length; i++) big[i] = (i * 13 + 5) & 255;
  writeFileSync(join(dir, 'big.bin'), big);
  const out = fresh('big-out');
  const pub = await publish({ dir, name: 'big', scope: '127.0.0.1', key: keyFile, out, quiet: true, ws: ['http://127.0.0.1:9/ws/'] });
  const torrent = await parseTorrentFile(new Uint8Array(pub.torrentFile));
  assert.ok(torrent.pieceCount >= 3);
  const seed = await customSeed(out);
  const r = await checkWebseed({ wsBase: seed.url + '/ws/', torrent, origin: 'https://example.com', timeoutMs: 4000 });
  assert.equal(r.ok, true, JSON.stringify(r.results.filter((x) => !x.ok)));
  assert.deepEqual(r.results.filter((x) => x.kind === 'piece').map((x) => x.info.piece), [0, torrent.pieceCount - 1]);
  const all = await checkWebseed({ wsBase: seed.url + '/ws/', torrent, origin: 'https://example.com', timeoutMs: 4000, pieces: 'all' });
  assert.equal(all.results.filter((x) => x.kind === 'piece').length, torrent.pieceCount);
  // a middle piece with wrong bytes is only caught by pieces: all
  const middle = await customSeed(out, { corrupt: 'big/big.bin' });
  const tail = await checkWebseed({ wsBase: middle.url + '/ws/', torrent, origin: 'https://example.com', timeoutMs: 4000 });
  assert.equal(tail.verdict, 'FAIL-wrong-bytes', 'the last byte of big.bin is in the last piece');
  assert.deepEqual(pieceIndices({ pieceCount: 1 }), [0]);
  assert.deepEqual(pieceIndices({ pieceCount: 5 }, 'none'), []);
  await assert.rejects(checkWebseed({ wsBase: seed.url + '/ws/', torrent, pieces: 'some' }), /--pieces/);
});

test('B4 origin and host modes: full GET parity, the Range probe, an edge transform and a missing file', async () => {
  const dir = fresh('host-site');
  writeFileSync(join(dir, 'index.html'), '<!doctype html><title>x</title>\n');
  mkdirSync(join(dir, 'img'));
  const png = Buffer.alloc(3000, 7);
  writeFileSync(join(dir, 'img', 'logo.png'), png);
  writeFileSync(join(dir, 'app.js'), 'console.log(1)\n'.repeat(50));
  const out = fresh('host-out');
  const pub = await publish({ dir, name: 'hostsite', scope: '127.0.0.1', key: keyFile, out, quiet: true });
  const torrent = await parseTorrentFile(new Uint8Array(pub.torrentFile));
  const root = join(out, 'hostsite');
  const host = (o = {}) => listen((req, res) => {
    const rel = decodeURIComponent(new URL(req.url, 'http://x').pathname).replace(/^\//, '');
    if ((o.missing || []).includes(rel)) {
      res.writeHead(404);
      return res.end();
    }
    let data;
    try {
      data = readFileSync(join(root, ...rel.split('/')));
    } catch (_) {
      res.writeHead(404);
      return res.end();
    }
    if (o.transform && rel === 'img/logo.png' && /image\/avif/.test(req.headers.accept || '')) {
      data = Buffer.from(data);
      data[0] ^= 1; // an image optimiser answering browsers with other bytes of the same length
    }
    const m = /^bytes=(\d+)-(\d+)$/.exec(req.headers.range || '');
    if (m && !o.noRange) {
      const s = Number(m[1]);
      const e = Math.min(Number(m[2]), data.length - 1);
      res.writeHead(206, { 'content-range': 'bytes ' + s + '-' + e + '/' + data.length });
      return res.end(data.subarray(s, e + 1));
    }
    res.writeHead(200, o.vary ? { vary: 'Accept' } : {});
    return res.end(data);
  });
  const good = await host();
  const origin = await verifyHostFiles({ base: good.url + '/', torrent, mode: 'origin', timeoutMs: 4000 });
  assert.equal(origin.ok, true, JSON.stringify(origin.results.filter((x) => !x.ok)));
  assert.equal(origin.verdict, 'PASS');
  assert.equal(origin.range.honoured, true);
  assert.equal(origin.results.length, torrent.files.length);

  const pages = await host({ noRange: true });
  const noRange = await verifyHostFiles({ base: pages.url + '/', torrent, mode: 'origin', timeoutMs: 4000 });
  assert.equal(noRange.ok, true, 'a host that ignores Range is fine for drop-in');
  assert.equal(noRange.range.honoured, false);
  assert.equal(noRange.range.status, 200);

  const cdn = await host({ transform: true, vary: true });
  assert.equal((await verifyHostFiles({ base: cdn.url + '/', torrent, mode: 'origin', timeoutMs: 4000 })).ok, true, 'origin mode asks with Accept: */*');
  const browserView = await verifyHostFiles({ base: cdn.url + '/', torrent, mode: 'host', timeoutMs: 4000 });
  assert.equal(browserView.ok, false, 'host mode asks like a browser and sees the transformed image');
  assert.equal(browserView.verdict, 'FAIL-wrong-bytes');
  const logo = browserView.results.find((x) => x.path === 'img/logo.png');
  assert.match(logo.problems.join(' '), /serves other bytes than the torrent/);
  assert.ok(browserView.results.some((x) => x.warnings.some((w) => /Vary: Accept/.test(w))));
  assert.match(browserAccept('a/b.PNG'), /^image\/avif/);
  assert.equal(browserAccept('x.js'), '*/*');

  const partial = await host({ missing: ['app.js'] });
  const gone = await verifyHostFiles({ base: partial.url + '/', torrent, mode: 'host', timeoutMs: 4000 });
  assert.equal(gone.ok, false);
  assert.match(gone.results.find((x) => x.path === 'app.js').problems.join(' '), /answered HTTP 404/);
  await assert.rejects(verifyHostFiles({ base: 'ftp://x/', torrent }), /http\(s\) URL/);
});

test('B4 check-site --full: origin mode over the web seed (every byte); a same-length change fails only there', async () => {
  const s = await startSite();
  const full = await checkSite(s.dev.url, { doh: false, timeoutMs: 4000, full: true });
  assert.equal(full.ok, true, JSON.stringify(full.results.filter((r) => r.level === 'fail')));
  assert.ok(full.results.some((r) => r.step === 'web seed' && /every byte of every file matches/.test(r.message)));
  // index.html changes in place with the same length: not in the first or last piece? the site is one piece, so
  // the seed mode sees it too; both report it
  const file = join(s.out, 'check-site-test', 'index.html');
  const original = readFileSync(file);
  const changed = Buffer.from(original);
  changed[5] ^= 1;
  writeFileSync(file, changed);
  const bad = await checkSite(s.dev.url, { doh: false, timeoutMs: 4000, full: true });
  assert.equal(bad.ok, false);
  assert.ok(bad.results.some((r) => r.step === 'web seed' && /serves other bytes than the torrent|SHA-1 of the bytes served differs/.test(r.message)));
  writeFileSync(file, original);
});

// ---------------------------------------------------------------------------------------------- v0.3 C2: names that cannot carry a DNS record

// The page lives at a nip.io name that this test cannot resolve: fetches for that host go to the local dev server, and the Response
// reports the nip.io URL as its own, which is what check-site reads as the final URL. Every URL asked for is recorded.
function viaLoopback(realBase, host) {
  const seen = [];
  const f = async (input, init) => {
    const url = String(input && input.url ? input.url : input);
    seen.push(url);
    const u = new URL(url);
    if (u.hostname !== host) return fetch(url, init);
    const res = await fetch(new URL(u.pathname + u.search, realBase), init);
    const wrapped = new Response(res.body, { status: res.status, statusText: res.statusText, headers: res.headers });
    Object.defineProperty(wrapped, 'url', { value: url });
    return wrapped;
  };
  f.seen = seen;
  return f;
}

test('v0.3 C2: a nip.io page is checked without any DNS-over-HTTPS request, and the report says the page tag is the only pointer and when it expires', async () => {
  const host = '203-0-113-7.nip.io';
  const out = fresh('out');
  const tracker = await createTracker({ port: 0, open: true });
  closers.push(() => tracker.close());
  const dev = await createDevServer({ root: distDir, webseed: out, port: 0, quiet: true });
  closers.push(() => dev.close());
  const NOW = Date.now();
  const pub = await publish({
    dir: siteDir, name: 'check-site-test', scope: host, key: keyFile, out, quiet: true, now: NOW, exp: 399,
    tr: [tracker.url], ws: [dev.url + 'ws/'],
  });
  dev.setPointer(pub.pointer);
  const f = viaLoopback(dev.url, host);
  const lines = [];
  const r = await checkSite('https://' + host + '/', { fetch: f, doh: true, log: (l) => lines.push(l), timeoutMs: 5000 });
  assert.equal(r.ok, true, JSON.stringify(r.results.filter((x) => x.level === 'fail')));
  const dns = r.results.filter((x) => x.step === 'dns pointer');
  assert.equal(dns.length, 1, JSON.stringify(dns));
  assert.equal(dns[0].level, 'info');
  assert.match(dns[0].message, /not possible for this name \(page tag only\)/);
  assert.match(dns[0].message, /nip\.io or sslip\.io/);
  assert.match(dns[0].message, /the page tag expires on 20\d\d-\d\d-\d\d/);
  assert.match(dns[0].message, /new visitors cannot load the site until you publish again/);
  const expires = new Date(NOW + 399 * 86400000).toISOString().slice(0, 10);
  assert.ok(dns[0].message.includes(expires), 'the date is the signed expiry (' + expires + '): ' + dns[0].message);
  const dohHosts = /cloudflare-dns\.com|doh\.dns\.sb|dns\.google/;
  assert.equal(f.seen.some((u) => dohHosts.test(u)), false, 'no DoH request: ' + f.seen.join(' '));
  assert.equal(lines.some((l) => /DNS-over-HTTPS TXT/.test(l)), false, 'no DoH target was announced either');
});

test('v0.3 C2: sslip.io names are skipped the same way, and an ordinary name is still looked up (a stub resolver answers)', async () => {
  const seen = [];
  const f = async (input) => {
    seen.push(String(input));
    throw new TypeError('fetch failed');
  };
  for (const host of ['203-0-113-7.sslip.io', 'app.203.0.113.7.nip.io']) {
    seen.length = 0;
    const r = await checkSite('https://' + host + '/', { fetch: f, doh: true, timeoutMs: 500 });
    const dns = r.results.find((x) => x.step === 'dns pointer');
    assert.ok(dns && dns.level === 'info' && /not possible for this name \(page tag only\)/.test(dns.message), host + ': ' + JSON.stringify(dns));
    assert.equal(seen.some((u) => /cloudflare-dns\.com|doh\.dns\.sb|dns\.google/.test(u)), false, host + ' made a DoH request: ' + seen.join(' '));
  }
  seen.length = 0;
  const ordinary = await checkSite('https://nip.io.example.com/', { fetch: f, doh: true, timeoutMs: 500 });
  assert.ok(seen.some((u) => /cloudflare-dns\.com/.test(u)), 'an ordinary name is looked up: ' + seen.join(' '));
  assert.ok(ordinary.results.some((x) => x.step === 'dns pointer' && x.level === 'fail'), 'and the stub failure is reported');
  seen.length = 0;
  const flagged = await checkSite('https://203-0-113-7.nip.io/', { fetch: f, doh: false, timeoutMs: 500 });
  assert.ok(flagged.results.some((x) => x.step === 'dns pointer' && /skipped \(--no-doh\)/.test(x.message)), '--no-doh still says so');
});

// 0.3.0 independence design (IND-10): a site on a hosting platform's name (alice.github.io, *.netlify.app, *.pages.dev, a ts.net
// machine) cannot carry a _magnet TXT record, so check-site reports the page tag as the only pointer and asks no resolver.
test('IND-10: check-site on a github.io, netlify.app, pages.dev or ts.net page reports "page tag only" and makes no DNS-over-HTTPS request', async () => {
  const seen = [];
  const f = async (input) => {
    seen.push(String(input && input.url ? input.url : input));
    throw new TypeError('fetch failed');
  };
  const lines = [];
  for (const host of ['alice.github.io', 'my-site.netlify.app', 'project.pages.dev', 'laptop.tail1234.ts.net']) {
    seen.length = 0;
    lines.length = 0;
    const r = await checkSite('https://' + host + '/', { fetch: f, doh: true, log: (l) => lines.push(l), timeoutMs: 500 });
    const dns = r.results.filter((x) => x.step === 'dns pointer');
    assert.equal(dns.length, 1, host + ': ' + JSON.stringify(dns));
    assert.equal(dns[0].level, 'info', host + ': ' + dns[0].message);
    assert.match(dns[0].message, /not possible for this name \(page tag only\)/, host);
    assert.match(dns[0].message, /DNS-over-HTTPS is skipped \(visitors skip it too\)/, host);
    assert.match(dns[0].message, /hosting platform/, host);
    assert.doesNotMatch(dns[0].message, /is not a public DNS name/, host);
    assert.equal(seen.some((u) => /cloudflare-dns\.com|doh\.dns\.sb|dns\.google/.test(u)), false, host + ' made a DoH request: ' + seen.join(' '));
    assert.equal(lines.some((l) => /DNS-over-HTTPS TXT/.test(l)), false, host + ': no DoH target was announced');
  }
  // A look-alike is an ordinary name and is still looked up.
  seen.length = 0;
  await checkSite('https://github.io.example.com/', { fetch: f, doh: true, timeoutMs: 500 });
  assert.ok(seen.some((u) => /cloudflare-dns\.com/.test(u)), 'a look-alike is looked up: ' + seen.join(' '));
});

test('v0.3 C2: the generic skip message still says why (localhost and IP addresses) and now says the page tag is the only pointer', async () => {
  const s = await startSite();
  const r = await checkSite(s.dev.url, { doh: true, timeoutMs: 5000 });
  const dns = r.results.find((x) => x.step === 'dns pointer');
  assert.match(dns.message, /^not possible for this name \(page tag only\): 127\.0\.0\.1 is not a public DNS name, so DNS-over-HTTPS is skipped \(visitors skip it too\)/);
  assert.match(dns.message, /the page tag expires on 20\d\d-\d\d-\d\d/);
});
