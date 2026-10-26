// Unit tests for tools/publish.mjs and tools/ledger-admin.mjs genesis (ARCHITECTURE section 10,
// DESIGN-REVIEW items 3, 11, 13, 14, 22, 23, S12): determinism, torrent shape, /.mw files, signed
// pointer, genesis block, DNS chunking, drop-in stamping, key refusal, the --verify-ws gate.
// No network except 127.0.0.1 servers on ephemeral ports, closed in after().
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, chmodSync, readdirSync, cpSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';

import { publish, stampHtml, dnsTxt, ignoreReason, siteManifest, collectSite, anchorInfoHash } from '../../tools/publish.mjs';
import { keygen } from '../../tools/keygen.mjs';
import { createDevServer } from '../../tools/dev-server.mjs';
import { readBlocksFile } from '../../tools/ledger-admin.mjs';
import { ToolError, UsageError, ROOT } from '../../tools/lib.mjs';
import { parseTorrentFile } from '../../src/common/torrent-file.js';
import { decode as bdecode } from '../../src/common/bencode.js';
import {
  parsePointer, verifyPointer, verifyRotation, splitTxt, joinTxtData, ledgerIdFor, formatPointer, MAX_EXP_DAYS,
} from '../../src/common/pointer.js';
import { validateBlock } from '../../src/chain/block.js';
import { stampedPointerFromHtml, parseRedirects, parseHeaders } from '../../src/sw/lib.js';

const work = mkdtempSync(join(tmpdir(), 'mw-publish-test-'));
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
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');

const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d49444154789c6360000002000001e221bc330000000049454e44ae426082', 'hex');

function writeTree(root, files) {
  for (const [path, content] of Object.entries(files)) {
    const abs = join(root, ...path.split('/'));
    mkdirSync(join(abs, '..'), { recursive: true });
    writeFileSync(abs, content);
  }
}

function makeSite(label = 'site') {
  const dir = fresh(label);
  writeTree(dir, {
    'index.html': '<!doctype html><html><head><title>Home</title></head><body><h1>Home</h1></body></html>\n',
    'about.html': '<!doctype html><html><head><meta charset="utf-8"><title>About</title></head><body>about</body></html>\n',
    '404.html': '<!doctype html><html><head><title>Not found</title></head><body>404</body></html>\n',
    'css/app.css': 'body { margin: 0 }\n',
    'js/app.js': 'console.log("hi");\n',
    'img/pixel.png': PNG,
    'data/x.json': '{"a":1}\n',
    'README.md': '# not published\n',
    '.env': 'SECRET=1\n',
    '.git/config': '[core]\n',
    'node_modules/dep/index.js': 'module.exports = 1\n',
    '.well-known/security.txt': 'Contact: mailto:a@example.com\n',
    '_redirects': '/old /new 301\n/blog/* /posts/:splat 200\n',
    '_headers': '/*\n  X-Frame-Options: DENY\n/assets/*\n  Cache-Control: public, max-age=31536000\n',
  });
  return dir;
}

let keyCounter = 0;
async function makeKey() {
  const file = join(work, 'owner-' + ++keyCounter + '.jwk');
  const res = await keygen({ out: file });
  return { file, pub: res.pub, fingerprint: res.fingerprint };
}

async function run(extra = {}) {
  const key = extra.key || (await makeKey()).file;
  return publish(Object.assign({
    dir: makeSite(), name: 'my-site', scope: 'example.com', key, tr: ['wss://tracker.example'], ws: ['https://static.example/ws/'],
    out: fresh('out'), now: NOW, quiet: true,
  }, extra));
}

// ---------------------------------------------------------------------------------------------- determinism and torrent shape

test('determinism: two runs over the same files give the same infohash and the same .torrent bytes', async () => {
  const dir = makeSite();
  const key = (await makeKey()).file;
  const a = await run({ dir, key });
  const b = await run({ dir, key });
  assert.equal(a.btih, b.btih);
  assert.equal(readFileSync(join(a.outDir, 'site.torrent')).equals(readFileSync(join(b.outDir, 'site.torrent'))), true);
  assert.equal(readFileSync(join(a.outDir, 'my-site.torrent')).equals(readFileSync(join(b.outDir, 'my-site.torrent'))), true);
});

test('determinism holds across key and scope; a changed file, name or file list changes the infohash', async () => {
  const dir = makeSite();
  const first = await run({ dir });
  const otherKey = await run({ dir, scope: 'other.example' });
  assert.equal(otherKey.btih, first.btih, 'key and scope are not part of the torrent');
  writeFileSync(join(dir, 'js', 'app.js'), 'console.log("changed");\n');
  assert.notEqual((await run({ dir })).btih, first.btih);
  writeFileSync(join(dir, 'js', 'app.js'), 'console.log("hi");\n');
  assert.equal((await run({ dir })).btih, first.btih, 'restoring the file restores the infohash');
  assert.notEqual((await run({ dir, name: 'other-name' })).btih, first.btih, 'the name is part of the info dictionary');
  const trOrder = await run({ dir, tr: ['wss://b.example', 'wss://a.example'] });
  const trOrder2 = await run({ dir, tr: ['wss://a.example', 'wss://b.example'] });
  assert.equal(trOrder.btih, trOrder2.btih, 'announce and url-list are outside info');
  assert.notEqual(Buffer.from(trOrder.torrentFile).equals(Buffer.from(trOrder2.torrentFile)), true);
});

test('torrent shape: fixed name, 256 KiB pieces, exact announce list, url-list, createdBy, no creation date, sorted paths', async () => {
  const res = await run({ tr: ['wss://t1.example', 'wss://t2.example'], ws: ['https://static.example/ws/'] });
  const parsed = await parseTorrentFile(new Uint8Array(res.torrentFile));
  assert.equal(parsed.name, 'my-site');
  assert.equal(parsed.pieceLength, 262144);
  assert.equal(parsed.infoHash, res.btih);
  assert.deepEqual(parsed.announce, ['wss://t1.example', 'wss://t2.example'], 'only the owner trackers, never the library defaults');
  assert.deepEqual(parsed.urlList, ['https://static.example/ws/']);
  const top = bdecode(new Uint8Array(res.torrentFile)).value;
  assert.equal(Buffer.from(top['created by']).toString(), 'felinar');
  assert.equal(top['creation date'], undefined, 'no creation date: the file is reproducible');
  assert.deepEqual(parsed.files.map((f) => f.path), [
    '.mw/files.json', '.mw/site.json', '404.html', 'about.html', 'css/app.css', 'data/x.json', 'img/pixel.png', 'index.html', 'js/app.js',
  ]);
  assert.equal(parsed.private, false, 'privacy is a per-add option; the infohash stays the public one');
  // the same torrent is what publish wrote to every output
  assert.equal(readFileSync(join(res.outDir, 'site.torrent')).equals(Buffer.from(res.torrentFile)), true);
  assert.equal(readFileSync(join(res.outDir, 'my-site.torrent')).equals(Buffer.from(res.torrentFile)), true);
});

