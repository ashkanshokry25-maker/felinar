// Unit tests for tools/dev-server.mjs (ARCHITECTURE section 10, DESIGN-REVIEW items 14, 22):
// static hosting with exact MIME types, the SPA fallback for the loader shell, Cache-Control,
// Range, the /ws/ web seed (OPTIONS, CORS, 206), --pointer and --dev meta injection, --tls.
// Servers listen on 127.0.0.1 with ephemeral ports and are closed in after().
import { test, after, before } from 'node:test';
import assert from 'node:assert/strict';
import https from 'node:https';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawn, spawnSync } from 'node:child_process';

import { createDevServer, contentTypeFor } from '../../tools/dev-server.mjs';
import { UsageError, ToolError, ROOT } from '../../tools/lib.mjs';
import { stampedPointerFromHtml } from '../../src/sw/lib.js';
import { parsePointer } from '../../src/common/pointer.js';

const work = mkdtempSync(join(tmpdir(), 'mw-dev-server-test-'));
const servers = [];
after(async () => {
  for (const s of servers) await s.close();
  rmSync(work, { recursive: true, force: true });
});

const SHELL = '<!doctype html><html><head><meta charset="utf-8"><title>Shell</title></head><body><script src="/_mw/boot.js"></script></body></html>\n';
const BIG = Buffer.alloc(3000);
for (let i = 0; i < BIG.length; i++) BIG[i] = i % 251;
const POINTER = 'v=mw1; btih=' + 'a'.repeat(40) + '; dn=dev; ws=http://127.0.0.1:1/ws/; seq=1';

function write(root, files) {
  for (const [p, content] of Object.entries(files)) {
    const abs = join(root, ...p.split('/'));
    mkdirSync(join(abs, '..'), { recursive: true });
    writeFileSync(abs, content);
  }
}

let root;
let seed;
let outside;
let dev;
let plain;

async function start(options) {
  const s = await createDevServer(Object.assign({ port: 0, quiet: true }, options));
  servers.push(s);
  return s;
}

before(async () => {
  root = join(work, 'root');
  seed = join(work, 'seed');
  outside = join(work, 'outside');
  write(root, {
    'index.html': SHELL,
    '404.html': '<!doctype html><html><head><title>Gone</title></head><body>gone</body></html>',
    'about.html': '<!doctype html><html><head><title>About</title></head><body>about</body></html>',
    'app.mjs': 'export default 1;\n',
    'app.js': 'console.log(1);\n',
    'lib.wasm': Buffer.from([0, 0x61, 0x73, 0x6d, 1, 0, 0, 0]),
    'manifest.webmanifest': '{}',
    'style.css': 'a{b:c}',
    'data.json': '{"a":1}',
    'clip.mp4': BIG,
    'big.bin': BIG,
    'empty.txt': '',
    'photo.png': Buffer.from([0x89, 0x50, 0x4e, 0x47]),
    'mw-sw.js': '// service worker\n',
    'mw-sw-kill.js': '// kill switch\n',
    '_mw/boot.js': '// boot\n',
    'sub/index.html': '<!doctype html><html><head><title>Sub</title></head><body>sub</body></html>',
    'some file.txt': 'spaces',
    '.env': 'SECRET=1',
    '.git/config': '[core]',
    '.well-known/security.txt': 'Contact: a@example.com',
    '.mw/site.json': '{"v":1}',
    'x.torrent': 'd4:infod4:name1:xee',
  });
  write(seed, {
    'my-site/index.html': BIG,
    'my-site/.mw/site.json': '{"v":1}',
    'my-site.torrent': 'd4:infod4:name1:xee',
    'summary.json': '{"btih":"x"}',
  });
  write(outside, { 'secret.txt': 'top secret' });
  symlinkSync(join(outside, 'secret.txt'), join(root, 'leak.txt'));
  symlinkSync(outside, join(seed, 'leakdir'));
  dev = await start({ root, webseed: seed, pointer: POINTER, dev: true });
  plain = await start({ root });
});

