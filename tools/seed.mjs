#!/usr/bin/env node
// tools/seed.mjs: a Node seeder for a published site (ARCHITECTURE section 10). It serves the files of
// <dir> to browser visitors over WebRTC, announcing to the trackers of the .torrent, so the site stays
// reachable without anyone's browser tab (sustained seeding; drop-in visitors only seed in bursts).
//
//   node tools/seed.mjs <site.torrent> <dir> [--tr <wss url>]... [--dry-run] [--quiet]
//
// <dir> is the web seed upload tree that tools/publish.mjs wrote (<out>/<name>/, it also holds /.mw/*),
// or the directory that contains it. Every piece is hashed against the .torrent before anything is
// announced. Nothing is copied: a read-only chunk store reads the files in place.
//
// Browsers only speak WebRTC, so Node needs a WebRTC implementation: node-datachannel (its polyfill).
// It is optional: when it cannot be loaded the tool prints how to seed another way and exits with 3.
// --tr replaces the tracker list of the .torrent for this run (a local tracker, say). The tool
// contacts the trackers and peers of the torrent, so it prints them before starting; it is never run
// by the tests.

import { readFileSync, existsSync, statSync, openSync, readSync, closeSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createHash } from 'node:crypto';

import { parseTorrentFile, sliceForPiece } from '../src/common/torrent-file.js';
import { encode as bencode, decode as bdecode } from '../src/common/bencode.js';
import { parseCli, runMain, isMain, formatBytes, ToolError, UsageError, out, warn } from './lib.mjs';

const USAGE = `
Usage: node tools/seed.mjs <site.torrent> <dir> [--tr <wss url>]... [--dry-run] [--quiet]
Exit codes: 0 stopped normally (or --dry-run verified), 1 the directory does not match the torrent,
2 usage error, 3 no WebRTC implementation for Node (instructions are printed).
`;

// ---------------------------------------------------------------------------------------------
// the directory
// ---------------------------------------------------------------------------------------------

/** resolveSeedDir(parsed, dir) → the directory that holds the torrent's files: <dir> itself, or <dir>/<name>. */
export function resolveSeedDir(parsed, dir) {
  const base = resolve(dir);
  const first = parsed.files.find((f) => !f.pad && f.length > 0) || parsed.files[0];
  const has = (d) => existsSync(join(d, ...first.path.split('/')));
  if (has(base)) return base;
  const nested = join(base, parsed.name);
  if (has(nested)) return nested;
  return base;
}

class Files {
  constructor(parsed, dir) {
    this.parsed = parsed;
    this.dir = dir;
    this.fds = new Map();
  }

  fd(index) {
    let fd = this.fds.get(index);
    if (fd === undefined) {
      fd = openSync(join(this.dir, ...this.parsed.files[index].path.split('/')), 'r');
      this.fds.set(index, fd);
    }
    return fd;
  }

  /** The bytes of piece `index`, zero-filled for pad files. */
  piece(index) {
    const parts = sliceForPiece(this.parsed, index).map(({ fileIndex, start, end }) => {
      const buf = Buffer.alloc(end - start);
      if (!this.parsed.files[fileIndex].pad) {
        const fd = this.fd(fileIndex);
        let got = 0;
        while (got < buf.length) {
          const n = readSync(fd, buf, got, buf.length - got, start + got);
          if (n === 0) throw new Error('unexpected end of ' + this.parsed.files[fileIndex].path);
          got += n;
        }
      }
      return buf;
    });
    return Buffer.concat(parts);
  }

  close() {
    for (const fd of this.fds.values()) {
      try {
        closeSync(fd);
      } catch (_) { /* already closed */ }
    }
    this.fds.clear();
  }
}

/**
 * verifyDirectory(parsed, dir) → { ok, missing: [path], wrongLength: [{ path, want, got }], badPieces: [index], pieces }
 * Checks every file's presence and length, then (when those pass) the SHA-1 of every piece.
 */
