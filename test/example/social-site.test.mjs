// Static checks for examples/social/ (V03-DESIGN-REVIEW Part 3, 4.2 E-ID-10 and E-SO-12 in part, DESIGN-REVIEW section 4): the file set, the HTML
// checker, every route has a screen or a state, every error code the page can show has a sentence, no banned word, no address that
// leaves the machine, no field that could take a recovery phrase or a backup file, alt text is enforced, nothing past the browser floor,
// nothing that parses HTML. Run: node --test test/example/social-site.test.mjs   (MW_SOCIAL_DIR overrides the site directory)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync, statSync, readdirSync } from 'node:fs';
import { resolve, dirname, join, relative } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';

const HERE = dirname(fileURLToPath(import.meta.url));
const SITE = process.env.MW_SOCIAL_DIR ? resolve(process.env.MW_SOCIAL_DIR) : resolve(HERE, '../../examples/social');
const { checkSite, checkHtml } = await import(pathToFileURL(join(HERE, 'check-html.mjs')).href);
const { lintPaths } = await import(pathToFileURL(resolve(HERE, '../../tools/lint-floor.mjs')).href);
const read = (p) => readFileSync(join(SITE, p), 'utf8');
const RESERVED = /^\/(_mw\/|mw-sw\.js|ws\/|\.mw\/)/;

function files(dir = SITE) {
  const out = [];
  for (const name of readdirSync(dir).sort()) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) out.push(...files(full)); else out.push(relative(SITE, full).split('\\').join('/'));
  }
  return out;
}
const ALL = files();
const SITE_FILES = [
  '404.html', 'config.json', 'css/app.css', 'img/social.svg', 'index.html',
  'js/app.js', 'js/chat.js', 'js/config.js', 'js/data.js', 'js/directory.js', 'js/dom.js', 'js/hub.js', 'js/ids.js', 'js/inbox.js', 'js/media-prep.js', 'js/model.js', 'js/notices.js',
  'js/qr.js', 'js/router.js', 'js/search.js', 'js/store.js', 'js/strings.js',
  'js/views/about.js', 'js/views/common.js', 'js/views/composer.js', 'js/views/group.js', 'js/views/invite.js', 'js/views/media.js', 'js/views/messages.js', 'js/views/notfound.js',
  'js/views/notifications.js', 'js/views/post-card.js', 'js/views/post.js', 'js/views/profile.js', 'js/views/settings.js', 'js/views/side.js', 'js/views/standalone.js', 'js/views/timeline.js',
];
const JS = ALL.filter((f) => f.endsWith('.js'));
const TEXT = ALL.filter((f) => /\.(html|css|js|json|svg|md)$/.test(f));
const SHIPPED_TEXT = TEXT.filter((f) => f !== 'README.md');

test('the published file set is exactly the template, with no dot-directory and nothing at a reserved loader path', () => {
  assert.deepEqual(ALL.filter((f) => f !== 'README.md'), SITE_FILES);
  assert.ok(existsSync(join(SITE, 'README.md')));
  for (const f of ALL) {
    assert.ok(statSync(join(SITE, f)).size > 0, f + ' is empty');
    assert.ok(!f.split('/').some((seg) => seg.startsWith('.')), f + ' is a dot-path (the repository layout test forbids them under examples/)');
  }
  for (const reserved of ['_mw', 'mw-sw.js', 'ws', '.mw']) assert.ok(!existsSync(join(SITE, reserved)), reserved + ' must not exist in the site');
});

