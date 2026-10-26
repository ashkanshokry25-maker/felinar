// Unit tests for tools/lib.mjs: the command-line parser, HTML meta stamping, file walking, the
// loopback policy helpers and the development certificates.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync, chmodSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import {
  parseCli, UsageError, ToolError, injectMeta, readMeta, scanTags, walkFiles, compareUtf8, isLoopbackHost, isLoopbackUrl,
  assertPrivateKeyFile, devCerts, formatBytes, escapeAttr, isUtf16, sha256Hex, writeFileAtomic, isInside, lanAddresses,
} from '../../tools/lib.mjs';

const work = mkdtempSync(join(tmpdir(), 'mw-lib-test-'));
// built from code points: the tool layer that writes this file may decode \u escapes
const E = String.fromCharCode(0xe9);
const BOM = String.fromCharCode(0xfeff);
after(() => rmSync(work, { recursive: true, force: true }));

test('parseCli: strings, ints, booleans, lists, aliases, camelCase keys, positionals and "--"', () => {
  const spec = {
    name: { type: 'string' }, 'max-bytes': { type: 'int' }, force: { type: 'boolean' }, tr: { type: 'list' },
    out: { type: 'string', alias: 'o', default: 'dist' }, tls: { type: 'tls' }, quiet: { type: 'boolean', default: true },
  };
  const r = parseCli(['site', '--name', 'x', '--max-bytes=42', '--force', '--tr', 'a', '--tr=b', '--no-quiet', '--', '--not-a-flag', 'y'], spec);
  assert.deepEqual(r.positionals, ['site', '--not-a-flag', 'y']);
  assert.deepEqual(r.flags, { name: 'x', maxBytes: 42, force: true, tr: ['a', 'b'], out: 'dist', tls: null, quiet: false });
  assert.equal(parseCli(['--out', 'z'], spec).flags.out, 'z');
  assert.equal(parseCli(['--o', 'z'], spec).flags.out, 'z', 'an alias is a long option too');
  assert.equal(parseCli([], spec).flags.out, 'dist');
  assert.equal(parseCli(['--force=false'], spec).flags.force, false);
  assert.equal(parseCli(['--help'], spec).flags.help, true);
});

test('parseCli: --tls with and without a certificate and key', () => {
  const spec = { tls: { type: 'tls' }, port: { type: 'int' } };
  assert.equal(parseCli(['--tls'], spec).flags.tls, true);
  assert.deepEqual(parseCli(['--tls', 'cert.pem', 'key.pem'], spec).flags.tls, { cert: 'cert.pem', key: 'key.pem' });
  const after = parseCli(['--tls', '--port', '5'], spec);
  assert.equal(after.flags.tls, true);
  assert.equal(after.flags.port, 5);
  assert.throws(() => parseCli(['--tls=cert.pem'], spec), UsageError);
});

test('parseCli: unknown flags, missing values and bad integers are usage errors', () => {
  const spec = { name: { type: 'string' }, n: { type: 'int' }, force: { type: 'boolean' } };
  assert.throws(() => parseCli(['--bogus'], spec), /unknown option --bogus/);
  assert.throws(() => parseCli(['--name'], spec), /needs a value/);
  assert.throws(() => parseCli(['--name', '--force'], spec), /needs a value/);
  assert.throws(() => parseCli(['--n', 'x'], spec), /non-negative integer/);
  assert.throws(() => parseCli(['--n', '-3'], spec), UsageError);
  assert.throws(() => parseCli(['--n', '1.5'], spec), UsageError);
  assert.throws(() => parseCli(['--n', '99999999999999999999'], spec), UsageError);
  assert.throws(() => parseCli(['--force=maybe'], spec), /true or false/);
  assert.equal(parseCli(['--n', '0'], spec).flags.n, 0);
});

