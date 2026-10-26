// Unit tests for the phase C2 zero-setup changes of tools/publish.mjs and tools/dev-server.mjs (SEEDING-AND-ZERO-SETUP-DESIGN 3.2 and 3.5,
// S2 Rc3 and Rc10):
//   publish   a scope tied to an address (a nip.io or sslip.io name, or an IP literal other than a loopback address) defaults --chain to
//             --name and says "the page tag is the only pointer" instead of the 450-byte DNS warning; --calls implies --chat and needs the
//             site's own tracker and STUN.
//   dev-server --tracker-proxy <port> passes WebSocket upgrades on /tracker to a tracker on 127.0.0.1, also over TLS.
// No network: every server listens on 127.0.0.1 with an ephemeral port, nothing resolves a name.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { spawn, spawnSync } from 'node:child_process';
import http from 'node:http';
import WebSocket from 'ws';

import {
  publish, addressBoundScope, featuresFromCfg, featureProblems, PUBLISH_FLAGS,
} from '../../tools/publish.mjs';
import { keygen } from '../../tools/keygen.mjs';
import { ledgerIdForOwner } from '../../tools/ledger-admin.mjs';
import { createDevServer } from '../../tools/dev-server.mjs';
import { createTracker } from '../../tools/tracker.mjs';
import { UsageError, ROOT } from '../../tools/lib.mjs';
import { parsePointer, normalizeScope } from '../../src/common/pointer.js';

const work = mkdtempSync(join(tmpdir(), 'mw-c2-zero-setup-'));
const closers = [];
after(async () => {
  for (const c of closers.reverse()) await c();
  rmSync(work, { recursive: true, force: true });
});

const NOW = Date.UTC(2026, 9, 20, 12, 0, 30);
let counter = 0;
const fresh = (label) => {
  const dir = join(work, label + '-' + ++counter);
  mkdirSync(dir, { recursive: true });
  return dir;
};
function writeTree(root, files) {
  for (const [path, content] of Object.entries(files)) {
    const abs = join(root, ...path.split('/'));
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, content);
  }
}
function makeSite() {
  const dir = fresh('site');
  writeTree(dir, {
    'index.html': '<!doctype html><html><head><meta charset="utf-8"><title>Home</title></head><body><h1>Home</h1></body></html>\n',
    'css/app.css': 'body { margin: 0 }\n',
  });
  return dir;
}
let keyCounter = 0;
async function makeKey() {
  const file = join(work, 'owner-' + ++keyCounter + '.jwk');
  const res = await keygen({ out: file });
  return { file, pub: res.pub };
}
const PUBLIC_FOUR = ['wss://tracker.webtorrent.dev', 'wss://tracker.openwebtorrent.com', 'wss://tracker.novage.com.ua', 'wss://open.ftorrent.com'];

async function run(extra = {}) {
  const key = extra.key || (await makeKey()).file;
  return publish(Object.assign({
    dir: makeSite(), name: 'my-site', scope: '203-0-113-7.nip.io', key, tr: ['wss://203-0-113-7.nip.io/tracker'], ws: ['https://203-0-113-7.nip.io/ws/'],
    out: fresh('out'), now: NOW, quiet: true,
  }, extra));
}

// ---------------------------------------------------------------------------------------------- publish: scopes tied to an address

test('addressBoundScope: nip.io and sslip.io names and IP literals other than loopback; loopback, localhost and ordinary names are not', () => {
  for (const s of [
    '203-0-113-7.nip.io', '203.0.113.7.nip.io', 'app.203-0-113-7.nip.io', '203-0-113-7.sslip.io', '203-0-113-7.SSLIP.io', '203-0-113-7.nip.io.', 'https://203-0-113-7.nip.io/', '203-0-113-7.nip.io:8443',
    'nip.io', '203.0.113.7', '192.168.1.20', '10.0.0.5', '[2001:db8::1]', 'https://203.0.113.7:8443/',
  ]) {
    assert.equal(addressBoundScope(s), true, s);
  }
  for (const s of [
    '127.0.0.1', '127.1', '127.5.5.5', 'localhost', 'app.localhost', '::1', '[::1]', 'example.com', 'www.example.com', 'nip.io.example.com', 'anip.io', 'my-sslip.io',
    'btih:0123456789abcdef0123456789abcdef01234567', '', ' ', 'not a host name', '2001:db8::1' /* not a valid scope without brackets */, null, undefined,
  ]) {
    assert.equal(addressBoundScope(s), false, String(s));
  }
});

