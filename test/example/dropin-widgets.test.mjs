// Checks for the widgets variant of examples/existing-site-dropin/ (V03-DESIGN-REVIEW 2.3.6 and 3.8), without a browser: the staged layout,
// the hashes filled in by stage() against the files they name, the tags against what `publish --signin-widget --chat-panel` prints, the
// headers, the page script in a sandbox, the real <mw-signin> flow (the widget's runner with a fake identity page) against the sign-in
// server fixture that serves the staged site, the fixture host, and the list of end-to-end checks in EXPECTED.md. Loopback only; ASCII only.
// Run: node --test test/example/dropin-widgets.test.mjs   (or npm run test:example)
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '../..');
const fixtures = await import(pathToFileURL(join(ROOT, 'test/fixtures/existing-site-dropin/stage.mjs')).href);
const { createHost } = await import(pathToFileURL(join(ROOT, 'test/fixtures/existing-site-dropin/host.mjs')).href);
const { stage, VARIANTS, WIDGET_VARIANTS, WIDGET_PLACEHOLDER, WIDGET_HOSTS, MW_TAG, FIXTURE_DIR, widgetIntegrity } = fixtures;
const { widgetTags } = await import(pathToFileURL(join(ROOT, 'tools/publish.mjs')).href);
const { startSigninServer } = await import(pathToFileURL(join(ROOT, 'test/fixtures/signin-server/server.mjs')).href);
const { createSigninRunner, COOLDOWN_MS } = await import(pathToFileURL(join(ROOT, 'src/widget/signin.js')).href);
const signin = await import(pathToFileURL(join(ROOT, 'src/identity/signin.js')).href);
const crypto = await import(pathToFileURL(join(ROOT, 'src/chain/crypto.js')).href);
const { parseHeaders, parseRedirects, stampedPointerFromHtml } = await import(pathToFileURL(join(ROOT, 'src/sw/lib.js')).href);
const { evaluateStamp } = await import(pathToFileURL(join(ROOT, 'src/dropin/stamp.js')).href);

const work = mkdtempSync(join(tmpdir(), 'mw-widgets-test-'));
const closers = [];
after(async () => {
  for (const close of closers) await close();
  rmSync(work, { recursive: true, force: true });
});
let n = 0;
const fresh = (label) => join(work, label + '-' + ++n);
const read = (dir, rel) => readFileSync(join(dir, ...rel.split('/')), 'utf8');
const sri = (bytes) => 'sha384-' + createHash('sha384').update(bytes).digest('base64');

/** A dist folder with the two widget files, as `node build.mjs` would leave them (any bytes will do for hashing). */
function fakeDist() {
  const dist = fresh('dist');
  mkdirSync(join(dist, '_mw'), { recursive: true });
  writeFileSync(join(dist, '_mw', 'signin.js'), 'export const fake = "signin";\n');
  writeFileSync(join(dist, '_mw', 'chat-panel.js'), 'export const fake = "chat-panel";\n// a different file\n');
  return dist;
}

const WIDGET_FILES = ['404.html', '_headers', 'css/app.3f2a1b.css', 'data.json', 'img/logo.png', 'index.html', 'js/app.9c0d2e.js', 'js/forum.js'];

test('stage(with-widgets): a complete forum root; the first fixture is unchanged and the main site does not pick the folder up', () => {
  const s = stage('with-widgets', fresh('w'));
  assert.deepEqual(s.files, WIDGET_FILES);
  assert.deepEqual(WIDGET_VARIANTS, ['with-widgets']);
  assert.deepEqual(VARIANTS, ['main', 'with-own-sw', 'with-own-sw-integrated'], 'the list of the first fixture did not change');
  const main = stage('main', fresh('m'));
  assert.ok(!main.files.some((f) => f.startsWith('with-widgets')), 'the main site root does not include the widgets folder');
  assert.equal(main.files.length, 12);
  assert.throws(() => stage('main', fresh('x'), { widgets: { dist: '.' } }), /widgets exist for the widgets variant only/);
  assert.throws(() => stage('with-widgets', fresh('x'), { version: 2 }), /main site only/);
  assert.throws(() => stage('nope', fresh('x')), /unknown fixture variant/);
});

