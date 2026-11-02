// deploy/rtc-worker/rtc.js: the rendezvous core of the Cloudflare Worker in this folder (worker.js): the WebSocket tracker
// protocol that the loader speaks (bittorrent-tracker 11.2.3, what tools/tracker.mjs runs on), the pairing and room protocol of
// the apps (pair.js), an allow list and caps, with no runtime dependency, so a unit test drives it with fake connections and the
// Worker wraps it around hibernating sockets.
//
//   createRendezvous({ allow, uploads, open, intervalS, maxUnlisted, maxPerSocket, now, pairing, persist, random, pairCaps, maxLanes })
//     -> { attach(conn, saved), message(conn, text), close(conn), stale(conn, nowMs), attachmentOf(conn), stats(),
//          allowLane(hex, expMs), restore({ chans, lanes }), sweep(nowMs), nextExpiry() }
//
// A conn is any object with send(text). The core keeps, per connection, the peer id of its first announce and the swarms it
// is in, or, for a pair socket, its codes and pending knocks; attachmentOf(conn) gives that state in a form the Worker stores
// on the socket (under 2 KB), and attach(conn, saved) takes it back after the Durable Object woke from hibernation.
//
// What a message does (the same as bittorrent-tracker's WebSocket server, which the loader was tested against):
//   announce: the swarm's counts come back ({ action, interval, info_hash, complete, incomplete }); each offer the message
//   carries is passed to one other peer of the swarm as { action: 'announce', offer, offer_id, peer_id, info_hash }; an
//   answer is passed to the peer it names (to_peer_id) and gets no reply; 'stopped' leaves the swarm. Only left === 0 makes a
//   peer a seeder, and nothing makes a seeder a leecher again (rtc-worker-lane-1: an answer carries no left).
//   scrape: { action: 'scrape', files: { <info_hash>: { complete, incomplete, downloaded } }, flags }; a bare scrape names no
//   swarm and answers files: {} (rtc-worker-lane-3), as tools/tracker.mjs does.
//   pair-* and room-* (ARCHITECTURE 15.21): dispatched to pair.js before the announce and scrape branch. The first
//   message of a socket classifies it for its lifetime, as a tracker socket (announce, scrape) or a pair socket (pair-*,
//   room-*); a message of the other kind answers { action, 'failure reason': 'socket already used for another protocol' }.
//   The lanes that pairs and rooms mint are allowed like listed infohashes until they expire (24 hours).
//   anything else, or a malformed message: { 'failure reason': <why> } (with action and info_hash when they are known).
//
// The core never touches storage. A host that keeps rows (the Durable Object) passes persist(ops), which gets
// [['put', key, value] | ['delete', key]] synchronously, before the replies of that message are sent, and loads them back with
// restore() before it attaches the sockets. message() on a pair frame also returns touched (the other conns whose attachment
// moved: the host rewrites them) and pair: true.

import { createPairing, isPairAction, frameTooLarge, MIXED, MAX_PAIR_BYTES, MAX_LANES, CHAN_KEY, LANE_KEY } from './pair.js';

/** The announce interval the reply asks for, in seconds (bittorrent-tracker's default for WebSocket clients). */
export const INTERVAL_S = 120;
/** At most this many offers in one announce (tools/tracker.mjs refuses more too). */
export const MAX_OFFERS = 20;
/** At most this many swarms per connection: the state stored on a hibernating socket must stay under 2 KB. */
export const MAX_SWARMS_PER_SOCKET = 32;
/** At most this many unlisted swarms (uploads mode) in all. */
export const MAX_UNLISTED_SWARMS = 10000;
/** A message longer than this closes the connection. */
export const MAX_MESSAGE_BYTES = 131072;
/** A connection that announced nothing for this long is closed by the sweep (bittorrent-tracker forgets a peer after 20 minutes). */
export const PEER_TTL_S = 20 * 60;
/** The largest offer SDP accepted, in characters. */
export const MAX_SDP_CHARS = 16384;
const EVENTS = new Set(['started', 'stopped', 'completed', 'update', 'paused']);