test('publish: --chain defaults to --name for a nip.io scope, so the ledger does not depend on the address; an explicit --chain wins', async () => {
  const owner = await makeKey();
  const a = await run({ key: owner.file, scope: '203-0-113-7.nip.io' });
  assert.equal(a.record.chain, 'my-site');
  assert.equal(a.ledgerId, await ledgerIdForOwner(owner.pub, { scope: '203-0-113-7.nip.io', chain: 'my-site' }));
  // the same key, name and files at another address, and at a domain with --chain: one ledger, one rendezvous swarm, one infohash
  const b = await run({ key: owner.file, scope: '198-51-100-9.sslip.io', tr: ['wss://198-51-100-9.sslip.io/tracker'], ws: ['https://198-51-100-9.sslip.io/ws/'], dir: makeSite() });
  const c = await run({ key: owner.file, scope: 'example.com', chain: 'my-site', tr: ['wss://example.com/tracker'], ws: ['https://example.com/ws/'], dir: makeSite() });
  assert.equal(b.ledgerId, a.ledgerId);
  assert.equal(c.ledgerId, a.ledgerId, 'moving up to a domain with --chain keeps the ledger (S2, rung 3)');
  assert.equal(b.rendezvousBtih, a.rendezvousBtih);
  assert.equal(c.rendezvousBtih, a.rendezvousBtih);
  assert.equal(c.btih, a.btih, 'the same files give the same infohash');
  const explicit = await run({ key: owner.file, scope: '203-0-113-7.nip.io', chain: 'chosen-label' });
  assert.equal(explicit.record.chain, 'chosen-label');
  assert.notEqual(explicit.ledgerId, a.ledgerId);
  // a public IP literal behaves the same way
  const ip = await run({ key: owner.file, scope: '203.0.113.7', tr: ['wss://203.0.113.7/tracker'], ws: ['https://203.0.113.7/ws/'], dir: makeSite() });
  assert.equal(ip.record.chain, 'my-site');
  assert.equal(ip.ledgerId, a.ledgerId);
  // and the signed pointer says so
  const parsed = parsePointer(a.pointer);
  assert.equal(parsed.ok, true);
  assert.equal(parsed.record.chain, 'my-site');
});

test('publish: loopback scopes and ordinary names keep the older defaults (no chain)', async () => {
  const owner = await makeKey();
  for (const scope of ['127.0.0.1', 'localhost', 'example.com', 'nip.io.example.com']) {
    const res = await run({ key: owner.file, scope, tr: ['wss://tracker.example'], ws: ['https://static.example/ws/'], dir: makeSite() });
    assert.equal(res.record.chain, null, scope);
    assert.equal(res.ledgerId, await ledgerIdForOwner(owner.pub, { scope: normalizeScope(scope), chain: null }), scope);
  }
});

test('publish: a site name too long for a ledger label stops with a usage error that says what to pass; --chain makes it work', async () => {
  const longName = 'a'.repeat(70);
  await assert.rejects(run({ name: longName }), (e) => e instanceof UsageError && /--chain <label> or a shorter --name/.test(e.message));
  const ok = await run({ name: longName, chain: 'short-label' });
  assert.equal(ok.record.chain, 'short-label');
  // an ordinary scope never needed a label, so the same long name is fine there
  const plain = await run({ name: longName, scope: 'example.com', tr: ['wss://tracker.example'], ws: ['https://static.example/ws/'] });
  assert.equal(plain.record.chain, null);
});

