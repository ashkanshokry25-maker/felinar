// Unit tests for tools/demo.mjs, tools/pin.mjs and tools/live.mjs helpers (ARCHITECTURE section 10,
// DESIGN-REVIEW item 22). No browser is started: the demo runs with seeder 'none' on free ports, and
// the pin/live helpers are the pure ones. The browser parts are exercised by the integration run.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync, readFileSync, statSync, mkdirSync, writeFileSync } from 'node:fs';
import https from 'node:https';
import { spawnSync } from 'node:child_process';
import WebSocket from 'ws';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { planDemo, tierText, runDemo, freePort, demoSiteLabel, LAN_STRING_Z8 } from '../../tools/demo.mjs';
import { chatLaneHash } from '../../tools/tracker.mjs';
import { backoffMs, statusLine, wantsReload, isBroken } from '../../tools/pin.mjs';
import { formatStatus, PLACEHOLDER_TITLES, pickLedgerDatabase } from '../../tools/live.mjs';
import { UsageError, ToolError, ROOT } from '../../tools/lib.mjs';
import { verifyPointer } from '../../src/common/pointer.js';
import { stampedPointerFromHtml } from '../../src/sw/lib.js';
import { chromiumArgs } from '../e2e/browser-args.mjs';

const work = mkdtempSync(join(tmpdir(), 'mw-demo-test-'));
const stoppers = [];
after(async () => {
  for (const s of stoppers) await s();
  rmSync(work, { recursive: true, force: true });
});

test('planDemo: the desktop tier is http://localhost; a pointer is signed for the hostname in the address bar', () => {
  const p = planDemo({ port: 8080, trackerPort: 8000 });
  assert.equal(p.tier, 'desktop');
  assert.equal(p.scope, 'localhost');
  assert.equal(p.origin, 'http://localhost:8080');
  assert.equal(p.wsBase, 'http://localhost:8080/ws/');
  assert.equal(p.trackerUrl, 'ws://localhost:8000');
  assert.equal(p.bindHost, '127.0.0.1', 'nothing listens on the LAN without --tls');
  assert.equal(p.tls, false);
});

test('planDemo: --tls is the LAN tier on the first LAN address, https and wss, bound to all interfaces, the tracker on the page\'s own origin', () => {
  const p = planDemo({ tls: true, port: 8443, trackerPort: 8001, lan: ['192.168.1.20', '10.0.0.5'] });
  assert.equal(p.tier, 'lan');
  assert.equal(p.scope, '192.168.1.20');
  assert.equal(p.origin, 'https://192.168.1.20:8443');
  assert.equal(p.wsBase, 'https://192.168.1.20:8443/ws/');
  // v0.3 C2 (S2 rung 1): one address, one port, one certificate; the tracker behind it listens on 127.0.0.1:8001
  assert.equal(p.trackerUrl, 'wss://192.168.1.20:8443/tracker');
  assert.equal(p.trackerProxy, true);
  assert.equal(p.trackerPort, 8001);
  assert.equal(p.bindHost, '0.0.0.0');
  assert.deepEqual(p.local, { origin: 'https://localhost:8443', trackerUrl: 'wss://localhost:8443/tracker' }, 'the headless seeder uses localhost names: the local-only browser resolves nothing else');
  assert.equal(planDemo({ tls: true, lanHost: 'mac.local', lan: [] }).scope, 'mac.local');
  assert.equal(planDemo({ tls: true, lanHost: 'mac.local', lan: [] }).trackerUrl, 'wss://mac.local:8080/tracker');
  assert.equal(planDemo({ tls: true, lanHost: 'fd00::7', lan: [] }).trackerUrl, 'wss://[fd00::7]:8080/tracker', 'an IPv6 address is bracketed');
  assert.throws(() => planDemo({ tls: true, lan: [] }), UsageError);
  // the desktop tier is unchanged: its own port, no proxy
  const d = planDemo({ port: 8080, trackerPort: 8000 });
  assert.equal(d.trackerProxy, undefined);
  assert.equal(d.trackerUrl, 'ws://localhost:8000');
});

