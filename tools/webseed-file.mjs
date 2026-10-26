#!/usr/bin/env node
// tools/webseed-file.mjs: put one file's bytes on static hosting as a web seed, with the serving headers of V03-DESIGN-REVIEW 2.8.5, and
// print the ws value (2.8.6, MF-50). Without a pin node holding the file on disk or a web seed, a shared file has no durability: it
// lives only while someone who has it has the page open.
//
//   node tools/webseed-file.mjs <file> --dir <static folder> --base <https URL of that folder> [--lane public|private]
//                               [--name <display name>] [--torrent <file.torrent>] [--prefix ws-files] [--json] [--quiet]
//
// <file> is the file as it travels in the swarm: for the PUBLIC lane (F1) the plain bytes the listing describes; for the PRIVATE lanes
// (F2 and M) the CIPHERTEXT, never the plaintext, so the host holds exactly what any peer in the private swarm holds. The tool copies it to
// <dir>/<prefix>/<sha256 of the bytes> (a name without an extension, so no host or browser decides the type from it) and writes
// <dir>/_headers (Netlify and Cloudflare Pages syntax; other hosts: set the same headers) with the headers a file is served under:
// Content-Type: application/octet-stream, X-Content-Type-Options: nosniff, Content-Security-Policy: sandbox; default-src 'none',
// Cross-Origin-Resource-Policy: same-origin, Cache-Control: no-store, Accept-Ranges: bytes, and a Content-Disposition: attachment with a
// cleaned, percent-encoded name. A script or a module cannot import it (nosniff and a type that is not JavaScript), a page cannot
// embed it, and a browser that opens the address downloads it. CORS headers let the loader's range requests through. With --torrent the
// bytes are checked against the torrent (one file, its length, every piece hash) before anything is written.

import { readFileSync, statSync, existsSync, mkdirSync, copyFileSync, chmodSync } from 'node:fs';
import { join, resolve, basename } from 'node:path';
import { createHash } from 'node:crypto';

import { fileHeaders } from '../src/files/serve.js';
import { cleanName } from '../src/files/names.js';
import { validateFileTorrent, LIMITS } from '../src/files/validate.js';
import { parseHeaders, headersFor } from '../src/sw/lib.js';
import { parseCli, runMain, isMain, writeFileAtomic, formatBytes, isLoopbackHost, ToolError, UsageError, out } from './lib.mjs';

const USAGE = `
Usage: node tools/webseed-file.mjs <file> --dir <static folder> --base <https URL of that folder> [--lane public|private]
                                   [--name <display name>] [--torrent <file.torrent>] [--prefix ws-files] [--json] [--quiet]

Copies <file> to <dir>/<prefix>/<sha256> and (re)writes <dir>/_headers with the serving headers of R 2.8.5, then prints the ws value to
put in the file listing or the grant. --lane private takes the CIPHERTEXT. --torrent <file> checks the bytes against the torrent first.
`;

/** The per-file caps of the lanes (R 2.8.8): a public file 25 MiB, a private file or media 100 MiB. */
export const LANE_CAPS = Object.freeze({ public: 25 * 1024 * 1024, private: 100 * 1024 * 1024 });
export const DEFAULT_PREFIX = 'ws-files';
const HEX64 = /^[0-9a-f]{64}$/;
const GENERATED = '# felinar web seed headers (tools/webseed-file.mjs; V03-DESIGN-REVIEW 2.8.5, 2.8.6). Regenerated on every run: do not edit by hand.';

/** CORS headers the loader's range requests need (the loader fetches web seed bytes cross-origin and checks every piece hash itself). */
export const WEBSEED_CORS = Object.freeze({
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS',
  'Access-Control-Allow-Headers': 'Range',
  'Access-Control-Expose-Headers': 'Content-Range, Content-Length, Accept-Ranges, ETag',
});

/**
 * commonHeaders() → the headers every file under the prefix is served with: the R 2.8.5 set (src/files/serve.js fileHeaders) without the
 * per-file Content-Disposition and the dynamic length and range, plus the CORS headers.
 */