test('publish: for an address-bound scope the 450-byte DNS warning becomes one line with the date the page tag expires; other scopes keep the warning', async () => {
  // four public trackers and an own tracker make a pointer above 450 bytes (S2 F16: 699 bytes for that mix)
  const big = { tr: ['wss://203-0-113-7.nip.io/tracker'].concat(PUBLIC_FOUR), cs: 'https://203-0-113-7.nip.io/ws/genesis.json', ct: 'mailto:you@example.org' };
  const nip = await run(Object.assign({ exp: 399 }, big));
  assert.ok(nip.warnings.includes('This name cannot carry a DNS record; the page tag is the only pointer (expires 2027-11-23).'), nip.warnings.join('\n'));
  assert.equal(nip.warnings.some((w) => /should stay at or under 450/.test(w)), false, 'no DNS size warning for a name that cannot carry DNS');
  assert.equal(nip.summary.expires, '2027-11-23');
  // the line is there even when the pointer is small, and the date follows --exp
  const small = await run({ tr: [], exp: 90 });
  assert.ok(small.warnings.includes('This name cannot carry a DNS record; the page tag is the only pointer (expires 2027-01-18).'), small.warnings.join('\n'));
  // an ordinary scope with the same pointer still gets the DNS size warning, and no such line
  const plain = await run(Object.assign({ scope: 'example.com' }, big));
  assert.ok(plain.warnings.some((w) => /should stay at or under 450/.test(w)), plain.warnings.join('\n'));
  assert.equal(plain.warnings.some((w) => /cannot carry a DNS record/.test(w)), false);
  const loop = await run(Object.assign({ scope: '127.0.0.1' }, big));
  assert.ok(loop.warnings.some((w) => /should stay at or under 450/.test(w)), 'loopback keeps the warning');
  // the 900-byte limit is a rule of the grammar and still applies
  await assert.rejects(run({ tr: ['wss://203-0-113-7.nip.io/tracker'].concat(PUBLIC_FOUR), ws: ['https://203-0-113-7.nip.io/ws/' + 'x'.repeat(300) + '/', 'https://203-0-113-7.nip.io/w2/' + 'y'.repeat(300) + '/'] }), /must stay at or under 900 bytes/);
});

