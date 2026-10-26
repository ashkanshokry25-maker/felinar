// Static checks for examples/peer-guestbook/ (ARCHITECTURE section 11, DESIGN-REVIEW item 7, S11 and section 4; V03-DESIGN-REVIEW 3.9).
// Run: npm run test:example (or node --test test/example/site.test.mjs). The checks live in test/example/, outside
// the site, so nothing but the site is in examples/peer-guestbook/; MW_EXAMPLE_DIR overrides the site directory.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync, statSync, readdirSync } from 'node:fs';
import { resolve, dirname, join, relative } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { execFileSync, spawnSync } from 'node:child_process';
import { inflateSync } from 'node:zlib';
import { createHash } from 'node:crypto';

const HERE = dirname(fileURLToPath(import.meta.url));
const SITE = process.env.MW_EXAMPLE_DIR ? resolve(process.env.MW_EXAMPLE_DIR) : resolve(HERE, '../../examples/peer-guestbook');
const { checkHtml, checkSite } = await import(pathToFileURL(join(HERE, 'check-html.mjs')).href);
const { lintPaths } = await import(pathToFileURL(resolve(HERE, '../../tools/lint-floor.mjs')).href);
const loaderStrings = await import(pathToFileURL(resolve(HERE, '../../src/loader/strings.js')).href);
const sdkApi = await import(pathToFileURL(resolve(HERE, '../../src/loader/api.js')).href);
const read = (p) => readFileSync(join(SITE, p), 'utf8');
const PAGES = ['index.html', 'about.html', 'profile.html', 'members.html', '404.html'];
const LIVE_PAGES = ['index.html', 'about.html', 'profile.html', 'members.html']; // the pages with the header bar and the sign-in button
const SITE_FILES = ['404.html', 'about.html', 'css/app.css', 'data/about.json', 'img/peer.png', 'index.html', 'js/app.js', 'js/auth.js', 'js/common.js', 'js/members.js', 'js/profile.js',
  'media/clip.mp4', 'members.html', 'profile.html'];
const V03_JS = ['js/auth.js', 'js/common.js', 'js/members.js', 'js/profile.js'];
const CLIP_SHA256 = '81045124d22c374964a3746d88e7c15231391378e1587ccbda29ffb0f3245b92';
const RESERVED = /^\/(_mw\/|mw-sw\.js|ws\/|\.mw\/)/;

// Files that publish.mjs puts into the torrent: everything except dot-paths and README.md.
function siteFiles(dir = SITE) {
  const out = [];
  for (const name of readdirSync(dir).sort()) {
    if (name.startsWith('.') || name === 'node_modules') continue;
    const full = join(dir, name);
    if (statSync(full).isDirectory()) out.push(...siteFiles(full));
    else out.push(relative(SITE, full).split('\\').join('/'));
  }
  return out;
}
const textFiles = () => [...siteFiles().filter((f) => /\.(html|css|js|json)$/.test(f)), 'README.md'];
// This folder's own scripts (checks and generators): ASCII only, but they may name the banned words.
const toolFiles = () => readdirSync(HERE).filter((f) => /\.m?js$/.test(f));

test('the published file set is exactly the site, and nothing uses a reserved loader path', () => {
  const files = siteFiles().filter((f) => f !== 'README.md');
  assert.deepEqual(files, SITE_FILES);
  for (const f of files) assert.ok(statSync(join(SITE, f)).size > 0, f + ' is empty');
  assert.ok(existsSync(join(SITE, 'README.md')), 'README.md missing');
  for (const f of ['check-html.mjs', 'site.test.mjs', 'browser.test.mjs', 'mock-sdk.js', 'make-media.mjs']) {
    assert.ok(existsSync(join(HERE, f)), 'test/example/' + f + ' missing');
  }
  assert.ok(!existsSync(join(SITE, '.dev')), 'the checks live in test/example/, not in the site');
  for (const reserved of ['_mw', 'mw-sw.js', 'ws', '.mw']) assert.ok(!existsSync(join(SITE, reserved)), reserved + ' must not exist in the site');
});

test('every page passes the HTML checker (counts reported)', (t) => {
  const reports = checkSite(SITE);
  assert.deepEqual(reports.map((r) => r.file), PAGES.slice().sort());
  for (const r of reports) {
    const c = r.counts;
    t.diagnostic(r.file + ': elements=' + c.elements + ' distinctTags=' + Object.keys(c.tags).length + ' ids=' + c.ids + ' urls=' + r.urls.length + ' errors=' + r.errors.length);
    assert.deepEqual(r.errors, [], r.file);
    assert.equal(c.inlineScripts, 0, r.file + ' has an inline script');
    assert.equal(c.inlineStyles, 0, r.file + ' has an inline style element');
  }
});

