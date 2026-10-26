// Unit tests for src/sw/lib.js (DESIGN-REVIEW items 7, 8, S11; ARCHITECTURE §7.1, §3.4.2).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  mimeFor, extOf, MIME_TYPES, parseRange, splitHubPath, decodePath, encodePath, applyRouting,
  normalizeManifest, headersFor, parseRedirects, parseHeaders, stampedPointerFromHtml, isShellHtml,
} from '../../src/sw/lib.js';

const BTIH = '0123456789abcdef0123456789abcdef01234567';

// ---------------------------------------------------------------------------------------------- MIME

test('mimeFor: at least 50 extensions, every one the SW and browsers depend on', () => {
  assert.ok(Object.keys(MIME_TYPES).length >= 50, 'a 50-entry map (ARCHITECTURE §7.1)');
  const exact = {
    'index.html': 'text/html; charset=utf-8',
    'a/b/page.htm': 'text/html; charset=utf-8',
    'app.css': 'text/css; charset=utf-8',
    'app.js': 'text/javascript; charset=utf-8',
    'mod.mjs': 'text/javascript; charset=utf-8',
    'data.json': 'application/json; charset=utf-8',
    'app.js.map': 'application/json; charset=utf-8',
    'lib.wasm': 'application/wasm',
    'icon.svg': 'image/svg+xml',
    'a.png': 'image/png',
    'a.jpg': 'image/jpeg',
    'a.jpeg': 'image/jpeg',
    'a.gif': 'image/gif',
    'a.webp': 'image/webp',
    'a.avif': 'image/avif',
    'fav.ico': 'image/x-icon',
    'f.woff2': 'font/woff2',
    'f.woff': 'font/woff',
    'f.ttf': 'font/ttf',
    'f.otf': 'font/otf',
    'f.eot': 'application/vnd.ms-fontobject',
    'manifest.webmanifest': 'application/manifest+json; charset=utf-8',
    'v.mp4': 'video/mp4',
    'v.webm': 'video/webm',
    'v.mov': 'video/quicktime',
    'a.mp3': 'audio/mpeg',
    'a.m4a': 'audio/mp4',
    'a.ogg': 'audio/ogg',
    'a.flac': 'audio/flac',
    'a.wav': 'audio/wav',
    'list.m3u8': 'application/vnd.apple.mpegurl',
    'segment0.ts': 'video/mp2t',
    'doc.pdf': 'application/pdf',
    'a.zip': 'application/zip',
    's.vtt': 'text/vtt; charset=utf-8',
    'README.md': 'text/markdown; charset=utf-8',
    't.txt': 'text/plain; charset=utf-8',
    'feed.xml': 'application/xml; charset=utf-8',
    'm.glb': 'model/gltf-binary',
    'p.jxl': 'image/jxl',
  };
  for (const [path, type] of Object.entries(exact)) assert.equal(mimeFor(path), type, path);
});

test('mimeFor: case, query, hash, multi-dot names; unknown is application/octet-stream', () => {
  assert.equal(mimeFor('PHOTO.PNG'), 'image/png');
  assert.equal(mimeFor('Style.CSS?v=3'), 'text/css; charset=utf-8');
  assert.equal(mimeFor('app.js#x'), 'text/javascript; charset=utf-8');
  assert.equal(mimeFor('lib.min.js'), 'text/javascript; charset=utf-8');
  assert.equal(mimeFor('archive.tar.gz'), 'application/gzip');
  for (const p of ['file.unknownext', 'LICENSE', '', 'dir.v2/file', '.htaccess', 'trailing.', 'constructor', 'x.__proto__', 'x.toString']) {
    assert.equal(mimeFor(p), 'application/octet-stream', p);
  }
  assert.equal(mimeFor(null), 'application/octet-stream');
  assert.equal(extOf('a/b/c.HTML'), 'html');
  assert.equal(extOf('.well-known'), '');
  assert.equal(extOf(undefined), '');
});

// ---------------------------------------------------------------------------------------------- Range