test('no --tr gives an empty announce list, not the create-torrent defaults', async () => {
  const res = await run({ tr: [], ws: [] });
  const parsed = await parseTorrentFile(new Uint8Array(res.torrentFile));
  assert.deepEqual(parsed.announce, []);
  assert.deepEqual(parsed.urlList, []);
  assert.ok(res.warnings.some((w) => /no --tr/.test(w)));
  assert.ok(res.warnings.some((w) => /no --ws or --xs/.test(w)));
});

test('ignore list: dotfiles and dot-directories, README.md, node_modules, host config; --ignore adds more', async () => {
  const res = await run({ ignore: ['data'] });
  const paths = res.files.map((f) => f.path);
  for (const p of ['README.md', '.env', '.git/config', 'node_modules/dep/index.js', '.well-known/security.txt', '_redirects', '_headers', 'data/x.json']) {
    assert.equal(paths.includes(p), false, p + ' stays out of the torrent');
  }
  assert.ok(paths.includes('index.html') && paths.includes('img/pixel.png'));
  assert.match(ignoreReason('a/.hidden/b.txt', false) || '', /dotfile/);
  assert.match(ignoreReason('node_modules', true) || '', /node_modules/);
  assert.equal(ignoreReason('docs/README.md', false), null, 'only the root README.md is host documentation');
  assert.match(ignoreReason('index.html~', false) || '', /editor backup/);
  assert.match(ignoreReason('sub/Thumbs.db', false) || '', /OS junk/);
  assert.equal(ignoreReason('index.html', false), null);
  const site = collectSite(makeSite());
  assert.ok(site.skipped.some((s) => s.path === '.git/'));
  assert.equal(site.torrent.length, 7);
  assert.ok(res.warnings.some((w) => /well-known/.test(w)));
});

// ---------------------------------------------------------------------------------------------- /.mw files

test('/.mw/site.json comes from the flags and from _redirects and _headers; /.mw/files.json lists sha256 per file', async () => {
  const res = await run({ spa: true, cleanUrls: true, trailingSlash: 'never', index: 'index.html' });
  const dir = join(res.outDir, 'my-site');
  const manifest = JSON.parse(readFileSync(join(dir, '.mw', 'site.json'), 'utf8'));
  assert.equal(manifest.v, 1);
  assert.equal(manifest.spa, true);
  assert.equal(manifest.cleanUrls, true);
  assert.equal(manifest.trailingSlash, 'never');
  assert.equal(manifest.notFound, '404.html', 'defaults to 404.html when the site has one');
  assert.deepEqual(manifest.redirects, parseRedirects('/old /new 301\n/blog/* /posts/:splat 200\n'));
  assert.deepEqual(manifest.headers, parseHeaders('/*\n  X-Frame-Options: DENY\n/assets/*\n  Cache-Control: public, max-age=31536000\n'));
  const list = JSON.parse(readFileSync(join(dir, '.mw', 'files.json'), 'utf8'));
  assert.equal(list.v, 1);
  assert.equal(list.name, 'my-site');
  const paths = list.files.map((f) => f.path);
  assert.deepEqual(paths, paths.slice().sort(), 'sorted');
  for (const f of list.files) {
    if (f.path === '.mw/files.json') continue;
    const bytes = readFileSync(join(dir, ...f.path.split('/')));
    assert.equal(f.length, bytes.length, f.path);
    assert.equal(f.sha256, sha256(bytes), f.path);
  }
  assert.ok(paths.includes('.mw/site.json') && paths.includes('index.html'));
  assert.equal(paths.includes('.mw/files.json'), false, 'a file cannot list its own hash');
  // the published torrent contains exactly these bytes
  const parsed = await parseTorrentFile(new Uint8Array(res.torrentFile));
  assert.ok(parsed.files.some((f) => f.path === '.mw/files.json'));
  const entries = res.files.map((f) => f.path);
  assert.deepEqual(entries, parsed.files.map((f) => f.path));
});

test('a site without an index page is reported', async () => {
  const dir = fresh('noindex');
  writeTree(dir, { 'app.html': '<html></html>', 'a.css': 'x' });
  const res = await run({ dir });
  assert.ok(res.warnings.some((w) => /no index\.html at its root/.test(w)));
  const withIndex = await run({ dir, index: 'app.html' });
  assert.equal(withIndex.warnings.some((w) => /no app\.html/.test(w)), false);
  assert.equal(JSON.parse(readFileSync(join(withIndex.outDir, 'my-site', '.mw', 'site.json'), 'utf8')).index, 'app.html');
});

test('siteManifest: defaults, drop-in leaves notFound to the host, flags are validated', () => {
  const files = [{ path: 'index.html' }, { path: '404.html' }, { path: 'app.html' }];
  const def = siteManifest({ files });
  assert.deepEqual([def.index, def.notFound, def.spa, def.cleanUrls, def.trailingSlash], ['index.html', '404.html', false, false, 'auto']);
  assert.equal(siteManifest({ files, dropin: true }).notFound, null);
  assert.equal(siteManifest({ files, flags: { notFound: 'none' } }).notFound, null);
  assert.equal(siteManifest({ files, flags: { spaPath: 'app.html' } }).spa, 'app.html');
  assert.throws(() => siteManifest({ files, flags: { trailingSlash: 'sometimes' } }), UsageError);
  assert.throws(() => siteManifest({ files, flags: { index: 'a/b.html' } }), UsageError);
});

// ---------------------------------------------------------------------------------------------- pointer and genesis