const get = (server, path, init) => fetch(server.url.replace(/\/$/, '') + path, init);

test('exact MIME types, including .mjs, .wasm and .webmanifest, and nosniff', async () => {
  const expected = {
    '/app.mjs': 'text/javascript; charset=utf-8',
    '/app.js': 'text/javascript; charset=utf-8',
    '/lib.wasm': 'application/wasm',
    '/manifest.webmanifest': 'application/manifest+json; charset=utf-8',
    '/style.css': 'text/css; charset=utf-8',
    '/data.json': 'application/json; charset=utf-8',
    '/clip.mp4': 'video/mp4',
    '/photo.png': 'image/png',
    '/x.torrent': 'application/x-bittorrent',
    '/about.html': 'text/html; charset=utf-8',
  };
  for (const [path, type] of Object.entries(expected)) {
    const res = await get(plain, path);
    assert.equal(res.status, 200, path);
    assert.equal(res.headers.get('content-type'), type, path);
    assert.equal(res.headers.get('x-content-type-options'), 'nosniff', path);
    await res.arrayBuffer();
  }
  assert.equal(contentTypeFor('/a/b/file.torrent'), 'application/x-bittorrent');
  assert.equal(contentTypeFor('x.unknown'), 'application/octet-stream');
});

test('Cache-Control: no-cache on /mw-sw.js, HTML and everything else (revalidate with ETag)', async () => {
  for (const path of ['/mw-sw.js', '/index.html', '/about.html', '/app.js', '/some/spa/route']) {
    const res = await get(plain, path);
    assert.equal(res.headers.get('cache-control'), 'no-cache', path);
    await res.arrayBuffer();
  }
  const first = await get(plain, '/app.js');
  const etag = first.headers.get('etag');
  assert.ok(etag);
  await first.arrayBuffer();
  const again = await get(plain, '/app.js', { headers: { 'if-none-match': etag } });
  assert.equal(again.status, 304);
  assert.equal((await again.arrayBuffer()).byteLength, 0);
});

test('SPA fallback: when the root index.html is the loader shell, unknown paths get the shell with 200', async () => {
  assert.equal(plain.spa, true);
  for (const path of ['/some/route', '/a/b/c/d.html', '/blog/2026/post', '/about']) {
    const res = await get(plain, path);
    assert.equal(res.status, 200, path);
    assert.equal(res.headers.get('content-type'), 'text/html; charset=utf-8');
    assert.equal(await res.text(), SHELL, path);
  }
  // real files win over the fallback, reserved paths never fall back
  assert.equal((await get(plain, '/about.html')).status, 200);
  for (const path of ['/_mw/missing.js', '/ws/missing', '/.mw/missing.json', '/_dev/x', '/mw-sw-missing/..%2Fx']) {
    const res = await get(plain, path);
    assert.notEqual(await res.text(), SHELL, path);
  }
  assert.equal((await get(plain, '/_mw/missing.js')).status, 404);
  assert.equal((await get(plain, '/ws/anything')).status, 404);
  assert.equal((await get(plain, '/.mw/missing.json')).status, 404);
});

test('without the shell, unknown paths get 404.html with status 404 (a drop-in host keeps its own 404); --spa forces the fallback', async () => {
  const site = join(work, 'dropin-root');
  write(site, { 'index.html': '<html><head></head><body>home</body></html>', '404.html': '<html><body>host 404</body></html>', 'a.css': 'x' });
  const s = await start({ root: site });
  assert.equal(s.spa, false);
  const res = await get(s, '/nope');
  assert.equal(res.status, 404);
  assert.match(await res.text(), /host 404/);
  assert.equal((await get(s, '/a.css')).status, 200);
  const forced = await start({ root: site, spa: true });
  const fb = await get(forced, '/nope');
  assert.equal(fb.status, 200);
  assert.match(await fb.text(), /home/);
  const off = await start({ root, spa: false });
  assert.equal((await get(off, '/some/route')).status, 404);
});