test('parseRange: absent, malformed, foreign or multi-range headers → null (full 200)', () => {
  for (const h of [null, undefined, '', '0-5', 'items=0-5', 'bytes=', 'bytes=-', 'bytes=a-b', 'bytes=1.5-3', 'bytes=-1-5', 'bytes=5-2', 'bytes=0-5, 10-15']) {
    assert.equal(parseRange(h, 100), null, String(h));
  }
  assert.equal(parseRange('bytes=0-5', undefined), null);
  assert.equal(parseRange('bytes=0-5', -1), null);
  assert.equal(parseRange('bytes=0-5', 10.5), null);
  assert.deepEqual(parseRange('bytes=0-5,', 100), { start: 0, end: 5 }, 'empty list elements are ignored');
});

test('parseRange: the Safari media probe bytes=0-1, open, clamped and spaced ranges', () => {
  assert.deepEqual(parseRange('bytes=0-1', 1000), { start: 0, end: 1 });
  assert.deepEqual(parseRange('bytes=0-1', 1), { start: 0, end: 0 }, 'clamped to the one byte there is');
  assert.deepEqual(parseRange('bytes=0-', 100), { start: 0, end: 99 });
  assert.deepEqual(parseRange('bytes=10-19', 100), { start: 10, end: 19 });
  assert.deepEqual(parseRange('bytes=10-1000', 100), { start: 10, end: 99 });
  assert.deepEqual(parseRange('bytes=99-', 100), { start: 99, end: 99 });
  assert.deepEqual(parseRange('Bytes = 7-10 ', 100), { start: 7, end: 10 });
  assert.deepEqual(parseRange('bytes=007-010', 100), { start: 7, end: 10 });
  assert.deepEqual(parseRange('bytes=0-99999999999999999999', 100), { start: 0, end: 99 });
});

test('parseRange: suffix ranges', () => {
  assert.deepEqual(parseRange('bytes=-10', 100), { start: 90, end: 99 });
  assert.deepEqual(parseRange('bytes=-1', 100), { start: 99, end: 99 });
  assert.deepEqual(parseRange('bytes=-100', 100), { start: 0, end: 99 });
  assert.deepEqual(parseRange('bytes=-1000', 100), { start: 0, end: 99 }, 'longer than the body: the whole body');
});

test('parseRange: unsatisfiable ranges → 416', () => {
  assert.equal(parseRange('bytes=100-', 100), 416);
  assert.equal(parseRange('bytes=100-200', 100), 416);
  assert.equal(parseRange('bytes=-0', 100), 416);
  assert.equal(parseRange('bytes=0-', 0), 416);
  assert.equal(parseRange('bytes=-5', 0), 416);
});

// ---------------------------------------------------------------------------------------------- paths

test('splitHubPath: /_mw/s/<btih>/<path> (same result as render.js)', () => {
  assert.deepEqual(splitHubPath('/_mw/s/' + BTIH + '/css/app.css'), { btih: BTIH, path: '/css/app.css' });
  assert.deepEqual(splitHubPath('/_mw/s/' + BTIH.toUpperCase() + '/'), { btih: BTIH, path: '/' });
  assert.deepEqual(splitHubPath('/_mw/s/' + BTIH), { btih: BTIH, path: '/' });
  assert.deepEqual(splitHubPath('/_mw/s/' + BTIH + '//x'), { btih: BTIH, path: '/x' });
  assert.deepEqual(splitHubPath('/_mw/s/' + BTIH + '/caf%C3%A9.html'), { btih: BTIH, path: '/caf%C3%A9.html' }, 'still encoded');
  assert.equal(splitHubPath('/_mw/s/xyz/'), null);
  assert.equal(splitHubPath('/_mw/s/' + BTIH.slice(1) + '/'), null);
  assert.equal(splitHubPath('/_mw/x/' + BTIH + '/'), null);
  assert.equal(splitHubPath(null), null);
});

