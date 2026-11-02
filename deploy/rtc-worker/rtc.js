// deploy/rtc-worker/rtc.js: the rendezvous core of the Cloudflare Worker in this folder (worker.js): the WebSocket tracker
// protocol that the loader speaks (bittorrent-tracker 11.2.3, what tools/tracker.mjs runs on), an allow list and caps, with
// no runtime dependency, so a unit test drives it with fake connections and the Worker wraps it around hibernating sockets.
//
//   createRendezvous({ allow, uploads, open, intervalS, maxUnlisted, maxPerSocket, now })
//     -> { attach(conn, saved), message(conn, text), close(conn), stale(conn, nowMs), attachmentOf(conn), stats() }
//
// A conn is any object with send(text). The core keeps, per connection, the peer id of its first announce and the swarms it
// is in; attachmentOf(conn) gives that state in a form the Worker stores on the socket (under 2 KB), and attach(conn, saved)
// takes it back after the Durable Object woke from hibernation.
//
// What a message does (the same as bittorrent-tracker's WebSocket server, which the loader was tested against):
//   announce: the swarm's counts come back ({ action, interval, info_hash, complete, incomplete }); each offer the message
//   carries is passed to one other peer of the swarm as { action: 'announce', offer, offer_id, peer_id, info_hash }; an
//   answer is passed to the peer it names (to_peer_id) and gets no reply; 'stopped' leaves the swarm.
//   scrape: { action: 'scrape', files: { <info_hash>: { complete, incomplete, downloaded } }, flags }.
//   anything else, or a malformed message: { 'failure reason': <why> } (with action and info_hash when they are known).

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
const SCRAPE_ALL_MAX = 100;
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

export function createRendezvous({ allow = new Set(), uploads = false, open = false, intervalS = INTERVAL_S, maxUnlisted = MAX_UNLISTED_SWARMS, maxPerSocket = MAX_SWARMS_PER_SOCKET, now = () => Date.now() } = {}) {
  const conns = new Map(); // conn -> { peerId: hex|null, swarms: Map<hex, { complete }>, last: ms }
  const swarms = new Map(); // hex -> { listed, peers: Map<hex, { conn, complete }> }
  let unlisted = 0;

  const listed = (hex) => allow.has(hex);
  const stateOf = (conn) => conns.get(conn) || attach(conn, null);
  const send = (conn, obj) => { try { conn.send(JSON.stringify(obj)); } catch (_) { /* a socket on its way out */ } };
  const counts = (swarm) => {
    let complete = 0;
    let incomplete = 0;
    for (const p of swarm.peers.values()) { if (p.complete) complete++; else incomplete++; }
    return { complete, incomplete };
  };

  function swarmFor(hex, create) {
    let s = swarms.get(hex);
    if (!s && create) {
      s = { listed: listed(hex), peers: new Map() };
      swarms.set(hex, s);
      if (!s.listed) unlisted++;
    }
    return s || null;
  }

  function dropIfEmpty(hex) {
    const s = swarms.get(hex);
    if (s && !s.peers.size && !s.listed) { swarms.delete(hex); unlisted--; }
  }

  function leave(conn, st, hex) {
    const s = swarms.get(hex);
    const peerHex = st.swarms.get(hex) ? st.swarms.get(hex).peerId : st.peerId;
    if (s && peerHex && s.peers.get(peerHex) && s.peers.get(peerHex).conn === conn) s.peers.delete(peerHex);
    st.swarms.delete(hex);
    dropIfEmpty(hex);
  }

  /** attach(conn, saved): a new connection, or one restored from its saved state ({ p, s: [[hex, complete], ...], t }). */
  function attach(conn, saved) {
    const st = { peerId: null, swarms: new Map(), last: now() };
    conns.set(conn, st);
    if (saved && typeof saved === 'object') {
      if (typeof saved.p === 'string' && HEX40_RE.test(saved.p)) st.peerId = saved.p;
      if (typeof saved.t === 'number' && saved.t > 0) st.last = saved.t * 1000;
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

  /** attachmentOf(conn) -> { p, s, t }: what the Worker stores on the socket. */
  function attachmentOf(conn) {
    const st = stateOf(conn);
    const s = [];
    for (const [hex, m] of st.swarms) s.push([hex, m.complete ? 1 : 0]);
    return { p: st.peerId, s, t: Math.floor(st.last / 1000) };
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
    s = swarmFor(hex, true);
    const complete = Number(msg.left) === 0;
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
    const list = msg.info_hash === undefined || msg.info_hash === null ? Array.from(swarms.keys()).slice(0, SCRAPE_ALL_MAX) : (Array.isArray(msg.info_hash) ? msg.info_hash : [msg.info_hash]).map(bin2hex);
    const files = {};
    for (const hex of list) {
      const s = swarms.get(hex);
      const c = s ? counts(s) : { complete: 0, incomplete: 0 };
      files[hex2bin(hex)] = { complete: c.complete, incomplete: c.incomplete, downloaded: c.complete };
    }
    send(conn, { action: 'scrape', files, flags: { min_request_interval: intervalS } });
  }

  /** message(conn, text) -> { changed, problem }: handles one text frame; changed says the saved state of conn moved. */
  function message(conn, text) {
    const st = stateOf(conn);
    st.last = now();
    let msg;
    try { msg = JSON.parse(text); } catch (_) { send(conn, { 'failure reason': 'invalid message: not JSON' }); return { changed: false, problem: 'invalid message: not JSON' }; }
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

  /** close(conn): the connection is gone; every swarm it was in forgets it. */
  function close(conn) {
    const st = conns.get(conn);
    if (!st) return;
    for (const hex of Array.from(st.swarms.keys())) leave(conn, st, hex);
    conns.delete(conn);
  }

  /** stale(conn, nowMs) -> true when the connection announced nothing for PEER_TTL_S. */
  function stale(conn, nowMs = now()) {
    const st = conns.get(conn);
    return !st || nowMs - st.last > PEER_TTL_S * 1000;
  }

  function stats() {
    let peers = 0;
    for (const s of swarms.values()) peers += s.peers.size;
    return { open, uploads, allowed: allow.size, swarms: swarms.size, unlisted, peers, sockets: conns.size, interval: intervalS };
  }

  return { attach, attachmentOf, message, close, stale, stats };
}
