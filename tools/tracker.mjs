#!/usr/bin/env node
// tools/tracker.mjs: a WebSocket tracker for WebTorrent peers (ARCHITECTURE section 10,
// DESIGN-REVIEW items 12(d), 15 and 22). Built on bittorrent-tracker's server.
//
//   node tools/tracker.mjs [--port 8000] [--host 127.0.0.1] [--interval 120000]
//                          [--allow <btih|file>]... [--uploads] [--hub <suffix>]... [--open] [--tls [<cert> <key>]]
//                          [--max-swarms 10000] [--max-swarms-per-connection 64]
//
// An open tracker relays WebRTC offers for any infohash and anyone can use it, so the tracker
// refuses to start without --allow unless --open is given. --allow takes a 40-hex or base32
// infohash, a magnet link, a .torrent, the summary.json that tools/publish.mjs writes (it lists
// the site's btih and its ledger anchor torrent), or a text file with one infohash, magnet link or
// pointer per line ('#' starts a comment). Allow files are re-read when they change.
//
// v0.3 lanes (review round SCALE-2): the chat lane of a listed site is derived from its ledger id
// (sha1("mw-chat1|" + ledgerId), src/chat/lane.js) and served with it; a hub's follow lane
// (sha1("mw-hub-lane1|" + suffix + "|0"), src/chain/multi.js) is listed with --hub or a "hub <suffix>"
// line. File, media and per-member ledger swarms get a new infohash per upload, which no list can name
// in advance: they are served in "uploads" mode (--uploads, an "uploads" line in an allow file, or a
// summary.json whose features include files or media), where an unlisted infohash is accepted under
// two caps. Listed infohashes are never refused for a cap.
// Caps (SCALE-10): one WebSocket may be in at most --max-swarms-per-connection unlisted swarms, and
// the tracker holds at most --max-swarms unlisted swarms; a socket that closes takes every peer id it
// announced with it, so a flood ends when its sockets do.
// Binds 127.0.0.1 by default (docs/DEV-NETWORK.md); use --host 0.0.0.0 for a LAN or a server.
// --tls serves wss:// with the files given, or with mkcert certificates from .mw-dev-certs/.