test('decodePath / encodePath', () => {
  assert.equal(decodePath('/caf%C3%A9%20b.png'), '/café b.png');
  assert.equal(decodePath('a/b'), '/a/b');
  assert.equal(decodePath('/100%/x%2'), '/100%/x%2', 'malformed escapes are kept');
  assert.equal(encodePath('/café b.png'), '/caf%C3%A9%20b.png');
  assert.equal(encodePath('/a:b@c/d?e#f'), '/a:b@c/d%3Fe%23f');
  assert.equal(decodePath(encodePath('/x y/z?w')), '/x y/z?w');
});

// ---------------------------------------------------------------------------------------------- _redirects / _headers

const REDIRECTS = `# Redirects (Netlify / Cloudflare Pages subset)
/home              /
/blog/my-post.php  /blog/my-post
/news              /blog
/cuties            https://www.petsofnetlify.com
/old/*             /new/:splat
/news/:year/:month/:date/:slug  /blog/:year/:month/:date/:slug  302
/app/*             /app/index.html   200
/shop/*            /shop/404.html    404
/force             /forced.html      302!
/api/*             https://api.example.com/:splat  200
/store             /blog   302   Country=us
/path id=:id       /new/:id  301
/teapot            /tea    418
https://old.example/*  https://new.example/:splat  301
not-a-path         /x
`;

test('parseRedirects: the supported subset, in order; unsupported lines are skipped', () => {
  const rules = parseRedirects(REDIRECTS);
  assert.deepEqual(rules, [
    { from: '/home', to: '/', status: 301, force: false },
    { from: '/blog/my-post.php', to: '/blog/my-post', status: 301, force: false },
    { from: '/news', to: '/blog', status: 301, force: false },
    { from: '/cuties', to: 'https://www.petsofnetlify.com', status: 301, force: false },
    { from: '/old/*', to: '/new/:splat', status: 301, force: false },
    { from: '/news/:year/:month/:date/:slug', to: '/blog/:year/:month/:date/:slug', status: 302, force: false },
    { from: '/app/*', to: '/app/index.html', status: 200, force: false },
    { from: '/shop/*', to: '/shop/404.html', status: 404, force: false },
    { from: '/force', to: '/forced.html', status: 302, force: true },
  ]);
  assert.deepEqual(parseRedirects(''), []);
  assert.deepEqual(parseRedirects(null), []);
  assert.deepEqual(parseRedirects('/a /b 307\r\n/c /d 308\r\n'), [
    { from: '/a', to: '/b', status: 307, force: false },
    { from: '/c', to: '/d', status: 308, force: false },
  ], 'CRLF files');
});

const HEADERS = `# security headers
/*
  X-Frame-Options: DENY
  X-Content-Type-Options: nosniff
  Permissions-Policy: camera=()
/assets/*
  Cache-Control: public, max-age=31536000, immutable
  Link: </assets/font.woff2>; rel=preload; as=font
  link: </assets/app.css>; rel=preload; as=style
/admin/*
  ! X-Frame-Options
  # a comment inside a block
  Content-Security-Policy: default-src 'self'; frame-ancestors 'none'
https://example.pages.dev/*
  X-Robots-Tag: noindex
/bad
  Bad Header: x
/empty
`;

test('parseHeaders: path blocks, joined repeats, skipped detach/comment/URL/invalid lines', () => {
  assert.deepEqual(parseHeaders(HEADERS), [
    { for: '/*', values: { 'X-Frame-Options': 'DENY', 'X-Content-Type-Options': 'nosniff', 'Permissions-Policy': 'camera=()' } },
    {
      for: '/assets/*',
      values: {
        'Cache-Control': 'public, max-age=31536000, immutable',
        Link: '</assets/font.woff2>; rel=preload; as=font, </assets/app.css>; rel=preload; as=style',
      },
    },
    { for: '/admin/*', values: { 'Content-Security-Policy': "default-src 'self'; frame-ancestors 'none'" } },
  ]);
  assert.deepEqual(parseHeaders(''), []);
});

// ---------------------------------------------------------------------------------------------- manifest