test('the HTML checker catches the mistakes it claims to catch', () => {
  const page = (body, head = '') => '<!doctype html>\n<html lang="en">\n<head>\n<meta charset="utf-8">\n' +
    '<meta name="viewport" content="width=device-width, initial-scale=1">\n<title>T</title>' + head + '\n</head>\n<body>\n<main>\n<h1>T</h1>\n' + body + '\n</main>\n</body>\n</html>\n';
  assert.deepEqual(checkHtml(page('<p>fine &amp; dandy</p>')).errors, []);
  const cases = [
    ['<div><span>x</div></span>', /closes <span> implicitly/],
    ['<p><div>x</div></p>', /block <div> inside phrasing <p>/],
    ['<p id="a">x</p><p id="a">y</p>', /duplicate id "a"/],
    ['<img src="/x.png">', /<img> needs alt/],
    ['<button onclick="go()" type="button">x</button>', /inline event handler onclick/],
    ['<p>a &mdash; b</p>', /entity &mdash;/],
    ['<p>a \u2014 b</p>', /non-ASCII/],
    ["<p class='x'>y</p>", /must be double-quoted/],
    ['<label for="nope">x</label>', /points to no element/],
    ['<li>x</li>', /<li> inside <main>/],
    ['</div>', /stray <\/div>/],
    ['<section>', /closes <section> implicitly/],
    ['<a href="/x" target="_blank">x</a>', /noopener/],
    ['<button>x</button>', /explicit type/],
    ['<p>1 < 2</p>', /stray "<"/],
    ['<p>R&D</p>', /bare "&"/],
    ['<div style="color: red">x</div>', /style attribute/],
    ['<a href="javascript:alert(1)">x</a>', /javascript: URL/],
    ['<h1>Second</h1>', /exactly one <h1>/],
    ['<input name="q">', /needs an id/],
    ['<a href="/"><button type="button">x</button></a>', /interactive <button> inside <a>/],
    ['<div/>', /not a void element/],
  ];
  for (const [body, pattern] of cases) {
    const errors = checkHtml(page(body)).errors;
    assert.ok(errors.some((e) => pattern.test(e)), 'expected ' + pattern + ' for ' + body + ', got ' + JSON.stringify(errors));
  }
  assert.ok(checkHtml('<html lang="en"><head><meta charset="utf-8"></head><body></body></html>').errors.some((e) => /missing <!doctype html>/.test(e)));
  assert.ok(checkHtml(page('').replace('</main>\n</body>\n</html>\n', '<div>')).errors.some((e) => /<div> is never closed/.test(e)));
});