import http from 'node:http';
import https from 'node:https';
import { readFileSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';
import Server from 'bittorrent-tracker/server';

import { normalizeBtih, parseMagnet } from '../src/common/magnet.js';
import { parsePointer } from '../src/common/pointer.js';
import { parseTorrentFile } from '../src/common/torrent-file.js';
import {
  parseCli, runMain, isMain, devCerts, lanAddresses, isLoopbackHost, ToolError, UsageError, out, warn,
} from './lib.mjs';

const USAGE = `
Usage: node tools/tracker.mjs [--port 8000] [--host 127.0.0.1] [--interval 120000]
                              [--allow <btih|file>]... [--open] [--tls [<cert> <key>]] [--quiet] [--json]

--allow   an infohash (40 hex or base32), a magnet link, a .torrent, publish's summary.json, or a
          text file with one infohash per line; repeatable. The tracker serves these, the chat lane
          of every listed site (from the ledgerId of a summary.json) and the hub lanes of --hub.
--uploads also serve unlisted infohashes (file, media and member ledger swarms) under the caps below;
          on by itself when a listed summary.json has files or media on, or an allow file has an
          "uploads" line
--hub     a hub's host name: its follow lane is listed too (repeatable; also a "hub <suffix>" line)
--max-swarms                  unlisted swarms the tracker holds at most (default 10000)
--max-swarms-per-connection   unlisted swarms one WebSocket may be in (default 256; a browser
                              shares one WebSocket per tracker for all its torrents, so a pin node
                              that holds more files needs more)
--open    serve every infohash under the same caps (anyone can use this tracker to relay WebRTC offers)
--tls     wss://; with two files (cert key) those are used, else mkcert files from .mw-dev-certs/
`;

const ACTION_SCRAPE = 2; // bittorrent-tracker lib/common.js ACTIONS.SCRAPE
// rendezvousBtih (v0.2.1 B2) is the ledger swarm; anchorBtih is its v0.2 name (publish writes both).
const JSON_HASH_KEYS = new Set(['btih', 'rendezvousbtih', 'anchorbtih', 'infohash', 'info_hash']);
/** src/chat/limits.js LANE_PREFIX and src/chain/multi.js LANE_PREFIX (a unit test keeps them equal). */
export const CHAT_LANE_PREFIX = 'mw-chat1|';
export const HUB_LANE_PREFIX = 'mw-hub-lane1|';
/** Defaults of the two caps (SCALE-10). */
export const MAX_SWARMS = 10000;
export const MAX_SWARMS_PER_CONNECTION = 256;
// The features of a summary.json that need unlisted swarms (a new infohash per upload).
const UPLOAD_FEATURES = new Set(['files', 'media']);

const sha1Hex = (text) => createHash('sha1').update(text, 'utf8').digest('hex');
/** chatLaneHash(ledgerId) → 40 hex: the site chat lane (src/chat/lane.js chatLaneInfoHash). */
export const chatLaneHash = (ledgerId) => sha1Hex(CHAT_LANE_PREFIX + ledgerId);
/** hubLaneHash(suffix, shard = 0) → 40 hex: a hub's follow lane (src/chain/multi.js laneInfoHash). */
export function hubLaneHash(suffix, shard = 0) {
  const s = String(suffix || '').trim().toLowerCase().replace(/\.$/, '');
  if (!s || !/^[a-z0-9.:[\]-]+$/.test(s)) throw new UsageError('--hub must be a host name, got ' + JSON.stringify(suffix));
  return sha1Hex(HUB_LANE_PREFIX + s + '|' + shard);
}

// ---------------------------------------------------------------------------------------------
// allow list
// ---------------------------------------------------------------------------------------------

function hashesFromJson(value, into, key = '') {
  if (typeof value === 'string') {
    if (JSON_HASH_KEYS.has(key.toLowerCase())) {
      const h = normalizeBtih(value);
      if (h) into.add(h);
    } else if (key.toLowerCase() === 'ledgerid' && value) {
      into.add(chatLaneHash(value)); // the site's chat lane (SCALE-2)
    }
  } else if (Array.isArray(value)) {
    if (key.toLowerCase() === 'features' && value.some((f) => UPLOAD_FEATURES.has(f))) into.uploads = true;
    for (const item of value) hashesFromJson(item, into, key);
  } else if (value && typeof value === 'object') {
    for (const k of Object.keys(value)) hashesFromJson(value[k], into, k);
  }
}

/**
 * hashesFromText(text) → Set of lowercase hex infohashes: JSON (btih / rendezvousBtih / anchorBtih / infoHash
 * keys, at any depth, and the chat lane of a ledgerId) or lines holding an infohash, a magnet link, a pointer record,
 * "hub <suffix>" (the hub's follow lane) or "uploads". The set's uploads property is true when the text asks for
 * unlisted swarms (an "uploads" line, or a summary.json whose features include files or media).
 */
export function hashesFromText(text) {
  const found = new Set();
  const trimmed = String(text).trim();
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    try {
      hashesFromJson(JSON.parse(trimmed), found);
      return found;
    } catch (_) { /* not JSON: read it as lines */ }
  }
  for (const raw of trimmed.split(/\r?\n/)) {
    const line = raw.replace(/\s+#.*$/, '').trim();
    if (!line || line.startsWith('#')) continue;
    if (/^uploads$/i.test(line)) {
      found.uploads = true;
      continue;
    }
    const hub = /^hub\s+(\S+)$/i.exec(line);
    if (hub) {
      try {
        found.add(hubLaneHash(hub[1]));
      } catch (_) { /* not a host name: ignored like any other unreadable line */ }
      continue;
    }
    const direct = normalizeBtih(line);
    if (direct) {
      found.add(direct);
      continue;
    }
    const magnet = /^magnet:/i.test(line) ? parseMagnet(line) : null;
    if (magnet) {
      found.add(magnet.btih);
      continue;
    }
    const pointer = parsePointer(line);
    if (pointer.ok) found.add(pointer.record.btih);
  }
  return found;
}

/** readAllowFile(path) → Promise<Set<hex>>: a .torrent, JSON or text file (see hashesFromText). */
export async function readAllowFile(path) {
  let bytes;
  try {
    bytes = readFileSync(path);
  } catch (err) {
    throw new ToolError('cannot read the allow file ' + path + ': ' + err.message);
  }
  if (bytes[0] === 0x64 /* d */) {
    try {
      return new Set([(await parseTorrentFile(new Uint8Array(bytes))).infoHash]);
    } catch (_) { /* a text file that starts with a d: fall through */ }
  }
  return hashesFromText(bytes.toString('utf8'));
}

/**
 * createAllowList(specs) → { has(hex), size, hashes(), refresh(), files }
 * specs: infohashes and file paths (see the module comment). Files are re-read when their
 * modification time changes (checked at most once per second, on use).
 */
export async function createAllowList(specs = [], { now = Date.now } = {}) {
  const fixed = new Set();
  const files = [];
  for (const spec of specs) {
    const direct = normalizeBtih(spec);
    if (direct) {
      fixed.add(direct);
      continue;
    }
    const magnet = /^magnet:/i.test(spec) ? parseMagnet(spec) : null;
    if (magnet) {
      fixed.add(magnet.btih);
      continue;
    }
    let st;
    try {
      st = statSync(spec);
    } catch (_) {
      throw new UsageError('--allow ' + spec + ' is neither an infohash nor a readable file');
    }
    if (!st.isFile()) throw new UsageError('--allow ' + spec + ' is not a file');
    files.push({ path: spec, mtime: -1, hashes: new Set() });
  }
  let merged = new Set(fixed);
  let uploads = false;
  let checkedAt = 0;
  const rebuild = () => {
    merged = new Set(fixed);
    uploads = false;
    for (const f of files) {
      for (const h of f.hashes) merged.add(h);
      if (f.hashes.uploads) uploads = true;
    }
  };
  const refresh = async (force = false) => {
    let changed = false;
    for (const f of files) {
      let mtime;
      try {
        mtime = statSync(f.path).mtimeMs;
      } catch (_) {
        continue; // keep the last good list while the file is being replaced
      }
      if (force || mtime !== f.mtime) {
        f.hashes = await readAllowFile(f.path);
        f.mtime = mtime;
        changed = true;
      }
    }
    if (changed) rebuild();
    checkedAt = now();
    return changed;
  };
  await refresh(true);
  return {
    files: files.map((f) => f.path),
    get size() {
      return merged.size;
    },
    hashes: () => Array.from(merged).sort(),
    /** true when an allow file asks for unlisted swarms (see hashesFromText). */
    get uploads() {
      return uploads;
    },
    has(hex) {
      if (files.length && now() - checkedAt >= 1000) {
        checkedAt = now();
        refresh().catch(() => {}); // takes effect from the next request
      }
      return merged.has(hex);
    },
    refresh,
  };
}

// ---------------------------------------------------------------------------------------------
// message checks
// ---------------------------------------------------------------------------------------------

const MAX_OFFERS = 20;

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

/**
 * messageProblem(raw) → null | string: why a WebSocket frame must not reach bittorrent-tracker.
 * Frames that are not JSON are left to the library (it answers them with a failure reason); the
 * checks cover what it would dereference without looking: the offers list of an announce and the
 * answer fields.
 */
export function messageProblem(raw) {
  let msg;
  try {
    msg = JSON.parse(Buffer.isBuffer(raw) ? raw.toString('utf8') : String(raw));
  } catch (_) {
    return null;
  }
  if (!isObject(msg)) return 'invalid message';
  if (msg.action !== 'announce') return null;
  if (msg.offers !== undefined) {
    if (!Array.isArray(msg.offers) || msg.offers.length > MAX_OFFERS) return 'invalid offers';
    for (const entry of msg.offers) {
      if (!isObject(entry) || !isObject(entry.offer) || typeof entry.offer_id !== 'string') return 'invalid offers';
    }
  }
  if (msg.answer !== undefined && msg.answer !== null) {
    if (!isObject(msg.answer) || typeof msg.to_peer_id !== 'string' || typeof msg.offer_id !== 'string') return 'invalid answer';
  }
  return null;
}

// ---------------------------------------------------------------------------------------------
// tracker
// ---------------------------------------------------------------------------------------------

/**
 * createTracker(options) → Promise<{ server, url, urls, host, port, allow, close(), stats() }>
 * options: { port = 8000 (0: ephemeral), host = '127.0.0.1', interval = 120000, allow = [], hubs = [], uploads = false, open = false,
 * tls = false (true or { cert, key } file paths), tlsHosts = [] (extra names for a generated certificate), maxPayload = 131072,
 * maxTorrents = 10000 (unlisted swarms in all), maxSwarmsPerSocket = 64 (unlisted swarms per WebSocket), quiet = true, log }
 * Throws UsageError when neither allow nor open is given.
 */
export async function createTracker(options = {}) {
  const o = Object.assign({
    port: 8000, host: '127.0.0.1', interval: 120000, allow: [], hubs: [], uploads: false, open: false, tls: false,
    maxPayload: 131072, maxTorrents: MAX_SWARMS, maxSwarmsPerSocket: MAX_SWARMS_PER_CONNECTION, quiet: true,
  }, options);
  const specs = [].concat(o.allow || []).concat([].concat(o.hubs || []).map((h) => hubLaneHash(h)));
  if (!o.open && specs.length === 0) {
    throw new UsageError('refusing to start an open tracker: pass --allow <btih|file> (the summary.json that publish writes, ' +
      'a .torrent, an infohash or a file with one infohash per line) to serve only your torrents, or --open to serve every infohash ' +
      '(anyone can then use this tracker to relay WebRTC offers).');
  }
  const log = o.quiet ? () => {} : (o.log || ((line) => process.stdout.write(line + '\n')));
  const allow = await createAllowList(specs);
  // Unlisted swarms are served in open mode and in uploads mode (an option, or asked for by an allow file).
  const unlistedServed = () => Boolean(o.open || o.uploads || allow.uploads);
  const listed = (hex) => allow.has(hex);
  let unlistedCount = 0; // swarms that exist and are not listed (kept by createSwarm and the prune below)

  const server = new Server({
    http: false,
    udp: false,
    stats: false,
    ws: { noServer: true, maxPayload: o.maxPayload, perMessageDeflate: false },
    interval: o.interval,
    filter(infoHash, params, cb) {
      if (listed(infoHash)) return cb(null); // never refused for a cap (SCALE-10)
      if (!unlistedServed()) return cb(new Error('torrent not allowed on this tracker'));
      const socket = params && params.socket;
      if (socket && Array.isArray(socket.infoHashes) && socket.infoHashes.indexOf(infoHash) < 0) {
        let mine = 0;
        for (const h of socket.infoHashes) if (!listed(h)) mine++;
        if (mine >= o.maxSwarmsPerSocket) return cb(new Error('too many swarms on this connection'));
      }
      if (!server.torrents[infoHash] && unlistedCount >= o.maxTorrents) return cb(new Error('this tracker is full'));
      if (socket && params.peer_id) {
        // Every peer id a socket announces, so its close stops all of them (the library stops only the first).
        if (!socket.mwPeers) socket.mwPeers = new Map();
        let ids = socket.mwPeers.get(infoHash);
        if (!ids) socket.mwPeers.set(infoHash, (ids = new Set()));
        if (ids.size < 4) ids.add(params.peer_id);
        else if (!ids.has(params.peer_id)) return cb(new Error('too many peer ids on this connection'));
      }
      return cb(null);
    },
  });
  const createSwarm = server.createSwarm.bind(server);
  server.createSwarm = (infoHash, cb) => createSwarm(infoHash, (err, swarm) => {
    if (!err && swarm && !listed(infoHash)) unlistedCount++;
    cb(err, swarm);
  });
  // bittorrent-tracker sends 'stopped' on close for the socket's first peer id only; the others would stay in their
  // swarms until the process restarts (SCALE-10: one socket with a fresh peer id per announce kept the tracker full).
  const onClose = server._onWebSocketClose.bind(server);
  server._onWebSocketClose = (socket) => {
    if (socket && socket.mwPeers) {
      for (const [infoHash, ids] of socket.mwPeers) {
        const swarm = server.torrents[infoHash];
        if (!swarm) continue;
        for (const id of ids) {
          if (id === socket.peerId) continue;
          const peer = swarm.peers.peek(id);
          if (peer && peer.socket === socket) swarm.announce({ type: 'ws', event: 'stopped', numwant: 0, peer_id: id });
        }
      }
      socket.mwPeers = null;
    }
    return onClose(socket);
  };
  server.on('error', (err) => log('[tracker] error: ' + (err && err.message)));
  server.on('warning', (err) => log('[tracker] warning: ' + (err && err.message)));

  // A scrape must name its infohashes: bittorrent-tracker answers a bare scrape with the counts of
  // every torrent it serves, which would let anyone list them. A bare scrape gets an empty answer
  // (not an error: the library's error path for scrapes assumes an info_hash and would throw).
  const request = server._onRequest.bind(server);
  server._onRequest = (params, cb) => {
    if (params && params.action === ACTION_SCRAPE && (params.info_hash == null || (Array.isArray(params.info_hash) && params.info_hash.length === 0))) {
      return cb(null, { action: ACTION_SCRAPE, files: {}, flags: { min_request_interval: Math.ceil(o.interval / 1000) } });
    }
    return request(params, cb);
  };

  // bittorrent-tracker 11 reads params.offers[i].offer for every peer it returns, so an announce
  // with offers: [null] and one other peer in the swarm throws from a timer callback and takes the
  // whole process down. Messages are checked here before the library sees them.
  const handleMessage = server._onWebSocketRequest.bind(server);
  server._onWebSocketRequest = (socket, opts, raw) => {
    const problem = messageProblem(raw);
    if (problem) {
      socket.send(JSON.stringify({ 'failure reason': problem }), socket.onSend);
      server.emit('warning', new Error(problem));
      return undefined;
    }
    return handleMessage(socket, opts, raw);
  };

  const stats = () => {
    let peers = 0;
    let torrents = 0;
    for (const hash of Object.keys(server.torrents)) {
      const swarm = server.torrents[hash];
      torrents++;
      peers += (swarm.complete || 0) + (swarm.incomplete || 0);
    }
    return { open: Boolean(o.open), uploads: unlistedServed(), allowed: o.open ? null : allow.size, torrents, unlisted: unlistedCount, peers };
  };

  const handler = (req, res) => {
    const path = String(req.url || '/').split('?')[0];
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405, { allow: 'GET, HEAD', 'content-type': 'text/plain; charset=utf-8' });
      return res.end('Method not allowed\n');
    }
    if (path === '/stats.json') {
      res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
      return res.end(req.method === 'HEAD' ? undefined : JSON.stringify(stats()));
    }
    if (path === '/' || path === '/healthz') {
      res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' });
      return res.end(req.method === 'HEAD' ? undefined : (path === '/healthz' ? 'ok\n' : 'felinar tracker (WebSocket)\n'));
    }
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
    return res.end('Not found\n');
  };

  let httpServer;
  let scheme = 'ws';
  if (o.tls) {
    const hosts = ['localhost', '127.0.0.1', '::1'];
    if (o.host === '0.0.0.0' || o.host === '::') hosts.push(...lanAddresses());
    else if (!['127.0.0.1', 'localhost', '::1'].includes(o.host)) hosts.push(o.host);
    for (const h of o.tlsHosts || []) if (!hosts.includes(h)) hosts.push(h);
    const certs = devCerts(Object.assign({ hosts }, typeof o.tls === 'object' ? o.tls : {}));
    httpServer = https.createServer({ cert: certs.cert, key: certs.key }, handler);
    scheme = 'wss';
  } else {
    httpServer = http.createServer(handler);
  }
  // The WebSocketServer runs with clientTracking off and http.Server.closeAllConnections() does not reach
  // upgraded sockets, so the live WebSockets are tracked here: close() ends them and dropConnections()
  // simulates a tracker blip (tests; v0.2.1 B1).
  const live = new Set();
  httpServer.on('upgrade', (req, socket, head) => {
    server.ws.handleUpgrade(req, socket, head, (ws) => {
      live.add(ws);
      ws.once('close', () => live.delete(ws));
      server.ws.emit('connection', ws, req);
    });
  });
  httpServer.on('clientError', (err, socket) => {
    if (socket.writable) socket.end('HTTP/1.1 400 Bad Request\r\n\r\n');
  });
  await new Promise((resolve, reject) => {
    httpServer.once('error', reject);
    httpServer.listen(o.port, o.host, () => {
      httpServer.off('error', reject);
      resolve();
    });
  });
  const port = httpServer.address().port;
  const shown = o.host === '0.0.0.0' || o.host === '::' ? '127.0.0.1' : (o.host.indexOf(':') >= 0 ? '[' + o.host + ']' : o.host);
  const urls = [scheme + '://' + shown + ':' + port];
  if (o.host === '0.0.0.0' || o.host === '::') for (const ip of lanAddresses()) urls.push(scheme + '://' + ip + ':' + port);

  // Empty swarms are forgotten (bittorrent-tracker keeps them forever); listed ones cost nothing and stay.
  const pruneNow = () => {
    let removed = 0;
    for (const hash of Object.keys(server.torrents)) {
      const swarm = server.torrents[hash];
      if (swarm && swarm.complete + swarm.incomplete === 0 && !listed(hash)) {
        delete server.torrents[hash];
        unlistedCount = Math.max(0, unlistedCount - 1);
        removed++;
      }
    }
    return removed;
  };
  const prune = setInterval(pruneNow, 300000);
  prune.unref();

  log('[tracker] ' + urls[0] + (o.open ? ' (open)' : ' (' + allow.size + ' allowed infohashes' + (unlistedServed() ? ', uploads' : '') + ')'));
  return {
    server,
    httpServer,
    host: o.host,
    port,
    url: urls[0],
    urls,
    allow,
    stats,
    /** prune() → n: forgets the empty unlisted swarms now (the tracker does it every 5 minutes). */
    prune: pruneNow,
    /** dropConnections() → n: terminates every live WebSocket (a tracker blip) and keeps listening. */
    dropConnections: () => {
      let n = 0;
      for (const ws of Array.from(live)) {
        try {
          ws.terminate();
          n++;
        } catch (_) { /* gone */ }
      }
      return n;
    },
    get liveConnections() { return live.size; },
    close: () => new Promise((resolve) => {
      clearInterval(prune);
      try {
        server.ws.close();
      } catch (_) { /* already closed */ }
      for (const client of Array.from(live).concat(Array.from(server.ws.clients || []))) {
        try {
          client.terminate();
        } catch (_) { /* gone */ }
      }
      if (typeof httpServer.closeAllConnections === 'function') httpServer.closeAllConnections();
      httpServer.close(() => resolve());
    }),
  };
}