test('Range: 206 with Content-Range, suffix and open-ended ranges, 416 when unsatisfiable, HEAD, Accept-Ranges', async () => {
  const full = await get(plain, '/big.bin');
  assert.equal(full.status, 200);
  assert.equal(full.headers.get('accept-ranges'), 'bytes');
  assert.equal(full.headers.get('content-length'), '3000');
  assert.equal(Buffer.from(await full.arrayBuffer()).equals(BIG), true);
  const r1 = await get(plain, '/big.bin', { headers: { range: 'bytes=0-9' } });
  assert.equal(r1.status, 206);
  assert.equal(r1.headers.get('content-range'), 'bytes 0-9/3000');
  assert.equal(r1.headers.get('content-length'), '10');
  assert.equal(Buffer.from(await r1.arrayBuffer()).equals(BIG.subarray(0, 10)), true);
  const probe = await get(plain, '/clip.mp4', { headers: { range: 'bytes=0-1' } });
  assert.equal(probe.status, 206, 'Safari\'s bytes=0-1 media probe');
  assert.equal(probe.headers.get('content-range'), 'bytes 0-1/3000');
  await probe.arrayBuffer();
  const suffix = await get(plain, '/big.bin', { headers: { range: 'bytes=-5' } });
  assert.equal(suffix.headers.get('content-range'), 'bytes 2995-2999/3000');
  assert.equal(Buffer.from(await suffix.arrayBuffer()).equals(BIG.subarray(2995)), true);
  const open = await get(plain, '/big.bin', { headers: { range: 'bytes=2990-' } });
  assert.equal(open.headers.get('content-range'), 'bytes 2990-2999/3000');
  await open.arrayBuffer();
  const clamped = await get(plain, '/big.bin', { headers: { range: 'bytes=2990-99999' } });
  assert.equal(clamped.headers.get('content-range'), 'bytes 2990-2999/3000');
  await clamped.arrayBuffer();
  const past = await get(plain, '/big.bin', { headers: { range: 'bytes=3000-' } });
  assert.equal(past.status, 416);
  assert.equal(past.headers.get('content-range'), 'bytes */3000');
  await past.arrayBuffer();
  const head = await get(plain, '/big.bin', { method: 'HEAD', headers: { range: 'bytes=0-9' } });
  assert.equal(head.status, 206);
  assert.equal(head.headers.get('content-length'), '10');
  assert.equal((await head.arrayBuffer()).byteLength, 0);
  const multi = await get(plain, '/big.bin', { headers: { range: 'bytes=0-1,5-6' } });
  assert.equal(multi.status, 200, 'several ranges: the whole body');
  await multi.arrayBuffer();
  const empty = await get(plain, '/empty.txt');
  assert.equal(empty.status, 200);
  assert.equal((await empty.arrayBuffer()).byteLength, 0);
});

test('/ws/ web seed: OPTIONS preflight with Allow-Headers *, Expose-Headers, 2xx, for any path', async () => {
  const res = await get(dev, '/ws/my-site/index.html', {
    method: 'OPTIONS',
    headers: { origin: 'https://example.com', 'access-control-request-method': 'GET', 'access-control-request-headers': 'range,cache-control,user-agent' },
  });
  assert.ok(res.status >= 200 && res.status < 300, 'status ' + res.status);
  assert.equal(res.headers.get('access-control-allow-origin'), '*');
  assert.equal(res.headers.get('access-control-allow-headers'), '*');
  assert.match(res.headers.get('access-control-allow-methods'), /GET/);
  assert.equal(res.headers.get('access-control-expose-headers'), 'Content-Range, Content-Length, Accept-Ranges, ETag');
  await res.arrayBuffer();
  const missing = await get(dev, '/ws/does/not/exist', { method: 'OPTIONS' });
  assert.ok(missing.status >= 200 && missing.status < 300, 'preflight succeeds before the file is looked up');
  assert.equal(missing.headers.get('access-control-allow-origin'), '*');
  await missing.arrayBuffer();
  const other = await get(dev, '/index.html', { method: 'OPTIONS' });
  assert.equal(other.headers.get('access-control-allow-origin'), null, 'CORS is for /ws/ only');
  await other.arrayBuffer();
});

