// Unit tests for the v0.2.1 publishing discipline (DIGEST-AMENDMENTS E1 to E4, F4, B4 tool side):
// tools/publish-policy.mjs as pure functions, and tools/publish.mjs end to end: the path policy, the
// dot-file table, budget gates and the size report, the secrets and personal-data lint, --from-wxr,
// the deterministic pack (--date, --double-pack), the open-ledger contact warning and --verify-host.
// No network except 127.0.0.1 servers on ephemeral ports, closed in after().
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, utimesSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';

import { publish, resolveCreationDate, buildTorrent, collectSite, ignoreReason, stampHtml } from '../../tools/publish.mjs';
import {
  lintPaths, pathProblems, dotPathReason, budgetReport, lintSecrets, importWxr, commentText, BUDGET, RESERVED_PATHS,
} from '../../tools/publish-policy.mjs';
import { keygen } from '../../tools/keygen.mjs';
import { ToolError, UsageError } from '../../tools/lib.mjs';
import { parseTorrentFile } from '../../src/common/torrent-file.js';
import { decode as bdecode } from '../../src/common/bencode.js';
import { parsePointer } from '../../src/common/pointer.js';

const work = mkdtempSync(join(tmpdir(), 'mw-publish-v021-'));
const servers = [];
after(async () => {
  for (const s of servers) await s.close();
  rmSync(work, { recursive: true, force: true });
});
let counter = 0;
const fresh = (label) => {
  const dir = join(work, label + '-' + ++counter);
  mkdirSync(dir, { recursive: true });
  return dir;
};
const NOW = Date.UTC(2026, 9, 19, 12, 0, 30);

function writeTree(root, files) {
  for (const [path, content] of Object.entries(files)) {
    const abs = join(root, ...path.split('/'));
    mkdirSync(join(abs, '..'), { recursive: true });
    writeFileSync(abs, content);
  }
}

const BASE_SITE = {
  'index.html': '<!doctype html><html><head><title>Home</title></head><body><h1>Home</h1></body></html>\n',
  'css/app.css': 'body { margin: 0 }\n',
  'js/app.js': 'console.log("hi");\n',
};

function site(extra = {}) {
  const dir = fresh('site');
  writeTree(dir, Object.assign({}, BASE_SITE, extra));
  return dir;
}

let keyFile = null;
async function key() {
  if (!keyFile) {
    keyFile = join(work, 'owner.jwk');
    await keygen({ out: keyFile });
  }
  return keyFile;
}

async function run(extra = {}) {
  return publish(Object.assign({
    dir: extra.dir || site(), name: 'v021-site', scope: 'example.com', key: await key(), tr: ['wss://tracker.example'], ws: ['https://static.example/ws/'],
    out: fresh('out'), now: NOW, quiet: true, env: {},
  }, extra));
}

function fakeDist() {
  const dist = fresh('dist');
  writeTree(dist, {
    'mw-sw.js': '// sw\n',
    'mw-sw-kill.js': '// kill\n',
    '_mw/mw.js': '// mw\n',
    '_mw/sdk.js': '// sdk\n',
  });
  return dist;
}

async function listen(handler) {
  const server = http.createServer(handler);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const entry = { url: 'http://127.0.0.1:' + server.address().port, close: () => new Promise((r) => { server.closeAllConnections(); server.close(r); }) };
  servers.push(entry);
  return entry;
}

// ---------------------------------------------------------------------------------------------- E1: path policy