test('the pointer is signed: verifyPointer passes for the scope, fails for tampering and for another scope', async () => {
  const key = await makeKey();
  const res = await run({ key: key.file, consent: 'gate', max: 5000000, chain: 'main' });
  const parsed = parsePointer(res.pointer);
  assert.equal(parsed.ok, true);
  const rec = parsed.record;
  assert.equal(rec.v, 'mw1');
  assert.equal(rec.btih, res.btih);
  assert.equal(rec.dn, 'my-site');
  assert.equal(rec.owner, key.pub);
  assert.equal(rec.gen, res.gen);
  assert.deepEqual(rec.tr, ['wss://tracker.example']);
  assert.deepEqual(rec.ws, ['https://static.example/ws/']);
  assert.deepEqual(rec.xs, ['https://static.example/ws/my-site.torrent'], 'xs is set whenever --ws is given');
  assert.equal(rec.consent, 'gate');
  assert.equal(rec.max, 5000000);
  assert.equal(rec.chain, 'main');
  assert.equal(rec.exp, Math.floor(NOW / 1000) + 90 * 86400, 'default validity is 90 days');
  assert.equal(rec.seq, Math.floor(NOW / 1000), 'default seq is the Unix time');
  assert.deepEqual(await verifyPointer(rec, 'example.com', { now: NOW }), Object.assign({}, await verifyPointer(rec, 'example.com', { now: NOW }), { ok: true, reason: null }));
  assert.equal((await verifyPointer(rec, 'EXAMPLE.com.', { now: NOW })).ok, true, 'scope is normalised');
  assert.equal((await verifyPointer(rec, 'other.example', { now: NOW })).reason, 'bad-sig');
  const tampered = parsePointer(res.pointer.replace('dn=my-site', 'dn=evil-site')).record;
  assert.equal((await verifyPointer(tampered, 'example.com', { now: NOW })).reason, 'bad-sig');
  const appended = parsePointer(res.pointer + '; extra=1').record;
  assert.equal((await verifyPointer(appended, 'example.com', { now: NOW })).reason, 'bad-sig', 'an unknown key added after signing fails');
  assert.equal((await verifyPointer(rec, 'example.com', { now: NOW + 91 * 86400 * 1000 })).reason, 'expired');
  assert.equal(await ledgerIdFor(rec, 'example.com'), res.ledgerId);
  assert.match(res.ledgerId, /^mw1:[A-Za-z0-9_-]{27}$/);
  // the printed outputs agree
  assert.equal(readFileSync(join(res.outDir, 'pointer.txt'), 'utf8').trim(), res.pointer);
  assert.match(readFileSync(join(res.outDir, 'meta.html'), 'utf8'), /^<meta name="mw-pointer" content="v=mw1; btih=/);
  assert.match(readFileSync(join(res.outDir, 'magnet.txt'), 'utf8'), /^magnet:\?xt=urn:btih:[0-9a-f]{40}&dn=my-site&tr=/);
  assert.match(readFileSync(join(res.outDir, 'magnet.txt'), 'utf8'), /&xs=/);
});

test('--exp, --seq and --max are honoured and bounded', async () => {
  const res = await run({ exp: 30, seq: 7 });
  const rec = parsePointer(res.pointer).record;
  assert.equal(rec.seq, 7);
  assert.equal(rec.exp, Math.floor(NOW / 1000) + 30 * 86400);
  await assert.rejects(run({ exp: MAX_EXP_DAYS + 1 }), UsageError);
  await assert.rejects(run({ exp: 0 }), UsageError);
  await assert.rejects(run({ max: 10 }), /more than --max/);
});

test('the genesis block validates, is a root policy block with every policy field, and gen= names it', async () => {
  const key = await makeKey();
  const res = await run({ key: key.file, policy: 'open', bits: 12, moderator: [key.pub], maxValueBytes: 1024 });
  const g = res.genesis;
  assert.equal(g.h, res.gen);
  assert.deepEqual(g.e.prev, []);
  assert.equal(g.e.author, key.pub);
  assert.equal(g.e.site, res.ledgerId);
  assert.equal(g.e.bits, 0);
  assert.deepEqual(g.e.op, {
    t: 'policy', writers: 'open', bits: 12, maxValueBytes: 1024, maxChainBytes: 8388608, moderators: [key.pub], allow: [],
  });
  assert.deepEqual(await validateBlock(g, { minBits: 0, genesisOwner: key.pub, site: res.ledgerId }), { ok: true });
  assert.equal((await validateBlock(g, { genesisOwner: 'B'.repeat(87), site: res.ledgerId })).ok, false, 'a root by another key is refused');
  const file = readBlocksFile(join(res.outDir, 'genesis.json'));
  assert.deepEqual(file, [g]);
  assert.equal(parsePointer(res.pointer).record.gen, g.h);
});

test('the default policy is owner-only with 16 bits; the genesis is reused across publishes of the same ledger', async () => {
  const key = await makeKey();
  const out = fresh('out');
  const a = await run({ key: key.file, out, now: NOW });
  assert.equal(a.genesis.e.op.writers, 'owner');
  assert.equal(a.genesis.e.op.bits, 16);
  assert.equal(a.genesisReused, false);
  const b = await run({ key: key.file, out, now: NOW + 3600 * 1000 });
  assert.equal(b.genesisReused, true);
  assert.equal(b.gen, a.gen, 'gen= is stable across site versions');
  assert.equal(b.ledgerId, a.ledgerId);
  // changing the policy of a live ledger needs ledger-admin or --new-genesis
  await assert.rejects(run({ key: key.file, out, policy: 'open' }), /ledger-admin|new-genesis/);
  const c = await run({ key: key.file, out, policy: 'open', newGenesis: true, now: NOW + 7200 * 1000 });
  assert.equal(c.genesisReused, false);
  assert.notEqual(c.gen, a.gen);
  // another owner key is another ledger: the old genesis is not reused
  const d = await run({ out, now: NOW });
  assert.notEqual(d.ledgerId, a.ledgerId);
  assert.equal(d.genesisReused, false);
});

test('an open ledger without --cs warns that a visitor may not be able to post; with --cs it does not', async () => {
  const open = await run({ policy: 'open' });
  assert.ok(open.warnings.some((w) => /lets visitors write \(writers=open\) but there is no --cs/.test(w)));
  const withCs = await run({ policy: 'open', cs: 'https://static.example/genesis.json' });
  assert.equal(withCs.warnings.some((w) => /no --cs/.test(w)), false);
  assert.equal(parsePointer(withCs.pointer).record.cs, 'https://static.example/genesis.json');
  const ownerOnly = await run({});
  assert.equal(ownerOnly.warnings.some((w) => /no --cs/.test(w)), false, 'an owner-only ledger needs no snapshot to be usable');
});

test('summary.json lists the infohash, the anchor torrent and the files for trackers and the demo seeder', async () => {
  const res = await run();
  const s = JSON.parse(readFileSync(join(res.outDir, 'summary.json'), 'utf8'));
  assert.equal(s.btih, res.btih);
  assert.equal(s.anchorBtih, await anchorInfoHash(res.ledgerId));
  assert.equal(s.pieceLength, 262144);
  assert.equal(s.name, 'my-site');
  assert.equal(s.mode, 'shell');
  assert.deepEqual(s.files.map((f) => f.path), res.files.map((f) => f.path));
  assert.equal(s.dns.name, '_magnet.example.com');
  assert.equal(s.pointer, res.pointer);
  for (const f of ['site.torrent', 'magnet.txt', 'pointer.txt', 'dns.txt', 'meta.html', 'webseed-layout.txt', 'genesis.json', 'summary.json', 'csp.txt']) {
    assert.ok(existsSync(join(res.outDir, f)), f);
  }
  assert.ok(existsSync(join(res.outDir, 'my-site', 'index.html')), 'the web seed upload tree');
});

// ---------------------------------------------------------------------------------------------- dns.txt and the other texts

const quotedStrings = (line) => Array.from(line.matchAll(/"((?:\\.|[^"\\])*)"/g)).map((m) => m[1].replace(/\\(.)/g, '$1'));