export function commonHeaders() {
  const h = fileHeaders({ name: 'file', size: undefined });
  delete h['Content-Disposition'];
  return Object.assign({}, h, WEBSEED_CORS);
}

/** headersText({ prefixPath, entries }) → the _headers file: one block for every file under the prefix, one block per file with its Content-Disposition. */
export function headersText({ prefixPath, entries }) {
  const lines = [GENERATED, prefixPath + '*'];
  for (const [name, value] of Object.entries(commonHeaders())) lines.push('  ' + name + ': ' + value);
  for (const e of entries.slice().sort((a, b) => (a.sha256 < b.sha256 ? -1 : a.sha256 > b.sha256 ? 1 : 0))) {
    lines.push(prefixPath + e.sha256, '  Content-Disposition: ' + e.disposition);
  }
  return lines.join('\n') + '\n';
}

/** readEntries(text, prefixPath) → the per-file entries of a _headers file this tool wrote: [{ sha256, disposition }]. */
export function readEntries(text, prefixPath) {
  const entries = [];
  for (const rule of parseHeaders(text)) {
    if (!rule.for.startsWith(prefixPath) || rule.for === prefixPath + '*') continue;
    const sha256 = rule.for.slice(prefixPath.length);
    const disposition = rule.values['Content-Disposition'];
    if (HEX64.test(sha256) && typeof disposition === 'string') entries.push({ sha256, disposition });
  }
  return entries;
}