test('tierText: the desktop tier explains why a phone cannot use it and the two ways to get one working', () => {
  const text = tierText(planDemo({ port: 8080, trackerPort: 8000 }), { port: 8080, trackerPort: 8000 }).join('\n');
  assert.match(text, /Tier: desktop/);
  assert.match(text, /Open http:\/\/localhost:8080\//);
  assert.match(text, /This page must be served over HTTPS \(or localhost\)/);
  assert.match(text, /npm run demo -- --tls/);
  assert.match(text, /adb reverse tcp:8080 tcp:8080 && adb reverse tcp:8000 tcp:8000/);
  assert.equal(/serverless|blockchain|unstoppable|censorship/i.test(text), false);
  // v0.3 verify fix round 2: a post signs in first, so the text names the identity page and the USB route reverses its port too
  const withIdp = tierText(planDemo({ port: 8080, trackerPort: 8000 }), { port: 8080, trackerPort: 8000, idpPort: 8081 }).join('\n');
  assert.match(withIdp, /Posting signs in first, at the identity page http:\/\/localhost:8081\//);
  assert.match(withIdp, /adb reverse tcp:8080 tcp:8080 && adb reverse tcp:8000 tcp:8000 && adb reverse tcp:8081 tcp:8081/);
  assert.match(text, /No identity page runs, so posting asks to sign in and fails/, 'without an identity page the text says what a post does');
});

test('tierText: the LAN tier tells how to trust the mkcert root on iOS and Android, or how to get mkcert', () => {
  const plan = planDemo({ tls: true, port: 8443, trackerPort: 8001, lan: ['192.168.1.20'] });
  const withCa = tierText(plan, { caRoot: '/Users/me/Library/Application Support/mkcert' }).join('\n');
  assert.match(withCa, /Tier: LAN/);
  assert.match(withCa, /https:\/\/192\.168\.1\.20:8443\//);
  assert.match(withCa, /rootCA\.pem/);
  assert.match(withCa, /Certificate Trust Settings/);
  assert.match(withCa, /Install a certificate > CA certificate/);
  const noCa = tierText(plan, { caRoot: null }).join('\n');
  assert.match(noCa, /brew install mkcert nss && mkcert -install/);
  assert.match(noCa, /never installs software/);
});

test('tierText: the LAN tier prints the rung 1 phone steps of S2: string Z8 as written, the USB route and the client isolation limit', () => {
  const plan = planDemo({ tls: true, port: 8443, trackerPort: 8001, lan: ['192.168.1.20'] });
  for (const caRoot of ['/Users/me/Library/Application Support/mkcert', null]) {
    const text = tierText(plan, { caRoot }).join('\n');
    assert.ok(text.includes(LAN_STRING_Z8), 'string Z8 is in the text');
    assert.match(text, /Tracker: wss:\/\/192\.168\.1\.20:8443\/tracker {3}Web seed: https:\/\/192\.168\.1\.20:8443\/ws\//);
    assert.match(text, /adb reverse tcp:8080 tcp:8080 && adb reverse tcp:8000 tcp:8000/, 'the USB route, on the default ports of the desktop tier');
    assert.match(text, /open http:\/\/localhost:8080\/ in Chrome on the phone/);
    assert.match(text, /Wi-Fi client isolation/);
    assert.match(text, /This tier runs no identity page/, 'v0.3 verify fix round 2: the LAN tier says that posting needs the desktop tier');
  }
  assert.equal(
    LAN_STRING_Z8,
    'Phones run this site only over https. Trust the certificate on each phone once, or connect an Android phone by USB. Whoever gets the key of this local certificate authority can read the secure traffic of every phone that trusts it: keep it on this computer and remove the certificate afterwards.',
  );
  // the desktop tier does not carry the LAN text
  assert.equal(tierText(planDemo({ port: 8080, trackerPort: 8000 })).join('\n').includes(LAN_STRING_Z8), false);
});

test('runDemo (no browser): builds, publishes examples/peer-guestbook with an open ledger, serves it with the pointer, allows only its torrents', async () => {
  const dist = join(work, 'dist');
  const dir = join(work, 'demo');
  const lines = [];
  const demo = await runDemo({ port: 0, trackerPort: 0, seeder: 'none', dist, dir, log: (l) => lines.push(l) });
  stoppers.push(() => demo.stop());
  assert.equal(demo.plan.tier, 'desktop');
  assert.match(demo.url, /^http:\/\/localhost:\d+\/$/);
  assert.equal(demo.seeder, 'none');
  assert.ok(existsSync(join(dist, 'index.html')) && existsSync(join(dist, 'mw-sw.js')), 'the loader was built');
  assert.equal(statSync(join(dir, 'owner.jwk')).mode & 0o777, 0o600);
  const base = demo.dev.url; // 127.0.0.1 numerically; the pointer is signed for "localhost"
  const html = await (await fetch(base)).text();
  const rec = stampedPointerFromHtml(html);
  assert.ok(rec, 'the dev server stamps the pointer into the shell');
  assert.equal(rec.btih, demo.publishResult.btih);
  assert.equal((await verifyPointer(rec, 'localhost')).ok, true);
  assert.deepEqual(rec.ws, [demo.plan.wsBase]);
  assert.deepEqual(rec.tr, [demo.plan.trackerUrl]);
  assert.equal(rec.cs, demo.plan.wsBase + 'genesis.json');
  assert.match(html, /<meta name="mw-dev" content="1">/);
  const summary = await (await fetch(base + 'ws/summary.json')).json();
  assert.equal(summary.btih, rec.btih);
  assert.equal(summary.name, 'peer-guestbook');
  const genesis = await (await fetch(base + 'ws/genesis.json')).json();
  assert.equal(genesis[0].h, rec.gen, 'cs= serves the genesis block');
  assert.equal(demo.publishResult.genesis.e.op.writers, 'open', 'the guestbook needs an open ledger');
  assert.equal(demo.tracker.allow.size, 3, 'the site, its ledger anchor and its chat lane (SCALE-2), nothing else');
  assert.ok(demo.tracker.allow.has(summary.btih) && demo.tracker.allow.has(summary.anchorBtih) && demo.tracker.allow.has(chatLaneHash(summary.ledgerId)));
  // v0.3 verify fix round 2: writing needs a sign-in, so the desktop tier serves the identity page (built next to dist) and the pointer names it
  assert.ok(demo.idp && /^http:\/\/localhost:\d+$/.test(demo.idp.origin), 'the identity page has an origin');
  assert.equal(rec.idp, demo.idp.origin, 'the pointer names the identity page (idp=)');
  assert.ok(existsSync(join(work, 'dist-idp', 'index.html')), 'the identity page was built next to dist');
  const idpPage = await fetch('http://127.0.0.1:' + demo.idp.port + '/');
  assert.equal(idpPage.status, 200);
  assert.match(await idpPage.text(), /<html/i);
  const text = lines.join('\n');
  assert.match(text, /identity page: http:\/\/localhost:\d+\//);
  assert.match(text, /Tier: desktop/);
  assert.match(text, /Ctrl-C stops/);
  assert.match(text, /npm run demo -- --tls/);
  // Post-wave fix L: the guestbook has a ledger of its own (a chain label for its folder), named in the output.
  assert.match(demo.chain, /^demo-peer-guestbook-[0-9a-f]{6}$/);
  assert.equal(rec.chain, demo.chain, 'the pointer carries the chain label');
  assert.match(text, /own ledger \(chain demo-peer-guestbook-[0-9a-f]{6}/);
  // a second run reuses the key and the label, so the ledger id (and a browser's saved posts) stay valid
  const again = await runDemo({ port: 0, trackerPort: 0, seeder: 'none', dist, dir, build: false, log: () => {} });
  stoppers.push(() => again.stop());
  assert.equal(again.publishResult.ledgerId, demo.publishResult.ledgerId);
  assert.equal(again.publishResult.gen, demo.publishResult.gen, 'the genesis block is reused');
  assert.equal(again.chain, demo.chain);
  await again.stop();
  await demo.stop();
  await assert.rejects(fetch(base), /fetch failed/);
  // Another site folder gets another ledger (before the fix both printed the same mw1: id), and the guestbook
  // keeps its own ledger and genesis afterwards.
  const other = join(work, 'other-site');
  mkdirSync(other, { recursive: true });
  writeFileSync(join(other, 'index.html'), '<!doctype html><title>Other</title><h1>Other</h1>\n');
  const second = await runDemo({ port: 0, trackerPort: 0, seeder: 'none', dist, dir, site: other, name: 'other', build: false, log: () => {} });
  stoppers.push(() => second.stop());
  assert.notEqual(second.publishResult.ledgerId, demo.publishResult.ledgerId, 'a different ledger id');
  assert.match(second.chain, /^demo-other-site-[0-9a-f]{6}$/);
  await second.stop();
  const back = await runDemo({ port: 0, trackerPort: 0, seeder: 'none', dist, dir, build: false, log: () => {} });
  stoppers.push(() => back.stop());
  assert.equal(back.publishResult.ledgerId, demo.publishResult.ledgerId, 'the guestbook keeps its ledger');
  assert.equal(back.publishResult.gen, demo.publishResult.gen, 'and its genesis block');
  await back.stop();
});

test('post-wave fix L: demoSiteLabel gives each site folder its own label, the same one every run, and no path in it', () => {
  const demoDir = join(work, 'labels');
  const a = join(work, 'one', 'public');
  const b = join(work, 'two', 'public');
  const la = demoSiteLabel(a, demoDir);
  assert.match(la, /^demo-public-[0-9a-f]{6}$/);
  assert.equal(demoSiteLabel(a, demoDir), la, 'remembered');
  assert.equal(demoSiteLabel(a + '/', demoDir), la, 'the same folder written differently');
  const lb = demoSiteLabel(b, demoDir);
  assert.notEqual(lb, la, 'two folders with the same name get different labels');
  assert.equal(la.includes(work) || la.includes('one'), false, 'the label never holds the path');
  const saved = JSON.parse(readFileSync(join(demoDir, 'sites.json'), 'utf8'));
  assert.equal(saved[a], la);
  assert.match(demoSiteLabel(join(work, 'odd name with spaces & ünïcode'), demoDir), /^demo-odd-name-with-spaces-n-code-[0-9a-f]{6}$|^demo-[A-Za-z0-9._-]+-[0-9a-f]{6}$/);
  assert.ok(demoSiteLabel(join(work, 'x'.repeat(80)), demoDir).length <= 64, 'within the 64 characters --chain allows');
});

test('runDemo --tls without mkcert fails with instructions instead of starting plain http', async () => {
  const saved = process.env.PATH;
  process.env.PATH = '';
  try {
    await assert.rejects(
      runDemo({ tls: true, lanHost: '192.168.1.20', port: 0, trackerPort: 0, seeder: 'none', dist: join(work, 'dist'), dir: join(work, 'demo-tls'), build: false, log: () => {} }),
      (err) => err instanceof ToolError && /mkcert/.test(err.message),
    );
  } finally {
    process.env.PATH = saved;
  }
});

test('freePort returns a port nothing listens on', async () => {
  const port = await freePort();
  assert.ok(port > 1023 && port < 65536);
  await assert.rejects(fetch('http://127.0.0.1:' + port + '/'), /fetch failed/);
});

test('pin helpers: restart delays grow to five minutes; broken and reload states are recognised', () => {
  assert.deepEqual([0, 1, 2, 3, 4, 5, 6, 10, 50].map(backoffMs), [5000, 10000, 20000, 40000, 80000, 160000, 300000, 300000, 300000]);
  assert.equal(isBroken(null), true);
  assert.equal(isBroken({ bootStage: 'stopped' }), true);
  assert.equal(isBroken({ bootStage: 'import', error: 'The loader could not start' }), true);
  assert.equal(isBroken({ bootStage: 'import', error: null }), false);
  assert.equal(wantsReload({ banners: ['Update available: reload'] }), true);
  assert.equal(wantsReload({ banners: ['First time on this device'] }), false);
  assert.equal(wantsReload(null), false);
  const line = statusLine({ status: 'Sharing', peers: '3 peers', ledger: 'Ledger: 5 entries' }, { restarts: 2, now: new Date(Date.UTC(2026, 9, 19, 12, 30, 45)) });
  assert.equal(line, '12:30:45 Sharing | 3 peers | Ledger: 5 entries (restarts: 2)');
});

test('live helpers: status lines, placeholder pages and the ledger database choice', () => {
  assert.equal(formatStatus({ error: 'boom', status: 'Stopped' }), 'ERROR boom | Stopped');
  assert.equal(formatStatus({ hasFrame: true, frameReady: true }), 'site rendered');
  assert.equal(formatStatus(null), 'no page');
  assert.ok(PLACEHOLDER_TITLES.includes("This site isn't ready yet"));
  const core = readFileSync(join(ROOT, 'src', 'sw', 'core.js'), 'utf8');
  for (const title of PLACEHOLDER_TITLES) assert.ok(core.includes(title), 'src/sw/core.js still has the placeholder title ' + title);
  const a = { database: 'mw-chain-a', blocks: [1] };
  const b = { database: 'mw-chain-b', blocks: [1, 2] };
  assert.equal(pickLedgerDatabase([a], null), a);
  assert.equal(pickLedgerDatabase([a, b], 'mw-chain-b'), b);
  assert.equal(pickLedgerDatabase([a, b], 'mw-chain-c'), null);
  assert.equal(pickLedgerDatabase([], null), null);
  assert.throws(() => pickLedgerDatabase([a, b], null), /several ledgers/);
});

test('every browser the tools start is local-only unless the tool is one of the three allowed to reach the internet', () => {
  const local = chromiumArgs();
  assert.ok(local.some((a) => a.startsWith('--host-resolver-rules=MAP * ~NOTFOUND')));
  const remote = chromiumArgs({ allowRemote: true });
  assert.equal(remote.some((a) => a.startsWith('--host-resolver-rules')), false);
  // demo.mjs and the seeder use the local-only launch; pin, snapshot <url> and check-site --headless ask
  // live.allowRemoteFor(url), which is false for a loopback page (code review round 1; tools-lib tests it).
  const demoSrc = readFileSync(join(ROOT, 'tools', 'demo.mjs'), 'utf8');
  assert.match(demoSrc, /allowRemote: false/);
  assert.equal(/allowRemote: true/.test(demoSrc), false);
  for (const tool of ['pin', 'snapshot', 'check-site']) assert.match(readFileSync(join(ROOT, 'tools', tool + '.mjs'), 'utf8'), /allowRemote: (live\.)?allowRemoteFor\(/, tool);
  const live = readFileSync(join(ROOT, 'tools', 'live.mjs'), 'utf8');
  assert.match(live, /chromiumArgs\(\{ allowRemote \}\)/, 'live.mjs is the only place that launches Chromium, through chromiumArgs()');
  assert.equal(/chromium\.launch(PersistentContext)?\(/.test(readFileSync(join(ROOT, 'tools', 'demo.mjs'), 'utf8')), false);
});

test('code review v0.3: a browser that may reach the internet runs with the Chromium sandbox and keeps mDNS host-candidate hiding on', async () => {
  const { launchBrowser, launchOptions } = await import('../../tools/live.mjs');
  const calls = [];
  const fakeContext = { browser: () => null, close: async () => {} };
  const fake = {
    launch: async (o) => { calls.push(['launch', o]); return { newContext: async () => fakeContext, close: async () => {} }; },
    launchPersistentContext: async (dir, o) => { calls.push(['persistent', o]); return fakeContext; },
  };
  const warned = [];
  await launchBrowser({ allowRemote: true, chromium: fake, warn: (l) => warned.push(l) });
  await launchBrowser({ allowRemote: true, profileDir: join(work, 'remote-profile'), chromium: fake, warn: (l) => warned.push(l) });
  for (const [, o] of calls) {
    assert.equal(o.chromiumSandbox, true);
    assert.equal(o.args.some((a) => /WebRtcHideLocalIpsWithMdns/.test(a)), false, 'mDNS hiding stays on');
    assert.equal(o.args.some((a) => a.startsWith('--host-resolver-rules')), false, 'it may resolve names');
    assert.ok(o.args.includes('--disable-background-networking'), 'the other local-only flags stay');
    assert.ok(o.args.some((a) => /^--disable-features=.*OptimizationHints/.test(a)), 'the other disabled features stay');
  }
  assert.deepEqual(warned, []);
  calls.length = 0;
  await launchBrowser({ allowRemote: false, chromium: fake });
  assert.equal(calls[0][1].chromiumSandbox, false, 'local-only runs (tests, CI containers) are unchanged');
  assert.deepEqual(calls[0][1].args, chromiumArgs(), 'the local-only flags as they are, mDNS flag included');
  const off = launchOptions({ allowRemote: true, env: { MW_CHROMIUM_NO_SANDBOX: '1' } });
  assert.equal(off.chromiumSandbox, false);
  assert.match(off.warning, /WITHOUT the Chromium sandbox/);
});

test('runDemo --tls with your own certificate (the LAN tier): https dev server, the tracker on its origin at /tracker (wss), pointer signed for the LAN host', async (t) => {
  const certDir = join(work, 'lan-certs');
  mkdirSync(certDir);
  const made = spawnSync('openssl', ['req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:prime256v1', '-nodes', '-keyout', join(certDir, 'key.pem'),
    '-out', join(certDir, 'cert.pem'), '-days', '1', '-subj', '/CN=localhost', '-addext', 'subjectAltName=DNS:localhost,IP:127.0.0.1'], { encoding: 'utf8' });
  if (made.status !== 0) {
    t.skip('openssl is not available');
    return;
  }
  const cert = readFileSync(join(certDir, 'cert.pem'));
  // bindHost 127.0.0.1: the test must not open ports on the LAN; the plan itself is the LAN tier
  const demo = await runDemo({
    tls: true, cert: join(certDir, 'cert.pem'), key: join(certDir, 'key.pem'), lanHost: '127.0.0.1', bindHost: '127.0.0.1',
    port: 0, trackerPort: 0, seeder: 'none', dist: join(work, 'dist'), dir: join(work, 'demo-lan'), build: false, log: () => {},
  });
  stoppers.push(() => demo.stop());
  assert.equal(demo.plan.tier, 'lan');
  assert.equal(demo.plan.scope, '127.0.0.1');
  assert.match(demo.url, /^https:\/\/127\.0\.0\.1:\d+\/$/);
  const html = await new Promise((resolve, reject) => {
    https.get(demo.url, { ca: cert, servername: 'localhost' }, (res) => {
      let data = '';
      res.on('data', (d) => { data += d; });
      res.on('end', () => resolve(data));
    }).on('error', reject);
  });
  const rec = stampedPointerFromHtml(html);
  assert.ok(rec);
  assert.equal((await verifyPointer(rec, '127.0.0.1')).ok, true, 'signed for the hostname the phone types');
  assert.equal(rec.ws[0], demo.plan.wsBase);
  // v0.3 C2: the pointer names /tracker on the page's own origin, not a second TLS port
  assert.equal(rec.tr.length, 1);
  assert.match(rec.tr[0], /^wss:\/\/127\.0\.0\.1:\d+\/tracker$/);
  assert.equal(rec.tr[0], demo.plan.trackerUrl);
  assert.equal(rec.tr[0], demo.url.replace(/^https/, 'wss') + 'tracker');
  assert.match(demo.tracker.url, /^ws:\/\/127\.0\.0\.1:\d+$/, 'the tracker itself is plain and on loopback only');
  assert.equal(demo.dev.trackerProxy, demo.tracker.port);
  const socket = await new Promise((resolve, reject) => {
    const ws = new WebSocket(rec.tr[0], { ca: cert, servername: 'localhost' });
    ws.once('open', () => resolve(ws));
    ws.once('error', reject);
  });
  const hash = Buffer.from('aa'.repeat(20), 'hex').toString('latin1');
  const answered = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('the tracker did not answer through the dev server')), 5000);
    socket.once('message', (data) => {
      clearTimeout(timer);
      resolve(JSON.parse(String(data)));
    });
    socket.send(JSON.stringify({ action: 'announce', info_hash: hash, peer_id: 'p'.repeat(20), uploaded: 0, downloaded: 0, left: 0, event: 'started', numwant: 0, offers: [] }));
  });
  assert.ok(answered['failure reason'] || answered.action === 'announce', JSON.stringify(answered));
  assert.match(String(answered['failure reason'] || ''), /not allowed/, 'the demo tracker serves only this site: an unlisted infohash is refused, which proves the real tracker answered');
  socket.terminate();
  // the tracker's own port does not speak TLS
  await assert.rejects(new Promise((resolve, reject) => {
    const ws = new WebSocket(demo.tracker.url.replace(/^ws:/, 'wss:'), { ca: cert, servername: 'localhost' });
    ws.once('open', () => resolve(ws));
    ws.once('error', reject);
  }));
  await assert.rejects(runDemo({ tls: true, cert: join(certDir, 'cert.pem'), key: join(certDir, 'missing.pem'), lanHost: '127.0.0.1', bindHost: '127.0.0.1', port: 0, trackerPort: 0, seeder: 'none', dist: join(work, 'dist'), dir: join(work, 'demo-lan2'), build: false, log: () => {} }), /ENOENT|no such file/);
});