test('dns.txt: the record name, the value split into quoted strings of at most 255 bytes, joined back to the pointer', async () => {
  // v0.2.1 A3: a pointer must stay at or under 900 bytes (MW-PTR/1); 7 long trackers keep it above 510 bytes (3 strings)
  const trackers = Array.from({ length: 7 }, (_, i) => 'wss://tracker-number-' + i + '.long-domain-name-for-testing.example');
  const res = await run({ tr: trackers });
  assert.ok(Buffer.byteLength(res.pointer) > 510, 'the pointer needs several chunks (' + Buffer.byteLength(res.pointer) + ' bytes)');
  const text = readFileSync(join(res.outDir, 'dns.txt'), 'utf8');
  assert.match(text, /^name:  _magnet\.example\.com$/m);
  assert.match(text, /^type:  TXT$/m);
  const valueLine = text.split('\n').find((l) => l.startsWith('value: '));
  const chunks = quotedStrings(valueLine);
  assert.ok(chunks.length >= 3);
  for (const c of chunks) assert.ok(Buffer.byteLength(c) <= 255, 'chunk of ' + Buffer.byteLength(c) + ' bytes');
  assert.equal(chunks.join(''), res.pointer, 'resolvers join the strings with no separator');
  assert.equal(joinTxtData(valueLine.slice('value: '.length)), res.pointer, 'the DoH client reads it back');
  assert.deepEqual(chunks, splitTxt(res.pointer));
  // zone line, Route 53 batch and Cloudflare example are present and consistent
  assert.match(text, /^_magnet\.example\.com\. 300 IN TXT "/m);
  const route53 = JSON.parse(text.slice(text.indexOf('{\n  "Comment"'), text.indexOf('\n}\n', text.indexOf('{\n  "Comment"')) + 2));
  const rr = route53.Changes[0].ResourceRecordSet;
  assert.equal(rr.Name, '_magnet.example.com.');
  assert.equal(rr.Type, 'TXT');
  assert.equal(quotedStrings(rr.ResourceRecords[0].Value).join(''), res.pointer);
  assert.match(text, /api\.cloudflare\.com\/client\/v4\/zones/);
  assert.match(text, /web seed passes/i);
});

test('dnsTxt: multi-byte pointers never split inside a character', () => {
  const pointer = 'v=mw1; dn=' + encodeURIComponent(String.fromCharCode(0xe9).repeat(200)) + '; ' + 'x'.repeat(300);
  const text = dnsTxt({ scope: 'example.com', pointer });
  const chunks = quotedStrings(text.split('\n').find((l) => l.startsWith('value: ')));
  assert.equal(chunks.join(''), pointer);
  assert.equal(dnsTxt({ scope: 'localhost', pointer: 'v=mw1' }).includes('not a DNS name'), true);
});

test('webseed-layout.txt: keys <ws>/<name>/<path>, the S3 CORS JSON with exposed headers, the CloudFront note, deploy order', async () => {
  const res = await run({ ws: ['https://cdn.example/seed/'] });
  const text = readFileSync(join(res.outDir, 'webseed-layout.txt'), 'utf8');
  assert.match(text, /https:\/\/cdn\.example\/seed\/my-site\/index\.html/);
  assert.match(text, /https:\/\/cdn\.example\/seed\/my-site\/\.mw\/site\.json/);
  assert.match(text, /https:\/\/cdn\.example\/seed\/my-site\.torrent/);
  const start = text.indexOf('[\n  {\n    "AllowedOrigins"');
  const cors = JSON.parse(text.slice(start, text.indexOf('\n]\n', start) + 2));
  assert.deepEqual(cors[0].AllowedOrigins, ['*']);
  assert.deepEqual(cors[0].AllowedHeaders, ['*']);
  assert.deepEqual(cors[0].ExposeHeaders, ['Content-Range', 'Content-Length', 'Accept-Ranges', 'ETag']);
  assert.match(text, /CloudFront/);
  assert.match(text, /OPTIONS/);
  // Post-wave fix M (research w1-10 F5): the managed CORS policies send no Access-Control-Allow-Headers, so they are
  // never the advice; the patched client sends only Range (B3).
  assert.match(text, /send no Access-Control-Allow-Headers \(research w1-10 F5\)/);
  assert.doesNotMatch(text, /attach the managed origin\s+request policy CORS-S3Origin[^.]*and the\s+managed response headers policy/);
  assert.match(text, /patched to send only Range/);
  assert.match(text, /at least 7 days/);
  assert.match(text, /check-webseed\.mjs https:\/\/cdn\.example\/seed\//);
});

// ---------------------------------------------------------------------------------------------- key and flag refusals

test('a group- or world-readable key is refused before anything is written', async () => {
  const key = await makeKey();
  chmodSync(key.file, 0o640);
  const out = fresh('out');
  await assert.rejects(run({ key: key.file, out }), (err) => err instanceof ToolError && /chmod 600/.test(err.message) && /group or others/.test(err.message));
  assert.deepEqual(readdirSync(out), [], 'no output');
  chmodSync(key.file, 0o644);
  await assert.rejects(run({ key: key.file, out }), /chmod 600/);
  chmodSync(key.file, 0o600);
  assert.equal((await run({ key: key.file, out })).btih.length, 40);
  await assert.rejects(run({ key: join(work, 'no-such-key.jwk') }), /key file not found/);
});

test('flag validation: usage errors for bad names, scopes, URLs and combinations', async () => {
  await assert.rejects(run({ name: 'bad name' }), UsageError);
  await assert.rejects(run({ name: 'site' }), /collides/);
  await assert.rejects(run({ scope: undefined }), /--scope/);
  await assert.rejects(run({ scope: 'btih:' + 'a'.repeat(40) }), /hostname/);
  await assert.rejects(run({ ws: ['http://static.example/ws/'] }), /must use https/);
  await assert.rejects(run({ tr: ['ws://tracker.example'] }), /wss/);
  await assert.rejects(run({ tr: ['https://tracker.example'] }), /wss/);
  await assert.rejects(run({ consent: 'maybe' }), UsageError);
  await assert.rejects(run({ policy: 'everyone' }), UsageError);
  await assert.rejects(run({ verifyWs: true, ws: [] }), /needs --ws/);
  await assert.rejects(run({ dir: join(work, 'no-such-dir') }), /no such directory/);
  const dir = makeSite();
  await assert.rejects(run({ dir, out: join(dir, 'out') }), /must not be inside/);
  // loopback hosts may use plain http / ws for development
  const dev = await run({ scope: '127.0.0.1', ws: ['http://127.0.0.1:8080/ws/'], tr: ['ws://127.0.0.1:8000'] });
  assert.equal((await verifyPointer(parsePointer(dev.pointer).record, '127.0.0.1', { now: NOW })).ok, true);
  assert.equal((await run({ tr: ['public'] })).record.tr.length, 4, '--tr public expands to the four default public trackers');
});

test('--prev-key signs the rotation: rot= verifies against the previous owner only, for this scope only', async () => {
  const previous = await makeKey();
  const next = await makeKey();
  const res = await run({ key: next.file, prevKey: previous.file, seq: 12, newGenesis: true });
  const rec = parsePointer(res.pointer).record;
  assert.ok(rec.rot);
  assert.equal(await verifyRotation(rec, previous.pub, 'example.com'), true);
  assert.equal(await verifyRotation(rec, next.pub, 'example.com'), false);
  assert.equal(await verifyRotation(rec, previous.pub, 'shop.example'), false, 'code review round 1: the rotation is bound to its scope');
  assert.equal(await verifyRotation(rec, previous.pub), false, 'a v2 rotation is not a v1 one');
  const check = await verifyPointer(rec, 'example.com', { now: NOW, pinnedOwner: previous.pub });
  assert.equal(check.ok, true);
  assert.equal(check.rotated, true, 'the key change is silent for returning visitors');
  assert.ok(res.warnings.some((w) => /new, empty ledger/.test(w)), '--new-genesis says the ledger restarts');
  await assert.rejects(run({ key: next.file, prevKey: next.file, newGenesis: true }), /same key/);
  await assert.rejects(run({ key: next.file, prevKey: previous.file }), /keeps the ledger, so it needs the ledger's genesis block/);
});

test('code review round 1: a key rotation keeps the ledger (lo=, same ledger id, the genesis reused)', async () => {
  const a = await makeKey();
  const b = await makeKey();
  const out = fresh('out');
  const dir = makeSite();
  const first = await run({ dir, key: a.file, out });
  const second = await run({ dir, key: b.file, prevKey: a.file, out, seq: Math.floor(NOW / 1000) + 10, now: NOW + 20000 });
  assert.equal(second.ledgerId, first.ledgerId, 'same ledger id');
  assert.equal(second.genesisReused, true);
  assert.equal(second.gen, first.gen);
  const rec = parsePointer(second.pointer).record;
  assert.equal(rec.owner, b.pub);
  assert.equal(rec.lo, a.pub, 'the pointer names the ledger owner');
  assert.equal(await ledgerIdFor(rec, 'example.com'), first.ledgerId, 'every loader computes the same id');
  assert.equal((await verifyPointer(rec, 'example.com', { now: NOW + 20000, pinnedOwner: a.pub })).rotated, true);
  assert.ok(second.warnings.some((w) => /hand control to this key/.test(w)), 'the owner is told to write the hand-over');
  // Without the rotation the pointer carries no lo=.
  assert.equal(parsePointer(first.pointer).record.lo, null);
});

test('post-wave fix Q: after a rotation publish does not tell the owner to upload genesis.json over the snapshot that holds the hand-over', async () => {
  const a = await makeKey();
  const b = await makeKey();
  const out = fresh('out');
  const dir = makeSite();
  const cs = 'https://example.com/ws/snapshot.json.gz';
  const plain = [];
  await run({ dir, key: a.file, out, cs, quiet: false, log: (l) => plain.push(String(l)) });
  assert.ok(plain.some((l) => /^Ledger snapshot: upload .*genesis\.json .* to https:\/\/example\.com\/ws\/snapshot\.json\.gz\.$/.test(l)), 'a new ledger: upload genesis.json to cs=');
  const rotated = [];
  await run({ dir, key: b.file, prevKey: a.file, out, cs, seq: Math.floor(NOW / 1000) + 10, now: NOW + 20000, quiet: false, log: (l) => rotated.push(String(l)) });
  const line = rotated.find((l) => /^Ledger snapshot:/.test(l));
  assert.ok(line, 'a snapshot line');
  assert.match(line, /keep the snapshot with the owner hand-over at https:\/\/example\.com\/ws\/snapshot\.json\.gz/);
  assert.match(line, /Do not upload .*genesis\.json there/);
  assert.equal(rotated.some((l) => /upload .*genesis\.json .* to https:/.test(l)), false, 'no upload hint that would drop the hand-over');
});

test('code review round 1: --seq is never ahead of the clock and --exp is at most 399 days', async () => {
  await assert.rejects(run({ seq: Math.floor(NOW / 1000) + 86400 }), /no later than the current Unix time/);
  await assert.rejects(run({ seq: 9007199254740991 }), /no later than the current Unix time/);
  await assert.rejects(run({ exp: 400 }), /1 to 399 days/);
  assert.ok(await run({ exp: 399 }));
});

// ---------------------------------------------------------------------------------------------- drop-in

function fakeDist() {
  const dist = fresh('dist');
  writeTree(dist, {
    'mw-sw.js': '// sw\n',
    'mw-sw-kill.js': '// kill\n',
    '_mw/boot.js': '// boot\n',
    '_mw/loader.js': '// loader\n',
    '_mw/mw.js': '// mw\n',
    '_mw/sw-core.js': '// core\n',
    'index.html': '<!doctype html><html><head><meta charset="utf-8"><title>Loading</title></head><body><script src="/_mw/boot.js"></script></body></html>',
    '404.html': '<!doctype html><html><head><title>Loading</title></head><body></body></html>',
  });
  return dist;
}

function makeDropinSite() {
  const dir = fresh('existing');
  writeTree(dir, {
    'index.html': '<!doctype html>\n<html lang="en">\n<head>\n<meta charset="utf-8">\n<title>Home</title>\n<link rel="stylesheet" href="/css/app.3f2a1b.css">\n<script type="module" src="/_mw/mw.js" async></script>\n</head>\n<body><h1>Home</h1></body>\n</html>\n',
    'about.html': '<h1>About</h1>\n<p>a bare fragment without head or body</p>\n',
    'blog/post-1.html': '<!DOCTYPE html><html><body><p>post</p></body></html>',
    'css/app.3f2a1b.css': 'body { color: #123 }\n',
    'js/app.9c0d2e.js': 'console.log(1);\n',
    'img/photo.png': PNG,
    'docs/page.htm': '<html><head></head><body>htm</body></html>',
    'README.md': '# readme\n',
    '_redirects': '/old /new 301\n',
  });
  return dir;
}

test('--dropin: HTML stays out of the torrent, every page is stamped with the signed pointer, the runtime is laid out', async () => {
  const dist = fakeDist();
  const dir = makeDropinSite();
  const res = await run({ dir, dropin: true, dist, ws: [], tr: ['wss://tracker.example'] });
  const parsed = await parseTorrentFile(new Uint8Array(res.torrentFile));
  assert.deepEqual(parsed.files.map((f) => f.path), ['.mw/files.json', '.mw/site.json', 'css/app.3f2a1b.css', 'img/photo.png', 'js/app.9c0d2e.js']);
  assert.equal(res.mode, 'dropin');
  const rec = parsePointer(res.pointer).record;
  assert.deepEqual(rec.xs, ['/_mw/t/' + res.btih + '.torrent'], 'xs is the same-origin torrent under /_mw/t/');
  assert.deepEqual(rec.ws, [], 'the engine adds /_mw/ws/ itself');
  const site = join(res.outDir, 'site');
  assert.equal(readFileSync(join(site, '_mw', 't', res.btih + '.torrent')).equals(Buffer.from(res.torrentFile)), true);
  assert.equal(readFileSync(join(site, 'mw-sw.js'), 'utf8'), '// sw\n');
  assert.equal(readFileSync(join(site, '_mw', 'mw.js'), 'utf8'), '// mw\n');
  assert.ok(existsSync(join(site, '.mw', 'site.json')) && existsSync(join(site, '.mw', 'files.json')), '/.mw/* is served by the host (the web seed rewrite reads it)');
  assert.ok(existsSync(join(site, '.nojekyll')), 'GitHub Pages must not drop /.mw/ and /_mw/');
  assert.ok(existsSync(join(site, 'README.md')) && existsSync(join(site, '_redirects')), 'host files stay in the deploy copy');
  assert.equal(readFileSync(join(site, 'css', 'app.3f2a1b.css'), 'utf8'), 'body { color: #123 }\n');
  for (const page of ['index.html', 'about.html', 'blog/post-1.html', 'docs/page.htm']) {
    const html = readFileSync(join(site, ...page.split('/')), 'utf8');
    const stamped = stampedPointerFromHtml(html.slice(0, 4096));
    assert.ok(stamped, page + ' carries the stamped pointer in its first 4 KiB');
    assert.equal(stamped.btih, res.btih);
    assert.equal((await verifyPointer(stamped, 'example.com', { now: NOW })).ok, true, page);
    assert.equal((html.match(/name="mw-pointer"/g) || []).length, 1);
  }
  // the original page is otherwise untouched: removing the stamp gives back the source bytes
  const original = readFileSync(join(dir, 'index.html'), 'utf8');
  const stampedIndex = readFileSync(join(site, 'index.html'), 'utf8');
  assert.equal(stampedIndex.replace(/<meta name="mw-pointer" content="[^"]*">/, ''), original);
  // as the first child of <head>, after the leading charset declaration
  assert.match(stampedIndex, /<head>\n<meta charset="utf-8"><meta name="mw-pointer" content="v=mw1; /);
  assert.match(readFileSync(join(site, 'docs', 'page.htm'), 'utf8'), /^<html><head><meta name="mw-pointer" /);
  assert.match(readFileSync(join(site, 'about.html'), 'utf8'), /^<meta name="mw-pointer" /);
  assert.ok(res.warnings.some((w) => /3 HTML page\(s\) do not load the runtime/.test(w)), 'pages that lack the script tag are listed');
  assert.ok(existsSync(join(res.outDir, 'mw-sw-kill.js')), 'the kill switch worker is next to the outputs');
  assert.equal(existsSync(join(res.outDir, 'my-site')), false, 'no separate web seed tree: the host files are the web seed');
  const csp = readFileSync(join(res.outDir, 'csp.txt'), 'utf8');
  assert.match(csp, /worker-src\s+'self'/);
  // Post-wave fix M: drop-in pages never query DNS and use the host's own files as the web seed.
  assert.doesNotMatch(csp, /cloudflare-dns\.com|dns\.google|doh\.dns\.sb/, 'no DNS-over-HTTPS resolver in the drop-in CSP additions');
  assert.match(csp, /Drop-in pages never query DNS/);
  assert.equal(existsSync(join(res.outDir, 'webseed-layout.txt')), false, 'no web seed layout for drop-in');
});

test('post-wave fix (M43): publish names the _redirects lines the Service Worker cannot apply, in shell mode', async () => {
  const { skippedRedirectLines } = await import('../../tools/publish.mjs');
  const text = '# comment\n/old /new 301\n/search q=:q /find?q=:q 301\n/api/* https://api.example.com/:splat 200\n/blog/* /posts/:splat 200\n/x /y 418\n';
  assert.deepEqual(skippedRedirectLines(text).map((s) => s.line), [3, 4, 6]);
  assert.deepEqual(skippedRedirectLines(null), []);
  const dir = makeSite();
  writeFileSync(join(dir, '_redirects'), text);
  const res = await run({ dir });
  const w = res.warnings.find((x) => /^_redirects: /.test(x));
  assert.ok(w, 'a warning names the skipped lines');
  assert.match(w, /^_redirects: 3 line\(s\) use what the Service Worker does not support/);
  assert.match(w, /first: line 3: \/search q=:q \/find\?q=:q 301/);
  const plain = await run({ dir: makeSite() });
  assert.equal(plain.warnings.some((x) => /^_redirects: /.test(x)), false, 'supported rules only: no warning');
});

test('post-wave fix M: a drop-in publish into an out dir of an earlier shell publish removes its webseed-layout.txt', async () => {
  const out = fresh('out');
  const key = (await makeKey()).file;
  await run({ out, key });
  assert.ok(existsSync(join(out, 'webseed-layout.txt')), 'the shell publish wrote it');
  const res = await run({ dir: makeDropinSite(), dropin: true, dist: fakeDist(), ws: [], out, key });
  assert.equal(existsSync(join(out, 'webseed-layout.txt')), false, 'stale shell output removed');
  assert.ok(existsSync(join(res.outDir, 'csp.txt')));
});

test('--dropin --inject-script adds the runtime tag, also to pages without </head>', async () => {
  const res = await run({ dir: makeDropinSite(), dropin: true, dist: fakeDist(), injectScript: true, ws: [] });
  const site = join(res.outDir, 'site');
  for (const page of ['index.html', 'about.html', 'blog/post-1.html', 'docs/page.htm']) {
    const html = readFileSync(join(site, ...page.split('/')), 'utf8');
    assert.equal((html.match(/<script\b[^>]*src="\/_mw\/mw\.js"[^>]*><\/script>/g) || []).length, 1, page + ' has the tag exactly once');
    // v0.2.1 D4: an injected tag carries data-cfasync="false" before src (Cloudflare Rocket Loader guard);
    // index.html keeps the tag the site wrote (publish reports it)
    if (page !== 'index.html') assert.ok(html.includes('<script data-cfasync="false" type="module" src="/_mw/mw.js" async></script>'), page + ' got the guarded tag');
    assert.ok(html.indexOf('name="mw-pointer"') < html.indexOf('/_mw/mw.js') || page === 'index.html');
  }
  assert.equal(res.warnings.some((w) => /do not load the runtime/.test(w)), false);
  assert.ok(res.warnings.some((w) => /without data-cfasync="false" before src \(first: index\.html\)/.test(w)), 'the site\'s own tag without the guard is reported');
});

test('stampHtml is idempotent and keeps every other byte, in any ASCII-compatible encoding', () => {
  const pointer = 'v=mw1; btih=' + 'a'.repeat(40) + '; dn=x; seq=1; exp=2; sig=s';
  const docs = [
    '<!doctype html><html><head><title>T</title></head><body>b</body></html>',
    '<html><head></head></html>',
    '<!DOCTYPE html><html lang=en><body>no head</body></html>',
    '<p>fragment</p>',
    '<!-- <head> in a comment --><html><head><meta charset=utf-8><title>x</title></head></html>',
    '<html><head><script>var s = "<head>";</script></head><body></body></html>',
    String.fromCharCode(0xfeff) + '<!doctype html><head><title>bom</title></head>',
  ];
  for (const doc of docs) {
    const once = stampHtml(Buffer.from(doc, 'utf8'), pointer);
    const twice = stampHtml(once.buffer, pointer);
    assert.equal(once.changed, true, doc);
    assert.equal(twice.changed, false, 'stamping twice changes nothing: ' + doc);
    assert.equal(twice.buffer.equals(once.buffer), true);
    assert.equal(stampedPointerFromHtml(once.buffer.toString('utf8')).btih, 'a'.repeat(40));
    const other = stampHtml(once.buffer, pointer.replace('seq=1', 'seq=9'));
    assert.equal((other.buffer.toString('utf8').match(/name="mw-pointer"/g) || []).length, 1, 'a new pointer replaces the old stamp');
    assert.match(other.buffer.toString('utf8'), /seq=9/);
    const stripped = once.buffer.toString('utf8').replace(/<meta name="mw-pointer" content="[^"]*">/, '');
    assert.equal(stripped, doc, 'only the stamp was added');
  }
  // latin1 bytes outside ASCII survive untouched
  const latin = Buffer.concat([Buffer.from('<html><head><title>'), Buffer.from([0xe9, 0xe8, 0xff]), Buffer.from('</title></head></html>')]);
  const stamped = stampHtml(latin, pointer).buffer;
  assert.equal(stamped.includes(Buffer.from([0xe9, 0xe8, 0xff])), true);
  assert.equal(stampHtml(stamped, pointer).buffer.equals(stamped), true);
});

test('the stamp goes first in <head>: after a leading charset meta only, never after other head content', () => {
  const pointer = 'v=mw1; btih=' + 'b'.repeat(40);
  const out = stampHtml(Buffer.from('<html><head>\n  <meta charset="utf-8">\n  <title>T</title>\n  <link rel="stylesheet" href="/a.css">\n</head></html>'), pointer).buffer.toString('utf8');
  const stampAt = out.indexOf('name="mw-pointer"');
  assert.ok(stampAt > out.indexOf('charset="utf-8"') && stampAt < out.indexOf('<title>'));
  const noCharset = stampHtml(Buffer.from('<html><head><title>T</title></head></html>'), pointer).buffer.toString('utf8');
  assert.match(noCharset, /^<html><head><meta name="mw-pointer"/);
});

test('--dropin refuses a site that already uses /_mw/ or /mw-sw.js, and a missing build', async () => {
  const dist = fakeDist();
  const withMw = makeDropinSite();
  writeTree(withMw, { '_mw/old.js': 'x' });
  const out = fresh('out');
  await assert.rejects(run({ dir: withMw, dropin: true, dist, out }), (err) => err instanceof ToolError && /already has \/_mw\//.test(err.message));
  assert.deepEqual(readdirSync(out), [], 'nothing written');
  const withSw = makeDropinSite();
  writeTree(withSw, { 'mw-sw.js': 'x' });
  await assert.rejects(run({ dir: withSw, dropin: true, dist }), /already has \/mw-sw\.js/);
  await assert.rejects(run({ dir: makeDropinSite(), dropin: true, dist: fresh('empty-dist') }), /node build\.mjs/);
});

test('--dropin skips UTF-16 pages with a note and still publishes the rest', async () => {
  const dir = makeDropinSite();
  writeFileSync(join(dir, 'utf16.html'), Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('<html></html>', 'utf16le')]));
  const res = await run({ dir, dropin: true, dist: fakeDist(), ws: [] });
  assert.ok(res.warnings.some((w) => /UTF-16 page utf16\.html/.test(w)));
  assert.equal(readFileSync(join(res.outDir, 'site', 'utf16.html')).equals(readFileSync(join(dir, 'utf16.html'))), true);
});

test('--shell writes the loader shell with the pointer stamped into index.html and 404.html', async () => {
  const dist = fakeDist();
  const res = await run({ shell: true, dist, ws: ['https://static.example/ws/'] });
  for (const page of ['index.html', '404.html']) {
    const html = readFileSync(join(res.outDir, 'shell', page), 'utf8');
    assert.equal(stampedPointerFromHtml(html).btih, res.btih, page);
  }
  assert.ok(existsSync(join(res.outDir, 'shell', 'mw-sw.js')) && existsSync(join(res.outDir, 'shell', '_mw', 'boot.js')));
});

// ---------------------------------------------------------------------------------------------- --verify-ws

async function startWebseed(dir, { dropRange = false } = {}) {
  if (dropRange) {
    const server = http.createServer((req, res) => {
      // a host that ignores Range: 200 with the whole file
      const rel = decodeURIComponent(new URL(req.url, 'http://x').pathname).replace(/^\/ws\//, '');
      const file = join(dir, ...rel.split('/'));
      if (req.method === 'OPTIONS') {
        res.writeHead(204, { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-expose-headers': 'Content-Range' });
        return res.end();
      }
      if (!existsSync(file)) {
        res.writeHead(404);
        return res.end();
      }
      res.writeHead(200, { 'access-control-allow-origin': '*' });
      return res.end(readFileSync(file));
    });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    const entry = { url: 'http://127.0.0.1:' + server.address().port + '/', close: () => new Promise((r) => { server.closeAllConnections(); server.close(r); }) };
    servers.push(entry);
    return entry;
  }
  const dev = await createDevServer({ root: dir, webseed: dir, port: 0, quiet: true });
  servers.push(dev);
  return dev;
}

test('--verify-ws: the pointer is withheld until the web seed passes, then written', async () => {
  const key = (await makeKey()).file;
  const dir = makeSite();
  const out = fresh('out');
  // 1. nothing is uploaded yet: a port with no listener refuses connections
  const closed = await startWebseed(out);
  const base = closed.url + 'ws/';
  await closed.close();
  servers.pop();
  const opts = { dir, key, out, scope: '127.0.0.1', tr: ['ws://127.0.0.1:1'], ws: [base], verifyWs: true };
  await assert.rejects(run(opts), (err) => err instanceof ToolError && /--verify-ws failed/.test(err.message) && /was not written/.test(err.message));
  for (const f of ['pointer.txt', 'magnet.txt', 'meta.html', 'dns.txt', 'summary.json']) assert.equal(existsSync(join(out, f)), false, f + ' is withheld');
  assert.ok(existsSync(join(out, 'my-site', 'index.html')), 'the upload tree is there');
  assert.ok(existsSync(join(out, 'site.torrent')));

  // 2. publish without the gate to get the upload tree, "upload" it (copy it to the host's directory),
  //    then the gated run passes
  const first = await run(Object.assign({}, opts, { verifyWs: false }));
  const hostDir = fresh('host');
  cpSync(first.outDir, hostDir, { recursive: true });
  const dev = await startWebseed(hostDir);
  const pass = await run(Object.assign({}, opts, { ws: [dev.url + 'ws/'], out: first.outDir }));
  assert.equal(pass.verified, true);
  assert.ok(existsSync(join(pass.outDir, 'pointer.txt')));
  assert.equal(pass.btih, first.btih, 'same files, same infohash');

  // 3. a file disappears from the host: the next gated run fails again and removes the stale pointer
  rmSync(join(hostDir, 'my-site', 'js', 'app.js'));
  await assert.rejects(run(Object.assign({}, opts, { ws: [dev.url + 'ws/'], out: first.outDir })), /--verify-ws failed/);
  assert.equal(existsSync(join(first.outDir, 'pointer.txt')), false, 'a stale pointer.txt does not survive a failed gate');
});

test('--verify-ws reports a host that answers Range with 200 in plain words', async () => {
  const key = (await makeKey()).file;
  const dir = makeSite();
  const first = await run({ dir, key, scope: '127.0.0.1', ws: ['http://127.0.0.1:9/ws/'] });
  const bad = await startWebseed(first.outDir, { dropRange: true });
  const lines = [];
  const original = process.stdout.write.bind(process.stdout);
  process.stdout.write = (chunk) => {
    lines.push(String(chunk));
    return true;
  };
  try {
    await assert.rejects(publish({
      dir, name: 'my-site', scope: '127.0.0.1', key, ws: [bad.url + 'ws/'], out: first.outDir, verifyWs: true, now: NOW,
    }), /--verify-ws failed/);
  } finally {
    process.stdout.write = original;
  }
  const text = lines.join('');
  assert.match(text, /Web seed misconfigured \(no Range support\)/);
  assert.match(text, /verify-ws: will contact http:\/\/127\.0\.0\.1:\d+/, 'the targets are printed before they are contacted');
  assert.equal(existsSync(join(first.outDir, 'pointer.txt')), false);
});

// ---------------------------------------------------------------------------------------------- command line

test('command line: exit codes and the printed pointer', async () => {
  const key = (await makeKey()).file;
  const dir = makeSite();
  const out = fresh('out');
  const args = ['tools/publish.mjs', dir, '--name', 'cli-site', '--scope', 'example.com', '--key', key, '--tr', 'wss://tracker.example', '--out', out];
  const ok = spawnSync(process.execPath, args, { cwd: ROOT, encoding: 'utf8' });
  assert.equal(ok.status, 0, ok.stderr);
  const pointerLine = ok.stdout.split('\n').find((l) => l.startsWith('v=mw1; '));
  assert.ok(pointerLine, 'the pointer is printed');
  assert.equal((await verifyPointer(parsePointer(pointerLine).record, 'example.com')).ok, true);
  assert.equal(formatPointer(parsePointer(pointerLine).record), pointerLine);
  const usage = spawnSync(process.execPath, ['tools/publish.mjs', dir, '--name'], { cwd: ROOT, encoding: 'utf8' });
  assert.equal(usage.status, 2);
  assert.match(usage.stderr, /--name needs a value/);
  const noDir = spawnSync(process.execPath, ['tools/publish.mjs', '--name', 'x'], { cwd: ROOT, encoding: 'utf8' });
  assert.equal(noDir.status, 2);
  chmodSync(key, 0o644);
  const refused = spawnSync(process.execPath, args, { cwd: ROOT, encoding: 'utf8' });
  assert.equal(refused.status, 1);
  assert.match(refused.stderr, /chmod 600/);
  assert.equal(refused.stderr.includes('"d"'), false, 'the private key is never printed');
});