test('every page passes the HTML checker, with no inline script, style or event handler', (t) => {
  const reports = checkSite(SITE);
  assert.deepEqual(reports.map((r) => r.file), ['404.html', 'index.html']);
  for (const r of reports) {
    t.diagnostic(r.file + ': elements=' + r.counts.elements + ' ids=' + r.counts.ids + ' urls=' + r.urls.length + ' errors=' + r.errors.length);
    assert.deepEqual(r.errors, [], r.file);
    assert.equal(r.counts.inlineScripts, 0, r.file);
    assert.equal(r.counts.inlineStyles, 0, r.file);
  }
  // The checker's own negative cases are in site.test.mjs; here: the app shell keeps what the code relies on.
  const index = read('index.html');
  for (const id of ['view', 'view-title', 'main', 'sync-line', 'theme-toggle', 'sign-in', 'identity-chip', 'main-nav', 'alerts-count', 'side', 'live-polite', 'live-assertive', 'toasts', 'standalone', 'standalone-why', 'brand-name', 'tpl-about']) {
    assert.match(index, new RegExp(' id="' + id + '"'), 'index.html is missing #' + id);
  }
  assert.match(index, /<script type="module" src="\/js\/app\.js"><\/script>/);
  assert.match(index, /<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">/);
  assert.match(index, /<meta name="color-scheme" content="light dark">/);
  assert.match(index, /<a class="skip" href="#main">Skip to content<\/a>/);
  assert.match(index, /<p id="sync-line" class="sync" role="status" aria-live="polite">/);
  assert.match(index, /<div id="live-polite" class="sr-only" aria-live="polite" aria-atomic="true"><\/div>/);
  assert.match(index, /<div id="live-assertive" class="sr-only" role="alert" aria-live="assertive" aria-atomic="true"><\/div>/);
  assert.match(index, /<noscript>\s*<div class="notice" role="note">\s*<strong>This site loads from other visitors' browsers and needs JavaScript\.<\/strong>/, 'the noscript notice of R 3.7');
  for (const nav of ['home', 'messages', 'notifications', 'media', 'settings', 'about']) assert.match(index, new RegExp('data-nav="' + nav + '"'));
  assert.ok(checkHtml('<html lang="en"><head><meta charset="utf-8"></head><body><template><tr></tr></template></body></html>').errors.length > 0, 'the checker is not vacuous');
});

test('every URL in the pages is root-relative or a fragment and names a file of the site; nothing uses a reserved loader path', () => {
  let checked = 0;
  for (const r of checkSite(SITE)) {
    for (const { attr, value } of r.urls) {
      if (value.startsWith('#')) continue; // the skip link
      assert.match(value, /^\/(?!\/)/, r.file + ': ' + attr + '="' + value + '" must be root-relative');
      assert.doesNotMatch(value, RESERVED, r.file + ': ' + value + ' is a reserved loader path');
      const path = value === '/' ? 'index.html' : value.slice(1);
      // The nav links are routes the loader answers with the app, not files; everything else is a file.
      const route = /^\/(messages|notifications|media|settings|about)?$/.test(value);
      assert.ok(route || existsSync(join(SITE, path)), r.file + ': ' + value + ' does not exist');
      checked++;
    }
  }
  assert.ok(checked >= 12, 'checked ' + checked + ' URLs');
});

test('R 3.7: every route has a screen or a state, and every settings section has a builder and a title', async () => {
  const router = await import(pathToFileURL(join(SITE, 'js/router.js')).href);
  const config = await import(pathToFileURL(join(SITE, 'js/config.js')).href);
  const app = read('js/app.js');
  const mapped = Object.fromEntries([...app.matchAll(/^\s+(\w+): \(\) => import\('\.\/views\/([\w-]+)\.js'\),$/gm)].map((m) => [m[1], m[2]]));
  const routes = router.ROUTE_NAMES;
  assert.deepEqual(routes.slice().sort(), ['about', 'group', 'home', 'media', 'messages', 'notfound', 'notifications', 'post', 'profile', 'settings', 'thread'], 'the ten routes of R 3.7 and the not-found state');
  for (const name of routes) {
    assert.ok(mapped[name], 'app.js maps no screen for the route ' + name);
    const file = 'js/views/' + mapped[name] + '.js';
    assert.ok(existsSync(join(SITE, file)), file);
    assert.match(read(file), /export (async )?function mount\(/, file + ' exports mount');
  }
  assert.match(read('js/views/notfound.js'), /STATE\.unknownRoute/);
  assert.match(read('js/views/standalone.js'), /STATE\.standalone/);
  assert.match(app, /import\('\.\/views\/standalone\.js'\)/);
  for (const [path, name] of [['/', 'home'], ['/@' + 'a'.repeat(32), 'profile'], ['/@' + 'a'.repeat(32) + '/p/' + 'b'.repeat(64), 'post'], ['/g/' + 'a'.repeat(32), 'group'], ['/messages', 'messages'], ['/messages/0123abcd', 'thread'],
    ['/notifications', 'notifications'], ['/media/x1', 'media'], ['/settings/privacy', 'settings'], ['/about', 'about']]) assert.equal(router.parseRoute(path).name, name, path);
  const settings = read('js/views/settings.js');
  for (const section of config.SETTINGS_SECTIONS) {
    assert.match(settings, new RegExp("[ {]" + section + ": \\['"), 'TITLES has ' + section);
    assert.match(settings, new RegExp('\\b' + section + ': \\w+Section\\b'), 'BUILD has ' + section);
  }
  // R 3.7 settings: identity, privacy defaults, notifications, storage, chat, media sharing, data export, delete account, "What others can see".
  for (const section of ['identity', 'privacy', 'notifications', 'storage', 'chat', 'media', 'export', 'delete', 'visibility']) assert.ok(config.SETTINGS_SECTIONS.includes(section), section);
});

test('every error code the page can show has a sentence, in the SDK\'s words', async () => {
  const strings = await import(pathToFileURL(join(SITE, 'js/strings.js')).href);
  const sdk = await import(pathToFileURL(resolve(HERE, '../../src/loader/strings.js')).href);
  const used = new Set();
  for (const f of JS) {
    if (f === 'js/strings.js') continue;
    for (const m of read(f).matchAll(/['"]((?:E_[A-Z_]+)|EMPTY|ALT_REQUIRED|MENTIONS|LINK_HTTPS|HANDLE|NOT_AVAILABLE|NO_HOME)['"]/g)) used.add(m[1]);
  }
  assert.ok(used.size >= 12, 'found only ' + used.size + ' codes in use: ' + Array.from(used).join(' '));
  const missing = Array.from(used).filter((c) => !strings.ERROR_TEXT[c]);
  assert.deepEqual(missing, [], 'codes used with no sentence');
  // Every code R 2.11.2 adds, and the shared ones, has its sentence here as well, word for word.
  for (const code of sdk.V03_ERROR_CODES.concat(sdk.V03_SHARED_CODES)) assert.equal(strings.ERROR_TEXT[code], sdk.ERROR_TEXT.en[code], code);
  for (const code of ['E_POLICY', 'E_LIMIT', 'E_RATE', 'E_NOT_SIGNED_IN', 'E_USER_CANCELLED', 'E_POPUP_BLOCKED', 'E_FILE_UNAVAILABLE', 'E_REVOKED', 'E_MEDIA_TYPE', 'E_MEDIA_STRIP', 'E_HOST_ONLY', 'E_NO_CHAT_KEY']) assert.ok(used.has(code) || strings.ERROR_TEXT[code], code);
  // Errors reach the person through errorMessage or fieldError; nothing prints err.message or a raw code.
  for (const f of JS) {
    const src = read(f);
    assert.doesNotMatch(src, /textContent\s*=\s*(?:err|e|error)\.(?:message|code)\b/, f + ' shows a raw error');
    assert.doesNotMatch(src, /toast\((?:err|e)\.(?:message|code)/, f + ' toasts a raw error');
  }
});

test('wording: ASCII only, none of the banned words, "Connected to you now" never "online" for presence, the old sentences gone', () => {
  const banned = [/blockchain/i, /serverless/i, /\bno servers?\b/i, /unstoppable/i, /censorship[- ]resistant/i, /fully decentrali[sz]ed/i, /sub-second/i, /production[- ]ready/i, /spam protection/i, /&(mdash|ndash|lsquo|rsquo|ldquo|rdquo|hellip);/];
  const onlineOk = ['Available only while someone who has it is online', 'Nobody who has this file is online right now.', 'nobody who has it is online'];
  for (const f of TEXT) {
    const text = read(f);
    const bad = text.search(/[^\x09\x0a\x0d\x20-\x7e]/); // eslint-disable-line no-control-regex
    assert.equal(bad, -1, f + ': non-ASCII character at offset ' + bad + ' (no em dashes, no curly quotes)');
    if (f.endsWith('.css')) continue;
    for (const re of banned) assert.doesNotMatch(text, re, f + ' uses ' + re);
    if (f.endsWith('.svg') || f.endsWith('.json')) continue;
    let rest = text;
    for (const ok of onlineOk) rest = rest.split(ok).join('');
    if (f.endsWith('.js')) rest = rest.replace(/'(?:online|offline)'|\.onLine\b/g, ''); // the browser's own event names and flag, not words the page shows
    assert.doesNotMatch(rest, /\bonline\b/i, f + ' says "online": use "Connected to you now" for presence');
  }
  const strings = read('js/strings.js');
  assert.ok(strings.includes("CONNECTED = 'Connected to you now'"));
  // The user-facing text says "site ledger", not "chain" (README may name the loader's own terms).
  for (const f of ['index.html', '404.html', 'js/strings.js']) assert.doesNotMatch(read(f), /\bchain\b/i, f);
  // Voice: no em or en dash, straight quotes, in every file including the README.
  for (const f of TEXT) assert.doesNotMatch(read(f), /[\u2013\u2014\u2018\u2019\u201c\u201d]/, f);
});

test('no address leaves the machine: no absolute URL, no protocol-relative URL, no external font, image or script', () => {
  const allowed = new Set(['http://www.w3.org/2000/svg']);
  for (const f of SHIPPED_TEXT) {
    const text = read(f);
    for (const m of text.matchAll(/https?:\/\/[^\s"'`)<>]*/g)) assert.ok(allowed.has(m[0]), f + ' contains the address ' + m[0]);
    assert.doesNotMatch(text, /(?:src|href)=["']\/\//, f + ' has a protocol-relative URL');
    if (f.endsWith('.css')) assert.doesNotMatch(text.replace(/\/\*[\s\S]*?\*\//g, ''), /url\(|@import|@font-face/, f);
  }
  assert.ok(read('js/dom.js').includes("'http://www.w3.org/2000/svg'"), 'the one namespace string is where it is expected');
  const sdkImports = JS.flatMap((f) => [...read(f).matchAll(/import\(\s*'(\/[^']+)'\s*\)/g)].map((m) => f + ' ' + m[1]));
  assert.deepEqual(sdkImports, ['js/app.js /_mw/sdk.js'], 'the SDK is imported once, dynamically, by root path');
  const fetches = JS.flatMap((f) => [...read(f).matchAll(/fetch\(\s*([^,)]+)/g)].map((m) => f + ' ' + m[1].trim()));
  assert.deepEqual(fetches, ["js/app.js '/config.json'", 'js/directory.js u', 'js/views/common.js ref'], 'the only fetches are the flags, the flagged directory and the loader\'s files.fetch(ref): ' + JSON.stringify(fetches));
  assert.match(read('js/directory.js'), /'\/_dir\/' \+ shardOf\(name\) \+ '\.json'/, 'the directory reads static shards of its own origin');
  // Static imports are relative modules only.
  for (const f of JS) for (const m of read(f).matchAll(/^import\s[^'"]*from\s+'([^']+)'/gm)) assert.match(m[1], /^\.{1,2}\//, f + ' imports ' + m[1]);
});

test('E-ID-10: no field anywhere could take a recovery phrase, a passphrase or a backup file', () => {
  const sensitive = /pass(?:word|phrase)|seed|mnemonic|recover|backup|secret|private[- ]?key|12[- ]?words|\bwords\b|one-time|\botp\b|\bpin\b/i;
  const html = read('index.html');
  // Static markup: no password, no file input, no input whose own attributes name a secret.
  for (const m of html.matchAll(/<(input|textarea|select)\b[^>]*>/g)) assert.doesNotMatch(m[0], sensitive, 'a field in index.html: ' + m[0]);
  assert.doesNotMatch(html, /type="(?:password|file)"/);
  // Created fields: every h('input' | 'textarea' | 'select', {...}) in the code.
  let inputs = 0, files = 0;
  for (const f of JS) {
    const src = read(f);
    for (const m of src.matchAll(/h\('(input|textarea|select)',\s*\{([^}]*)\}/g)) {
      inputs++;
      assert.doesNotMatch(m[2], sensitive, f + ' creates a field that names a secret: ' + m[0].slice(0, 100));
      assert.doesNotMatch(m[2], /type:\s*'password'/, f);
      assert.doesNotMatch(m[2], /autocomplete:\s*'(?:current-password|new-password|one-time-code)'/, f);
      if (/type:\s*'file'/.test(m[2])) {
        files++;
        const accept = /accept:\s*'([^']*)'/.exec(m[2]);
        assert.ok(accept && /^(image\/\*|video\/\*)(,(image\/\*|video\/\*))?$/.test(accept[1]), f + ': a file input must accept only pictures and videos: ' + m[0].slice(0, 100));
      }
    }
    assert.doesNotMatch(src, /createElement\(\s*'input'\s*\)/, f + ' creates an input outside h()');
    assert.doesNotMatch(src, /showOpenFilePicker|webkitdirectory/, f);
  }
  assert.ok(inputs >= 25, 'found ' + inputs + ' created fields');
  assert.ok(files >= 3, 'the three file inputs (composer, avatar, private media) are accounted for: ' + files);
  // The only mention of the words in the page is the sentence that says where they are asked for.
  const strings = read('js/strings.js');
  assert.ok(strings.includes('felinar never asks for your 12 words on the site you are signing in to.'));
  for (const f of JS) if (f !== 'js/strings.js') assert.doesNotMatch(read(f), /enter your (?:12 )?words|type your (?:12 )?words|your recovery phrase/i, f);
});

test('alt text is enforced: the model, the composer and every image the page creates', () => {
  const composer = read('js/views/composer.js'), model = read('js/model.js'), strings = read('js/strings.js');
  assert.match(model, /if \(m\.kind !== 'video' && !alt\) errors\.push\(\{ field: 'media\[' \+ i \+ '\]\.alt', code: 'ALT_REQUIRED' \}\)/);
  assert.match(composer, /required: a\.kind !== 'video'/, 'the description field is required for pictures');
  assert.match(composer, /post\.disabled = state\.busy \|\| uploading \|\| !check\.ok/, 'Post stays off until every picture has a description');
  assert.match(composer, /Describe this picture \(required\)/);
  assert.match(strings, /ALT_REQUIRED: 'Describe each picture before you post\./);
  assert.match(read('js/views/settings.js'), /Describe your picture \(required\)/);
  for (const f of JS) {
    const src = read(f);
    for (const m of src.matchAll(/h\('img',\s*\{[^}]*\}/g)) assert.match(m[0], /\balt\b/, f + ': an <img> without alt: ' + m[0].slice(0, 80));
  }
  for (const m of read('index.html').matchAll(/<img\b[^>]*>/g)) assert.match(m[0], /\balt=/);
  assert.match(read('js/views/invite.js'), /role: 'img', 'aria-label'/, 'the QR code has a text alternative');
});

test('JavaScript: parses, never builds HTML from text, keeps storage and object URLs in their one file, stays inside the browser floor', () => {
  const floor = lintPaths([SITE]);
  assert.deepEqual(floor.findings || floor, [], 'tools/lint-floor.mjs over the template');
  for (const f of JS) {
    execFileSync(process.execPath, ['--check', join(SITE, f)]);
    const src = read(f);
    for (const bad of ['innerHTML', 'outerHTML', 'insertAdjacentHTML', 'document.write', 'eval(', 'new Function', 'srcdoc', 'DOMParser', 'createContextualFragment', 'setHTMLUnsafe', 'sessionStorage', 'indexedDB', 'document.cookie', 'postMessage']) {
      assert.ok(!src.includes(bad), f + ' must not use ' + bad);
    }
    assert.doesNotMatch(src, /setAttribute\(\s*['"]on/i, f + ': no event handler attributes');
    assert.doesNotMatch(src, /^await\s/m, f + ': no top-level await');
    if (f !== 'js/store.js') assert.ok(!src.includes('localStorage'), f + ' must reach storage through store.js');
    if (f !== 'js/media-prep.js') assert.ok(!src.includes('createObjectURL'), f + ' must not make object URLs (a file from mw.files is never rendered that way)');
    // R 2.8.4 and 2.8.5: a file is fetched on a tap (mw.files.fetch, whose card the loader shows), and its bytes reach the screen only through
    // mw.files.preview and the disk only through mw.files.save. The handle fetch returns is never read.
    assert.ok(f === 'js/views/common.js' || !/files\.fetch\(/.test(src), f + ': only views/common.js fetches a file, for a tap (R 2.8.4)');
    assert.doesNotMatch(src, /\.(blob|stream|arrayBuffer)\(\)/, f + ': the bytes of a shared file are never read by the page (R 2.8.5)');
    assert.ok(!/\bwindow\.mw\b|globalThis\.mw\b/.test(src) || f === 'js/app.js', f + ' reaches the SDK through ctx');
  }
  assert.doesNotMatch(read('js/model.js'), /\b(document|window|navigator|localStorage|fetch|Date\.now|Math\.random)\b/, 'the model is pure: no DOM, no clock, no randomness');
  assert.doesNotMatch(read('js/qr.js'), /\b(document|window|navigator)\b/);
  const importsOfModel = /^import .* from '\.\/(config|ids)\.js';$/m;
  assert.match(read('js/model.js'), importsOfModel);
  for (const f of ['js/model.js', 'js/ids.js', 'js/router.js', 'js/notices.js', 'js/search.js', 'js/qr.js', 'js/config.js']) assert.doesNotMatch(read(f), /from '\.\/(dom|data|hub|chat|store|inbox)\.js'/, f + ' imports something impure');
});

test('css/app.css: balanced, light and dark with a manual override, two layouts, 44 px targets, reduced motion, focus ring, no external resources', () => {
  const css = read('css/app.css'), body = css.replace(/\/\*[\s\S]*?\*\//g, '');
  assert.equal((body.match(/{/g) || []).length, (body.match(/}/g) || []).length);
  for (const need of ['@media (prefers-color-scheme: dark)', ':root:not([data-theme="light"])', ':root[data-theme="dark"]', ':root[data-theme="light"]', '@media (min-width: 1024px)', '@media (max-width: 640px)',
    '@media (prefers-reduced-motion: reduce)', ':focus-visible', '[hidden] { display: none !important; }', 'min-height: 44px', 'min-width: 44px', 'system-ui', 'env(safe-area-inset-left)', '.sr-only', '.skip']) {
    assert.ok(css.includes(need), 'the stylesheet needs ' + need);
  }
  assert.doesNotMatch(body, /url\(|@import|@font-face/);
  for (const late of [':has(', '@container', 'color-mix(', '@scope', 'text-wrap', '@layer']) assert.ok(!body.includes(late), 'post-floor CSS ' + late);
  assert.doesNotMatch(body, /&[\s.:#[a-z]/, 'no CSS nesting');
  assert.doesNotMatch(body, /outline:\s*none/i.test(body) ? /^$/ : /$^/, 'x');
  // Outline removal is allowed only for the two programmatic focus targets.
  for (const m of body.matchAll(/([^{}]+)\{[^}]*outline:\s*none[^}]*\}/g)) assert.match(m[1].trim(), /^#main:focus, #view-title:focus$/, 'outline: none on ' + m[1].trim());
  assert.match(body, /\.skip:focus \{ top: max\(8px, env\(safe-area-inset-top\)\); \}/);
  assert.match(body, /--accent: #1d4ed8;/);
});

// index.html asks for viewport-fit=cover, which the shell copies to the top page (src/loader/render.js), so the page runs under the sensor
// housing and the rounded corners in landscape: every edge offset of a fixed layer, and of the skip link when it shows, keeps at least
// the safe-area inset of its side.
test('css/app.css with viewport-fit=cover: fixed layers and the skip link keep clear of the safe areas', () => {
  assert.match(read('index.html'), /viewport-fit=cover/);
  const body = read('css/app.css').replace(/\/\*[\s\S]*?\*\//g, '');
  const rules = [...body.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map((m) => ({ sel: m[1].trim(), decls: m[2] }));
  const edgy = rules.filter((r) => /position:\s*fixed/.test(r.decls) || /^\.skip(:focus)?$/.test(r.sel));
  assert.ok(edgy.some((r) => r.sel === '.toasts') && edgy.some((r) => r.sel === '.skip:focus'), edgy.map((r) => r.sel).join(', '));
  const bad = [];
  for (const r of edgy) {
    for (const m of r.decls.matchAll(/(?:^|;)\s*(top|right|bottom|left):\s*([^;]+)/g)) {
      const [, side, value] = m;
      if (/^-/.test(value.trim())) continue; // parked off screen (the skip link before it has focus)
      if (!new RegExp('^max\\(\\d+px, env\\(safe-area-inset-' + side + '\\)\\)$').test(value.trim())) bad.push(r.sel + ' ' + side + ': ' + value.trim());
    }
  }
  assert.deepEqual(bad, [], 'edge offsets without the safe-area inset of their side');
});

test('img/social.svg is a small, plain SVG: no script, no link, no event handler', () => {
  const svg = read('img/social.svg');
  assert.match(svg, /^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg" viewBox="0 0 64 64"/);
  assert.doesNotMatch(svg, /<script|href=|xlink|\bon\w+=|<foreignObject|<image|<style/i);
  assert.ok(svg.length < 1000);
  const tags = [...svg.matchAll(/<(\/?)(\w+)[^>]*?(\/?)>/g)];
  const stack = [];
  for (const [, close, name, self] of tags) { if (self) continue; if (close) assert.equal(stack.pop(), name); else stack.push(name); }
  assert.deepEqual(stack, []);
});

test('config.json and the flags: directory off by default, labelled "pending counsel"', () => {
  const cfg = JSON.parse(read('config.json'));
  assert.deepEqual(Object.keys(cfg).sort(), ['appName', 'directory', 'directoryKey', 'directoryNote', 'hubName', 'moderationContact']);
  assert.equal(cfg.directoryKey, '', 'no directory key until an operator turns the directory on and publishes one');
  assert.equal(cfg.directory, false);
  assert.equal(cfg.directoryNote, 'pending counsel');
  const app = read('js/app.js');
  assert.match(app, /directory: cfg\.directory === true/, 'only an explicit true turns the directory on');
  assert.match(read('js/views/settings.js'), /Off\. This hub has not turned its directory on \(' \+ DIRECTORY_LABEL \+ '\)/);
  assert.match(read('js/directory.js'), /ships OFF/);
});

test('the template follows the numbers of R 3 and says where they come from', async () => {
  const c = await import(pathToFileURL(join(SITE, 'js/config.js')).href);
  assert.deepEqual([c.LIMITS.postChars, c.LIMITS.commentChars, c.LIMITS.bioChars, c.LIMITS.nameChars, c.LIMITS.mediaPerPost, c.LIMITS.mentionsPerPost, c.LIMITS.profileLinks, c.LIMITS.okRefs, c.LIMITS.pageSize, c.LIMITS.drafts],
    [2000, 1000, 280, 48, 4, 10, 3, 20, 30, 20]);
  assert.deepEqual([c.LIMITS.avatarPx, c.LIMITS.avatarBytes, c.LIMITS.valueBytes], [512, 256 * 1024, 2048]);
  assert.deepEqual(c.FOLLOW_CAPS, { phone: 250, desktop: 1000 });
  assert.deepEqual(c.WALL_MODES, ['everyone', 'follow', 'nobody', 'approve']);
  assert.equal(c.DEFAULT_WALL, 'follow');
  assert.deepEqual(c.REACTIONS, ['+1', 'heart', 'laugh', 'sad']);
  assert.deepEqual(c.LISTS, { post: 'mw.post', comment: 'mw.c', share: 'mw.q', follow: 'mw.f', ok: 'mw.ok', profile: 'mw.prof', count: 'mw.cnt' });
  assert.match(read('js/config.js'), /chosen/, 'limits that R marks "chosen" say so');
  assert.ok(Object.isFrozen(c.LIMITS) && Object.isFrozen(c.FOLLOW_CAPS));
});

test('README.md: deployment, the template torrent, the follow caps, what needs an index, the GAPs and the tests', () => {
  const md = read('README.md');
  for (const need of ['template torrent', 'btih=<template>', 'config.json', '"directory": true', 'pending counsel', '250', '1,000', 'You follow 250 of 250 on this phone', 'needs an index', 'central storage', 'Kept by the hub',
    'Available only while someone who has it is online', 'GAP', 'mw.hub.follow', '{ ledger }', 'createPage', 'withdrawPage', 'requestJoin', 'mwn1:', 'node tools/publish.mjs examples/social', 'npm run test:example', 'npm run check:example',
    'Open in your home', 'Public Suffix List', 'No ranking', 'js/model.js', 'U-SO-1', 'E-SO-1', '../../docs/deviations/examples.md', "You don't follow anyone yet.", "This page doesn't exist in this app.", 'Catching up: 37 of 120 pages']) {
    assert.ok(md.includes(need), 'README.md must mention ' + need);
  }
  for (const f of SITE_FILES.filter((x) => x.startsWith('js/') && !x.startsWith('js/views/'))) assert.ok(md.includes(f), 'README.md names ' + f);
});