test('injectMeta: first child of <head> after a leading charset, idempotent, replaces earlier tags, escapes attributes', () => {
  const page = '<!doctype html><html><head><meta charset="utf-8"><title>T</title></head><body></body></html>';
  const once = injectMeta(page, [{ name: 'mw-pointer', content: 'v=mw1; a="b"; c<d' }]);
  assert.equal(once.html, '<!doctype html><html><head><meta charset="utf-8"><meta name="mw-pointer" content="v=mw1; a=&quot;b&quot;; c&lt;d"><title>T</title></head><body></body></html>');
  assert.equal(once.changed, true);
  assert.equal(readMeta(once.html, 'mw-pointer'), 'v=mw1; a="b"; c<d', 'the content reads back');
  const twice = injectMeta(once.html, [{ name: 'mw-pointer', content: 'v=mw1; a="b"; c<d' }]);
  assert.equal(twice.html, once.html);
  assert.equal(twice.changed, false);
  const replaced = injectMeta(once.html, [{ name: 'MW-Pointer', content: 'new' }]);
  assert.equal((replaced.html.match(/mw-pointer/gi) || []).length, 1);
  assert.equal(readMeta(replaced.html, 'mw-pointer'), 'new');
  const two = injectMeta('<html><head></head></html>', [{ name: 'a', content: '1' }, { name: 'b', content: '2' }]);
  assert.equal(two.html, '<html><head><meta name="a" content="1"><meta name="b" content="2"></head></html>');
  assert.equal(two.end, '<html><head>'.length + '<meta name="a" content="1"><meta name="b" content="2">'.length);
});

test('injectMeta: pages without <head>, with BOMs, comments and scripts that mention <head>', () => {
  const m = [{ name: 'x', content: 'y' }];
  assert.equal(injectMeta('<p>fragment</p>', m).html, '<meta name="x" content="y"><p>fragment</p>');
  assert.equal(injectMeta('<!doctype html><p>no html tag</p>', m).html, '<!doctype html><meta name="x" content="y"><p>no html tag</p>');
  assert.equal(injectMeta('<html><body>b</body></html>', m).html, '<html><meta name="x" content="y"><body>b</body></html>');
  assert.equal(injectMeta(BOM + '<html><head></head></html>', m).html, BOM + '<html><head><meta name="x" content="y"></head></html>');
  const tricky = '<!-- <head> --><html><head><script>var s = "<head>";</script></head></html>';
  const out = injectMeta(tricky, m).html;
  assert.equal(out, '<!-- <head> --><html><head><meta name="x" content="y"><script>var s = "<head>";</script></head></html>');
  assert.equal(readMeta('<!-- <meta name="x" content="no"> --><meta name="x" content="yes">', 'x'), 'yes');
  assert.equal(readMeta('<html></html>', 'x'), null);
  assert.deepEqual(scanTags('<a href="1"><!-- <b> --><script><c></script><d>').map((t) => t.name), ['a', 'script', 'd']);
  assert.equal(isUtf16(Buffer.from([0xff, 0xfe, 0x3c, 0x00])), true);
  assert.equal(isUtf16(Buffer.from('<html>')), false);
  assert.equal(escapeAttr('a&"<>'), 'a&amp;&quot;&lt;&gt;');
});

test('walkFiles: sorted by UTF-8 bytes, posix paths, skips and reports links and ignored entries', () => {
  const root = join(work, 'walk');
  mkdirSync(join(root, 'sub', 'deeper'), { recursive: true });
  mkdirSync(join(root, 'skipme'));
  for (const f of ['b.txt', 'a.txt', 'Z.txt', 'sub/x.txt', 'sub/deeper/y.txt', 'skipme/z.txt', E + '.txt', 'zz.txt']) writeFileSync(join(root, ...f.split('/')), f);
  symlinkSync(join(root, 'a.txt'), join(root, 'link.txt'));
  const skipped = [];
  const files = walkFiles(root, { skip: (rel, isDir) => (isDir && rel === 'skipme' ? 'ignored' : null), onSkip: (rel, why) => skipped.push([rel, why]) });
  assert.deepEqual(files.map((f) => f.path), ['Z.txt', 'a.txt', 'b.txt', 'sub/deeper/y.txt', 'sub/x.txt', 'zz.txt', E + '.txt'], 'uppercase before lowercase, accents after ASCII (byte order)');
  assert.ok(files.every((f) => f.abs.startsWith(root) && typeof f.size === 'number'));
  assert.deepEqual(skipped.sort(), [['link.txt', 'symbolic link (not followed)'], ['skipme/', 'ignored']]);
  assert.ok(compareUtf8('a', 'b') < 0 && compareUtf8(E, 'z') > 0 && compareUtf8('a', 'a') === 0);
  assert.throws(() => walkFiles(join(root, 'nope')), ToolError);
});