test('the page is a template: the drop-in tag, the two widget tags with a placeholder hash, the two elements; no inline script', () => {
  const s = stage('with-widgets', fresh('t'));
  const html = read(s.dir, 'index.html');
  assert.equal(html.split(MW_TAG).length - 1, 1, 'the drop-in tag, once, in <head>');
  assert.ok(html.indexOf(MW_TAG) < html.indexOf('</head>'));
  assert.equal(html.split(WIDGET_PLACEHOLDER).length - 1, 2, 'one placeholder per widget script');
  assert.match(html, /<mw-signin statement="Sign in to Example Forum" challenge-url="\/auth\/mw\/challenge" proof-url="\/auth\/mw\/verify"><\/mw-signin>/);
  // Review round R 5.3 (CONF-1): the panel reads only lang, so the page carries no tracker or stun attribute.
  assert.match(html, /<mw-chat-panel><\/mw-chat-panel>/);
  void WIDGET_HOSTS;
  assert.doesNotMatch(html, /<script(?![^>]*\bsrc=)[^>]*>/, 'every script is a file: nothing inline');
  assert.doesNotMatch(html, /\son[a-z]+=/, 'no inline event handler');
  assert.equal(s.widgets.signin, null);
  assert.equal(s.widgets.chatPanel, null);
});

test('stage fills the hashes the way publish computes them (sha384, base64, from the built file); explicit values win; the tracker and STUN hosts are filled in', () => {
  const dist = fakeDist();
  const want = { signin: sri(readFileSync(join(dist, '_mw', 'signin.js'))), chatPanel: sri(readFileSync(join(dist, '_mw', 'chat-panel.js'))) };
  assert.deepEqual(widgetIntegrity(dist), want);
  assert.notEqual(want.signin, want.chatPanel);
  assert.deepEqual(widgetIntegrity(fresh('empty')), { signin: null, chatPanel: null });
  const s = stage('with-widgets', fresh('f'), { widgets: { dist, tracker: '127.0.0.1:8000', stun: '127.0.0.1' } });
  const html = read(s.dir, 'index.html');
  assert.ok(!html.includes(WIDGET_PLACEHOLDER));
  assert.match(html, new RegExp('src="/_mw/signin\\.js" integrity="' + want.signin.replace(/[+/=]/g, '\\$&') + '" crossorigin'));
  assert.match(html, new RegExp('src="/_mw/chat-panel\\.js" integrity="' + want.chatPanel.replace(/[+/=]/g, '\\$&') + '" crossorigin'));
  assert.match(html, /<mw-chat-panel><\/mw-chat-panel>/, 'CONF-1: no tracker or stun attribute to fill in');
  assert.deepEqual(s.widgets, { signin: want.signin, chatPanel: want.chatPanel, tracker: '127.0.0.1:8000', stun: '127.0.0.1' });
  const explicit = stage('with-widgets', fresh('e'), { widgets: { dist, signin: 'sha384-AAAA' } });
  assert.ok(read(explicit.dir, 'index.html').includes('integrity="sha384-AAAA"'));
  assert.ok(read(explicit.dir, 'index.html').includes('integrity="' + want.chatPanel + '"'), 'the one not given comes from dist');
  // The page names exactly the files a publish with the two flags copies to /_mw/.
  assert.ok(html.includes('src="/_mw/signin.js"') && html.includes('src="/_mw/chat-panel.js"'));
});

test('the tags on the page are the tags `publish --signin-widget --chat-panel` prints (widgetTags), for the same statement, routes and hosts', () => {
  const dist = fakeDist();
  const w = widgetIntegrity(dist);
  const html = read(stage('with-widgets', fresh('p'), { widgets: { dist, tracker: 'tracker.example.com', stun: 'stun.example.com' } }).dir, 'index.html');
  const a = widgetTags({ name: 'signin', integrity: w.signin, statement: 'Sign in to Example Forum' });
  const b = widgetTags({ name: 'chat-panel', integrity: w.chatPanel, tracker: 'tracker.example.com', stun: 'stun.example.com' });
  for (const tag of [a.script, a.element, b.script, b.element]) assert.ok(html.includes(tag), 'the page holds ' + tag);
});