test('publish: the report names the default ledger label for an address-bound scope and only then', async () => {
  const lines = [];
  await run({ quiet: false, log: (l) => lines.push(l) });
  assert.ok(lines.some((l) => /^ {2}chain {5}my-site \(the default for a name tied to an address/.test(l)), lines.join('\n'));
  const plainLines = [];
  await run({ quiet: false, log: (l) => plainLines.push(l), scope: 'example.com', tr: ['wss://tracker.example'], ws: ['https://static.example/ws/'] });
  assert.equal(plainLines.some((l) => /^ {2}chain /.test(l)), false);
});

// ---------------------------------------------------------------------------------------------- publish: --calls

test('publish --calls implies --chat and needs the site\'s own tracker and STUN, like chat (MF-44)', async () => {
  // the shared public trackers are not enough, and neither is a missing STUN server
  await assert.rejects(run({ calls: true, tr: PUBLIC_FOUR }), (e) => {
    assert.ok(e instanceof UsageError);
    assert.match(e.message, /chat, calls are on \(MF-44\)/);
    assert.match(e.message, /--tracker <wss URL>/);
    assert.match(e.message, /--stun <stun: URL>/);
    return true;
  });
  await assert.rejects(run({ calls: true, tracker: ['wss://203-0-113-7.nip.io/tracker'] }), (e) => e instanceof UsageError && /--stun/.test(e.message) && !/--tracker <wss URL>/.test(e.message));
  const lines = [];
  const ok = await run({
    calls: true, tracker: ['wss://203-0-113-7.nip.io/tracker'], stun: ['stun:203-0-113-7.nip.io:3478'], quiet: false, log: (l) => lines.push(l),
  });
  assert.deepEqual(ok.summary.features, ['chat', 'calls'], 'chat comes with calls');
  assert.deepEqual(ok.summary.stun, ['stun:203-0-113-7.nip.io:3478']);
  const text = lines.join('\n');
  assert.match(text, /features {2}chat, calls \(own tracker wss:\/\/203-0-113-7\.nip\.io\/tracker, STUN stun:203-0-113-7\.nip\.io:3478\)/);
  assert.match(text, /node tools\/ledger-admin\.mjs cfg --key <owner\.jwk> --file <ledger\.json> --chat members --calls contacts/);
  // --chat together with --calls lists chat once
  const both = await run({ calls: true, chat: true, tracker: ['wss://203-0-113-7.nip.io/tracker'], stun: ['stun:203-0-113-7.nip.io:3478'] });
  assert.deepEqual(both.summary.features, ['chat', 'calls']);
  // without --calls nothing changes: no feature, no hint
  const none = await run({ quiet: false, log: (l) => lines.push(l) });
  assert.deepEqual(none.summary.features, []);
});

test('featuresFromCfg: a feature is on when it is set and not off; calls included', () => {
  assert.deepEqual(featuresFromCfg({}), { chat: false, files: false, media: false, calls: false });
  assert.deepEqual(featuresFromCfg({ chat: 'members', calls: 'contacts' }), { chat: true, files: false, media: false, calls: true });
  assert.deepEqual(featuresFromCfg({ chat: 'off', files: 'members', media: 'members', calls: 'off' }), { chat: false, files: true, media: true, calls: false });
  assert.deepEqual(featuresFromCfg(null), { chat: false, files: false, media: false, calls: false });
  assert.deepEqual(featuresFromCfg('chat'), { chat: false, files: false, media: false, calls: false });
  const problems = featureProblems({ features: ['chat', 'calls'], tr: PUBLIC_FOUR, stun: [] });
  assert.equal(problems.length, 2);
  assert.match(problems[0], /chat, calls is on/);
});

test('publish command line: --calls is in --help and in the parsed flags; the help names the new defaults', () => {
  const help = spawnSync(process.execPath, ['tools/publish.mjs', '--help'], { cwd: ROOT, encoding: 'utf8' });
  assert.equal(help.status, 0);
  assert.ok(help.stdout.includes('--calls'));
  assert.ok(Object.prototype.hasOwnProperty.call(PUBLISH_FLAGS, 'calls'));
  assert.match(help.stdout, /--calls \(turn the feature on; --chat-panel and --calls imply --chat\)/);
  assert.match(help.stdout, /default for a nip\.io or sslip\.io name or a non-loopback IP/);
  const noStun = spawnSync(process.execPath, ['tools/publish.mjs', makeSite(), '--name', 'x', '--scope', '203-0-113-7.nip.io', '--key', join(work, 'no-such.jwk'), '--calls', '--out', fresh('o'), '--quiet'], { cwd: ROOT, encoding: 'utf8' });
  assert.equal(noStun.status, 2, 'the missing tracker and STUN stop it before the key is read');
  assert.match(noStun.stderr, /--tracker/);
});

test('wording: the new publish text uses none of the words the project does not use', () => {
  const source = readFileSync(join(ROOT, 'tools', 'publish.mjs'), 'utf8');
  for (const word of ['blockchain', 'serverless', 'unstoppable', 'censorship-resistant', 'production-ready']) assert.equal(source.toLowerCase().includes(word), false, word);
});

// ---------------------------------------------------------------------------------------------- dev-server: --tracker-proxy

const SHELL = '<!doctype html><html><head><meta charset="utf-8"><title>Shell</title></head><body><script src="/_mw/boot.js"></script></body></html>\n';
const bin = (hex) => Buffer.from(hex, 'hex').toString('latin1');
const HASH = 'ab'.repeat(20);
const announce = (hex = HASH) => ({
  action: 'announce', info_hash: bin(hex), peer_id: 'p'.repeat(20), uploaded: 0, downloaded: 0, left: 0, event: 'started', numwant: 0, offers: [],
});

function ask(ws, message, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('no answer in ' + timeoutMs + ' ms')), timeoutMs);
    ws.once('message', (data) => {
      clearTimeout(timer);
      resolve(JSON.parse(String(data)));
    });
    ws.send(JSON.stringify(message));
  });
}
function open(url, options = {}) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url, options);
    ws.once('open', () => resolve(ws));
    ws.once('error', reject);
    ws.once('unexpected-response', (req, res) => reject(Object.assign(new Error('Unexpected server response: ' + res.statusCode), { statusCode: res.statusCode })));
  });
}

let siteRoot;
async function startPair({ tls = false, ...extra } = {}) {
  if (!siteRoot) {
    siteRoot = fresh('root');
    writeTree(siteRoot, { 'index.html': SHELL, '_mw/boot.js': '// boot\n' });
  }
  const tracker = await createTracker({ port: 0, open: true });
  closers.push(() => tracker.close());
  const dev = await createDevServer(Object.assign({ root: siteRoot, port: 0, quiet: true, trackerProxy: tracker.port, tls }, extra));
  closers.push(() => dev.close());
  return { tracker, dev };
}