test('/ws/ web seed: Range gets 206 with CORS headers; plain GET 200; 404 and 405 carry CORS headers too', async () => {
  const r = await get(dev, '/ws/my-site/index.html', { headers: { range: 'bytes=100-199', origin: 'https://example.com' } });
  assert.equal(r.status, 206);
  assert.equal(r.headers.get('content-range'), 'bytes 100-199/3000');
  assert.equal(r.headers.get('access-control-allow-origin'), '*');
  assert.match(r.headers.get('access-control-expose-headers'), /Content-Range/);
  assert.equal(r.headers.get('accept-ranges'), 'bytes');
  assert.ok(r.headers.get('etag'));
  assert.equal(Buffer.from(await r.arrayBuffer()).equals(BIG.subarray(100, 200)), true);
  const zero = await get(dev, '/ws/my-site/index.html', { headers: { range: 'bytes=0-0' } });
  assert.equal(zero.status, 206);
  assert.equal(zero.headers.get('content-range'), 'bytes 0-0/3000');
  assert.equal((await zero.arrayBuffer()).byteLength, 1);
  const all = await get(dev, '/ws/my-site/index.html');
  assert.equal(all.status, 200);
  assert.equal(all.headers.get('access-control-allow-origin'), '*');
  await all.arrayBuffer();
  const dot = await get(dev, '/ws/my-site/.mw/site.json');
  assert.equal(dot.status, 200, 'dot-directories are part of the web seed');
  assert.equal(await dot.text(), '{"v":1}');
  assert.equal((await get(dev, '/ws/my-site.torrent')).headers.get('content-type'), 'application/x-bittorrent');
  assert.equal((await (await get(dev, '/ws/summary.json')).json()).btih, 'x');
  const nf = await get(dev, '/ws/my-site/nope.html');
  assert.equal(nf.status, 404);
  assert.equal(nf.headers.get('access-control-allow-origin'), '*');
  await nf.arrayBuffer();
  const post = await get(dev, '/ws/my-site/index.html', { method: 'POST' });
  assert.equal(post.status, 405);
  assert.equal(post.headers.get('access-control-allow-origin'), '*');
  await post.arrayBuffer();
  const unreachable = await get(plain, '/ws/my-site/index.html');
  assert.equal(unreachable.status, 404, 'no --webseed: nothing at /ws/');
  await unreachable.arrayBuffer();
});

test('path safety: no traversal, no symbolic link out of the root or the web seed, bad escapes refused', async () => {
  for (const path of ['/..%2f..%2fetc%2fpasswd', '/..%2foutside%2fsecret.txt', '/ws/..%2f..%2foutside%2fsecret.txt', '/a%00b', '/%5c..%5csecret', '/%zz']) {
    const res = await get(dev, path);
    assert.ok(res.status === 400 || res.status === 404, path + ' -> ' + res.status);
    assert.equal((await res.text()).includes('top secret'), false, path);
  }
  // dot segments written as %2e%2e are resolved by the URL parser into an ordinary (unknown) path
  const dots = await get(dev, '/%2e%2e/%2e%2e/outside/secret.txt');
  assert.equal((await dots.text()).includes('top secret'), false);
  const leak = await get(dev, '/leak.txt');
  assert.equal(leak.status === 200 && (await leak.text()) === 'top secret', false, 'a symbolic link leaving the root is not followed');
  const leak2 = await get(dev, '/ws/leakdir/secret.txt');
  assert.equal(leak2.status, 404);
  await leak2.arrayBuffer();
  const raw = await new Promise((resolve) => {
    import('node:net').then(({ default: net }) => {
      const sock = net.connect(dev.port, '127.0.0.1', () => sock.write('GET /../../outside/secret.txt HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n'));
      let data = '';
      sock.on('data', (d) => { data += d; });
      sock.on('close', () => resolve(data));
    });
  });
  assert.equal(raw.includes('top secret'), false);
});