test('plain: the forum before it migrated has neither the drop-in tag nor the widgets', () => {
  const s = stage('with-widgets', fresh('plain'), { plain: true, widgets: { dist: fakeDist() } });
  const html = read(s.dir, 'index.html');
  for (const gone of ['/_mw/mw.js', '/_mw/signin.js', '/_mw/chat-panel.js', '<mw-signin', '<mw-chat-panel']) assert.ok(!html.includes(gone), gone + ' is gone');
  assert.match(html, /<h1>Example Forum<\/h1>/);
  assert.match(html, /<section id="signin"/);
});

test('every root-relative reference of the forum page resolves to a staged file, one of the two routes the server must answer, or /_mw/', () => {
  const s = stage('with-widgets', fresh('refs'));
  const have = new Set(s.files);
  const html = read(s.dir, 'index.html');
  const routes = new Set(['/auth/mw/challenge', '/auth/mw/verify']);
  let checked = 0;
  for (const m of html.matchAll(/(?:src|href|challenge-url|proof-url)="([^"]+)"/g)) {
    const url = m[1];
    checked++;
    if (url === '/' || url.startsWith('/_mw/')) continue;
    assert.ok(have.has(url.slice(1)) || routes.has(url), url + ' is neither a staged file, a route nor a runtime file');
  }
  assert.ok(checked >= 9, 'checked ' + checked);
  assert.deepEqual(parseRedirects(''), [], 'the forum has no _redirects');
  assert.ok(!s.files.includes('_redirects'));
});