test('--tracker-proxy: a WebSocket to /tracker on the dev server reaches the tracker on 127.0.0.1 (query string and all)', async () => {
  const { tracker, dev } = await startPair();
  assert.equal(dev.trackerProxy, tracker.port);
  assert.match(dev.url, /^http:\/\/127\.0\.0\.1:\d+\/$/, 'bind rules are unchanged: loopback by default');
  for (const path of ['tracker', 'tracker?x=1']) {
    const ws = await open(dev.url.replace(/^http/, 'ws') + path);
    const answer = await ask(ws, announce());
    assert.equal(answer.action, 'announce', path);
    assert.ok(answer.interval > 0, 'the tracker answered, not the dev server');
    ws.close();
  }
  assert.ok(tracker.stats().torrents >= 1, 'the announce was registered by the tracker itself');
});

test('--tracker-proxy: two clients through the proxy see each other as a tracker would arrange (peer counts add up)', async () => {
  const { dev } = await startPair();
  const url = dev.url.replace(/^http/, 'ws') + 'tracker';
  const hex = 'cd'.repeat(20);
  const a = await open(url);
  const first = await ask(a, Object.assign(announce(hex), { peer_id: 'a'.repeat(20), left: 1 }));
  assert.equal(first.incomplete, 1);
  const b = await open(url);
  const second = await ask(b, Object.assign(announce(hex), { peer_id: 'b'.repeat(20), left: 0 }));
  assert.equal(second.complete, 1);
  assert.equal(second.incomplete, 1, 'the second client sees the first one\'s swarm: one shared tracker behind two proxied sockets');
  a.close();
  b.close();
});

test('--tracker-proxy: only upgrades on exactly /tracker are passed on; a plain GET of /tracker is served like any other path', async () => {
  const { dev } = await startPair();
  await assert.rejects(open(dev.url.replace(/^http/, 'ws') + 'other'), (e) => e.statusCode === 404 || /404/.test(e.message));
  await assert.rejects(open(dev.url.replace(/^http/, 'ws') + 'tracker/extra'), (e) => e.statusCode === 404 || /404/.test(e.message));
  await assert.rejects(open(dev.url.replace(/^http/, 'ws') + 'tracker2'), (e) => e.statusCode === 404 || /404/.test(e.message));
  const plain = await fetch(dev.url + 'tracker');
  assert.equal(plain.status, 200, 'a plain request is not the tracker\'s business (the SPA fallback answers)');
  assert.equal(await plain.text(), SHELL);
});

test('--tracker-proxy: without the option an upgrade is refused as before; with a tracker that is down the client gets 502', async () => {
  siteRoot = siteRoot || (() => {
    const r = fresh('root');
    writeTree(r, { 'index.html': SHELL, '_mw/boot.js': '// boot\n' });
    return r;
  })();
  const plain = await createDevServer({ root: siteRoot, port: 0, quiet: true });
  closers.push(() => plain.close());
  assert.equal(plain.trackerProxy, null);
  await assert.rejects(open(plain.url.replace(/^http/, 'ws') + 'tracker'));
  // a tracker that was there and is gone: the port is closed again, so the proxy has nobody to connect to
  const gone = await createTracker({ port: 0, open: true });
  const port = gone.port;
  await gone.close();
  const dev = await createDevServer({ root: siteRoot, port: 0, quiet: true, trackerProxy: port });
  closers.push(() => dev.close());
  await assert.rejects(open(dev.url.replace(/^http/, 'ws') + 'tracker'), (e) => e.statusCode === 502 || /502/.test(e.message));
});

test('--tracker-proxy: close() ends the proxied sockets (closeAllConnections does not reach upgraded ones)', async () => {
  const { dev } = await startPair();
  const ws = await open(dev.url.replace(/^http/, 'ws') + 'tracker');
  await ask(ws, announce('ef'.repeat(20)));
  const closed = new Promise((resolve) => ws.once('close', resolve));
  await dev.close();
  await Promise.race([closed, new Promise((_, reject) => setTimeout(() => reject(new Error('the proxied socket stayed open after close()')), 5000))]);
});