test('normalizeManifest: defaults, shorthand forms, caching per input object', () => {
  const d = normalizeManifest(null);
  assert.equal(d.index, 'index.html');
  assert.equal(d.notFound, '404.html');
  assert.equal(d.spa, null);
  assert.equal(d.cleanUrls, false);
  assert.equal(d.trailingSlash, 'auto');
  assert.deepEqual(d.redirects, []);
  assert.deepEqual(d.headers, []);
  assert.equal(normalizeManifest({ spa: true }).spa, 'index.html');
  assert.equal(normalizeManifest({ spa: '/app.html' }).spa, 'app.html');
  assert.equal(normalizeManifest({ notFound: null }).notFound, null);
  assert.equal(normalizeManifest({ notFound: false }).notFound, null);
  assert.equal(normalizeManifest({ notFound: '/errors/404.html' }).notFound, 'errors/404.html');
  assert.equal(normalizeManifest({ index: 'main.html' }).index, 'main.html');
  assert.equal(normalizeManifest({ index: 'a/b.html' }).index, 'index.html', 'an index name never has a slash');
  assert.equal(normalizeManifest({ trailingSlash: true }).trailingSlash, true);
  assert.equal(normalizeManifest({ trailingSlash: 'never' }).trailingSlash, false);
  assert.equal(normalizeManifest({ redirects: '/a /b 302' }).redirects[0].status, 302);
  assert.equal(normalizeManifest({ redirects: [{ from: '/a', to: '/b' }, { from: 'bad', to: '/b' }] }).redirects.length, 1);
  assert.deepEqual(normalizeManifest({ headers: { '/*': { 'X-A': '1' } } }).headers[0].values, { 'X-A': '1' });
  assert.equal(normalizeManifest({ headers: '/*\n  X-B: 2\n' }).headers[0].values['X-B'], '2');
  const raw = { spa: true };
  assert.equal(normalizeManifest(raw), normalizeManifest(raw), 'cached');
  const n = normalizeManifest(raw);
  assert.equal(normalizeManifest(n), n, 'a normalized manifest passes through');
  assert.ok(Object.isFrozen(n));
});

// ---------------------------------------------------------------------------------------------- applyRouting

const FILES = new Set([
  'index.html', 'about.html', 'docs/index.html', 'docs/guide.html', 'app.js', 'css/app.css', '404.html',
  'café.html', 'data.json', 'blog/index.html', 'forced.html', 'shop/404.html', 'app/index.html', 'notes',
  'spa.html', 'errors/404.html', 'main.html',
]);
const has = (p) => FILES.has(p);
const route = (m, p, nav) => {
  const r = applyRouting(m, p, has, nav === undefined ? undefined : { navigate: nav });
  return r.redirect ? [r.status, '->', r.redirect] : [r.status, r.path];
};

test('applyRouting: defaults (index, extensionless .html, directory slash, 404 page for navigations)', () => {
  assert.deepEqual(route(null, '/'), [200, 'index.html']);
  assert.deepEqual(route(null, '/index.html'), [200, 'index.html']);
  assert.deepEqual(route(null, '/about'), [200, 'about.html']);
  assert.deepEqual(route(null, '/about.html'), [200, 'about.html']);
  assert.deepEqual(route(null, '/about/'), [301, '->', '/about']);
  assert.deepEqual(route(null, '/docs'), [301, '->', '/docs/']);
  assert.deepEqual(route(null, '/docs/'), [200, 'docs/index.html']);
  assert.deepEqual(route(null, '/docs/guide'), [200, 'docs/guide.html']);
  assert.deepEqual(route(null, '/notes'), [200, 'notes'], 'an exact file without extension wins');
  assert.deepEqual(route(null, '/caf%C3%A9.html'), [200, 'café.html']);
  assert.deepEqual(route(null, '/caf%C3%A9'), [200, 'café.html']);
  assert.deepEqual(route(null, '/css//app.css', false), [200, 'css/app.css']);
  assert.deepEqual(route(null, '/about?x=1'), [200, 'about.html'], 'the query never matters');
  assert.deepEqual(route(null, '/missing'), [404, '404.html']);
  assert.deepEqual(route(null, '/missing', false), [404, null], 'a missing subresource is a plain 404');
  assert.deepEqual(route(null, '/missing.js', false), [404, null]);
  assert.deepEqual(applyRouting(null, '/x', () => false), { path: null, status: 404, redirect: null, headers: {} });
});