test('_headers: the opener policy the sign-in popup needs (same-origin-allow-popups, never same-origin), no-referrer, immutable assets', () => {
  const s = stage('with-widgets', fresh('headers'));
  const headers = parseHeaders(read(s.dir, '_headers'));
  assert.deepEqual(headers.map((h) => h.for), ['/*', '/css/*', '/js/*', '/data.json']);
  assert.equal(headers[0].values['X-Fixture-Host'], 'example-forum');
  assert.equal(headers[0].values['Cross-Origin-Opener-Policy'], 'same-origin-allow-popups');
  assert.equal(headers[0].values['Referrer-Policy'], 'no-referrer');
  assert.match(headers[1].values['Cache-Control'], /immutable/);
  assert.doesNotMatch(read(s.dir, '_headers').replace(/^#.*$/gm, ''), /same-origin(?!-allow-popups)/, 'no header says same-origin without -allow-popups');
});

test('js/forum.js in a sandbox: it records what the button reports, sets text only, and never touches a key, a phrase or storage', () => {
  const code = readFileSync(join(FIXTURE_DIR, 'with-widgets', 'js', 'forum.js'), 'utf8');
  for (const bad of ['innerHTML', 'insertAdjacentHTML', 'eval(', 'localStorage', 'sessionStorage', 'document.cookie', 'postMessage', 'importScripts']) assert.ok(!code.includes(bad), bad);
  const line = { textContent: 'Not signed in.' };
  let listener = null;
  const button = { addEventListener: (type, fn) => { assert.equal(type, 'mw-signin'); listener = fn; } };
  const window = {};
  vm.runInNewContext(code, { window, document: { getElementById: (id) => (id === 'signin-status' ? line : null), querySelector: (sel) => (sel === 'mw-signin' ? button : null) } });
  assert.equal(window.__forum.jsRan, true);
  listener({ detail: { state: 'pending' } });
  assert.equal(line.textContent, 'Waiting for the identity page...');
  const pub = 'p256:' + 'A'.repeat(87);
  listener({ detail: { state: 'signed-in', status: 200, body: { ok: true, pub, keyMode: 'pairwise' } } });
  assert.deepEqual(Array.from(window.__forum.events), ['pending', 'signed-in']); // Array.from: the sandbox has its own Array
  assert.equal(window.__forum.signedIn, true);
  assert.equal(window.__forum.pub, pub);
  assert.equal(window.__forum.keyMode, 'pairwise');
  assert.equal(window.__forum.status, 200);
  assert.match(line.textContent, /^Signed in as p256:AAAAAAAAA\.\.\. The forum's server checked the proof\.$/);
  listener({ detail: { state: 'error', code: 'E_RATE' } });
  assert.deepEqual(Array.from(window.__forum.events), ['pending', 'signed-in', 'error:E_RATE']);
  assert.equal(window.__forum.error, 'E_RATE');
  assert.equal(line.textContent, 'Sign-in did not finish (E_RATE).');
  // Without the widget the script says so and does not throw.
  const w2 = {};
  vm.runInNewContext(code, { window: w2, document: { getElementById: () => null, querySelector: () => null } });
  assert.equal(w2.__forum.error, 'no-widget');
});

test('the fixture host serves the forum with its _headers, and the first fixture\'s 404 page', async () => {
  const s = stage('with-widgets', fresh('host'));
  const host = await createHost({ root: s.dir });
  closers.push(() => host.close());
  const res = await fetch(host.url);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('x-fixture-host'), 'example-forum');
  assert.equal(res.headers.get('cross-origin-opener-policy'), 'same-origin-allow-popups');
  assert.equal(res.headers.get('referrer-policy'), 'no-referrer');
  assert.match(await res.text(), /<mw-signin /);
  const forum = await fetch(host.url + 'js/forum.js');
  assert.equal(forum.status, 200);
  assert.match(forum.headers.get('cache-control'), /immutable/);
  assert.equal((await fetch(host.url + 'nope')).status, 404);
});

// ---------------------------------------------------------------------------------------------------------------------
// The widget's own flow against the forum's server (the fixture that serves the staged site and checks the proof)
// ---------------------------------------------------------------------------------------------------------------------

/** A stand-in for the identity page: builds and signs the proof the way src/idp does, for the origin the page really has. */
async function fakeIdentity({ origin, keyMode = 'pairwise' } = {}) {
  const pair = await crypto.generateKeyPair();
  const pub = await crypto.exportPublicKey(pair.publicKey);
  const seen = [];
  return {
    pub, seen,
    client: {
      // As the real client: the window opens first, then the challenge is awaited (code review v0.3, round 2).
      async signIn({ purpose, challenge: late, want }) {
        const challenge = await late;
        seen.push({ purpose, challenge, want });
        const c = signin.buildChallenge({ origin, pub, keyMode, purpose, challenge, now: Date.now(), requestId: 'cmVxdWVzdC1pZC0xMjM0NQ', idp: 'http://127.0.0.1:9', build: 'test-build' });
        return { proof: await signin.signChallenge(c, pair.privateKey) };
      },
    },
  };
}

test('the button\'s flow against the forum\'s server: challenge, proof text, 200 with the key; the same proof again is a replay; a proof for another origin is refused', async () => {
  const s = stage('with-widgets', fresh('srv'), { widgets: { dist: fakeDist() } });
  const forum = await startSigninServer({ staticDir: s.dir, statement: 'Sign in to Example Forum' });
  closers.push(() => forum.close());
  // The page and the widget file come from the one origin, with the opener policy.
  const page = await fetch(forum.url + '/');
  assert.equal(page.status, 200);
  assert.equal(page.headers.get('cross-origin-opener-policy'), 'same-origin-allow-popups');
  assert.match(await page.text(), /<mw-signin /);
  // The runner is the widget's: same-origin URLs only, a GET for the challenge, the proof text in a POST.
  const win = { location: { href: forum.url + '/', origin: forum.url }, fetch: (u, o) => fetch(u, o) };
  const id = await fakeIdentity({ origin: forum.origin });
  const posted = [], responses = [];
  const fetchFn = async (u, o) => {
    const res = await fetch(u, o);
    let body = null;
    try { body = await res.clone().json(); } catch (err) { body = null; }
    posted.push([o && o.method, new URL(u).pathname, o && o.body]);
    responses.push({ path: new URL(u).pathname, status: res.status, body });
    return res;
  };
  let t = 1000000;
  const runner = createSigninRunner({ client: id.client, fetchFn, win, now: () => t });
  const out = await runner.run({ challengeUrl: '/auth/mw/challenge', proofUrl: '/auth/mw/verify', statement: 'Sign in to Example Forum' });
  assert.equal(out.status, 200);
  assert.deepEqual(posted.map((p) => [p[0], p[1]]), [['GET', '/auth/mw/challenge'], ['POST', '/auth/mw/verify']]);
  assert.match(posted[1][2], /^\{"c":\{/, 'the body is the proof text');
  assert.equal(id.seen[0].purpose, 'server');
  assert.equal(id.seen[0].challenge.statement, 'Sign in to Example Forum', 'the statement is the server\'s, shown word for word at the identity page');
  assert.deepEqual(id.seen[0].want, ['proof']);
  assert.equal(responses[0].status, 200);
  assert.ok(typeof responses[0].body.nonce === 'string' && responses[0].body.nonce.length >= 22);
  assert.equal(out.body.ok, true);
  assert.equal(out.body.pub, id.pub);
  assert.equal(out.body.keyMode, 'pairwise');
  assert.equal(out.body.statement, 'Sign in to Example Forum');
  // A second click inside the cooldown is refused by the widget before anything is sent.
  const before = posted.length;
  await assert.rejects(() => runner.run({ challengeUrl: '/auth/mw/challenge', proofUrl: '/auth/mw/verify' }), (e) => e.code === 'E_RATE');
  assert.equal(posted.length, before);
  // The same proof text posted again is a replay.
  const again = await fetch(forum.url + '/auth/mw/verify', { method: 'POST', body: posted[1][2], headers: { 'content-type': 'application/json' } });
  assert.equal(again.status, 401);
  assert.equal((await again.json()).reason, 'replay');
  // A proof the identity page made for a different origin never verifies here, however fresh its nonce.
  const other = await fakeIdentity({ origin: 'http://127.0.0.1:1' });
  t += COOLDOWN_MS + 1;
  const runner2 = createSigninRunner({ client: other.client, fetchFn, win, now: () => t });
  await assert.rejects(() => runner2.run({ challengeUrl: '/auth/mw/challenge', proofUrl: '/auth/mw/verify' }), (e) => e.code === 'E_DENIED' && e.status === 401);
  const last = responses[responses.length - 1];
  assert.equal(last.path, '/auth/mw/verify');
  assert.equal(last.status, 401);
  assert.equal(last.body.reason, 'origin');
  // Other origins are refused by the widget itself, before any request.
  const runner3 = createSigninRunner({ client: id.client, fetchFn, win, now: () => t + 100 * COOLDOWN_MS });
  const sent = posted.length;
  await assert.rejects(() => runner3.run({ challengeUrl: 'https://other.example/challenge', proofUrl: '/auth/mw/verify' }), (e) => e.code === 'E_BAD_REQUEST');
  assert.equal(posted.length, sent, 'nothing was sent to another origin');
});

// ---------------------------------------------------------------------------------------------------------------------
// The owner steps, run with the real publish tool and the real ledger-admin functions
// ---------------------------------------------------------------------------------------------------------------------

test('the owner steps of the README, run: publish --dropin --chain --signin-widget --chat-panel prints the tags the page holds, lays the widgets out, stamps the pages; ledger-admin cfg switches chat on', async () => {
  const { publish } = await import(pathToFileURL(join(ROOT, 'tools/publish.mjs')).href);
  const { keygen } = await import(pathToFileURL(join(ROOT, 'tools/keygen.mjs')).href);
  const admin = await import(pathToFileURL(join(ROOT, 'tools/ledger-admin.mjs')).href);
  const { loadOwnerKey } = await import(pathToFileURL(join(ROOT, 'tools/lib.mjs')).href);
  // A dist folder with what a publish copies: the runtime files and the two widgets (any bytes will do for the hash).
  const dist = fresh('pdist');
  mkdirSync(join(dist, '_mw'), { recursive: true });
  writeFileSync(join(dist, 'mw-sw.js'), '// sw\n');
  writeFileSync(join(dist, 'mw-sw-kill.js'), '// kill\n');
  for (const f of ['boot.js', 'loader.js', 'mw.js', 'sw-core.js', 'signin.js', 'chat-panel.js']) writeFileSync(join(dist, '_mw', f), '// ' + f + '\n');
  writeFileSync(join(dist, 'index.html'), '<!doctype html><html><head><title>x</title></head><body></body></html>');
  const key = join(work, 'owner-widgets.jwk');
  await keygen({ out: key });
  const site = stage('with-widgets', fresh('psite'), { widgets: { dist, tracker: '127.0.0.1:8000', stun: '127.0.0.1' } });
  const res = await publish({ dir: site.dir, name: 'forum', scope: '127.0.0.1', key, chain: 'forum-chat', signinWidget: true, signinStatement: 'Sign in to Example Forum', chatPanel: true,
    tracker: ['ws://127.0.0.1:8000'], stun: ['stun:127.0.0.1:3478'], tr: [], ws: [], dropin: true, dist, out: fresh('pout'), now: Date.now(), quiet: true });
  // The tags publish prints are the tags the staged page holds, byte for byte.
  const printed = res.summary.widgets;
  assert.deepEqual(printed.map((w) => w.name), ['signin', 'chat-panel']);
  const html = read(join(res.outDir, 'site'), 'index.html');
  for (const w of printed) {
    assert.ok(html.includes(w.script), 'the page holds the printed script tag of ' + w.name);
    assert.ok(html.includes(w.element), 'the page holds the printed element of ' + w.name);
    assert.equal(w.integrity, sri(readFileSync(join(dist, '_mw', w.name + '.js'))));
    assert.deepEqual(readFileSync(join(res.outDir, 'site', '_mw', w.name + '.js')), readFileSync(join(dist, '_mw', w.name + '.js')), w.path + ' is laid out as built');
    assert.ok(read(join(res.outDir, 'widget'), 'tags.html').includes(w.script));
  }
  assert.deepEqual(res.summary.features, ['chat'], '--chat-panel implies the chat check');
  assert.deepEqual(res.summary.stun, ['stun:127.0.0.1:3478']);
  // The policy lines and the opener header it tells the owner about.
  const csp = read(res.outDir, 'csp.txt');
  assert.match(csp, /worker-src\s+'self'/);
  assert.match(csp, /connect-src\s+'self' ws:\/\/127\.0\.0\.1:8000/);
  assert.match(csp, /\/_mw\/signin\.js and \/_mw\/chat-panel\.js are module scripts on your own origin with integrity=/);
  assert.match(csp, /Cross-Origin-Opener-Policy: same-origin; same-origin-allow-popups is safe/);
  assert.match(read(res.outDir, 'loader-headers.txt'), /Cross-Origin-Opener-Policy: same-origin-allow-popups/);
  // The pages are stamped for the host, keep the drop-in tag and the widgets, and the widgets stay out of the torrent's HTML.
  const pointer = stampedPointerFromHtml(html.slice(0, 4096));
  assert.ok(pointer, 'the forum page is stamped');
  assert.equal((await evaluateStamp({ text: pointer.raw, scope: '127.0.0.1', now: Date.now() })).ok, true);
  assert.ok(html.includes(MW_TAG));
  const torrent = await (await import(pathToFileURL(join(ROOT, 'src/common/torrent-file.js')).href)).parseTorrentFile(new Uint8Array(res.torrentFile));
  assert.ok(!torrent.files.some((f) => /\.html?$/.test(f.path)), 'no HTML in the torrent');
  // "ledger-admin cfg --chat open" on the genesis publish wrote: the switch the panel needs is not there before, and is there after
  // (open, not members: the forum's visitors read its ledger and do not write to it; v0.3 final integration, seen in E-CH-R).
  const blocks = admin.readBlocksFile(join(res.outDir, 'genesis.json'));
  assert.deepEqual(admin.currentCfg((await admin.loadLedger(blocks)).state), {}, 'publish writes no _mw.cfg: --chat-panel only checks the tracker and STUN');
  const identity = await loadOwnerKey(key);
  const after = await admin.setCfg({ blocks, identity, set: { chat: 'open' } });
  assert.deepEqual(after.cfg, { chat: 'open' });
  assert.deepEqual(admin.currentCfg((await admin.loadLedger(after.blocks)).state), { chat: 'open' });
  // A key the ledger's schema does not know would hide the whole object, so the writer refuses it (docs/deviations/examples.md, D-1 and D-2).
  // The test names a key no schema has: wall, which D-2 was about, is a schema key once request 5 lands in src/chain/state.js.
  await assert.rejects(() => admin.setCfg({ blocks, identity, set: { 'no-such-key': 'follow' } }), /schema/);
});

// ---------------------------------------------------------------------------------------------------------------------
// The notes
// ---------------------------------------------------------------------------------------------------------------------

test('EXPECTED.md lists the checks 11 to 20 for the widgets, says which ones were not run in a browser, and keeps the first ten', () => {
  const md = readFileSync(join(FIXTURE_DIR, 'EXPECTED.md'), 'utf8');
  for (let i = 1; i <= 20; i++) assert.match(md, new RegExp('^' + i + '\\. \\*\\*', 'm'), 'numbered check ' + i);
  assert.doesNotMatch(md, /^21\. /m);
  const widgets = md.slice(md.indexOf('## The widgets variant')).replace(/\s+/g, ' ');
  for (const need of ['were not run in a browser', 'test/example/dropin-widgets.test.mjs', 'startSigninServer', 'publish --dropin --chain forum-chat --signin-widget --signin-statement "Sign in to Example Forum" --chat-panel --tracker', 'ledger-admin cfg --chat open', '_mw.cfg.chat',
    'integrity', 'sha384', 'Cross-Origin-Opener-Policy: same-origin-allow-popups', 'E_RATE', 'E_BAD_REQUEST', "reason: 'replay'", "reason: 'origin'", 'securitypolicyviolation', 'csp.txt',
    "'unavailable'", "'signed-out'", "'off'", "'on'", 'Scripts on this page can act as you on this site while you are signed in. They cannot reach your other sites.',
    'Sign in to Example Forum', 'E-SI-1']) {
    assert.ok(widgets.includes(need), 'EXPECTED.md must mention ' + need);
  }
  assert.ok(md.indexOf('## The five acceptance checks') < md.indexOf('## The widgets variant'));
});

test('README.md: the owner steps of R 3.8, the tags, the policy lines, the routes, the test helpers, and wording that follows the rules', () => {
  const md = readFileSync(join(FIXTURE_DIR, 'README.md'), 'utf8').replace(/\s+/g, ' ');
  for (const need of ['node tools/publish.mjs <your site> --name forum', '--dropin --chain forum-chat --signin-widget --chat-panel', '--tracker wss://tracker.example.com', '--stun stun:stun.example.com:3478',
    '<script type="module" src="/_mw/signin.js" integrity="sha384-..." crossorigin></script>', '<mw-signin statement="Sign in to Example Forum" challenge-url="/auth/mw/challenge" proof-url="/auth/mw/verify"></mw-signin>',
    '<mw-chat-panel></mw-chat-panel>', 'widget/tags.html', 'csp.txt', "script-src 'self'", "worker-src 'self'", 'connect-src',
    'Cross-Origin-Opener-Policy: same-origin-allow-popups', '/auth/mw/challenge', '/auth/mw/verify', '@felinar/verify', 'signin-server-node.md', 'signin-widget.md', 'startSigninServer',
    "stage('with-widgets'", 'widgetIntegrity', 'with-widgets/', 'dropin-widgets.test.mjs', 'items 11 to 20',
    'Scripts on this page can act as you on this site while you are signed in. They cannot reach your other sites.', 'no shared widget host']) {
    assert.ok(md.includes(need), 'README.md must mention ' + need);
  }
  for (const file of ['README.md', 'EXPECTED.md']) {
    const text = readFileSync(join(FIXTURE_DIR, file), 'utf8');
    for (const re of [/blockchain/i, /serverless/i, /unstoppable/i, /censorship[- ]resistant/i, /fully decentrali[sz]ed/i, /sub-second/i, /production[- ]ready/i]) assert.doesNotMatch(text, re, file + ' uses ' + re);
    assert.equal(/[\u2013\u2014\u2018\u2019\u201c\u201d]/.test(text), false, file + ' has a dash or curly quote');
  }
  // The folder that holds the site has only site files, and the widgets variant adds no dot-directory.
  for (const f of stage('with-widgets', fresh('ascii')).files) {
    assert.ok(!f.split('/').some((seg) => seg.startsWith('.')), f);
  }
});

test('the new fixture files are ASCII and name no secret: no key, no phrase, no password field', () => {
  const s = stage('with-widgets', fresh('ascii2'));
  for (const f of ['index.html', 'js/forum.js', '_headers']) {
    const text = read(s.dir, f);
    assert.equal(text.search(/[^\x09\x0a\x0d\x20-\x7e]/), -1, f); // eslint-disable-line no-control-regex
    assert.doesNotMatch(text, /type="password"|<input|<textarea|recovery phrase|12 words|passphrase/i, f);
  }
});