export function verifyDirectory(parsed, dir) {
  const result = { ok: true, missing: [], wrongLength: [], badPieces: [], pieces: parsed.pieceCount };
  for (const f of parsed.files) {
    if (f.pad) continue;
    let st = null;
    try {
      st = statSync(join(dir, ...f.path.split('/')));
    } catch (_) { /* reported below */ }
    if (!st || !st.isFile()) result.missing.push(f.path);
    else if (st.size !== f.length) result.wrongLength.push({ path: f.path, want: f.length, got: st.size });
  }
  if (result.missing.length || result.wrongLength.length) {
    result.ok = false;
    return result;
  }
  const files = new Files(parsed, dir);
  try {
    for (let i = 0; i < parsed.pieceCount; i++) {
      const sum = createHash('sha1').update(files.piece(i)).digest();
      if (!sum.equals(Buffer.from(parsed.pieces.subarray(i * 20, i * 20 + 20)))) result.badPieces.push(i);
    }
  } finally {
    files.close();
  }
  result.ok = result.badPieces.length === 0;
  return result;
}

/** createDirStoreClass(parsed, dir) → an abstract-chunk-store class that reads pieces from the files, read only. */
export function createDirStoreClass(parsed, dir) {
  return class DirStore {
    constructor(chunkLength) {
      this.chunkLength = chunkLength;
      this.files = new Files(parsed, dir);
    }

    put(index, buf, cb) {
      if (cb) queueMicrotask(() => cb(null)); // complete torrent: nothing is ever written
    }

    get(index, opts, cb) {
      if (typeof opts === 'function') {
        cb = opts;
        opts = null;
      }
      let piece;
      try {
        piece = this.files.piece(index);
      } catch (err) {
        return queueMicrotask(() => cb(err));
      }
      const offset = (opts && opts.offset) || 0;
      const length = (opts && opts.length) || piece.length - offset;
      return queueMicrotask(() => cb(null, piece.subarray(offset, offset + length)));
    }

    close(cb) {
      this.files.close();
      if (cb) queueMicrotask(() => cb(null));
    }

    destroy(cb) {
      this.close(cb);
    }
  };
}

/** rewriteAnnounce(torrentBytes, trackers) → the .torrent with its tracker lists replaced (outside the infohash). */
export function rewriteAnnounce(torrentBytes, trackers) {
  const { value } = bdecode(torrentBytes);
  delete value.announce;
  delete value['announce-list'];
  if (trackers.length) {
    value.announce = trackers[0];
    value['announce-list'] = trackers.map((t) => [t]);
  }
  return bencode(value);
}

// ---------------------------------------------------------------------------------------------
// WebRTC for Node
// ---------------------------------------------------------------------------------------------

/**
 * loadWebRtc({ importer }) → { ok: true, source } | { ok: false, reason }
 * Installs node-datachannel's WebRTC polyfill (or webrtc-polyfill, which wraps it) as the globals
 * WebTorrent looks for. `importer(name)` defaults to dynamic import (tests pass a stand-in).
 */
export async function loadWebRtc({ importer = (name) => import(name), target = globalThis } = {}) {
  const attempts = [];
  for (const name of ['node-datachannel/polyfill', 'webrtc-polyfill']) {
    try {
      const mod = await importer(name);
      const api = mod && mod.RTCPeerConnection ? mod : (mod && mod.default && mod.default.RTCPeerConnection ? mod.default : null);
      if (!api) throw new Error('no RTCPeerConnection export');
      for (const key of ['RTCPeerConnection', 'RTCSessionDescription', 'RTCIceCandidate', 'RTCDataChannel']) {
        if (api[key] && !target[key]) target[key] = api[key];
      }
      target.WRTC = { RTCPeerConnection: api.RTCPeerConnection, RTCSessionDescription: api.RTCSessionDescription, RTCIceCandidate: api.RTCIceCandidate };
      return { ok: true, source: name };
    } catch (err) {
      attempts.push(name + ': ' + ((err && err.message) || err));
    }
  }
  return { ok: false, reason: attempts.join('; ') };
}

/** The text printed when Node cannot do WebRTC. */
export function seedInstructions({ torrent, dir, reason }) {
  return [
    'Node cannot speak WebRTC here (' + reason + '), and browsers only speak WebRTC, so this tool cannot seed.',
    '',
    'Pick one:',
    '  1. Build the WebRTC binding for Node that came with the tools (the version the lockfile pins), then run this command again:',
    '       npm rebuild node-datachannel --ignore-scripts=false',
    '     Only this package\'s install script runs. It downloads a prebuilt binary from the node-datachannel GitHub releases, which',
    '     no lockfile hash covers, so run it only if you accept that; every other install stays without scripts (SECURITY.md).',
    '  2. Keep a real browser on the site, which also holds the ledger: node tools/pin.mjs <your site URL> --headless',
    '  3. For a local demo: node tools/demo.mjs (a headless browser seeds the example from tools/seeder.html).',
    '',
    'Without any seeder the site still loads from its web seed (xs= and ws= in the pointer); seeding adds',
    'peers, offload and ledger sync. Files to serve: ' + dir + ' (from ' + torrent + ').',
  ].join('\n');
}