test('--tracker-proxy: over TLS the page origin carries the tracker (wss), with the certificate of the dev server', async (t) => {
  const certDir = fresh('certs');
  const made = spawnSync('openssl', ['req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:prime256v1', '-nodes', '-keyout', join(certDir, 'key.pem'),
    '-out', join(certDir, 'cert.pem'), '-days', '1', '-subj', '/CN=localhost', '-addext', 'subjectAltName=DNS:localhost,IP:127.0.0.1'], { encoding: 'utf8' });
  if (made.status !== 0) {
    t.skip('openssl is not available');
    return;
  }
  const ca = readFileSync(join(certDir, 'cert.pem'));
  const { dev } = await startPair({ tls: { cert: join(certDir, 'cert.pem'), key: join(certDir, 'key.pem') } });
  assert.match(dev.url, /^https:\/\/127\.0\.0\.1:\d+\/$/);
  const ws = await open(dev.url.replace(/^https/, 'wss') + 'tracker', { ca, servername: 'localhost' });
  const answer = await ask(ws, announce('01'.repeat(20)));
  assert.equal(answer.action, 'announce');
  ws.close();
  // a client that does not trust the certificate is refused before anything reaches the tracker
  await assert.rejects(open(dev.url.replace(/^https/, 'wss') + 'tracker'), /self-signed|unable to verify|certificate/i);
});

test('--tracker-proxy: values that are not a port are usage errors; the upstream is loopback whatever --host says', async () => {
  for (const bad of [0, -1, 65536, 1.5, '8000', 'x', NaN]) {
    await assert.rejects(createDevServer({ root: siteRoot || ROOT, port: 0, quiet: true, trackerProxy: bad }), (e) => e instanceof UsageError && /--tracker-proxy/.test(e.message), String(bad));
  }
  const source = readFileSync(join(ROOT, 'tools', 'dev-server.mjs'), 'utf8');
  assert.match(source, /net\.connect\(\{ host: '127\.0\.0\.1', port: upstreamPort \}\)/, 'the upstream host is fixed');
});

test('--tracker-proxy command line: the flag is in --help, --json reports it, a bad value exits 2, SIGTERM stops it', async () => {
  const help = spawnSync(process.execPath, ['tools/dev-server.mjs', '--help'], { cwd: ROOT, encoding: 'utf8' });
  assert.equal(help.status, 0);
  assert.ok(help.stdout.includes('--tracker-proxy'));
  const bad = spawnSync(process.execPath, ['tools/dev-server.mjs', '--root', siteRoot || ROOT, '--port', '0', '--tracker-proxy', '0'], { cwd: ROOT, encoding: 'utf8' });
  assert.equal(bad.status, 2);
  assert.match(bad.stderr, /--tracker-proxy/);
  const tracker = await createTracker({ port: 0, open: true });
  closers.push(() => tracker.close());
  const child = spawn(process.execPath, ['tools/dev-server.mjs', '--root', siteRoot || ROOT, '--port', '0', '--tracker-proxy', String(tracker.port), '--json'], { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '';
  child.stdout.on('data', (d) => { stdout += d; });
  const info = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('no JSON printed: ' + stdout)), 8000);
    const tick = setInterval(() => {
      try {
        const parsed = JSON.parse(stdout.split('\n')[0]);
        clearTimeout(timer);
        clearInterval(tick);
        resolve(parsed);
      } catch (_) { /* not complete yet */ }
    }, 25);
    child.once('exit', (code) => reject(new Error('exited early ' + code + ': ' + stdout)));
  });
  child.removeAllListeners('exit');
  assert.equal(info.trackerProxy, tracker.port);
  const ws = await open(info.url.replace(/^http/, 'ws') + 'tracker');
  assert.equal((await ask(ws, announce('23'.repeat(20)))).action, 'announce');
  ws.close();
  const exited = new Promise((resolve) => child.once('exit', (code) => resolve(code)));
  child.kill('SIGTERM');
  assert.equal(await exited, 0);
});

test('a plain request to the proxy-less default server still works while another server proxies (no shared state)', async () => {
  const { dev } = await startPair();
  const plain = await createDevServer({ root: siteRoot, port: 0, quiet: true });
  closers.push(() => plain.close());
  for (const s of [dev, plain]) {
    const res = await new Promise((resolve, reject) => {
      http.get(s.url, (r) => {
        let data = '';
        r.on('data', (d) => { data += d; });
        r.on('end', () => resolve({ status: r.statusCode, data }));
      }).on('error', reject);
    });
    assert.equal(res.status, 200);
    assert.equal(res.data, SHELL);
  }
});