test('applyRouting: index and notFound', () => {
  assert.deepEqual(route({ index: 'main.html' }, '/'), [200, 'main.html']);
  assert.deepEqual(route({ notFound: '/errors/404.html' }, '/missing'), [404, 'errors/404.html']);
  assert.deepEqual(route({ notFound: null }, '/missing'), [404, null]);
  assert.deepEqual(route({ notFound: 'nope.html' }, '/missing'), [404, null], 'a notFound page that does not exist');
});

test('applyRouting: spa fallback for navigations only, after files and rules', () => {
  const spa = { spa: true, redirects: '/news /blog/ 302' };
  assert.deepEqual(route(spa, '/users/42'), [200, 'index.html']);
  assert.deepEqual(route(spa, '/users/42', false), [404, null], 'fetch and assets never get the spa document');
  assert.deepEqual(route(spa, '/about'), [200, 'about.html'], 'a file still wins');
  assert.deepEqual(route(spa, '/news'), [302, '->', '/blog/'], 'a rule still wins');
  assert.deepEqual(route({ spa: '/spa.html' }, '/deep/link'), [200, 'spa.html']);
  assert.deepEqual(route({ spa: '/missing.html' }, '/deep/link'), [404, '404.html'], 'a missing spa document falls back');
});

test('applyRouting: cleanUrls', () => {
  const m = { cleanUrls: true };
  assert.deepEqual(route(m, '/about.html'), [301, '->', '/about']);
  assert.deepEqual(route(m, '/about'), [200, 'about.html']);
  assert.deepEqual(route(m, '/index.html'), [301, '->', '/']);
  assert.deepEqual(route(m, '/docs/index.html'), [301, '->', '/docs/']);
  assert.deepEqual(route(m, '/docs/guide.html'), [301, '->', '/docs/guide']);
  assert.deepEqual(route(m, '/app.js', false), [200, 'app.js'], 'only HTML pages get clean URLs');
  assert.deepEqual(route(m, '/'), [200, 'index.html']);
});

test('applyRouting: trailingSlash true and false', () => {
  const always = { trailingSlash: true };
  assert.deepEqual(route(always, '/about'), [301, '->', '/about/']);
  assert.deepEqual(route(always, '/about/'), [200, 'about.html']);
  assert.deepEqual(route(always, '/docs'), [301, '->', '/docs/']);
  assert.deepEqual(route(always, '/docs/'), [200, 'docs/index.html']);
  assert.deepEqual(route({ trailingSlash: true, cleanUrls: true }, '/about.html'), [301, '->', '/about/']);
  const never = { trailingSlash: false };
  assert.deepEqual(route(never, '/docs/'), [301, '->', '/docs']);
  assert.deepEqual(route(never, '/docs'), [200, 'docs/index.html']);
  assert.deepEqual(route(never, '/about/'), [301, '->', '/about']);
  assert.deepEqual(route(never, '/'), [200, 'index.html'], 'the root keeps its slash');
  assert.deepEqual(route({ trailingSlash: false, cleanUrls: true }, '/docs/index.html'), [301, '->', '/docs']);
});