// ---------------------------------------------------------------------------------------------

async function main(argv) {
  const { flags, positionals } = parseCli(argv, {
    tr: { type: 'list' },
    'dry-run': { type: 'boolean' },
    quiet: { type: 'boolean' },
  });
  if (flags.help) {
    out(USAGE.trim());
    return 0;
  }
  if (positionals.length !== 2) throw new UsageError('expected <site.torrent> <dir>');
  const [torrentPath, dirArg] = positionals;
  let torrentBytes;
  try {
    torrentBytes = new Uint8Array(readFileSync(torrentPath));
  } catch (err) {
    throw new ToolError('cannot read ' + torrentPath + ': ' + err.message);
  }
  const parsed = await parseTorrentFile(torrentBytes);
  const dir = resolveSeedDir(parsed, dirArg);
  const log = flags.quiet ? () => {} : out;
  log('seed ' + parsed.name + ' (btih ' + parsed.infoHash + ', ' + parsed.files.filter((f) => !f.pad).length + ' files, ' + formatBytes(parsed.length) + ')');
  log('files from ' + dir);
  const check = verifyDirectory(parsed, dir);
  if (!check.ok) {
    for (const p of check.missing.slice(0, 10)) warn('missing ' + p);
    for (const w of check.wrongLength.slice(0, 10)) warn(w.path + ' is ' + w.got + ' bytes, the torrent says ' + w.want);
    if (check.badPieces.length) warn(check.badPieces.length + ' of ' + check.pieces + ' pieces do not match the torrent (first: ' + check.badPieces[0] + ')');
    out('The directory does not match the torrent. Seed the upload tree that publish wrote: <out>/' + parsed.name + '/ (it also holds /.mw/site.json and /.mw/files.json).');
    return 1;
  }
  log('all ' + check.pieces + ' pieces match the torrent');
  if (flags.dryRun) return 0;
  const trackers = flags.tr.length ? flags.tr : parsed.announce;
  const rtc = await loadWebRtc();
  if (!rtc.ok) {
    process.stderr.write(seedInstructions({ torrent: torrentPath, dir, reason: rtc.reason }) + '\n');
    return 3;
  }
  log('WebRTC from ' + rtc.source);
  log('Will contact: ' + (trackers.join(', ') || '(no tracker in the torrent)') + ' and every browser that asks for this torrent.');
  const { default: WebTorrent } = await import('webtorrent');
  const client = new WebTorrent({ dht: false, lsd: false, natUpnp: false, natPmp: false, utp: false });
  client.on('error', (err) => warn('client error: ' + ((err && err.message) || err)));
  const Store = createDirStoreClass(parsed, dir);
  const torrent = client.add(Buffer.from(rewriteAnnounce(torrentBytes, trackers)), { store: Store, skipVerify: true, private: true });
  torrent.on('warning', (w) => warn(((w && w.message) || String(w))));
  torrent.on('error', (err) => warn('torrent error: ' + ((err && err.message) || err)));
  torrent.on('wire', () => log('peer connected (' + torrent.numPeers + ' now)'));
  await new Promise((resolveReady) => torrent.once('ready', resolveReady));
  if (torrent.infoHash !== parsed.infoHash) throw new ToolError('internal: the client computed infohash ' + torrent.infoHash);
  log('seeding ' + torrent.infoHash + '; Ctrl-C to stop');
  const tick = setInterval(() => log(new Date().toISOString().slice(11, 19) + ' peers ' + torrent.numPeers + ', uploaded ' + formatBytes(torrent.uploaded)), 30000);
  await new Promise((resolveStop) => {
    const stop = () => {
      clearInterval(tick);
      client.destroy(() => resolveStop());
    };
    process.once('SIGINT', stop);
    process.once('SIGTERM', stop);
  });
  return 0;
}

if (isMain(import.meta.url)) runMain(main, USAGE);