test('pages: head metadata, shared navigation, and the elements js/app.js and the E2E tests use', () => {
  for (const p of PAGES) {
    const html = read(p);
    assert.match(html, /^<!doctype html>\n<html lang="en">\n<head>\n {2}<meta charset="utf-8">/, p);
    assert.match(html, /<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">/, p);
    assert.match(html, /<meta name="color-scheme" content="light dark">/, p);
    assert.match(html, /<link rel="stylesheet" href="\/css\/app\.css">/, p);
  }
  const index = read('index.html'), about = read('about.html');
  for (const html of [index, about]) {
    assert.match(html, /<a href="\/"( aria-current="page")?>Guestbook<\/a>/);
    assert.match(html, /<a href="\/about\.html"( aria-current="page")?>About<\/a>/);
    assert.match(html, /<script type="module" src="\/js\/app\.js"><\/script>/);
    for (const id of ['standalone', 'standalone-why', 'unmoderated', 'peers', 'posts', 'ledger', 'sharing', 'source', 'toasts']) {
      assert.match(html, new RegExp(' id="' + id + '"'), 'missing #' + id);
    }
    assert.match(html, /<p id="ledger" class="ledger" aria-live="polite" aria-atomic="true">/);
  }
  for (const id of ['transfer', 'site-meta', 'role-badge', 'me-short', 'name-form', 'name', 'notice', 'notice-form', 'notice-input',
    'post-form', 'msg', 'count', 'post-btn', 'post-note', 'entries', 'entries-empty', 'mod-card', 'role-line', 'role-help',
    'unmoderated-note', 'mod-howto', 'pol-writers', 'pol-fee', 'pol-mods', 'pol-banned', 'clip']) {
    assert.match(index, new RegExp(' id="' + id + '"'), 'index.html is missing #' + id);
  }
  for (const p of LIVE_PAGES) { // R 3.9: every page has the sign-in bar, and the nav leads to the new pages
    const html = read(p);
    for (const [href, label] of [['/', 'Guestbook'], ['/members.html', 'Members'], ['/profile.html', 'Profile'], ['/about.html', 'About']]) {
      assert.match(html, new RegExp('<a href="' + href.replace(/\./g, '\\.') + '"( aria-current="page")?>' + label + '</a>'), p + ': nav link ' + label);
    }
    assert.equal((html.match(/aria-current="page"/g) || []).length, 1, p + ' marks exactly one current page');
    assert.match(html, /<div id="auth-bar" class="wrap auth-bar" hidden>/, p + ': the bar stays hidden until the loader reports that it has sign in');
    assert.match(html, /<p id="auth-state" class="small" aria-live="polite"><\/p>/, p);
    assert.match(html, /<button type="button" id="sign-in" hidden>Sign in<\/button>/, p);
    assert.match(html, /<button type="button" id="sign-out" class="quiet" hidden>Sign out<\/button>/, p);
    for (const id of ['standalone', 'standalone-why', 'toasts']) assert.match(html, new RegExp(' id="' + id + '"'), p + ' is missing #' + id);
    assert.match(html, /<script type="module" src="\/js\/auth\.js"><\/script>/, p);
  }
  assert.match(read('profile.html'), /<script type="module" src="\/js\/profile\.js"><\/script>/);
  assert.match(read('members.html'), /<script type="module" src="\/js\/members\.js"><\/script>/);
  for (const p of ['profile.html', 'members.html']) assert.doesNotMatch(read(p), /\/js\/app\.js/, p + ' has its own script');
  assert.match(index, /<form id="notice-form" hidden>/, 'the notice editor starts hidden');
  assert.match(index, /<p id="unmoderated" class="flags" hidden>/, 'the unmoderated badge starts hidden');
  assert.match(index, /<video id="clip" src="\/media\/clip\.mp4" controls playsinline preload="metadata" width="320" height="180"><\/video>/);
  assert.match(index, /<h1>Peer Guestbook<\/h1>/);
  assert.ok(index.includes('chooses Import moderator key'), 'the moderation card explains how to become a moderator');
  assert.match(about, /<ul data-about="facts">/);
});

test('every URL in the pages is root-relative and names a file of the site', () => {
  const resolveUrl = (u) => (u === '/' ? 'index.html' : u.slice(1));
  let checked = 0;
  for (const r of checkSite(SITE)) {
    assert.ok(r.urls.length >= 4, r.file + ' has too few URLs');
    for (const { attr, value } of r.urls) {
      assert.match(value, /^\/(?!\/)/, r.file + ': ' + attr + '="' + value + '" must be root-relative');
      assert.doesNotMatch(value, RESERVED, r.file + ': ' + value + ' is a reserved loader path');
      assert.ok(existsSync(join(SITE, resolveUrl(value))), r.file + ': ' + value + ' does not exist');
      checked++;
    }
  }
  assert.ok(checked >= 19, 'checked ' + checked + ' URLs');
});

test('404.html is a plain static page: no script, no loader paths, root-relative links', () => {
  const html = read('404.html');
  assert.doesNotMatch(html, /<script/i);
  assert.doesNotMatch(html, /_mw/);
  assert.match(html, /<meta name="robots" content="noindex">/);
  assert.match(html, /<a href="\/">Back to the guestbook<\/a>/);
  assert.match(html, /<a href="\/about\.html">/);
});

test('js/app.js: parses, stays under 400 lines, never injects HTML, keeps to the browser floor', () => {
  const path = join(SITE, 'js/app.js');
  execFileSync(process.execPath, ['--check', path]);
  const js = readFileSync(path, 'utf8');
  const lines = js.split('\n').length;
  assert.ok(lines < 400, 'app.js has ' + lines + ' lines');
  for (const bad of ['innerHTML', 'outerHTML', 'insertAdjacentHTML', 'document.write', 'eval(', 'new Function', 'srcdoc',
    'DOMParser', 'createContextualFragment', 'setHTMLUnsafe', 'localStorage', 'sessionStorage']) {
    assert.ok(!js.includes(bad), 'app.js must not use ' + bad);
  }
  assert.doesNotMatch(js, /setAttribute\(\s*['"]on/i, 'no event handler attributes');
  const floor = ['Promise.withResolvers', 'Object.groupBy', 'Map.groupBy', 'Array.fromAsync', '.union(', '.intersection(', '.difference(',
    '.symmetricDifference(', '.isSubsetOf(', '.isSupersetOf(', '.isDisjointFrom(', 'URL.parse(', 'AbortSignal.any(', 'structuredClone(',
    'Iterator.from', '.toArray()', '.toSorted(', '.toReversed(', '.toSpliced(', '.isWellFormed(', 'import.meta.resolve'];
  for (const api of floor) assert.ok(!js.includes(api), 'app.js uses post-floor API ' + api);
  assert.doesNotMatch(js, /\/[dgimsuy]*v[dgimsuy]*[\s,;.)]/, 'no regex v flag');
  assert.doesNotMatch(js, /^await\s/m, 'no top-level await');
  assert.doesNotMatch(js, /^import\s/m, 'no static imports: the SDK is imported dynamically');
});

test('js/app.js uses the section 9 SDK contract and only site or SDK URLs', () => {
  const js = read('js/app.js');
  const imports = [...js.matchAll(/import\(\s*'([^']+)'\s*\)/g)].map((m) => m[1]);
  assert.deepEqual(imports, ['/_mw/sdk.js']);
  assert.deepEqual([...js.matchAll(/fetch\(\s*'([^']+)'/g)].map((m) => m[1]), ['/data/about.json']);
  assert.doesNotMatch(js, /https?:\/\//, 'no absolute URLs');
  for (const need of ["mw.ready()", 'info.role', 'info.unmoderated', 'mw.db.subscribe(', 's.inSync', "NOTICE_KEY = '_notice'",
    'ctx.mw.db.set(NOTICE_KEY', 'ctx.mw.db.del(NOTICE_KEY', "mw.db.get(NOTICE_KEY)", "mw.db.list('guestbook'", "ctx.mw.db.append('guestbook', { msg })",
    'mw.db.tombstone(it.h)', 'mw.mod.ban(it.author)', 'c.state()', 'ctx.mw.identity.setName(', 'mw.site.info()',
    "listen(mw, 'peers'", "listen(mw, 'sync'", "listen(mw, 'status'", "listen(mw, 'progress'", 'snap.profiles', 'snap.policy',
    "'Ledger: '", "', in sync with '", "'entry', 'entries'", 'E_NO_HOST', 'E_NOT_MODERATOR', 'E_BANNED', 'E_CAP', 'MAX_MSG = 280',
    // v0.3 (R 3.9): a guest signs in inside the click that asked to write, and the page follows mw.auth.onChange
    "ctx.info.auth === 'guest'", 'ctx.onAuth(await ctx.mw.auth.signIn())', 'mw.auth.onChange(ctx.onAuth)', 'GUEST_NOTE', 'ME_COPY']) {
    assert.ok(js.includes(need), 'app.js must contain ' + need);
  }
  // Role gates: the notice editor for owner and moderator only; Remove post and Ban author for moderators.
  assert.match(js, /show\('#notice-form', role === 'owner' \|\| role === 'moderator'\)/);
  assert.match(js, /mod = ctx\.role === 'owner' \|\| ctx\.role === 'moderator'/);
  // Every element id app.js touches exists on one of the two pages.
  const ids = new Set([...read('index.html').matchAll(/ id="([^"]+)"/g), ...read('about.html').matchAll(/ id="([^"]+)"/g)].map((m) => m[1]));
  const used = [...js.matchAll(/'#([a-z][a-z0-9-]*)/g)].map((m) => m[1]);
  assert.ok(used.length > 20);
  for (const id of used) assert.ok(ids.has(id), 'app.js uses #' + id + ' which no page has');
});

test('wording: ASCII only, DESIGN-REVIEW section 4 terms, and the verbatim strings', () => {
  const banned = [/blockchain/i, /serverless/i, /\bno servers?\b/i, /unstoppable/i, /censorship[- ]resistant/i, /fully decentrali[sz]ed/i,
    /sub-second/i, /\bisolat/i, /spam protection/i, /&(mdash|ndash|lsquo|rsquo|ldquo|rdquo|hellip);/];
  for (const f of toolFiles()) {
    const bad = readFileSync(join(HERE, f), 'utf8').search(/[^\x09\x0a\x0d\x20-\x7e]/); // eslint-disable-line no-control-regex
    assert.equal(bad, -1, 'test/example/' + f + ': non-ASCII character at offset ' + bad + ' (no em dashes or curly quotes)');
  }
  for (const f of textFiles()) {
    const text = read(f);
    const bad = text.search(/[^\x09\x0a\x0d\x20-\x7e]/); // eslint-disable-line no-control-regex
    assert.equal(bad, -1, f + ': non-ASCII character at offset ' + bad + ' (no em dashes or curly quotes)');
    if (f.endsWith('.css')) continue; // CSS is not user-facing text
    for (const re of banned) assert.doesNotMatch(text, re, f + ' uses ' + re);
  }
  // User-facing text says "site ledger", never "chain".
  for (const f of ['index.html', 'about.html', 'profile.html', 'members.html', '404.html', 'js/app.js', 'data/about.json', ...V03_JS]) assert.doesNotMatch(read(f), /\bchain\b/i, f);
  const js = read('js/app.js');
  assert.ok(js.includes("mobile: 'Sharing only while this page is open and on screen.'"), 'section 4.3 phone status line');
  assert.ok(js.includes("'Host only: no peer connections. Slower, and shared data won\\'t sync.'"), 'section 4.5 host-only string');
  const about = read('about.html');
  assert.ok(about.includes("Shared data on this site is kept in a signed log. Every visitor keeps a copy and checks every entry, so nobody can forge or quietly rewrite one. There's no mining and no single 'latest' version."));
  assert.ok(about.includes('Phones load the site and sync the ledger while the page is open and on screen.'));
  assert.ok(read('index.html').includes('No backend.'));
});

test('v0.3 scripts: they parse, set text only, import the SDK dynamically from /_mw/sdk.js, and stay inside the browser floor', () => {
  const floor = lintPaths([SITE]);
  assert.deepEqual(floor.findings || floor, [], 'tools/lint-floor.mjs over the site');
  for (const f of V03_JS) {
    execFileSync(process.execPath, ['--check', join(SITE, f)]);
    const js = read(f);
    for (const bad of ['innerHTML', 'outerHTML', 'insertAdjacentHTML', 'document.write', 'eval(', 'new Function', 'srcdoc', 'DOMParser', 'createContextualFragment',
      'setHTMLUnsafe', 'localStorage', 'sessionStorage', 'indexedDB', 'createObjectURL', 'postMessage', 'document.cookie']) assert.ok(!js.includes(bad), f + ' must not use ' + bad);
    assert.doesNotMatch(js, /setAttribute\(\s*['"]on/i, f + ': no event handler attributes');
    assert.doesNotMatch(js, /https?:\/\//, f + ': no absolute URLs');
    assert.doesNotMatch(js, /^await\s/m, f + ': no top-level await');
    assert.ok(js.split('\n').length < 200, f + ' stays small');
    // The only static import is the shared helpers, by root path; the SDK is imported dynamically, in one place.
    const statics = [...js.matchAll(/^import\s[^'"]*from\s+'([^']+)'/gm)].map((m) => m[1]);
    assert.ok(statics.every((u) => u === '/js/common.js'), f + ' imports ' + statics.join(', '));
    for (const u of statics) assert.ok(existsSync(join(SITE, u.slice(1))), f + ' imports a missing file ' + u);
  }
  assert.deepEqual([...read('js/common.js').matchAll(/import\(\s*'([^']+)'\s*\)/g)].map((m) => m[1]), ['/_mw/sdk.js']);
  for (const f of ['js/auth.js', 'js/profile.js', 'js/members.js']) assert.doesNotMatch(read(f), /import\(/, f + ' gets the SDK through common.js');
  assert.ok(!/fetch\(/.test(V03_JS.map(read).join('\n').replace(/mw\.files\.fetch\(/g, '')), 'no fetch() in the v0.3 scripts: they talk to the SDK only');
  // Every element id a script touches exists on the page it belongs to.
  const idsOf = (page) => new Set([...read(page).matchAll(/ id="([^"]+)"/g)].map((m) => m[1]));
  const usedBy = (f) => [...read(f).matchAll(/'#([a-z][a-z0-9-]*)/g)].map((m) => m[1]);
  for (const [file, pages] of [['js/auth.js', LIVE_PAGES], ['js/profile.js', ['profile.html']], ['js/members.js', ['members.html']]]) {
    const used = usedBy(file);
    assert.ok(used.length >= 4, file + ' uses ids');
    for (const page of pages) for (const id of used) assert.ok(idsOf(page).has(id), file + ' uses #' + id + ' which ' + page + ' does not have');
  }
  // What each script calls on the SDK (R 2.11.2).
  const calls = {
    'js/auth.js': ['mw.auth.signIn()', 'mw.auth.signOut()', 'mw.auth.onChange('],
    'js/profile.js': ['mw.me.get()', "mw.me.set('display'", "mw.me.set('links'", 'mw.me.del(', 'mw.me.sync({ on:', 'mw.me.erase()', 'mw.identity.openIdentity()', 'mw.identity.backupStatus()',
      'mw.auth.signOut({ forget: true })', 'mw.auth.onChange('],
    'js/members.js': ['mw.chat.state()', 'mw.chat.enable()', 'mw.chat.room.join(', 'mw.chat.room.send(', "mw.chat.on('room'", 'mw.files.list()', 'mw.files.fetch(', 'mw.files.preview(', 'mw.files.save(',
      'mw.files.share(file, { public: true })', 'mw.files.remove(', 'info.features', 'ctx.features.chat', 'ctx.features.files'],
  };
  for (const [file, needles] of Object.entries(calls)) for (const needle of needles) assert.ok(read(file).includes(needle), file + ' must contain ' + needle);
  // Order matters for a file: fetch before preview or save (the loader answers preview and save only for a fetched file; R 2.8.4).
  const members = read('js/members.js');
  assert.ok(members.indexOf('mw.files.fetch(') < members.indexOf('mw.files.preview('), 'Fetch comes before Show');
});

test('R 3.9 and the card copy: the sentences the pages show are the loader\'s (src/loader/strings.js)', () => {
  const { CARD_TEXT, REPLACED_SENTENCES, UI_TEXT, ERROR_TEXT } = loaderStrings;
  const en = { card: CARD_TEXT.en, replaced: REPLACED_SENTENCES.en, ui: UI_TEXT.en };
  const inPage = (page, sentence, label) => assert.ok(read(page).includes(sentence), page + ' must say (' + label + '): ' + sentence);
  // profile.html
  assert.ok(read('profile.html').includes('<p id="rec-privacy"><strong>Encrypted. The site can read it while you are signed in.</strong></p>'));
  inPage('profile.html', en.replaced.profileSealed, 'profileSealed');
  inPage('profile.html', en.replaced.recordReaders, 'recordReaders');
  inPage('profile.html', en.card.syncRecord, 'syncRecord');
  inPage('profile.html', en.card.neverWords, 'neverWords');
  inPage('profile.html', en.card.recoveryKitIos, 'recoveryKitIos');
  inPage('profile.html', en.card.scriptsNote, 'scriptsNote');
  inPage('profile.html', en.ui.removeFromDeviceText, 'removeFromDeviceText');
  inPage('profile.html', en.card.signIn.slice(en.card.signIn.indexOf('This site gets a key')), 'signIn, after the origin');
  assert.ok(read('profile.html').includes('>' + en.ui.removeFromDevice + '</button>'), 'the Remove from this device button');
  assert.ok(read('profile.html').includes('>' + en.ui.signOut + '</button>'));
  // about.html
  inPage('about.html', en.card.signIn.slice(en.card.signIn.indexOf('This site gets a key')), 'signIn, after the origin');
  inPage('about.html', en.replaced.signInNoCompany, 'signInNoCompany');
  // members.html
  inPage('members.html', en.card.rooms, 'rooms');
  inPage('members.html', en.card.fetchPublic, 'fetchPublic');
  assert.ok(read('members.html').includes('>' + en.ui.chatTurnOn + '</button>'), 'Turn on chat');
  assert.ok(read('members.html').includes('<h3>' + en.ui.chatLobby + '</h3>'));
  assert.ok(read('members.html').includes('<label for="lobby-msg">' + en.ui.chatMessage + '</label>'));
  assert.ok(read('members.html').includes('>' + en.ui.chatSend + '</button>'));
  assert.ok(read('members.html').includes('<p id="lobby-empty" class="muted">' + en.ui.chatNoMessages + '</p>'));
  // the scripts: error sentences are the SDK's, word for word, and the one sentence the page adds is its own
  const common = read('js/common.js');
  const table = common.slice(common.indexOf('export const ERRORS = {'), common.indexOf('export function explain'));
  const codes = [...table.matchAll(/(E_[A-Z_]+): '((?:[^'\\]|\\.)*)'/g)].map((m) => [m[1], m[2].replace(/\\'/g, "'")]);
  assert.ok(codes.length >= 20, 'the table has ' + codes.length + ' codes');
  for (const [code, text] of codes) {
    if (code === 'E_NO_HOST') continue; // this page's own words for a page that is not inside the loader
    assert.equal(text, ERROR_TEXT.en[code] || ERROR_TEXT.en[sdkApi.ERROR_STRING_KEYS[code]], code); // a code without its own sentence uses the one the SDK names
  }
  for (const code of ['E_NOT_SIGNED_IN', 'E_USER_CANCELLED', 'E_POPUP_BLOCKED', 'E_NEEDS_GESTURE', 'E_HOST_ONLY', 'E_NO_OWN_TRACKER', 'E_FILE_UNAVAILABLE', 'E_POLICY', 'E_LIMIT']) {
    assert.ok(codes.some(([c]) => c === code), code + ' has a sentence');
  }
  // app.js keeps its own table (it has no imports): the sign-in codes in it are the SDK's words too.
  const appJs = read('js/app.js');
  for (const code of ['E_NOT_SIGNED_IN', 'E_USER_CANCELLED', 'E_POPUP_BLOCKED', 'E_IDP_UNREACHABLE', 'E_UNSUPPORTED', 'E_HOST_ONLY_IDENTITY']) {
    const m = new RegExp(code + ": '((?:[^'\\\\]|\\\\.)*)'").exec(appJs);
    assert.ok(m, 'app.js has a sentence for ' + code);
    assert.equal(m[1].replace(/\\'/g, "'"), ERROR_TEXT.en[code], code);
  }
  // The two sentences R 2.5.4 gives for a record that cannot sync, and the guestbook's own guest line.
  assert.ok(read('js/profile.js').includes('This site does not let visitors write to its ledger, so your record stays on this device.'));
  assert.ok(read('js/profile.js').includes('The owner has not turned on synced records, so your record stays on this device.'));
  assert.ok(read('js/members.js').includes('Messages are off on this site. The owner has not turned them on.'));
  assert.ok(read('js/members.js').includes('File listings are off on this site. The owner has not turned them on.'));
});

test('E-ID-10 for the guestbook: no field takes a recovery phrase, a password or a backup file; the identity page does that', () => {
  for (const page of PAGES) {
    const html = read(page);
    for (const m of html.matchAll(/<input\b[^>]*>/g)) {
      const tag = m[0];
      const type = (/\btype="([^"]+)"/.exec(tag) || [, 'text'])[1];
      assert.ok(['text', 'url', 'file', 'checkbox'].includes(type), page + ': input type ' + type);
      assert.doesNotMatch(tag, /(?:phrase|words|passphrase|password|backup|recovery|seed|mnemonic)/i, page + ': ' + tag);
      assert.doesNotMatch(tag, /autocomplete="(?:current|new)-password"/, page);
    }
    for (const m of html.matchAll(/<textarea\b[^>]*>/g)) assert.doesNotMatch(m[0], /(?:phrase|words|passphrase|password|backup|recovery|seed|mnemonic)/i, page);
    assert.doesNotMatch(html, /(?:enter|type|paste) your (?:12 )?(?:words|recovery phrase|passphrase)/i, page);
  }
  for (const f of V03_JS) assert.doesNotMatch(read(f), /(?:enter|type|paste) your (?:12 )?(?:words|recovery phrase|passphrase)/i, f);
  // The recovery kit and device links only open the identity page; nothing else in the page handles a key or a phrase.
  const profile = read('js/profile.js');
  assert.equal([...profile.matchAll(/await mw\.identity\.openIdentity\(\)/g)].length, 1, 'one call site, shared by both buttons');
  for (const bad of ['identity.export', 'identity.import', 'keys.export', 'identity.root', 'consent.accept', 'link.accept', 'media.key', 'extractable']) {
    for (const f of [...V03_JS, 'js/app.js']) assert.ok(!read(f).includes(bad), f + ' must not use ' + bad + ' (A4 rule, R 2.11.1)');
  }
});

test('css/app.css: balanced, dark mode, no external resources, within the browser floor', () => {
  const css = read('css/app.css');
  const body = css.replace(/\/\*[\s\S]*?\*\//g, '');
  assert.equal((body.match(/{/g) || []).length, (body.match(/}/g) || []).length);
  assert.match(css, /@media \(prefers-color-scheme: dark\)/);
  assert.match(css, /\[hidden\] \{ display: none !important; \}/);
  assert.match(css, /@media \(pointer: coarse\)/);
  assert.match(css, /system-ui/);
  assert.doesNotMatch(body, /url\(|@import|@font-face/);
  for (const late of [':has(', '@container', 'color-mix(', '@scope', 'text-wrap']) assert.ok(!body.includes(late), 'post-floor CSS ' + late);
  for (const need of ['.auth-bar', '.site-nav { display: flex; flex-wrap: wrap;', 'button.quiet', '.stack', 'label.check', '.preview img']) assert.ok(css.includes(need), 'the stylesheet needs ' + need);
  assert.doesNotMatch(body, /&[\s.:#[a-z]/, 'no CSS nesting');
});

test('img/peer.png is a valid 64x64 8-bit RGBA PNG with correct CRCs', () => {
  const buf = readFileSync(join(SITE, 'img/peer.png'));
  assert.deepEqual([...buf.subarray(0, 8)], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const table = new Int32Array(256).map((_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c; });
  const crc32 = (b) => { let c = -1; for (const x of b) c = table[(c ^ x) & 0xff] ^ (c >>> 8); return (c ^ -1) >>> 0; };
  let off = 8, idat = Buffer.alloc(0), ihdr;
  const types = [];
  while (off < buf.length) {
    const len = buf.readUInt32BE(off), type = buf.toString('latin1', off + 4, off + 8), data = buf.subarray(off + 8, off + 8 + len);
    assert.equal(buf.readUInt32BE(off + 8 + len), crc32(buf.subarray(off + 4, off + 8 + len)), 'CRC of ' + type);
    types.push(type);
    if (type === 'IHDR') ihdr = data;
    if (type === 'IDAT') idat = Buffer.concat([idat, data]);
    off += 12 + len;
  }
  assert.equal(types[0], 'IHDR');
  assert.equal(types[types.length - 1], 'IEND');
  assert.deepEqual([ihdr.readUInt32BE(0), ihdr.readUInt32BE(4), ihdr[8], ihdr[9], ihdr[12]], [64, 64, 8, 6, 0]);
  assert.equal(inflateSync(idat).length, 64 * (1 + 64 * 4));
});

// ISO BMFF box walker: [{ type, start, size, body }] for one level.
function boxes(buf, start, end) {
  const out = [];
  for (let off = start; off + 8 <= end;) {
    let size = buf.readUInt32BE(off), hdr = 8;
    if (size === 1) { size = Number(buf.readBigUInt64BE(off + 8)); hdr = 16; }
    if (size === 0) size = end - off;
    assert.ok(size >= hdr && off + size <= end, 'box size out of range at ' + off);
    out.push({ type: buf.toString('latin1', off + 4, off + 8), start: off, size, body: buf.subarray(off + hdr, off + size) });
    off += size;
  }
  return out;
}
const child = (list, type) => { const b = list.find((x) => x.type === type); assert.ok(b, 'missing ' + type + ' box'); return b; };
const kids = (box) => boxes(box.body, 0, box.body.length);

test('media/clip.mp4 is a short faststart H.264 MP4 (Range and seeking test clip)', (t) => {
  const buf = readFileSync(join(SITE, 'media/clip.mp4'));
  assert.ok(buf.length > 4096 && buf.length < 65536, 'size ' + buf.length);
  assert.equal(createHash('sha256').update(buf).digest('hex'), CLIP_SHA256, 'clip changed: re-run test/example/make-media.mjs and update CLIP_SHA256');
  const top = boxes(buf, 0, buf.length);
  assert.equal(top[0].type, 'ftyp');
  assert.equal(top[0].body.toString('latin1', 0, 4), 'isom');
  assert.ok(top.findIndex((b) => b.type === 'moov') < top.findIndex((b) => b.type === 'mdat'), 'moov must come before mdat (faststart)');
  const moov = kids(child(top, 'moov'));
  const mvhd = child(moov, 'mvhd').body;
  const seconds = mvhd.readUInt32BE(16) / mvhd.readUInt32BE(12); // version 0: timescale at 12, duration at 16
  assert.ok(Math.abs(seconds - 4) < 0.05, 'duration ' + seconds);
  const traks = moov.filter((b) => b.type === 'trak');
  assert.equal(traks.length, 1, 'one video track, no audio');
  const trak = kids(traks[0]);
  const tkhd = child(trak, 'tkhd').body;
  assert.deepEqual([tkhd.readUInt32BE(76) >>> 16, tkhd.readUInt32BE(80) >>> 16], [320, 180]);
  const mdia = kids(child(trak, 'mdia'));
  assert.equal(child(mdia, 'hdlr').body.toString('latin1', 8, 12), 'vide');
  const stbl = kids(child(kids(child(mdia, 'minf')), 'stbl'));
  const stsd = child(stbl, 'stsd').body;
  const entry = boxes(stsd, 8, stsd.length)[0];
  assert.equal(entry.type, 'avc1');
  const avcC = child(boxes(entry.body, 78, entry.body.length), 'avcC').body;
  assert.deepEqual([avcC[1], avcC[3]], [66, 30], 'Baseline profile, level 3.0');
  assert.equal(child(stbl, 'stss').body.readUInt32BE(4), 4, 'a keyframe every second');
  assert.equal(child(stbl, 'stsz').body.readUInt32BE(8), 48, '48 frames');
  const probe = spawnSync('ffprobe', ['-v', 'error', '-count_frames', '-show_entries', 'stream=codec_name,profile,width,height,nb_read_frames', '-of', 'json', join(SITE, 'media/clip.mp4')], { encoding: 'utf8' });
  if (probe.error) { t.diagnostic('ffprobe not installed: decode check skipped'); return; }
  const s = JSON.parse(probe.stdout).streams[0];
  assert.deepEqual([s.codec_name, s.profile, s.width, s.height, s.nb_read_frames], ['h264', 'Constrained Baseline', 320, 180, '48']);
});

test('data/about.json carries the fields the pages read', () => {
  const about = JSON.parse(read('data/about.json'));
  assert.equal(about.name, 'Peer Guestbook');
  for (const k of ['version', 'description', 'built']) assert.equal(typeof about[k], 'string', k);
  assert.ok(Array.isArray(about.facts) && about.facts.length === 5);
  for (const page of ['index.html', 'about.html']) {
    for (const key of [...read(page).matchAll(/data-about="([^"]+)"/g)].map((m) => m[1])) assert.ok(key in about, page + ' reads about.' + key);
  }
  assert.deepEqual(about.pages, ['/', '/members.html', '/profile.html', '/about.html', '/404.html']);
  assert.equal(about.version, '3.0.0');
});

test('README.md: the publish note and the documented behaviour', () => {
  const md = read('README.md');
  assert.ok(md.includes('node tools/publish.mjs examples/peer-guestbook --name peer-guestbook --scope <host> --key owner.jwk --policy open --bits 16 ...'));
  for (const need of ['_notice', 'unmoderated', 'inSync', 'Sharing only while this page is open and on screen.', 'E_NO_HOST', '--moderator',
    'Import moderator key', 'media/clip.mp4', 'Range', 'test/example/check-html.mjs', 'npm run test:example',
    // v0.3 (R 3.9)
    'Sign in', 'Sign out', 'profile.html', 'members.html', 'mw.auth.signIn()', 'mw.identity.openIdentity()', 'mw.identity.backupStatus()', 'mw.me.sync({ on: true })',
    'Encrypted. The site can read it while you are signed in.', 'ready().features', '_mw.cfg.chat', '_mw.cfg.files', '_mw.cfg.records', '--chat --files', '--tracker', '--stun',
    'ledger-admin cfg', 'E_NO_OWN_TRACKER', 'browser-v03.test.mjs', 'guest']) {
    assert.ok(md.includes(need), 'README.md must mention ' + need);
  }
});

test('UX-15: every SDK error code has a guestbook sentence, and an unknown code never shows the SDK\'s internal message', async () => {
  const { ERRORS, explain } = await import(pathToFileURL(join(SITE, 'js/common.js')).href);
  const appJs = read('js/app.js');
  const appTable = appJs.slice(appJs.indexOf('const ERRORS = {'), appJs.indexOf('const HOW = {'));
  const appCodes = new Map([...appTable.matchAll(/(E_[A-Z_]+): '((?:[^'\\]|\\.)*)'/g)].map((m) => [m[1], m[2].replace(/\\'/g, "'")]));
  // The guestbook's own older wording (v0.2.1, kept): every other code in app.js is the SDK's sentence word for word.
  const OWN = new Set(['E_RATE', 'E_POLICY', 'E_LIMIT', 'E_NOT_MODERATOR', 'E_NOT_OWNER', 'E_POW_ABORTED', 'E_IDENTITY', 'E_NO_HOST', 'E_BANNED', 'E_CAP']);
  for (const code of sdkApi.ERROR_CODES) {
    const sdkText = loaderStrings.ERROR_TEXT.en[code] || loaderStrings.ERROR_TEXT.en[sdkApi.ERROR_STRING_KEYS[code]];
    assert.ok(sdkText, code + ' has an SDK sentence');
    assert.ok(Object.prototype.hasOwnProperty.call(ERRORS, code), 'js/common.js has a sentence for ' + code);
    assert.ok(appCodes.has(code), 'js/app.js has a sentence for ' + code);
    if (!OWN.has(code)) assert.equal(appCodes.get(code), sdkText, 'js/app.js: ' + code);
    assert.doesNotMatch(explain({ code, message: 'internal: ' + code }), /internal|\{name\}/, code);
  }
  assert.equal(explain({ code: 'E_SYNCING', message: 'still syncing (height 3 of 9)' }), 'Still catching up with the site. Try again in a moment.');
  assert.equal(explain({ code: 'E_POLICY', message: 'join the room first' }), 'This site does not allow that.');
  assert.equal(explain({ code: 'E_BLOCKED' }), 'You cannot send to this person.');
  assert.equal(explain({ code: 'E_NO_CHAT_KEY' }), 'This person has not turned on messages on this site.');
  assert.equal(explain({ code: 'E_NEW_IN_A_LATER_SDK', message: 'QuotaExceededError: the quota has been exceeded' }), 'Something went wrong (E_NEW_IN_A_LATER_SDK).');
  assert.equal(explain(new TypeError('x is undefined')), 'Something went wrong.', 'a page bug is not shown to the visitor as developer text');
  // app.js uses the same rule (it has no imports, so its explain is a copy)
  assert.ok(appJs.includes(": code ? 'Something went wrong (' + code + ').' : 'Something went wrong.';"), 'app.js: generic line with the code');
  assert.ok(!/explain = \(err\) => [^\n]*err\.message/.test(appJs), 'app.js: no err.message fallback');
});

test('UX-16 (MF-70): guestbook entries and Lobby lines put the short id beside every self-chosen name', () => {
  // The rendered text is checked in browser.test.mjs (entries) and browser-v03.test.mjs (Lobby); this pins the rule in the sources.
  assert.ok(read('js/app.js').includes("name + ' (' + short + ')'"), 'js/app.js setupBook: "name (short id)"');
  assert.ok(read('js/members.js').includes("name + ' (' + short + ')'"), 'js/members.js who(): "name (short id)"');
});