test('--pointer injects <meta name="mw-pointer"> into every HTML page, the SPA fallback and 404 pages, not into other files', async () => {
  for (const path of ['/', '/index.html', '/about.html', '/some/route', '/sub/']) {
    const html = await (await get(dev, path)).text();
    const rec = stampedPointerFromHtml(html);
    assert.ok(rec, path + ' carries the pointer');
    assert.equal(rec.btih, 'a'.repeat(40));
    assert.equal((html.match(/name="mw-pointer"/g) || []).length, 1);
  }
  const head = await (await get(dev, '/')).text();
  assert.match(head, /<meta charset="utf-8"><meta name="mw-pointer"/, 'first in <head>, after the charset declaration');
  assert.equal((await (await get(dev, '/app.js')).text()), 'console.log(1);\n');
  assert.equal((await (await get(dev, '/data.json')).text()), '{"a":1}');
  assert.equal((await (await get(plain, '/')).text()), SHELL, 'no --pointer: the file is served as it is');
  const headReq = await get(dev, '/', { method: 'HEAD' });
  assert.equal(headReq.status, 200);
  assert.equal((await headReq.arrayBuffer()).byteLength, 0);
  assert.equal(Number(headReq.headers.get('content-length')) > SHELL.length, true, 'content-length counts the injected tag');
});

test('--pointer accepts @file and rejects text that is not a pointer', async () => {
  const file = join(work, 'pointer.txt');
  writeFileSync(file, POINTER + '\n');
  const s = await start({ root, pointer: '@' + file });
  assert.equal(stampedPointerFromHtml(await (await get(s, '/')).text()).btih, 'a'.repeat(40));
  await assert.rejects(createDevServer({ root, port: 0, quiet: true, pointer: 'not a pointer' }), UsageError);
  await assert.rejects(createDevServer({ root: join(work, 'nope'), port: 0, quiet: true }), ToolError);
  await assert.rejects(createDevServer({ root, webseed: join(work, 'no', 'such', 'dir'), port: 0, quiet: true }), ToolError);
  // a missing leaf next to an existing parent is created: the directory publish is about to write
  const made = join(work, 'to-be-published');
  const early = await start({ root, webseed: made });
  assert.equal((await get(early, '/ws/summary.json')).status, 404);
  writeFileSync(join(made, 'summary.json'), '{"btih":"late"}');
  assert.equal((await (await get(early, '/ws/summary.json')).json()).btih, 'late');
  await assert.rejects(createDevServer({ root, port: 0, quiet: true, hub: 'sideways' }), UsageError);
});

test('--dev injects <meta name="mw-dev" content="1">, --hub and --doh add their metas; boot.js reads the dev marker', async () => {
  const html = await (await get(dev, '/')).text();
  assert.match(html, /<meta name="mw-dev" content="1">/);
  assert.equal((await (await get(plain, '/')).text()).includes('mw-dev'), false);
  const s = await start({ root, hub: 'shared', doh: 'https://doh.example/dns-query' });
  const page = await (await get(s, '/')).text();
  assert.match(page, /<meta name="mw-hub" content="shared">/);
  assert.match(page, /<meta name="mw-doh" content="https:\/\/doh\.example\/dns-query">/);
  // src/loader/boot.js: boot.dev follows the mw-dev meta and cspFor() then adds the dev sources
  const boot = readFileSync(join(ROOT, 'src', 'loader', 'boot.js'), 'utf8');
  assert.match(boot, /metaContent\('mw-dev'\)/);
  assert.match(boot, /ws:\/\/127\.0\.0\.1:\*/);
  assert.match(boot, /ws:\/\/localhost:\*/);
  assert.match(boot, /wss:\/\/' \+ lanHost \+ ':\*/);
});