async function main(argv) {
  const { flags, positionals } = parseCli(argv, {
    port: { type: 'int', default: 8000 },
    host: { type: 'string', default: '127.0.0.1' },
    interval: { type: 'int', default: 120000 },
    allow: { type: 'list' },
    hub: { type: 'list' },
    uploads: { type: 'boolean' },
    'max-swarms': { type: 'int', default: MAX_SWARMS },
    'max-swarms-per-connection': { type: 'int', default: MAX_SWARMS_PER_CONNECTION },
    open: { type: 'boolean' },
    tls: { type: 'tls' },
    quiet: { type: 'boolean' },
    json: { type: 'boolean' },
  });
  if (flags.help) {
    out(USAGE.trim());
    return 0;
  }
  if (positionals.length) throw new UsageError('unexpected argument ' + positionals[0]);
  if (flags.open && !isLoopbackHost(flags.host)) {
    warn('--open on ' + flags.host + ': anyone who can reach this tracker can use it to relay WebRTC offers for any infohash');
  }
  if (flags.maxSwarms < 1 || flags.maxSwarmsPerConnection < 1) throw new UsageError('--max-swarms and --max-swarms-per-connection must be at least 1');
  const tracker = await createTracker({
    port: flags.port, host: flags.host, interval: flags.interval, allow: flags.allow, hubs: flags.hub, uploads: flags.uploads, open: flags.open, tls: flags.tls,
    maxTorrents: flags.maxSwarms, maxSwarmsPerSocket: flags.maxSwarmsPerConnection, quiet: true,
  });
  const uploads = tracker.stats().uploads;
  if (flags.json) out(JSON.stringify({ url: tracker.url, urls: tracker.urls, port: tracker.port, open: flags.open, uploads, allowed: tracker.allow.size }));
  else {
    out('felinar tracker listening: ' + tracker.url);
    for (const u of tracker.urls.slice(1)) out('  ' + u);
    out(flags.open ? '  open: serving every infohash' : '  serving ' + tracker.allow.size + ' allowed infohash(es)' +
      (tracker.allow.files.length ? ' from ' + tracker.allow.files.join(', ') + ' (re-read when the file changes)' : ''));
    if (flags.open || uploads) {
      out('  unlisted swarms (file, media and member ledger swarms): at most ' + flags.maxSwarms + ' in all and ' + flags.maxSwarmsPerConnection + ' per connection; listed ones are never refused');
    }
    if (tracker.allow.size === 0 && !flags.open) warn('the allow list is empty: every announce is refused until an infohash is added');
  }
  const stop = () => tracker.close().then(() => process.exit(0));
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
  if (!flags.quiet && !flags.json) {
    const tick = setInterval(() => {
      const s = tracker.stats();
      out('[tracker] ' + new Date().toISOString() + ' torrents ' + s.torrents + ', peers ' + s.peers);
    }, 600000);
    tick.unref();
  }
  return undefined;
}

if (isMain(import.meta.url)) runMain(main, USAGE);