/** bin2hex(s) -> the 40-hex text of a 20-byte "binary string" (one char per byte), or null for anything else. */
export function bin2hex(s) {
  if (typeof s !== 'string' || s.length !== 20) return null;
  let hex = '';
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c > 255) return null;
    hex += (c < 16 ? '0' : '') + c.toString(16);
  }
  return hex;
}

/** hex2bin(hex) -> the binary string of a hex text. */
export function hex2bin(hex) {
  let s = '';
  for (let i = 0; i + 1 < hex.length; i += 2) s += String.fromCharCode(parseInt(hex.slice(i, i + 2), 16));
  return s;
}

const HEX40_RE = /^[0-9a-f]{40}$/;

/**
 * parseAllow(text) -> { set: Set<40-hex>, uploads: boolean }. The text holds infohashes separated by spaces, commas or lines:
 * 40 hex (any case), urn:btih:<hex> or a magnet link with it; a line starting with # is a comment; the word "uploads" turns
 * uploads mode on (unlisted swarms served under the caps, as tools/tracker.mjs --uploads).
 */
export function parseAllow(text) {
  const set = new Set();
  let uploads = false;
  for (const rawLine of String(text || '').split(/\r?\n/)) {
    const line = rawLine.replace(/#.*$/, '').trim();
    if (!line) continue;
    for (const token of line.split(/[\s,]+/)) {
      if (!token) continue;
      if (/^uploads$/i.test(token)) { uploads = true; continue; }
      const m = /(?:urn:btih:|^)([0-9a-fA-F]{40})(?![0-9a-fA-F])/.exec(token);
      if (m) set.add(m[1].toLowerCase());
    }
  }
  return { set, uploads };
}

/** messageProblem(msg) -> null when msg is a well-formed announce or scrape, else the failure reason. */
export function messageProblem(msg) {
  if (!msg || typeof msg !== 'object' || Array.isArray(msg)) return 'invalid message';
  if (msg.action === 'announce') {
    if (bin2hex(msg.info_hash) === null) return 'invalid info_hash';
    if (bin2hex(msg.peer_id) === null) return 'invalid peer_id';
    if (msg.event !== undefined && msg.event !== null && msg.event !== '' && !EVENTS.has(msg.event)) return 'invalid event';
    if (msg.answer !== undefined && msg.answer !== null) {
      if (bin2hex(msg.to_peer_id) === null) return 'invalid `to_peer_id` (required with `answer`)';
      if (typeof msg.answer !== 'object' || typeof msg.answer.sdp !== 'string' || msg.answer.sdp.length > MAX_SDP_CHARS) return 'invalid answer';
    }
    if (msg.offers !== undefined && msg.offers !== null) {
      if (!Array.isArray(msg.offers) || msg.offers.length > MAX_OFFERS) return 'invalid offers';
      for (const o of msg.offers) {
        if (!o || typeof o !== 'object' || !o.offer || typeof o.offer !== 'object' || typeof o.offer.sdp !== 'string' || o.offer.sdp.length > MAX_SDP_CHARS) return 'invalid offers';
        if (typeof o.offer_id !== 'string' || !o.offer_id || o.offer_id.length > 64) return 'invalid offers';
      }
    }
    return null;
  }
  if (msg.action === 'scrape') {
    const list = msg.info_hash === undefined || msg.info_hash === null ? [] : (Array.isArray(msg.info_hash) ? msg.info_hash : [msg.info_hash]);
    for (const h of list) if (bin2hex(h) === null) return 'invalid info_hash';
    return null;
  }
  return 'invalid action in WS request: ' + String(msg.action);
}

export function createRendezvous({
  allow = new Set(), uploads = false, open = false, intervalS = INTERVAL_S, maxUnlisted = MAX_UNLISTED_SWARMS, maxPerSocket = MAX_SWARMS_PER_SOCKET,
  now = () => Date.now(), pairing: pairOn = true, persist = null, random, pairCaps, maxLanes = MAX_LANES,
} = {}) {
  // conn -> { peerId: hex|null, swarms: Map<hex, { complete }>, last: ms, proto: null|'tracker'|'pair' }
  const conns = new Map();
  // hex -> { listed, lane, peers: Map<hex, { conn, complete }> }; a lane swarm is listed while its lane is allowed and goes when empty
  const swarms = new Map();
  const lanes = new Map(); // hex -> expiry ms: the private lanes pairs and rooms minted, allowed like listed infohashes until then
  let unlisted = 0;

  const listed = (hex) => allow.has(hex) || lanes.has(hex);
  const stateOf = (conn) => conns.get(conn) || attach(conn, null);
  const send = (conn, obj) => { try { conn.send(JSON.stringify(obj)); } catch (_) { /* a socket on its way out */ } };
  const counts = (swarm) => {
    let complete = 0;
    let incomplete = 0;
    for (const p of swarm.peers.values()) { if (p.complete) complete++; else incomplete++; }
    return { complete, incomplete };
  };
  const flush = (ops) => { if (ops.length && persist) persist(ops); };

  function swarmFor(hex, create) {
    let s = swarms.get(hex);
    if (!s && create) {
      s = { listed: listed(hex), lane: !allow.has(hex) && lanes.has(hex), peers: new Map() };
      swarms.set(hex, s);
      if (!s.listed) unlisted++;
    }
    return s || null;
  }

  function dropIfEmpty(hex) {
    const s = swarms.get(hex);
    if (s && !s.peers.size && (!s.listed || s.lane)) { swarms.delete(hex); if (!s.listed) unlisted--; }
  }

  function leave(conn, st, hex) {
    const s = swarms.get(hex);
    const peerHex = st.swarms.get(hex) ? st.swarms.get(hex).peerId : st.peerId;
    if (s && peerHex && s.peers.get(peerHex) && s.peers.get(peerHex).conn === conn) s.peers.delete(peerHex);
    st.swarms.delete(hex);
    dropIfEmpty(hex);
  }

  /**
   * allowLane(hex, expMs) -> true when the lane is allowed (false: not a lane id, or the cap of lanes is reached). Used by the
   * host to load stored lanes; the pairing calls the same through addLane with durable = true, which also persists the row.
   */
  function addLane(hex, exp, durable) {
    if (typeof hex !== 'string' || !HEX40_RE.test(hex) || typeof exp !== 'number' || !Number.isFinite(exp)) return false;
    if (!lanes.has(hex) && lanes.size >= maxLanes) return false;
    lanes.set(hex, exp);
    const s = swarms.get(hex);
    if (s && !s.listed) { s.listed = true; s.lane = true; unlisted--; }
    if (durable) flush([['put', LANE_KEY + hex, exp]]);
    return true;
  }

  /**
   * sweepLanes(t) -> the conns whose swarms changed: a lane past its expiry is dead. It is no longer allowed, its swarm goes and its
   * members leave it (their next announce is refused, as tools/tracker.mjs refuses it); connections the peers already made between
   * themselves are not the rendezvous's to end.
   */
  function sweepLanes(t) {
    const ops = [];
    const left = [];
    for (const [hex, exp] of Array.from(lanes)) {
      if (exp > t) continue;
      lanes.delete(hex);
      ops.push(['delete', LANE_KEY + hex]);
      const s = swarms.get(hex);
      if (!s || !s.lane) continue;
      for (const p of s.peers.values()) {
        const st = conns.get(p.conn);
        if (st && st.swarms.delete(hex) && !left.includes(p.conn)) left.push(p.conn);
      }
      swarms.delete(hex);
    }
    flush(ops);
    return left;
  }

  const pairs = pairOn ? createPairing({ random, now, caps: pairCaps, persist: flush, allowLane: (hex, exp) => addLane(hex, exp, true) }) : null;

  /** attach(conn, saved): a new connection, or one restored from its saved state ({ p, s: [[hex, complete], ...], t } or { k: 'pair', c, q, t }). */
  function attach(conn, saved) {
    const st = { peerId: null, swarms: new Map(), last: now(), proto: null };
    conns.set(conn, st);
    if (saved && typeof saved === 'object') {
      if (typeof saved.t === 'number' && saved.t > 0) st.last = saved.t * 1000;
      if (pairs && (saved.k === 'pair' || Array.isArray(saved.c) || Array.isArray(saved.q))) {
        st.proto = 'pair';
        for (const [to, obj] of pairs.attach(conn, saved)) send(to, obj);
        return st;
      }
      if (typeof saved.p === 'string' && HEX40_RE.test(saved.p)) { st.peerId = saved.p; st.proto = 'tracker'; }
      if (st.peerId && Array.isArray(saved.s)) {
        for (const entry of saved.s.slice(0, maxPerSocket)) {
          const hex = Array.isArray(entry) ? entry[0] : null;
          if (typeof hex !== 'string' || !HEX40_RE.test(hex)) continue;
          if (!listed(hex) && !open && !uploads) continue;
          const s = swarmFor(hex, true);
          const complete = Array.isArray(entry) && entry[1] === 1;
          s.peers.set(st.peerId, { conn, complete });
          st.swarms.set(hex, { complete, peerId: st.peerId });
        }
      }
    }
    return st;
  }

  /** attachmentOf(conn) -> { p, s, t } or { k: 'pair', c, q, t }: what the Worker stores on the socket. */
  function attachmentOf(conn) {
    const st = stateOf(conn);
    const t = Math.floor(st.last / 1000);
    if (pairs && st.proto === 'pair') {
      const a = pairs.attachmentOf(conn);
      return { k: 'pair', c: a.c, q: a.q, t };
    }
    const s = [];
    for (const [hex, m] of st.swarms) s.push([hex, m.complete ? 1 : 0]);
    return { p: st.peerId, s, t };
  }

  function announce(conn, st, msg) {
    const hex = bin2hex(msg.info_hash);
    const peerHex = bin2hex(msg.peer_id);
    const bin = msg.info_hash;
    const fail = (why) => send(conn, { action: 'announce', 'failure reason': why, info_hash: bin });
    if (!st.peerId) st.peerId = peerHex;
    const member = st.swarms.get(hex) || null;
    let s = swarms.get(hex) || null;
    if (!member) {
      if (!open && !listed(hex)) {
        if (!uploads) return fail('not allowed: this rendezvous serves the sites it lists');
        if (!s && unlisted >= maxUnlisted) return fail('not allowed: no room for another unlisted swarm');
      }
      if (st.swarms.size >= maxPerSocket) return fail('not allowed: too many swarms on one connection (' + maxPerSocket + ')');
    }
    if (msg.event === 'stopped') {
      if (member) leave(conn, st, hex);
      const c = s && swarms.has(hex) ? counts(s) : { complete: 0, incomplete: 0 };
      send(conn, { action: 'announce', interval: intervalS, info_hash: bin, complete: c.complete, incomplete: c.incomplete });
      return;
    }
    const prior = s ? s.peers.get(peerHex) : undefined;
    s = swarmFor(hex, true);
    // rtc-worker-lane-1: only left === 0 promotes a peer, and nothing demotes one (bittorrent-tracker's swarm does the same); the
    // announce that carries an answer has no left, so it must leave a seeder a seeder
    const complete = Boolean(prior && prior.complete) || Number(msg.left) === 0;
    if (member && member.peerId !== peerHex) s.peers.delete(member.peerId);
    s.peers.set(peerHex, { conn, complete });
    st.swarms.set(hex, { complete, peerId: peerHex });
    if (msg.answer) {
      const to = s.peers.get(bin2hex(msg.to_peer_id));
      if (to && to.conn !== conn) send(to.conn, { action: 'announce', answer: msg.answer, offer_id: msg.offer_id, peer_id: hex2bin(peerHex), info_hash: bin });
      return;
    }
    const c = counts(s);
    send(conn, { action: 'announce', interval: intervalS, info_hash: bin, complete: c.complete, incomplete: c.incomplete });
    const offers = Array.isArray(msg.offers) ? msg.offers : [];
    if (offers.length) {
      const others = [];
      for (const [id, p] of s.peers) if (id !== peerHex && p.conn !== conn) others.push(p);
      for (let i = others.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); const t = others[i]; others[i] = others[j]; others[j] = t; }
      const n = Math.min(offers.length, others.length);
      for (let i = 0; i < n; i++) send(others[i].conn, { action: 'announce', offer: offers[i].offer, offer_id: offers[i].offer_id, peer_id: hex2bin(peerHex), info_hash: bin });
    }
  }

  function scrape(conn, msg) {
    // rtc-worker-lane-3: a scrape names its infohashes; a bare one answers files: {} (tools/tracker.mjs does the same), so a
    // visitor cannot list the swarms this rendezvous serves, unlisted file and member swarms included
    const list = msg.info_hash === undefined || msg.info_hash === null ? [] : (Array.isArray(msg.info_hash) ? msg.info_hash : [msg.info_hash]).map(bin2hex);
    const files = {};
    for (const hex of list) {
      const s = swarms.get(hex);
      const c = s ? counts(s) : { complete: 0, incomplete: 0 };
      files[hex2bin(hex)] = { complete: c.complete, incomplete: c.incomplete, downloaded: c.complete };
    }
    send(conn, { action: 'scrape', files, flags: { min_request_interval: intervalS } });
  }

  /** pairMessage(conn, st, msg, text): a pair-* or room-* frame goes to pair.js, never to the announce and scrape branch. */
  function pairMessage(conn, st, msg, text) {
    const refuse = (why) => {
      const reply = { action: String(msg.action).slice(0, 64), 'failure reason': why };
      if (typeof msg.rid === 'string' && msg.rid.length >= 1 && msg.rid.length <= 16) reply.rid = msg.rid;
      send(conn, reply);
      return { changed: false, problem: why, touched: [], pair: true };
    };
    if (!pairs) return refuse('pairing is off on this rendezvous');
    if (st.proto === 'tracker') return refuse(MIXED);
    if (frameTooLarge(text)) return refuse('message too large');
    const fresh = st.proto !== 'pair';
    st.proto = 'pair';
    const out = pairs.message(conn, msg);
    for (const [to, obj] of out.replies) send(to, obj);
    return { changed: fresh || out.changed, problem: out.problem, touched: pairs.takeTouched().filter((c) => c !== conn), pair: true };
  }

  /** message(conn, text) -> { changed, problem }: handles one text frame; changed says the saved state of conn moved. */
  function message(conn, text) {
    const st = stateOf(conn);
    st.last = now();
    if (st.proto === 'pair' && typeof text === 'string' && text.length > MAX_PAIR_BYTES) {
      // a pair socket sends small frames: a big one is refused unparsed (ARCHITECTURE 15.21)
      send(conn, { 'failure reason': 'message too large' });
      return { changed: false, problem: 'message too large', touched: [], pair: true };
    }
    let msg;
    try { msg = JSON.parse(text); } catch (_) { send(conn, { 'failure reason': 'invalid message: not JSON' }); return { changed: false, problem: 'invalid message: not JSON' }; }
    const object = Boolean(msg) && typeof msg === 'object' && !Array.isArray(msg);
    if (object && isPairAction(msg.action)) return pairMessage(conn, st, msg, text);
    if (object && (msg.action === 'announce' || msg.action === 'scrape')) {
      if (st.proto === 'pair') {
        send(conn, { action: msg.action, 'failure reason': MIXED });
        return { changed: false, problem: MIXED };
      }
      if (!st.proto) st.proto = 'tracker';
    }
    const problem = messageProblem(msg);
    if (problem) {
      const reply = { 'failure reason': problem };
      if (msg && (msg.action === 'announce' || msg.action === 'scrape')) reply.action = msg.action;
      if (msg && typeof msg.info_hash === 'string' && msg.info_hash.length === 20) reply.info_hash = msg.info_hash;
      send(conn, reply);
      return { changed: false, problem };
    }
    const before = st.peerId + '|' + Array.from(st.swarms, ([h, m]) => h + (m.complete ? '+' : '-')).join(',');
    if (msg.action === 'announce') announce(conn, st, msg);
    else scrape(conn, msg);
    const after = st.peerId + '|' + Array.from(st.swarms, ([h, m]) => h + (m.complete ? '+' : '-')).join(',');
    return { changed: before !== after, problem: null };
  }

  /** close(conn) -> { touched }: the connection is gone; every swarm it was in forgets it and its codes and knocks are released. */
  function close(conn) {
    const st = conns.get(conn);
    if (!st) return { touched: [] };
    if (pairs) for (const [to, obj] of pairs.close(conn)) send(to, obj);
    for (const hex of Array.from(st.swarms.keys())) leave(conn, st, hex);
    conns.delete(conn);
    return { touched: pairs ? pairs.takeTouched() : [] };
  }

  /**
   * stale(conn, nowMs) -> true when the connection announced nothing for PEER_TTL_S. A pair socket that owns a code waits for the
   * code to run out instead: its owner may sit with the page open and send nothing.
   */
  function stale(conn, nowMs = now()) {
    const st = conns.get(conn);
    if (!st) return true;
    if (pairs && st.proto === 'pair' && pairs.ownsLive(conn)) return false;
    return nowMs - st.last > PEER_TTL_S * 1000;
  }

  /** sweep(nowMs) -> { touched }: lanes past their expiry go, knocks and codes past theirs are answered and released (the host's alarm). */
  function sweep(t = now()) {
    const touched = sweepLanes(t);
    if (!pairs) return { touched };
    for (const [to, obj] of pairs.sweep(t)) send(to, obj);
    for (const conn of pairs.takeTouched()) if (!touched.includes(conn)) touched.push(conn);
    return { touched };
  }

  /** nextExpiry() -> the earliest ms at which a lane, a code or a knock runs out (Infinity when there is none). */
  function nextExpiry() {
    let at = pairs ? pairs.nextExpiry() : Infinity;
    for (const exp of lanes.values()) if (exp < at) at = exp;
    return at;
  }

  /**
   * restore({ chans, lanes }): load the stored rows, before any socket is attached. chans and lanes are the entries of
   * ctx.storage.list({ prefix }) (key -> value); a lane that ran out or cannot be allowed is deleted from the store.
   */
  function restore({ chans = [], lanes: laneRows = [] } = {}) {
    const t = now();
    const ops = [];
    for (const [key, exp] of laneRows) {
      const hex = typeof key === 'string' && key.startsWith(LANE_KEY) ? key.slice(LANE_KEY.length) : key;
      if (typeof exp === 'number' && exp > t && addLane(hex, exp, false)) continue;
      if (typeof key === 'string') ops.push(['delete', key.startsWith(LANE_KEY) ? key : LANE_KEY + key]);
    }
    flush(ops);
    if (pairs) {
      pairs.load(Array.from(chans, ([key, d]) => [typeof key === 'string' && key.startsWith(CHAN_KEY) ? key.slice(CHAN_KEY.length) : key, d]));
      return;
    }
    // pairing was switched off: the rows of its codes are left over, and nothing will ever claim them (lanes stay until they expire)
    flush(Array.from(chans, ([key]) => ['delete', typeof key === 'string' && key.startsWith(CHAN_KEY) ? key : CHAN_KEY + key]));
  }

  function stats() {
    let peers = 0;
    for (const s of swarms.values()) peers += s.peers.size;
    const p = pairs ? pairs.stats() : { codes: 0, knocks: 0 };
    return { open, uploads, allowed: allow.size, swarms: swarms.size, unlisted, peers, sockets: conns.size, interval: intervalS, codes: p.codes, knocks: p.knocks, lanes: lanes.size };
  }

  return { attach, attachmentOf, message, close, stale, stats, allowLane: (hex, exp) => addLane(hex, exp, false), restore, sweep, nextExpiry };
}