test('dotfiles of the served project are hidden, except .well-known and .mw', async () => {
  for (const path of ['/.env', '/.git/config', '/.git/', '/sub/.hidden']) {
    const res = await get(plain, path);
    assert.equal(res.status, 404, path);
    assert.equal((await res.text()).includes('SECRET'), false, path);
  }
  assert.equal(await (await get(plain, '/.well-known/security.txt')).text(), 'Contact: a@example.com');
  assert.equal(await (await get(plain, '/.mw/site.json')).text(), '{"v":1}', 'the routing manifest of a drop-in deploy copy');
});

test('the kill switch worker can be swapped in for /mw-sw.js while the server runs (DESIGN-REVIEW item 20)', async () => {
  const s = await start({ root });
  assert.equal(await (await get(s, '/mw-sw.js')).text(), '// service worker\n');
  s.killSwitch();
  const killed = await get(s, '/mw-sw.js');
  assert.equal(await killed.text(), '// kill switch\n');
  assert.equal(killed.headers.get('content-type'), 'text/javascript; charset=utf-8');
  assert.equal(killed.headers.get('cache-control'), 'no-cache');
  s.killSwitch(false);
  assert.equal(await (await get(s, '/mw-sw.js')).text(), '// service worker\n');
  s.override('/data.json', join(root, 'app.js'));
  assert.equal(await (await get(s, '/data.json')).text(), 'console.log(1);\n');
  s.override('/data.json', null);
  assert.equal(await (await get(s, '/data.json')).text(), '{"a":1}');
  const preset = await start({ root, overrides: { '/style.css': join(root, 'app.js') } });
  assert.equal(await (await get(preset, '/style.css')).text(), 'console.log(1);\n');
});

test('directories: /sub redirects to /sub/, which serves sub/index.html; names with spaces are decoded', async () => {
  const redirect = await get(plain, '/sub', { redirect: 'manual' });
  assert.equal(redirect.status, 301);
  assert.equal(redirect.headers.get('location'), '/sub/');
  await redirect.arrayBuffer();
  assert.match(await (await get(plain, '/sub/')).text(), /Sub/);
  assert.equal(await (await get(plain, '/some%20file.txt')).text(), 'spaces');
});

test('code review round 1: /.//sub redirects to /sub/, never to the scheme-relative //sub/', async () => {
  const http = await import('node:http');
  const port = new URL(plain.url).port;
  for (const raw of ['/.//sub', '//sub', '/./sub']) {
    const res = await new Promise((resolve, reject) => {
      const req = http.request({ host: '127.0.0.1', port, path: raw, method: 'GET' }, resolve);
      req.on('error', reject);
      req.end();
    });
    res.resume();
    assert.equal(res.statusCode, 301, raw);
    assert.equal(res.headers.location, '/sub/', raw + ' -> ' + res.headers.location);
  }
});

test('close() frees the port and ends keep-alive connections', async () => {
  const s = await createDevServer({ root, port: 0, quiet: true });
  const res = await get(s, '/app.js');
  await res.arrayBuffer();
  const port = s.port;
  await s.close();
  await assert.rejects(fetch('http://127.0.0.1:' + port + '/'), /fetch failed/);
});