test('applyRouting: redirects (shadowing, force, splat, placeholders, rewrites, 404 rules)', () => {
  const m = {
    redirects: REDIRECTS + [
      '/about /elsewhere 301',
      '/ghost/* /nothing.html 200',
      '/loop /loop 301',
      '/q /search?x=1 302',
      '/first /one 302',
      '/first /two 302',
    ].join('\n'),
  };
  assert.deepEqual(route(m, '/news'), [301, '->', '/blog']);
  assert.deepEqual(route(m, '/news/'), [301, '->', '/blog'], 'a trailing slash matches too');
  assert.deepEqual(route(m, '/about'), [200, 'about.html'], 'non-forced rules never shadow a file');
  assert.deepEqual(route(m, '/force'), [302, '->', '/forced.html']);
  assert.deepEqual(route({ redirects: '/about /elsewhere 302!' }, '/about'), [302, '->', '/elsewhere'], 'forced rules win over files');
  assert.deepEqual(route(m, '/old/a/b.html'), [301, '->', '/new/a/b.html']);
  assert.deepEqual(route(m, '/old'), [301, '->', '/new/'], 'a trailing /* also matches the bare directory');
  assert.deepEqual(route(m, '/news/2024/01/02/hi'), [302, '->', '/blog/2024/01/02/hi']);
  assert.deepEqual(route(m, '/app/x/y'), [200, 'app/index.html'], '200 rewrites to an internal file');
  assert.deepEqual(route(m, '/ghost/x'), [404, '404.html'], 'a rewrite to a missing file does not match');
  assert.deepEqual(route(m, '/shop/item'), [404, 'shop/404.html'], '404 rules serve their page with 404');
  assert.deepEqual(route(m, '/cuties'), [301, '->', 'https://www.petsofnetlify.com']);
  assert.deepEqual(route(m, '/loop'), [404, '404.html'], 'a rule that redirects to itself is skipped');
  assert.deepEqual(route(m, '/q'), [302, '->', '/search?x=1']);
  assert.deepEqual(route(m, '/first'), [302, '->', '/one'], 'the first matching rule wins');
  assert.deepEqual(route(m, '/home'), [301, '->', '/']);
});

test('applyRouting: headers rules match the request path and merge', () => {
  const m = {
    headers: [
      { for: '/*', values: { 'X-Test': 'a', 'Permissions-Policy': 'camera=()' } },
      { for: '/assets/*', values: { 'x-test': 'b', 'Cache-Control': 'max-age=60' } },
      { for: '/docs/:page', values: { 'X-Doc': 'yes' } },
      { for: '/exact', values: { 'X-Exact': '1' } },
    ],
  };
  assert.deepEqual(applyRouting(m, '/assets/app.css', has, { navigate: false }).headers,
    { 'X-Test': 'a, b', 'Permissions-Policy': 'camera=()', 'Cache-Control': 'max-age=60' });
  assert.deepEqual(applyRouting(m, '/', has).headers, { 'X-Test': 'a', 'Permissions-Policy': 'camera=()' });
  assert.deepEqual(headersFor(m, '/docs/guide'), { 'X-Test': 'a', 'Permissions-Policy': 'camera=()', 'X-Doc': 'yes' });
  assert.deepEqual(headersFor(m, '/docs/a/b'), { 'X-Test': 'a', 'Permissions-Policy': 'camera=()' }, ':name is one segment');
  assert.equal(headersFor(m, '/exact/')['X-Exact'], '1');
  assert.equal(headersFor(m, '/exactly')['X-Exact'], undefined);
  const r = applyRouting(m, '/docs', has);
  assert.equal(r.status, 301);
  assert.equal(r.headers['X-Test'], 'a', 'redirects carry the headers too');
});

// ---------------------------------------------------------------------------------------------- stamped pointer

const PTR = 'v=mw1; btih=' + BTIH + '; xs=/_mw/t/' + BTIH + '.torrent; tr=wss://t.example';

test('stampedPointerFromHtml: the stamped meta in any attribute order, quoting and case', () => {
  const html = '<!doctype html><html><head><meta name="mw-pointer" content="' + PTR + '"><title>x</title>';
  const r = stampedPointerFromHtml(html);
  assert.equal(r.btih, BTIH);
  assert.deepEqual(r.xs, ['/_mw/t/' + BTIH + '.torrent']);
  assert.deepEqual(r.tr, ['wss://t.example']);
  assert.equal(r.signed, false);
  assert.equal(r.kind, 'pointer');
  assert.equal(stampedPointerFromHtml("<head><meta content='" + PTR + "' name='mw-pointer'>").btih, BTIH);
  assert.equal(stampedPointerFromHtml('<HEAD><META NAME=mw-pointer CONTENT="' + PTR + '"/>').btih, BTIH);
  assert.equal(stampedPointerFromHtml('<meta charset="utf-8"><meta name="mw-pointer" content="' + PTR + '" />').btih, BTIH);
  assert.equal(stampedPointerFromHtml(new TextEncoder().encode('<head><meta name="mw-pointer" content="' + PTR + '">')).btih, BTIH, 'bytes');
});