test('loopback helpers implement docs/DEV-NETWORK.md', () => {
  for (const h of ['localhost', 'LOCALHOST', 'a.localhost', '127.0.0.1', '127.1.2.3', '::1', '[::1]', 'localhost.']) assert.equal(isLoopbackHost(h), true, h);
  for (const h of ['example.com', '192.168.1.1', '10.0.0.1', '0.0.0.0', 'localhost.example.com', '128.0.0.1', '', null, undefined]) assert.equal(isLoopbackHost(h), false, String(h));
  assert.equal(isLoopbackUrl('http://127.0.0.1:8080/x'), true);
  assert.equal(isLoopbackUrl('wss://localhost:8001'), true);
  assert.equal(isLoopbackUrl('https://example.com'), false);
  assert.equal(isLoopbackUrl('not a url'), false);
  assert.ok(Array.isArray(lanAddresses()));
});

test('assertPrivateKeyFile: regular files readable by the owner only', () => {
  const key = join(work, 'k.jwk');
  writeFileSync(key, '{}', { mode: 0o600 });
  chmodSync(key, 0o600);
  assert.doesNotThrow(() => assertPrivateKeyFile(key));
  for (const mode of [0o640, 0o604, 0o660, 0o644, 0o666]) {
    chmodSync(key, mode);
    assert.throws(() => assertPrivateKeyFile(key), /chmod 600/, mode.toString(8));
  }
  chmodSync(key, 0o400);
  assert.doesNotThrow(() => assertPrivateKeyFile(key), 'read-only for the owner is fine');
  assert.throws(() => assertPrivateKeyFile(work), /not a regular file/);
  assert.throws(() => assertPrivateKeyFile(join(work, 'absent.jwk')), /not found.*keygen/);
});

test('devCerts: explicit files win; without mkcert the error says what to install; both files are required', () => {
  const certFile = join(work, 'c.pem');
  const keyFile = join(work, 'k.pem');
  writeFileSync(certFile, 'CERT');
  writeFileSync(keyFile, 'KEY');
  const explicit = devCerts({ cert: certFile, key: keyFile });
  assert.equal(explicit.cert.toString(), 'CERT');
  assert.equal(explicit.generated, false);
  assert.throws(() => devCerts({ cert: certFile }), /certificate and a key/);
  const saved = process.env.PATH;
  process.env.PATH = '';
  try {
    assert.throws(() => devCerts({ dir: join(work, 'no-certs'), hosts: ['localhost'] }), (err) => err instanceof ToolError && /mkcert/.test(err.message) && /mkcert -install/.test(err.message));
  } finally {
    process.env.PATH = saved;
  }
});

test('small helpers: formatBytes, sha256Hex, writeFileAtomic, isInside', () => {
  assert.equal(formatBytes(0), '0 B');
  assert.equal(formatBytes(1023), '1023 B');
  assert.equal(formatBytes(1024), '1.0 KiB');
  assert.equal(formatBytes(10 * 1024 * 1024), '10 MiB');
  assert.equal(sha256Hex(Buffer.from('abc')), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  const file = join(work, 'deep', 'er', 'file.txt');
  writeFileAtomic(file, 'one');
  writeFileAtomic(file, 'two');
  assert.equal(require_read(file), 'two');
  assert.equal(isInside('/a/b', '/a/b/c'), true);
  assert.equal(isInside('/a/b', '/a/b'), true);
  assert.equal(isInside('/a/b', '/a/bc'), false);
  assert.equal(isInside('/a/b', '/a'), false);
});

import { readFileSync } from 'node:fs';
function require_read(file) {
  return readFileSync(file, 'utf8');
}

// Code review round 1 (docs/DEV-NETWORK.md): tools that drive a browser give loopback pages the
// local-only browser; pin, snapshot and check-site --headless all ask live.allowRemoteFor().
test('allowRemoteFor: loopback pages get the local-only browser, remote pages the open one', async () => {
  const { allowRemoteFor } = await import('../../tools/live.mjs');
  for (const url of ['http://127.0.0.1:8080/', 'http://localhost:3000/x', 'http://[::1]:9/']) assert.equal(allowRemoteFor(url), false, url);
  for (const url of ['https://example.com/', 'https://203.0.113.9/']) assert.equal(allowRemoteFor(url), true, url);
  const { readFileSync } = await import('node:fs');
  const { ROOT: root } = await import('../../tools/lib.mjs');
  for (const tool of ['pin.mjs', 'snapshot.mjs', 'check-site.mjs']) {
    const src = readFileSync(join(root, 'tools', tool), 'utf8');
    assert.equal(/allowRemote:\s*true/.test(src), false, tool + ' never hard-codes allowRemote: true');
  }
});