test('E1 lintPaths: ? # % \\ and control characters, dot segments, trailing dots and spaces, long names, twins, reserved paths', () => {
  const r = lintPaths([
    'css/style.css', 'css/style.css?ver=6.4.2', 'img/a#b.png', 'img/100%.png', 'img\\dir.png', 'a/../b.png', 'tab\there.txt',
    'trailing./x.txt', ' lead.txt', 'x/' + 'y'.repeat(256) + '.txt', 'img/IMG_001.JPG', 'img/img_001.jpg', 'café/i.html', 'café/i.html',
    '_mw/sdk.js', 'mw-sw.js', 'ws/site/a.js', 'wsx/ok.js', 'style.css@ver=6.4.2',
  ]);
  const bad = (p) => r.errors.filter((e) => e.path === p).map((e) => e.why).join(' | ');
  assert.equal(bad('css/style.css'), '');
  assert.match(bad('css/style.css?ver=6.4.2'), /character "\?"/);
  assert.match(bad('img/a#b.png'), /character "#"/);
  assert.match(bad('img/100%.png'), /character "%"/);
  assert.match(bad('img\\dir.png'), /character "\\\\"/);
  assert.match(bad('a/../b.png'), /dot segment/);
  assert.match(bad('tab\there.txt'), /control character U\+0009/);
  assert.match(bad('trailing./x.txt'), /trailing dot/);
  assert.match(bad(' lead.txt'), /leading or trailing space/);
  assert.match(bad('x/' + 'y'.repeat(256) + '.txt'), /longer than 255 bytes/);
  assert.match(bad('img/img_001.jpg'), /twin of "img\/IMG_001\.JPG"/);
  assert.match(bad('café/i.html'), /twin of "café\/i\.html"/, 'NFC and NFD spellings collide');
  assert.match(bad('_mw/sdk.js'), /reserved by felinar/);
  assert.match(bad('mw-sw.js'), /reserved by felinar/);
  assert.match(bad('ws/site/a.js'), /reserved by felinar/);
  assert.equal(bad('wsx/ok.js'), '', 'only the ws/ directory is reserved');
  assert.equal(bad('style.css@ver=6.4.2'), '', 'a legal name (wget windows mode) passes; links to it need the same spelling');
  assert.deepEqual(r.renames, [{ from: 'café/i.html', to: 'café/i.html' }]);
  assert.ok(pathProblems('a:b.txt').warnings.some((w) => /reserved on Windows/.test(w)), 'Windows-reserved characters warn');
  assert.deepEqual(RESERVED_PATHS.prefixes, ['_mw/', '.mw/', 'ws/']);
  assert.match(pathProblems('a'.repeat(1030)).errors.join(' '), /1,024 bytes/);
});

test('E1 dot-file table: every dot path has a stated reason; --include-dot publishes some, never secrets or VCS data', () => {
  assert.match(dotPathReason('.git/config', false), /version control/);
  assert.match(dotPathReason('.git', true), /version control/);
  assert.match(dotPathReason('.env', false), /environment file/);
  assert.match(dotPathReason('.env.production', false), /environment file/);
  assert.match(dotPathReason('.github', true), /tooling/);
  assert.match(dotPathReason('.htaccess', false), /host configuration/);
  assert.match(dotPathReason('.nojekyll', false), /host configuration/);
  assert.match(dotPathReason('.well-known', true), /serve \/\.well-known\/ from the host/);
  assert.match(dotPathReason('.mw', true), /reserved/);
  assert.match(dotPathReason('.DS_Store', false), /OS junk/);
  assert.match(dotPathReason('blog/.hidden.txt', false), /dotfile \(not published; --include-dot blog\/\.hidden\.txt publishes it\)/);
  assert.match(dotPathReason('a/.cache', true), /tooling/);
  assert.equal(dotPathReason('docs/readme.md', false), null);
  assert.equal(dotPathReason('blog/.hidden.txt', false, { includeDot: ['blog/.hidden.txt'] }), null);
  assert.equal(dotPathReason('.config', true, { includeDot: ['.config/app.json'] }), null, 'the directory of an included file is walked');
  assert.match(dotPathReason('.env', false, { includeDot: ['.env'] }), /environment file/, '.env is never published');
  assert.match(dotPathReason('.git', true, { includeDot: ['.git'] }), /version control/);
  assert.match(ignoreReason('a/.hidden/b.txt', false) || '', /dotfile/);
});

test('E1 publish: refuses a path that breaks web-seed URLs or a reserved path, before anything is written', async () => {
  const out = fresh('out');
  await assert.rejects(run({ dir: site({ 'css/style.css?ver=6.4.2': 'x' }), out }), (err) => err instanceof ToolError && /path policy/.test(err.message) && /style\.css\?ver=6\.4\.2/.test(err.message));
  assert.deepEqual(readdirSync(out), [], 'nothing was written');
  await assert.rejects(run({ dir: site({ 'ws/data.json': '{}' }) }), /reserved by felinar/);
  await assert.rejects(run({ dir: site({ '_mw/x.js': '1' }) }), /reserved by felinar/);
  await assert.rejects(run({ dir: site({ '.mw/site.json': '{}' }) }), /\.mw\/ exists, and \/\.mw\/ is reserved/);
});

