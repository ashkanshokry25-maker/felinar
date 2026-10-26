// Browser smoke test for examples/peer-guestbook/ with Playwright (Chromium, plus WebKit where installed).
// A small static server plays the loader's part: it serves the site at the origin root, answers
// Range requests with 206 like the Service Worker does (ARCHITECTURE section 7.1), returns 404.html
// for unknown paths, and serves test/example/mock-sdk.js as /_mw/sdk.js. The real loader is covered by the
// integration E2E suite; this one checks the page's own behaviour against the section 9 contract.
// Run: npm run test:example, or node --test test/example/browser.test.mjs   (skips when playwright is not installed)
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { readFileSync, existsSync, statSync } from 'node:fs';
import { resolve, dirname, join, extname, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';

const HERE = dirname(fileURLToPath(import.meta.url));
// The repository's local-only launch flags (docs/DEV-NETWORK.md).
const { CHROMIUM_LOCAL_ONLY_ARGS } = await import(pathToFileURL(resolve(HERE, '../e2e/browser-args.mjs')).href);
const SITE = process.env.MW_EXAMPLE_DIR ? resolve(process.env.MW_EXAMPLE_DIR) : resolve(HERE, '../../examples/peer-guestbook');
const MOCK_SDK = join(HERE, 'mock-sdk.js');
let pw = null;
try { pw = await import('playwright'); } catch (err) { pw = null; }

const MIME = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json', '.png': 'image/png', '.mp4': 'video/mp4' };
const TEXT = {
  desktop: 'While this tab is open your browser connects to other visitors and, unless sharing is off, passes on files and posts.',
  mobile: 'Sharing only while this page is open and on screen.',
  hostOnly: "Host only: no peer connections. Slower, and shared data won't sync.",
  pending: "Peer connections start after you accept the loader's notice. Until then nothing connects to other visitors.",
  noHost: 'This page is not running inside the felinar loader.',
  banned: 'A moderator has banned this identity on this site.',
  reader: 'You can read this guestbook, but the owner only lets selected people post here.',
  unmoderated: 'You can post and delete your own posts. This copy has no owner key, so it has no moderators.',
};

// Same fake keys as mock-sdk.js: 65 bytes starting with 0x04, base64url.
function fakePub(seed) {
  const bytes = [4];
  for (let i = 1; i < 65; i++) bytes.push((seed * 131 + i * 17) & 255);
  return Buffer.from(bytes).toString('base64url');
}
const shortOf = (pub) => createHash('sha256').update(Buffer.from(pub, 'base64url')).digest('hex').slice(0, 8);
const ME = fakePub(1), ALICE = fakePub(2), BOB = fakePub(3), OWNER = fakePub(9);
const POSTS = [
  { author: ALICE, name: 'Alice', msg: 'Hello from Alice' },
  { author: BOB, msg: 'Bob was here' },
  { author: OWNER, name: 'Site owner', msg: 'Welcome, from the owner' },
];
const OPEN = { writers: 'open', bits: 16, maxValueBytes: 2048, moderators: [], banned: [] };

function parseRange(header, size) {
  const m = /^bytes=(\d*)-(\d*)$/.exec(header || '');
  if (!m || (m[1] === '' && m[2] === '')) return null;
  let start, end;
  if (m[1] === '') { start = Math.max(0, size - Number(m[2])); end = size - 1; } else { start = Number(m[1]); end = m[2] === '' ? size - 1 : Math.min(Number(m[2]), size - 1); }
  return start >= size || start > end ? 416 : { start, end };
}

function startServer() {
  const hits = [];
  const server = http.createServer((req, res) => {
    const path = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
    const hit = { path, range: req.headers.range || null, status: 0 };
    hits.push(hit);
    let file = path === '/_mw/sdk.js' ? MOCK_SDK
      : path.split('/').some((seg) => seg.startsWith('.')) ? null : join(SITE, path.endsWith('/') ? path + 'index.html' : path);
    let status = 200;
    const inSite = file && (file === MOCK_SDK || file.startsWith(SITE + sep));
    if (!inSite || !existsSync(file) || statSync(file).isDirectory()) { file = join(SITE, '404.html'); status = 404; }
    const body = readFileSync(file);
    const headers = { 'content-type': MIME[extname(file)] || 'application/octet-stream', 'cache-control': 'no-store', 'accept-ranges': 'bytes' };
    const range = status === 200 && req.headers.range ? parseRange(req.headers.range, body.length) : null;
    if (range === 416) { hit.status = 416; res.writeHead(416, { 'content-range': 'bytes */' + body.length }); res.end(); return; }
    if (range) {
      hit.status = 206;
      res.writeHead(206, { ...headers, 'content-range': 'bytes ' + range.start + '-' + range.end + '/' + body.length, 'content-length': range.end - range.start + 1 });
      res.end(body.subarray(range.start, range.end + 1));
      return;
    }
    hit.status = status;
    res.writeHead(status, { ...headers, 'content-length': body.length });
    res.end(body);
  });
  return new Promise((ok) => server.listen(0, '127.0.0.1', () => ok({ server, hits, base: 'http://127.0.0.1:' + server.address().port })));
}

describe('Peer Guestbook in a browser', { skip: pw ? false : 'playwright is not installed' }, () => {
  let srv, chromium, webkit;
  before(async () => {
    srv = await startServer();
    chromium = await pw.chromium.launch({ args: CHROMIUM_LOCAL_ONLY_ARGS });
    try { webkit = await pw.webkit.launch(); } catch (err) { webkit = null; }
  });
  after(async () => {
    if (chromium) await chromium.close();
    if (webkit) await webkit.close();
    if (srv) srv.server.close();
  });

  async function open(browser, path, scenario, opts = {}) {
    const context = await browser.newContext(opts.device || { viewport: { width: opts.width || 1024, height: 800 } });
    const page = await context.newPage();
    const problems = [];
    page.on('pageerror', (e) => problems.push('pageerror: ' + e.message));
    page.on('console', (m) => { if (m.type() === 'error' && !/Failed to load resource|Importing a module script failed/.test(m.text())) problems.push('console: ' + m.text()); });
    if (scenario) await page.addInitScript((s) => { globalThis.__mwScenario = s; }, scenario);
    if (opts.blockSdk) await page.route('**/_mw/sdk.js', (route) => route.fulfill({ status: 404, contentType: 'text/plain', body: 'no loader here' }));
    const response = await page.goto(srv.base + path);
    return { context, page, problems, response };
  }
  const text = (page, sel) => page.locator(sel).first().textContent();
  const visible = (page, sel) => page.$eval(sel, (n) => !n.closest('[hidden]'));
  async function waitText(page, sel, expected, timeout = 5000) {
    try {
      await page.waitForFunction(([s, e]) => { const n = document.querySelector(s); return !!n && n.textContent === e; }, [sel, expected], { timeout });
    } catch (err) {
      assert.equal(await page.$eval(sel, (n) => n.textContent).catch(() => '(no ' + sel + ')'), expected, 'waiting for ' + sel);
    }
  }
  const count = (page, sel) => page.locator(sel).count();
  const tap2 = async (loc) => { await loc.click(); assert.equal(await loc.textContent(), 'Tap again to confirm'); await loc.click(); };

  it('standalone: a plain static host without /_mw/sdk.js keeps the static page usable', async () => {
    const { context, page, problems } = await open(chromium, '/', null, { blockSdk: true, width: 375 });
    await page.waitForSelector('#standalone:not([hidden])');
    assert.equal(await text(page, '#standalone-why'), 'The loader SDK at /_mw/sdk.js is not served here.');
    assert.equal(await text(page, '#ledger'), 'Ledger: not available without the loader.');
    assert.equal(await page.$eval('#post-form fieldset', (f) => f.disabled), true);
    assert.equal(await page.$eval('#name-form fieldset', (f) => f.disabled), true);
    await waitText(page, '[data-about="version"]', '3.0.0');
    await page.waitForFunction(() => document.querySelector('img.logo').complete);
    assert.equal(await page.$eval('img.logo', (img) => img.naturalWidth), 64);
    assert.equal(await page.evaluate(() => getComputedStyle(document.body).backgroundColor), 'rgb(244, 246, 248)');
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), 'no horizontal scroll at 375 px');
    assert.deepEqual(problems, []);
    await context.close();
  });

  it('E_NO_HOST: the SDK is served but the page is not inside the loader', async () => {
    const { context, page, problems } = await open(chromium, '/', { noHost: true });
    await page.waitForSelector('#standalone:not([hidden])');
    assert.equal(await text(page, '#standalone-why'), TEXT.noHost);
    assert.deepEqual(problems, []);
    await context.close();
  });

  it('writer: ledger line, consent copy, posting as text, names, own delete, remote posts, no moderation buttons', async () => {
    const { context, page, problems } = await open(chromium, '/', { role: 'writer', owner: OWNER, height: 1204, peers: 3, inSync: 2, posts: POSTS, policy: OPEN });
    await waitText(page, '#ledger', 'Ledger: 1,204 entries, in sync with 2 peers');
    assert.equal(await text(page, '#peers'), '3');
    assert.equal(await text(page, '#posts'), '3');
    assert.equal(await text(page, '#role-badge'), 'writer');
    assert.equal(await visible(page, '#notice-form'), false);
    assert.equal(await visible(page, '#unmoderated'), false);
    assert.equal(await visible(page, '#mod-howto'), true);
    await waitText(page, '#sharing', TEXT.desktop);
    await page.waitForFunction(() => document.querySelector('#site-meta').textContent !== '');
    assert.match(await text(page, '#source'), /^The files of "Peer Guestbook" arrived from other visitors, peer-to-peer over WebRTC\. Each one is checked against infohash 0123456789ab\.\.\. before it is used\.$/);
    assert.match(await text(page, '#site-meta'), /^3 files, 31\.4 KB, shell mode, ledger mw1:/);
    assert.equal(await text(page, '#pol-writers'), 'Anyone');
    assert.equal(await text(page, '#pol-fee'), '16-bit proof-of-work per post');
    const whos = await page.$$eval('#entries .who', (nodes) => nodes.map((n) => n.textContent));
    // UX-16 (MF-70): a profile name always shows the short id of its key beside it; a key without a name shows the short id alone
    assert.deepEqual(whos, ['Site owner (' + shortOf(OWNER) + ')owner', shortOf(BOB), 'Alice (' + shortOf(ALICE) + ')'], 'newest first, names from profiles with the short id, short id otherwise');
    assert.equal(await count(page, '#entries .act-remove, #entries .act-ban, #entries .act-delete'), 0);

    const evil = '<img src=x onerror="window.__xss=1">hi & bye';
    await page.fill('#msg', evil);
    assert.equal(await text(page, '#count'), evil.length + ' / 280');
    await page.click('#post-btn');
    await waitText(page, '#entries li:first-child .msg', evil);
    await waitText(page, '#count', '0 / 280'); // the mock pushes the entry a moment before the write is acknowledged
    assert.equal(await text(page, '#entries li:first-child .tag'), 'you');
    assert.equal(await page.evaluate(() => typeof window.__xss), 'undefined');
    assert.equal(await count(page, '#entries img'), 0);
    await waitText(page, '#ledger', 'Ledger: 1,205 entries, in sync with 2 peers');
    assert.equal(await page.$eval('#entries li:first-child', (li) => li.dataset.author), ME);

    await page.fill('#name', 'Ada');
    await page.click('#name-form button[type="submit"]');
    await waitText(page, '#entries li:first-child .who', 'Ada (' + shortOf(ME) + ')you');

    const del = page.locator('#entries li:first-child .act-delete');
    await del.click();
    await page.evaluate(() => __mwMock.setPeers(3, 2)); // a snapshot that changes nothing in the list
    await page.waitForTimeout(150);
    assert.equal(await del.textContent(), 'Tap again to confirm', 'an unrelated snapshot must not reset a half-confirmed button');
    await del.click();
    await page.waitForFunction(() => document.querySelectorAll('#entries li').length === 3);
    assert.ok(await page.evaluate(() => __mwMock.calls.some((c) => c[0] === 'db.tombstone')));

    await page.evaluate(() => { __mwMock.injectRaw(null); __mwMock.injectRaw(7); });
    await page.evaluate(() => __mwMock.remoteAppend(__mwMock.fakePub(5), 'From another visitor', 'Eve'));
    await waitText(page, '#entries li:first-child .msg', 'From another visitor');
    assert.equal(await text(page, '#entries li:first-child .who'), 'Eve (' + shortOf(fakePub(5)) + ')', 'a second visitor who calls themself Eve is told apart by the short id');
    assert.equal(await text(page, '#posts'), '4');
    assert.deepEqual(problems, []);
    await context.close();
  });

  it('moderator: notice editor, Remove post and Ban author, with the owner shielded from bans', async () => {
    const { context, page, problems } = await open(chromium, '/', { role: 'moderator', owner: OWNER, posts: POSTS, policy: { ...OPEN, moderators: [ME] } });
    await waitText(page, '#role-badge', 'moderator');
    assert.equal(await visible(page, '#notice-form'), true);
    assert.match(await text(page, '#role-help'), /^You are a moderator/);
    await page.waitForFunction(() => document.querySelectorAll('#entries li').length === 3);
    const owners = page.locator('#entries li[data-author="' + OWNER + '"]');
    assert.equal(await owners.locator('.act-remove').count(), 1);
    assert.equal(await owners.locator('.act-ban').count(), 0, 'no Ban author on the owner');
    assert.equal(await count(page, '#entries li[data-author="' + ALICE + '"] .act-ban'), 1);

    await page.fill('#notice-input', 'Be kind.\nNo spam.');
    await page.click('#notice-btn');
    await waitText(page, '#notice', 'Be kind.\nNo spam.');
    assert.equal(await page.$eval('#notice', (n) => n.classList.contains('muted')), false);
    assert.ok(await page.evaluate(() => __mwMock.calls.some((c) => c[0] === 'db.set' && c[1] === '_notice')));

    await tap2(page.locator('#entries li[data-author="' + ALICE + '"] .act-ban'));
    await page.waitForFunction((a) => !document.querySelector('#entries li[data-author="' + a + '"]'), ALICE);
    await waitText(page, '#pol-banned', '1');
    await tap2(page.locator('#entries li[data-author="' + BOB + '"] .act-remove'));
    await page.waitForFunction(() => document.querySelectorAll('#entries li').length === 1);

    await page.fill('#notice-input', '');
    await page.click('#notice-btn');
    await waitText(page, '#notice', 'No notice has been posted.');
    assert.ok(await page.evaluate(() => __mwMock.calls.some((c) => c[0] === 'db.set' && c[1] === '_notice' && c[2] === null)), 'empty notice deletes the key');
    assert.deepEqual(problems, []);
    await context.close();
  });

  it('a policy that names this visitor a moderator, or bans it, changes the page without a reload', async () => {
    const { context, page, problems } = await open(chromium, '/', { role: 'writer', owner: OWNER, posts: POSTS, policy: OPEN });
    await waitText(page, '#role-badge', 'writer');
    await page.evaluate(() => __mwMock.setPolicy({ moderators: [__mwMock.me] }));
    await waitText(page, '#role-badge', 'moderator');
    assert.equal(await visible(page, '#notice-form'), true);
    await waitText(page, '#pol-mods', '1');
    assert.equal(await count(page, '#entries .act-ban'), 2);
    await page.evaluate(() => __mwMock.setPolicy({ moderators: [], banned: [__mwMock.me] }));
    await waitText(page, '#role-badge', 'reader');
    assert.equal(await page.$eval('#post-form fieldset', (f) => f.disabled), true);
    assert.equal(await text(page, '#post-note'), TEXT.banned);
    assert.equal(await visible(page, '#notice-form'), false);
    assert.deepEqual(problems, []);
    await context.close();
  });

  it('an older SDK without role, consent, mod or the sync event still lets visitors post', async () => {
    const { context, page, problems } = await open(chromium, '/', { legacy: true, posts: POSTS, owner: OWNER, policy: OPEN });
    await waitText(page, '#role-badge', 'writer');
    await page.waitForFunction(() => document.querySelectorAll('#entries li').length === 3);
    assert.equal(await visible(page, '#sharing'), false);
    await page.fill('#msg', 'Posted through the old SDK');
    await page.click('#post-btn');
    await waitText(page, '#entries li:first-child .msg', 'Posted through the old SDK');
    assert.equal(await count(page, '#entries .act-ban'), 0);
    assert.deepEqual(problems, []);
    await context.close();
  });

  it('unmoderated copy with host-only consent shows the badge and the host-only line', async () => {
    const { context, page, problems } = await open(chromium, '/', { unmoderated: true, owner: null, consent: 'host-only', policy: OPEN });
    await waitText(page, '#sharing', TEXT.hostOnly);
    assert.equal(await visible(page, '#unmoderated'), true);
    assert.equal(await visible(page, '#unmoderated-note'), true);
    assert.equal(await visible(page, '#mod-howto'), false, 'no moderator how-to on an unmoderated copy');
    assert.equal(await text(page, '#role-help'), TEXT.unmoderated);
    assert.deepEqual(problems, []);
    await context.close();
  });

  it('consent copy follows mw.consent.state() as it changes', async () => {
    const { context, page, problems } = await open(chromium, '/', { consent: 'pending' });
    await waitText(page, '#sharing', TEXT.pending);
    await page.evaluate(() => __mwMock.setConsent('accepted'));
    await waitText(page, '#sharing', TEXT.desktop);
    assert.deepEqual(problems, []);
    await context.close();
  });

  it('phones get "Sharing only while this page is open and on screen." and no sideways scroll', async () => {
    const { context, page, problems } = await open(chromium, '/', { posts: POSTS, owner: OWNER }, { device: pw.devices['Pixel 7'] });
    await waitText(page, '#sharing', TEXT.mobile);
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), 'no horizontal scroll');
    assert.notEqual(await page.$eval('#toasts', (n) => getComputedStyle(n).top), 'auto', 'toasts at the top on touch screens');
    assert.deepEqual(problems, []);
    await context.close();
  });

  it('first paint from db.list and db.get when no snapshot is replayed; plain values; boolean inSync', async () => {
    const { context, page, problems } = await open(chromium, '/', { replay: false, kvForm: 'plain', notice: 'Hello from the owner', role: 'reader',
      owner: OWNER, inSync: true, peers: 4, height: 7, posts: POSTS, policy: { ...OPEN, writers: 'owner' } });
    await waitText(page, '#notice', 'Hello from the owner');
    await page.waitForFunction(() => document.querySelectorAll('#entries li').length === 3);
    assert.equal(await text(page, '#ledger'), 'Ledger: 7 entries');
    assert.equal(await page.$eval('#post-form fieldset', (f) => f.disabled), true);
    assert.equal(await text(page, '#post-note'), TEXT.reader);
    await page.evaluate(() => __mwMock.setPeers(5, true));
    await waitText(page, '#ledger', 'Ledger: 7 entries, in sync with 5 peers');
    assert.equal(await text(page, '#peers'), '5');
    await page.evaluate(() => __mwMock.emit('sync', { inSync: 1 }));
    await waitText(page, '#ledger', 'Ledger: 7 entries, in sync with 1 peer');
    assert.deepEqual(problems, []);
    await context.close();
  });

  it('about page: facts from /data/about.json, ledger line, and the link back', async () => {
    const { context, page, problems } = await open(chromium, '/about.html', { height: 1, peers: 1, inSync: 1 });
    await page.waitForFunction(() => document.querySelectorAll('[data-about="facts"] li').length === 5);
    await waitText(page, '#ledger', 'Ledger: 1 entry, in sync with 1 peer');
    await page.click('.site-nav a[href="/"]');
    await page.waitForURL(srv.base + '/');
    assert.equal(await text(page, 'h1'), 'Peer Guestbook');
    assert.deepEqual(problems, []);
    await context.close();
  });

  it('404.html renders styled at any depth', async () => {
    const { context, page, response } = await open(chromium, '/no/such/deep/page', null, { blockSdk: true });
    assert.equal(response.status(), 404);
    assert.equal(await text(page, 'h1'), 'That page is not part of this site');
    assert.equal(await page.$eval('.card', (n) => getComputedStyle(n).borderTopLeftRadius), '14px', '/css/app.css applied');
    assert.equal(await page.getAttribute('main a', 'href'), '/');
    await context.close();
  });

  for (const engine of ['chromium', 'webkit']) {
    it('the MP4 loads metadata and seeks through 206 Range responses in ' + engine, async (t) => {
      const browser = engine === 'chromium' ? chromium : webkit;
      if (!browser) return t.skip('WebKit is not installed for Playwright');
      const before = srv.hits.length;
      const { context, page } = await open(browser, '/', null, { blockSdk: true });
      await page.waitForFunction(() => document.querySelector('#clip').readyState >= 1, null, { timeout: 15000 });
      const meta = await page.$eval('#clip', (v) => [v.duration, v.videoWidth, v.videoHeight]);
      assert.ok(Math.abs(meta[0] - 4) < 0.1, 'duration ' + meta[0]);
      assert.deepEqual(meta.slice(1), [320, 180]);
      await page.$eval('#clip', (v) => { v.currentTime = 2.5; });
      await page.waitForFunction(() => { const v = document.querySelector('#clip'); return !v.seeking && v.readyState >= 2 && Math.abs(v.currentTime - 2.5) < 0.6; }, null, { timeout: 15000 });
      const ranged = srv.hits.slice(before).filter((h) => h.path === '/media/clip.mp4');
      assert.ok(ranged.length > 0 && ranged.every((h) => h.status === 206), engine + ' requested the clip with Range: ' + JSON.stringify(ranged));
      await context.close();
    });
  }

  it('WebKit runs the page logic: ledger line, posting, moderator buttons', async (t) => {
    if (!webkit) return t.skip('WebKit is not installed for Playwright');
    const { context, page, problems } = await open(webkit, '/', { role: 'moderator', owner: OWNER, height: 1204, peers: 3, inSync: 3, posts: POSTS, policy: { ...OPEN, moderators: [ME] } });
    await waitText(page, '#ledger', 'Ledger: 1,204 entries, in sync with 3 peers');
    await page.waitForFunction(() => document.querySelectorAll('#entries li').length === 3);
    assert.deepEqual(await page.$$eval('#entries .who', (nodes) => nodes.map((n) => n.textContent)), ['Site owner (' + shortOf(OWNER) + ')owner', shortOf(BOB), 'Alice (' + shortOf(ALICE) + ')'], 'WebCrypto short ids');
    await page.fill('#msg', 'Hello from WebKit');
    await page.click('#post-btn');
    await waitText(page, '#entries li:first-child .msg', 'Hello from WebKit');
    assert.equal(await count(page, '#entries .act-ban'), 2);
    assert.equal(await visible(page, '#notice-form'), true);
    assert.deepEqual(problems, []);
    await context.close();
  });
});