test('stampedPointerFromHtml: character references, magnets, comments, truncation', () => {
  const amp = stampedPointerFromHtml('<meta name="mw-pointer" content="v=mw1; btih=' + BTIH + '; xs=https://h.example/t?a=1&amp;b=2; dn=a&gt;b">');
  assert.deepEqual(amp.xs, ['https://h.example/t?a=1&b=2']);
  assert.equal(amp.dn, 'a>b');
  const quoted = stampedPointerFromHtml("<meta name=\"mw-pointer\" content='v=mw1; btih=" + BTIH + "; dn=x>y'>");
  assert.equal(quoted.dn, 'x>y', "a '>' inside a quoted value does not end the tag");
  const magnet = stampedPointerFromHtml('<meta name="mw-pointer" content="magnet:?xt=urn:btih:' + BTIH + '&amp;dn=Site">');
  assert.equal(magnet.kind, 'magnet');
  assert.equal(magnet.btih, BTIH);
  const commented = '<!-- <meta name="mw-pointer" content="v=mw1; btih=' + 'f'.repeat(40) + '"> --><meta name="mw-pointer" content="' + PTR + '">';
  assert.equal(stampedPointerFromHtml(commented).btih, BTIH, 'commented-out tags are ignored');
  assert.equal(stampedPointerFromHtml('<meta name="mw-pointer" content="v=mw1; btih=' + BTIH), null, 'cut at the chunk boundary');
  assert.equal(stampedPointerFromHtml('<meta name="mw-pointer-old" content="' + PTR + '">'), null);
  assert.equal(stampedPointerFromHtml('<meta name="mw-pointer" content="v=mw1; dn=no-btih">'), null);
  assert.equal(stampedPointerFromHtml('<meta name="mw-pointer">'), null);
  assert.equal(stampedPointerFromHtml('<html><head><title>plain</title></head>'), null);
  assert.equal(stampedPointerFromHtml(''), null);
  assert.equal(stampedPointerFromHtml(null), null);
});

test('isShellHtml: the loader shell, not a drop-in page', () => {
  const shell = readFileSync(new URL('../../src/loader/index.html', import.meta.url), 'utf8');
  assert.equal(isShellHtml(shell), true, 'src/loader/index.html');
  assert.equal(isShellHtml('<script src="/_mw/boot.js?v=2"></script>'), true);
  assert.equal(isShellHtml("<script src='https://site.example/_mw/boot.js'></script>"), true);
  assert.equal(isShellHtml('<meta name="mw-shell" content="1">'), true);
  assert.equal(isShellHtml('<meta name="mw-pointer" content="x"><script type="module" src="/_mw/mw.js" async></script>'), false);
  assert.equal(isShellHtml('<script src="/x/_mw/boot.js"></script>'), false);
  assert.equal(isShellHtml(''), false);
});

test('v0.3 reservedRoute: /_mw/f/<id>, /_mw/media/<sid>, /_mw/idp-return', async () => {
  const { reservedRoute, RESERVED_ROUTES } = await import('../../src/sw/lib.js');
  assert.deepEqual(RESERVED_ROUTES, { file: '/_mw/f/', media: '/_mw/media/', idpReturn: '/_mw/idp-return' });
  assert.deepEqual(reservedRoute('/_mw/f/' + 'a'.repeat(32)), { kind: 'file', id: 'a'.repeat(32) });
  assert.deepEqual(reservedRoute('/_mw/media/abc'), { kind: 'media', id: 'abc' });
  assert.deepEqual(reservedRoute('/_mw/idp-return'), { kind: 'idp-return' });
  assert.equal(reservedRoute('/_mw/fx'), null);
  assert.equal(reservedRoute('/_mw/loader.js'), null);
  assert.equal(reservedRoute('/f/x'), null);
});