test('E1 publish: an NFD file name is published under its NFC spelling (torrent and drop-in deploy copy), with a warning', async () => {
  const dir = site({ ['café.css']: 'p { color: red }\n' });
  const res = await run({ dir });
  assert.ok(res.files.some((f) => f.path === 'café.css'), 'the torrent uses NFC');
  assert.equal(res.files.some((f) => f.path === 'café.css'), false);
  assert.ok(res.warnings.some((w) => /NFC/.test(w)));
  const drop = await run({ dir, dropin: true, dist: fakeDist(), ws: [] });
  const names = readdirSync(join(drop.outDir, 'site'));
  assert.ok(names.some((n) => n.normalize('NFC') === 'café.css'));
  assert.ok(existsSync(join(drop.outDir, 'site', 'café.css')));
});

test('E1 publish: dropped dot paths are listed with reasons in summary.json; --include-dot publishes one', async () => {
  const dir = site({
    '.env': 'SECRET=1\n', '.git/config': '[core]\n', '.github/workflows/ci.yml': 'on: push\n', '.htaccess': 'Options -Indexes\n',
    '.well-known/security.txt': 'Contact: mailto:a@example.com\n', 'blog/.notes.txt': 'draft\n', '.prettierrc': '{}\n',
  });
  const res = await run({ dir });
  const dropped = res.summary.dropped;
  const reason = (p) => (dropped.find((d) => d.path === p) || {}).reason || '';
  assert.match(reason('.env'), /environment file/);
  assert.match(reason('.git/'), /version control/);
  assert.match(reason('.github/'), /tooling/);
  assert.match(reason('.htaccess'), /host configuration/);
  assert.match(reason('.well-known/'), /from the host/);
  assert.match(reason('blog/.notes.txt'), /--include-dot blog\/\.notes\.txt/);
  assert.match(reason('.prettierrc'), /tooling configuration/);
  for (const d of dropped) assert.equal(res.files.some((f) => f.path === d.path), false);
  const inc = await run({ dir, includeDot: ['blog/.notes.txt'] });
  assert.ok(inc.files.some((f) => f.path === 'blog/.notes.txt'), '--include-dot publishes it');
  const s = collectSite(dir, { includeDot: ['blog/.notes.txt'] });
  assert.ok(s.torrent.some((f) => f.path === 'blog/.notes.txt'));
});

// ---------------------------------------------------------------------------------------------- E2: budget gates

test('E2 budgetReport: file count, metadata, the loader .torrent cap, visitor caps and host profiles', () => {
  const limits = { desktop: 128 * 1024 * 1024, mobile: 48 * 1024 * 1024, cellular: 24 * 1024 * 1024 };
  const small = budgetReport({ files: [{ path: 'a.js', length: 10 }], torrentBytes: 300, pieceCount: 1, xs: true, limits });
  assert.deepEqual(small.errors, []);
  assert.deepEqual(small.warnings, []);
  assert.ok(small.lines.some((l) => /^files {7}1$/.test(l)));
  assert.ok(small.lines.some((l) => /^hosts .*Cloudflare Pages \(free\): fits/.test(l)));
  const many = Array.from({ length: BUDGET.warnFiles }, (_, i) => ({ path: 'f' + i, length: 1 }));
  assert.match(budgetReport({ files: many, torrentBytes: 1000, xs: true, limits }).warnings.join(' '), /5000 files/);
  const tooMany = Array.from({ length: 20001 }, (_, i) => ({ path: 'f' + i, length: 1 }));
  assert.match(budgetReport({ files: tooMany, torrentBytes: 1000, xs: true, limits }).errors.join(' '), /more than 20000/);
  assert.deepEqual(budgetReport({ files: tooMany, torrentBytes: 1000, xs: true, limits, maxFiles: 30000 }).errors, [], '--max-files raises the limit');
  assert.match(budgetReport({ files: [{ path: 'a', length: 1 }], torrentBytes: 1500000, xs: true, limits }).warnings.join(' '), /warn at 1 MB/);
  assert.match(budgetReport({ files: [{ path: 'a', length: 1 }], torrentBytes: 9 * 1024 * 1024, xs: true, limits }).errors.join(' '), /loader refuses a \.torrent above 8(\.0)? MiB/);
  const big = [{ path: 'video.mp4', length: 200 * 1024 * 1024 }];
  assert.match(budgetReport({ files: big, torrentBytes: 20000, xs: true, mode: 'shell', limits }).errors.join(' '), /every visitor refuses/);
  const dropin = budgetReport({ files: big, torrentBytes: 20000, xs: true, mode: 'dropin', limits });
  assert.deepEqual(dropin.errors, [], 'drop-in pages still load from the host');
  assert.match(dropin.warnings.join(' '), /no visitor completes a copy/);
  assert.ok(dropin.lines.some((l) => /Cloudflare Pages \(free\): NO \(largest file above 25 MiB\)/.test(l)));
  const phones = budgetReport({ files: [{ path: 'a.bin', length: 60 * 1024 * 1024 }], torrentBytes: 5000, xs: true, limits });
  assert.match(phones.warnings.join(' '), /phones refuse/);
  assert.ok(phones.lines.some((l) => /mobile Wi-Fi NO/.test(l)));
});