test('--tls serves https with the certificate files given (self-signed here, made with openssl when present)', async (t) => {
  const certDir = join(work, 'certs');
  mkdirSync(certDir);
  const made = spawnSync('openssl', ['req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:prime256v1', '-nodes', '-keyout', join(certDir, 'key.pem'),
    '-out', join(certDir, 'cert.pem'), '-days', '1', '-subj', '/CN=localhost', '-addext', 'subjectAltName=DNS:localhost,IP:127.0.0.1'], { encoding: 'utf8' });
  if (made.status !== 0) {
    t.skip('openssl is not available');
    return;
  }
  const s = await start({ root, tls: { cert: join(certDir, 'cert.pem'), key: join(certDir, 'key.pem') } });
  assert.match(s.url, /^https:\/\/127\.0\.0\.1:\d+\/$/);
  const body = await new Promise((resolve, reject) => {
    https.get(s.url + 'app.js', { ca: readFileSync(join(certDir, 'cert.pem')), servername: 'localhost' }, (res) => {
      let data = '';
      res.on('data', (d) => { data += d; });
      res.on('end', () => resolve(data));
    }).on('error', reject);
  });
  assert.equal(body, 'console.log(1);\n');
  await assert.rejects(createDevServer({ root, port: 0, quiet: true, tls: { cert: join(certDir, 'cert.pem'), key: null } }), /certificate and a key/);
});

test('--tls without certificates and without mkcert explains how to get them', async () => {
  const saved = process.env.PATH;
  process.env.PATH = '';
  try {
    await assert.rejects(
      createDevServer({ root, port: 0, quiet: true, tls: true, host: '127.0.0.1' }),
      (err) => err instanceof ToolError && /mkcert/.test(err.message) && /--tls/.test(err.message),
    );
  } finally {
    process.env.PATH = saved;
  }
});

test('command line: --port 0 prints the URL, serves, and stops on SIGTERM; bad flags exit 2', async () => {
  const child = spawn(process.execPath, ['tools/dev-server.mjs', '--root', root, '--port', '0', '--dev', '--webseed', seed], { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  const url = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('no URL printed: ' + out)), 8000);
    child.stdout.on('data', (d) => {
      out += d;
      const m = /(http:\/\/127\.0\.0\.1:\d+\/)/.exec(out);
      if (m) {
        clearTimeout(timer);
        resolve(m[1]);
      }
    });
    child.once('exit', (code) => reject(new Error('exited early ' + code + ': ' + out)));
  });
  child.removeAllListeners('exit');
  const res = await fetch(url + 'ws/summary.json');
  assert.equal(res.status, 200);
  await res.arrayBuffer();
  const exited = new Promise((resolve) => child.once('exit', (code, signal) => resolve({ code, signal })));
  child.kill('SIGTERM');
  const { code } = await exited;
  assert.equal(code, 0);
  assert.match(out, /dev mode/);
  const bad = spawnSync(process.execPath, ['tools/dev-server.mjs', '--bogus'], { cwd: ROOT, encoding: 'utf8' });
  assert.equal(bad.status, 2);
  assert.equal(parsePointer(POINTER).ok, true);
});

test('F7 (v0.2.1): a root without /_mw/sdk.js gets the static SDK stub there; a root with its own file keeps it', async () => {
  const plainRoot = join(work, 'plain-site-' + Date.now());
  write(plainRoot, { 'index.html': '<!doctype html><title>plain</title>', 'js/app.js': 'import("/_mw/sdk.js")' });
  const s = await start({ root: plainRoot });
  const res = await fetch(s.url + '_mw/sdk.js');
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type'), /javascript/);
  const code = await res.text();
  assert.match(code, /mode: STATIC|'static'/);
  assert.match(code, /export default mw/);
  const other = await fetch(s.url + '_mw/other.js');
  assert.equal(other.status, 404, 'only /_mw/sdk.js has a stub');
  await other.arrayBuffer();
  const ownRoot = join(work, 'own-sdk-' + Date.now());
  write(ownRoot, { 'index.html': '<!doctype html><title>own</title>', '_mw/sdk.js': 'export default "real";\n' });
  const s2 = await start({ root: ownRoot });
  assert.equal(await (await fetch(s2.url + '_mw/sdk.js')).text(), 'export default "real";\n');
});