/** wsUrl(base, prefix, sha256) → the web seed URL of a stored file. */
export function wsUrl(base, prefix, sha256) {
  return base.replace(/\/*$/, '/') + prefix + '/' + sha256;
}

function checkBase(base) {
  let u;
  try {
    u = new URL(base);
  } catch (_) {
    throw new UsageError('--base must be the absolute URL the folder is served at, such as https://static.example/');
  }
  if (u.protocol !== 'https:' && !(u.protocol === 'http:' && isLoopbackHost(u.hostname))) throw new UsageError('--base must be https (http only for localhost)');
  if (u.search || u.hash || u.username || u.password) throw new UsageError('--base is a plain URL: no query, fragment or credentials');
  return u.href.endsWith('/') ? u.href : u.href + '/';
}

async function checkAgainstTorrent(bytes, torrentFile, lane) {
  let torrent;
  try {
    torrent = readFileSync(torrentFile);
  } catch (err) {
    throw new ToolError('cannot read --torrent ' + torrentFile + ': ' + err.message);
  }
  let checked;
  try {
    checked = await validateFileTorrent(new Uint8Array(torrent), { length: bytes.length, maxBytes: LANE_CAPS[lane], privateSwarm: lane === 'private' });
  } catch (err) {
    throw new ToolError('--torrent ' + torrentFile + ' is not a ' + lane + ' file torrent for these bytes (' + (err.reason || err.message) + ')');
  }
  const pieces = checked.pieces;
  for (let i = 0; i < checked.pieceCount; i++) {
    const piece = bytes.subarray(i * checked.pieceLength, Math.min(bytes.length, (i + 1) * checked.pieceLength));
    const digest = createHash('sha1').update(piece).digest();
    if (Buffer.compare(digest, Buffer.from(pieces.subarray(i * 20, i * 20 + 20))) !== 0) {
      throw new ToolError('piece ' + i + ' of --torrent does not match the file: these are not the bytes of that torrent' + (lane === 'private' ? ' (a private torrent covers the ciphertext)' : ''));
    }
  }
  return checked.infoHash;
}

/**
 * webseedFile({ file, dir, base, lane, name, torrent, prefix }) → { ws, path, sha256, bytes, headersFile, infoHash, disposition, lane }
 * Copies the file under <dir>/<prefix>/<sha256> and rewrites <dir>/_headers (the entries of earlier runs are kept).
 */
export async function webseedFile({ file, dir, base, lane = 'public', name = null, torrent = null, prefix = DEFAULT_PREFIX } = {}) {
  if (!file || !existsSync(file)) throw new UsageError('no such file: ' + file);
  if (!dir) throw new UsageError('missing --dir <static folder>');
  if (!base) throw new UsageError('missing --base <https URL of that folder>');
  if (lane !== 'public' && lane !== 'private') throw new UsageError('--lane must be public or private');
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(prefix)) throw new UsageError('--prefix is one plain path segment');
  const baseUrl = checkBase(base);
  const st = statSync(file);
  if (!st.isFile()) throw new UsageError(file + ' is not a regular file');
  if (st.size === 0) throw new ToolError(file + ' is empty');
  if (st.size > LANE_CAPS[lane]) {
    throw new ToolError(file + ' is ' + st.size.toLocaleString('en-US') + ' bytes, over the ' + LANE_CAPS[lane].toLocaleString('en-US') + ' bytes (' + formatBytes(LANE_CAPS[lane]) + ') cap of a ' + lane + ' file (R 2.8.8)');
  }
  const bytes = readFileSync(file);
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  const infoHash = torrent ? await checkAgainstTorrent(bytes, torrent, lane) : null;
  const display = cleanName(name === null || name === undefined ? basename(file) : String(name)) || 'file';
  const disposition = fileHeaders({ name: display, size: undefined })['Content-Disposition'];
  const root = resolve(dir);
  const target = join(root, prefix, sha256);
  mkdirSync(join(root, prefix), { recursive: true });
  copyFileSync(file, target);
  chmodSync(target, 0o644);
  const ws = wsUrl(baseUrl, prefix, sha256);
  const prefixPath = new URL(ws).pathname.slice(0, -sha256.length);
  const headersFile = join(root, '_headers');
  const previous = existsSync(headersFile) ? readEntries(readFileSync(headersFile, 'utf8'), prefixPath) : [];
  const entries = previous.filter((e) => e.sha256 !== sha256).concat([{ sha256, disposition }]);
  writeFileAtomic(headersFile, headersText({ prefixPath, entries }));
  return { ws, path: join(prefix, sha256), sha256, bytes: bytes.length, headersFile, infoHash, disposition, lane, files: entries.length };
}

/** headersFor(urlPath) of a written _headers, for checks: the merged headers a request for that path gets. */
export function headersOfWritten(text, urlPath) {
  return headersFor({ headers: text }, urlPath);
}

async function main(argv) {
  const { flags, positionals } = parseCli(argv, {
    dir: { type: 'string' },
    base: { type: 'string' },
    lane: { type: 'string', default: 'public' },
    name: { type: 'string' },
    torrent: { type: 'string' },
    prefix: { type: 'string', default: DEFAULT_PREFIX },
    json: { type: 'boolean' },
    quiet: { type: 'boolean' },
  });
  if (flags.help) {
    out(USAGE.trim());
    return 0;
  }
  if (positionals.length !== 1) throw new UsageError('expected one file');
  const r = await webseedFile({ file: positionals[0], dir: flags.dir, base: flags.base, lane: flags.lane, name: flags.name, torrent: flags.torrent, prefix: flags.prefix });
  if (flags.json) {
    out(JSON.stringify({ ws: r.ws, path: r.path, sha256: r.sha256, bytes: r.bytes, infoHash: r.infoHash, lane: r.lane }));
    return 0;
  }
  if (!flags.quiet) {
    out('copied ' + formatBytes(r.bytes) + ' (' + r.lane + ') to ' + join(flags.dir, r.path));
    out('headers ' + r.headersFile + ' (' + r.files + ' file' + (r.files === 1 ? '' : 's') + '): download only, no sniffing, sandboxed, CORS for range requests');
    if (r.infoHash) out('torrent  ' + r.infoHash + ' (every piece matched)');
    else out('torrent  not checked: pass --torrent <file> to check the bytes against the torrent first');
    if (r.lane === 'private') out('This is the ciphertext of a private file: the host holds what any peer of the private swarm holds, never the plaintext.');
    out('Upload ' + flags.dir + ' to the host that serves ' + flags.base + ' and keep _headers with it (a host that ignores _headers needs the same headers set by hand).');
    out('Serve it from a host or path your site\'s pages do not import from: nosniff and the octet-stream type already make a script or module import fail.');
  }
  out('ws=' + r.ws);
  return 0;
}

if (isMain(import.meta.url)) runMain(main, USAGE);