test('E2 publish: a size report in summary.json; --max-files refuses a site above it', async () => {
  const res = await run();
  assert.ok(Array.isArray(res.summary.size.report) && res.summary.size.report.length >= 5);
  assert.equal(res.summary.size.files, res.files.length);
  assert.ok(res.summary.size.torrentBytes > 0);
  await assert.rejects(run({ maxFiles: 2 }), (err) => err instanceof ToolError && /budget/.test(err.message) && /more than 2/.test(err.message));
});

// ---------------------------------------------------------------------------------------------- E3: secrets and PII

test('E3 lintSecrets: key, dump and backup files by name; private keys and tokens inside files; WordPress exports with PII', () => {
  const txt = (s) => Buffer.from(s);
  const entries = [
    { path: 'wp-config.php.bak', bytes: txt('<?php define("DB_PASSWORD", "x");') },
    { path: 'keys/server.pem', bytes: txt('cert') },
    { path: 'home/id_rsa', bytes: txt('k') },
    { path: 'home/id_rsa.pub', bytes: txt('ssh-rsa AAAA') },
    { path: 'db/site.sql', bytes: txt('INSERT') },
    { path: 'old/site-backup-2024.zip', bytes: Buffer.from([0x50, 0x4b, 0, 0]) },
    { path: 'downloads/brochure.zip', bytes: Buffer.from([0x50, 0x4b, 0, 0]) },
    { path: 'js/config.js', bytes: txt('const k = "-----BEGIN RSA PRIVATE KEY-----\\nMIIE";') },
    { path: 'js/aws.js', bytes: txt('const id = "AKIAABCDEFGHIJKLMNOP";') },
    { path: 'js/gh.js', bytes: txt('token = "ghp_' + 'a'.repeat(36) + '"') },
    { path: 'owner.json', bytes: txt('{"crv":"P-256","d":"' + 'x'.repeat(43) + '","kty":"EC","x":"y"}') },
    { path: 'export.xml', bytes: txt('<rss xmlns:wp="http://wordpress.org/export/1.2/"><wp:comment_author_email><![CDATA[a@b.c]]></wp:comment_author_email></rss>') },
    { path: 'clean.xml', bytes: txt('<rss xmlns:wp="http://wordpress.org/export/1.2/"><wp:comment_author_email></wp:comment_author_email></rss>') },
    { path: 'js/maps.js', bytes: txt('key=AIza' + 'b'.repeat(35)) },
    { path: 'img/photo.png', bytes: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 1, 2]) },
  ];
  const r = lintSecrets(entries);
  const hit = (p) => r.errors.filter((e) => e.path === p).map((e) => e.why).join(' | ');
  assert.match(hit('wp-config.php.bak'), /WordPress configuration/);
  assert.match(hit('keys/server.pem'), /private key/);
  assert.match(hit('home/id_rsa'), /SSH private key/);
  assert.equal(hit('home/id_rsa.pub'), '', 'a public key is not a secret');
  assert.match(hit('db/site.sql'), /database dump/);
  assert.match(hit('old/site-backup-2024.zip'), /backup archive/);
  assert.equal(hit('downloads/brochure.zip'), '');
  assert.match(hit('js/config.js'), /PEM private key/);
  assert.match(hit('js/aws.js'), /AWS access key/);
  assert.match(hit('js/gh.js'), /GitHub token/);
  assert.match(hit('owner.json'), /private JWK/);
  assert.match(hit('export.xml'), /WordPress export with commenter e-mail or IP/);
  assert.equal(hit('clean.xml'), '', 'an export without addresses passes');
  assert.equal(hit('js/maps.js'), '', 'a browser Google key only warns');
  assert.ok(r.warnings.some((w) => w.path === 'js/maps.js'));
  assert.equal(hit('img/photo.png'), '');
  const allowed = lintSecrets([{ path: 'keys/server.pem', bytes: txt('cert') }], { allow: ['keys/server.pem'] });
  assert.deepEqual(allowed.errors, []);
  assert.match(allowed.warnings[0].why, /allowed by --allow-secret/);
});

test('E3 publish: refuses a site with a secret before writing anything; --allow-secret lets a checked file through', async () => {
  const out = fresh('out');
  const dir = site({ 'downloads/db-dump.sql': 'INSERT INTO users' });
  await assert.rejects(run({ dir, out }), (err) => err instanceof ToolError && /secrets or personal data/.test(err.message) && /downloads\/db-dump\.sql: database dump/.test(err.message));
  assert.deepEqual(readdirSync(out), []);
  const ok = await run({ dir, allowSecret: ['downloads/db-dump.sql'] });
  assert.ok(ok.files.some((f) => f.path === 'downloads/db-dump.sql'));
  assert.ok(ok.warnings.some((w) => /allowed by --allow-secret/.test(w)));
  // drop-in: the pages of the deploy copy are scanned too
  const page = site({ 'about.html': '<p>-----BEGIN OPENSSH PRIVATE KEY-----</p>' });
  await assert.rejects(run({ dir: page, dropin: true, dist: fakeDist(), ws: [] }), /about\.html: contains a PEM private key/);
});

const WXR = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:wp="http://wordpress.org/export/1.2/" xmlns:content="http://purl.org/rss/1.0/modules/content/">
<channel><wp:wxr_version>1.2</wp:wxr_version>
<item><title>Hello world</title><link>https://example.com/hello-world/</link><wp:post_id>12</wp:post_id><wp:post_name><![CDATA[hello-world]]></wp:post_name><wp:status><![CDATA[publish]]></wp:status>
<wp:comment><wp:comment_id>1</wp:comment_id><wp:comment_author><![CDATA[Ana]]></wp:comment_author><wp:comment_author_email><![CDATA[ana@example.org]]></wp:comment_author_email><wp:comment_author_url>https://ana.example.org</wp:comment_author_url><wp:comment_author_IP><![CDATA[203.0.113.7]]></wp:comment_author_IP><wp:comment_date_gmt><![CDATA[2024-01-02 03:04:05]]></wp:comment_date_gmt><wp:comment_content><![CDATA[<p>Nice &amp; <b>clear</b> post<script>alert(1)</script></p>]]></wp:comment_content><wp:comment_approved><![CDATA[1]]></wp:comment_approved><wp:comment_type><![CDATA[comment]]></wp:comment_type><wp:comment_parent>0</wp:comment_parent></wp:comment>
<wp:comment><wp:comment_id>2</wp:comment_id><wp:comment_author><![CDATA[Bo]]></wp:comment_author><wp:comment_author_email>bo@example.org</wp:comment_author_email><wp:comment_author_IP>198.51.100.9</wp:comment_author_IP><wp:comment_content><![CDATA[Reply]]></wp:comment_content><wp:comment_approved>1</wp:comment_approved><wp:comment_type></wp:comment_type><wp:comment_parent>1</wp:comment_parent></wp:comment>
<wp:comment><wp:comment_id>3</wp:comment_id><wp:comment_author>Spammer</wp:comment_author><wp:comment_author_email>s@spam.example</wp:comment_author_email><wp:comment_author_IP>192.0.2.1</wp:comment_author_IP><wp:comment_content>buy</wp:comment_content><wp:comment_approved>spam</wp:comment_approved></wp:comment>
<wp:comment><wp:comment_id>4</wp:comment_id><wp:comment_author>Pending</wp:comment_author><wp:comment_author_email>p@example.org</wp:comment_author_email><wp:comment_content>wait</wp:comment_content><wp:comment_approved>0</wp:comment_approved></wp:comment>
<wp:comment><wp:comment_id>5</wp:comment_id><wp:comment_author>Blog</wp:comment_author><wp:comment_content>linked</wp:comment_content><wp:comment_approved>1</wp:comment_approved><wp:comment_type>pingback</wp:comment_type></wp:comment>
</item>
<item><title>Draft</title><wp:post_id>13</wp:post_id><wp:post_name>draft</wp:post_name><wp:status>draft</wp:status>
<wp:comment><wp:comment_id>6</wp:comment_id><wp:comment_author>Early</wp:comment_author><wp:comment_author_email>e@example.org</wp:comment_author_email><wp:comment_content>first</wp:comment_content><wp:comment_approved>1</wp:comment_approved></wp:comment>
</item>
<item><title>Café</title><wp:post_id>14</wp:post_id><wp:post_name>%c3%a9t%c3%a9</wp:post_name><wp:status>publish</wp:status>
<wp:comment><wp:comment_id>7</wp:comment_id><wp:comment_author>C</wp:comment_author><wp:comment_content>ok</wp:comment_content><wp:comment_approved>1</wp:comment_approved></wp:comment>
</item>
</channel></rss>`;

test('E3 importWxr: approved comments as plain text, no e-mail or IP anywhere, pending, spam, pingbacks and drafts dropped', () => {
  const r = importWxr(WXR);
  assert.deepEqual(r.stats, { posts: 2, comments: 3, emails: 5, ips: 3, unapproved: 2, pingbacks: 1, unpublished: 1 });
  const paths = r.files.map((f) => f.path);
  assert.deepEqual(paths, ['comments/hello-world.json', 'comments/index.json', 'comments/post-14.json']);
  const all = r.files.map((f) => f.bytes.toString('utf8')).join('\n');
  for (const secret of ['ana@example.org', 'bo@example.org', '203.0.113.7', '198.51.100.9', '@example', 'Spammer', 'Pending', 'Early']) {
    assert.equal(all.includes(secret), false, secret + ' is not published');
  }
  const hello = JSON.parse(r.files[0].bytes.toString('utf8'));
  assert.equal(hello.post.slug, 'hello-world');
  assert.equal(hello.post.link, 'https://example.com/hello-world/');
  assert.deepEqual(hello.comments.map((c) => [c.id, c.parent, c.author]), [['1', '0', 'Ana'], ['2', '1', 'Bo']]);
  assert.equal(hello.comments[0].text, 'Nice & clear post', 'tags and scripts are dropped, entities decoded');
  assert.equal(hello.comments[0].url, 'https://ana.example.org');
  assert.equal(commentText('a<br>b<p>c</p>'), 'a\nb\n\nc', 'a line break and a paragraph');
  assert.throws(() => importWxr('<rss></rss>'), /not a WordPress export/);
  assert.equal(lintSecrets(r.files).errors.length, 0, 'the import passes the lint');
});

test('E3 publish --from-wxr: comments/ goes into the torrent (and the drop-in deploy copy), the dropped fields are printed', async () => {
  const wxrFile = join(fresh('wxr'), 'export.xml');
  writeFileSync(wxrFile, WXR);
  const res = await run({ fromWxr: wxrFile });
  assert.ok(res.files.some((f) => f.path === 'comments/hello-world.json'));
  assert.deepEqual(res.summary.wxr.emails, 5);
  const drop = await run({ fromWxr: wxrFile, dropin: true, dist: fakeDist(), ws: [] });
  assert.ok(existsSync(join(drop.outDir, 'site', 'comments', 'index.json')));
  await assert.rejects(run({ dir: site({ 'comments/x.json': '{}' }), fromWxr: wxrFile }), /already has comments\/x\.json/);
  await assert.rejects(run({ fromWxr: wxrFile, wxrDir: '_mw' }), /--wxr-dir/);
  // a raw export inside the site is refused
  await assert.rejects(run({ dir: site({ 'data/export.xml': WXR }) }), /WordPress export with commenter e-mail/);
});

// ---------------------------------------------------------------------------------------------- E4: deterministic pack

test('E4 resolveCreationDate: --date (ISO or seconds), SOURCE_DATE_EPOCH, the git commit time, else none', () => {
  assert.deepEqual(resolveCreationDate({ date: '2026-10-01T00:00:00Z', env: {} }), { seconds: 1790812800, source: 'flag' });
  assert.deepEqual(resolveCreationDate({ date: '1790812800', env: {} }), { seconds: 1790812800, source: 'flag' });
  assert.deepEqual(resolveCreationDate({ env: { SOURCE_DATE_EPOCH: '1700000000' } }), { seconds: 1700000000, source: 'SOURCE_DATE_EPOCH' });
  assert.deepEqual(resolveCreationDate({ dir: fresh('not-git'), env: {} }), { seconds: null, source: null });
  assert.throws(() => resolveCreationDate({ date: '0', env: {} }), UsageError);
  assert.throws(() => resolveCreationDate({ date: 'yesterday', env: {} }), UsageError);
  const repo = fresh('repo');
  writeFileSync(join(repo, 'index.html'), 'x');
  const git = (...args) => spawnSync('git', args, {
    cwd: repo, encoding: 'utf8',
    env: Object.assign({}, process.env, { GIT_AUTHOR_DATE: '2025-05-05T05:05:05Z', GIT_COMMITTER_DATE: '2025-05-05T05:05:05Z', GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' }),
  });
  if (git('init', '-q').status === 0 && git('add', '.').status === 0 && git('commit', '-q', '-m', 'x').status === 0) {
    assert.deepEqual(resolveCreationDate({ dir: repo, env: {} }), { seconds: Date.parse('2025-05-05T05:05:05Z') / 1000, source: 'git' });
  }
});

test('E4 double-pack: two copies of a site (other paths, creation order and mtimes) give identical .torrent bytes with --date', async () => {
  const files = Object.assign({}, BASE_SITE, { 'img/a.bin': Buffer.alloc(300000, 3), 'z/last.txt': 'z\n', 'a/first.txt': 'a\n' });
  const one = fresh('copy-one');
  writeTree(one, files);
  const two = fresh('copy-two');
  const reversed = {};
  for (const k of Object.keys(files).reverse()) reversed[k] = files[k];
  writeTree(two, reversed);
  utimesSync(join(two, 'z', 'last.txt'), new Date(0), new Date(1000));
  const date = '2026-10-01T00:00:00Z';
  const a = await run({ dir: one, date, name: 'pack' });
  const b = await run({ dir: two, date, name: 'pack' });
  assert.equal(a.btih, b.btih);
  assert.equal(Buffer.from(a.torrentFile).equals(Buffer.from(b.torrentFile)), true, 'identical .torrent bytes');
  const { value } = bdecode(a.torrentFile);
  assert.equal(value['creation date'], Date.parse(date) / 1000, 'the creation date is the input, never the clock');
  assert.equal(a.summary.creationDateSource, 'flag');
  const plain = await run({ dir: one, name: 'pack' });
  assert.equal(plain.btih, a.btih, 'the date is outside info: same infohash');
  assert.equal(bdecode(plain.torrentFile).value['creation date'], undefined, 'no date given: none in the file');
  const checked = await run({ dir: one, date, name: 'pack', doublePack: true });
  assert.equal(checked.btih, a.btih);
  const t = await buildTorrent({ name: 'x', entries: [{ path: 'a', bytes: Buffer.from('a') }, { path: 'b', bytes: Buffer.from('b') }], creationDate: 1234 });
  assert.equal(bdecode(t.torrentFile).value['creation date'], 1234);
  assert.equal(bdecode(t.torrentFile).value['created by'] instanceof Uint8Array, true);
  assert.equal(Buffer.from(bdecode(t.torrentFile).value['created by']).toString(), 'felinar');
  assert.equal((await parseTorrentFile(t.torrentFile)).announce.length, 0, 'no default trackers');
});

// ---------------------------------------------------------------------------------------------- F4: owner duties

test('F4: an open ledger without a ct= contact warns; --ct puts the contact into the signed pointer', async () => {
  const open = await run({ policy: 'open', cs: 'https://static.example/genesis.json' });
  assert.ok(open.warnings.some((w) => /writers=open/.test(w) && /--ct/.test(w)));
  const withCt = await run({ policy: 'open', cs: 'https://static.example/genesis.json', ct: 'mailto:abuse@example.com', aud: 'general' });
  assert.equal(withCt.warnings.some((w) => /writers=open/.test(w) && /--ct/.test(w)), false);
  const rec = parsePointer(withCt.pointer).record;
  assert.equal(rec.ct, 'mailto:abuse@example.com');
  assert.equal(rec.aud, 'general');
  const owner = await run();
  assert.equal(owner.warnings.some((w) => /--ct/.test(w)), false, 'an owner-only ledger needs no contact warning');
  await assert.rejects(run({ ct: 'javascript:alert(1)' }), /--ct must be an https: or mailto: URL/);
  await assert.rejects(run({ aud: 'everyone' }), /--aud must be/);
});

// ---------------------------------------------------------------------------------------------- B4: --verify-host

test('B4 publish --verify-host: the pointer is withheld until the live host serves browsers the torrent bytes', async () => {
  const dir = site({ 'img/logo.png': Buffer.alloc(2000, 9) });
  const dist = fakeDist();
  const first = await run({ dir, dropin: true, dist, ws: [], scope: '127.0.0.1' });
  const hostRoot = join(first.outDir, 'site');
  let transform = false;
  const host = await listen((req, res) => {
    const rel = decodeURIComponent(new URL(req.url, 'http://x').pathname).replace(/^\//, '');
    const file = join(hostRoot, ...rel.split('/'));
    if (!rel || !existsSync(file)) {
      res.writeHead(404);
      return res.end();
    }
    let data = readFileSync(file);
    if (transform && rel === 'img/logo.png' && /image\/avif/.test(req.headers.accept || '')) {
      data = Buffer.from(data);
      data[10] ^= 1;
    }
    res.writeHead(200);
    return res.end(data);
  });
  const out = fresh('out');
  const ok = await run({ dir, dropin: true, dist, ws: [], scope: '127.0.0.1', out, verifyHost: host.url + '/' });
  assert.equal(ok.summary.verifiedHost, true);
  assert.ok(existsSync(join(out, 'pointer.txt')));
  assert.equal(ok.btih, first.btih);
  transform = true;
  await assert.rejects(run({ dir, dropin: true, dist, ws: [], scope: '127.0.0.1', out, verifyHost: host.url + '/' }), (err) => err instanceof ToolError && /--verify-host failed/.test(err.message));
  assert.equal(existsSync(join(out, 'pointer.txt')), false, 'a stale pointer does not survive a failed gate');
  assert.equal(existsSync(join(out, 'site')), false, 'no page was stamped');
  await assert.rejects(run({ verifyHost: host.url + '/' }), (err) => err instanceof UsageError && /drop-in host/.test(err.message));
});

test('D4 stampHtml: reports a tag without data-cfasync and a page that loads the runtime twice', () => {
  const pointer = 'v=mw1; btih=' + 'a'.repeat(40) + '; dn=x';
  const plain = stampHtml(Buffer.from('<html><head><script type="module" src="/_mw/mw.js" async></script></head></html>'), pointer);
  assert.equal(plain.cfasync, false);
  const guarded = stampHtml(Buffer.from('<html><head><script data-cfasync="false" type="module" src="/_mw/mw.js" async></script></head></html>'), pointer);
  assert.equal(guarded.cfasync, true);
  const twice = stampHtml(Buffer.from('<html><head><script data-cfasync="false" type="module" src="/_mw/mw.js"></script><script data-cfasync="false" type="module" src="/_mw/mw.js?v=2"></script></head></html>'), pointer);
  assert.equal(twice.duplicate, true);
  const injected = stampHtml(Buffer.from('<p>fragment</p>'), pointer, { injectScript: true });
  assert.equal(injected.cfasync, true);
  assert.match(injected.buffer.toString('latin1'), /<script data-cfasync="false" type="module" src="\/_mw\/mw\.js" async><\/script>/);
  const again = stampHtml(injected.buffer, pointer, { injectScript: true });
  assert.equal(again.buffer.equals(injected.buffer), true, 'stamping and injecting twice changes nothing');
});

test('code review round 1 (F53): publish --dropin prints the egress note for the copy size (behaviour, not source text)', async () => {
  const { egressNote } = await import('../../tools/publish.mjs');
  const dir = site({ 'css/big.css': 'a { color: red }\n'.repeat(4000) });
  const lines = [];
  const res = await run({ dir, dropin: true, dist: fakeDist(), ws: [], quiet: false, log: (l) => lines.push(String(l)) });
  const printed = lines.join('\n');
  const copyBytes = res.files.reduce((n, f) => n + f.length, 0);
  assert.ok(printed.includes(egressNote(copyBytes)), 'the drop-in output carries the egress note for ' + copyBytes + ' bytes');
  assert.match(printed, /cellular and Save-Data visitors fill it from peers only/);
  // A shell publish does not print it.
  const shellLines = [];
  await run({ dir, quiet: false, log: (l) => shellLines.push(String(l)) });
  assert.ok(shellLines.length > 0, 'the shell publish reported something');
  assert.equal(shellLines.some((l) => l.includes(egressNote(copyBytes)) || /times the size/.test(l)), false, 'no egress note in shell mode');
});
