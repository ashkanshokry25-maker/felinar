// deploy/rtc-worker/pair.js: the pairing and room protocol of the rendezvous (mw-pair-v1; ARCHITECTURE 15.21).
// Pure, no platform code and no dependency, so rtc.js (the Cloudflare Worker's core), tools/tracker.mjs (the Node tracker) and
// the unit tests drive the same state machine with fake connections.
//
//   createPairing({ random, now, allowLane, laneExpiry, liveness, persist, caps, relay })
//     -> { message(conn, msg), close(conn), sweep(nowMs), attach(conn, saved), attachmentOf(conn), load(entries),
//          takeTouched(), nextExpiry(), ownsLive(conn), stats() }
//   message() answers { replies, changed, problem } and, when the socket sent more than caps.messagesPerMin messages in a minute,
//   close: 'too many messages' as well: the host closes that socket with code 1008 and then calls close(conn) as for any socket.
//   When a join evicted members that had gone silent (DECISIONS DEC-1, below) it answers evicted: [conn, ...] as well: the host
//   closes each of those sockets with code 1000 if it is still open and then calls close(conn) for it as for any socket.
//
// What the rendezvous is to a pairing: a blind relay. A code is 12 characters, shown xxxx-xxxx-xxxx. The first 4 are the CHANNEL,
// the only part of a code this module ever sees; the last 8 are the SECRET (40 bits), which stays on the clients. A hello
// (identity key, chat key, name) travels only as a BOX, { iv, ct }, sealed under a key derived from the secret, so this module
// checks shapes and sizes and forwards what it cannot read. Why 8 secret characters and not 4: a relay that kept the boxes could
// try secrets offline against them (there is no PAKE yet); 40 bits cost it about a million times more than 20 would. It never
// carries an SDP, an address or a key. WebRTC offers and answers move only after the owner accepts: accept mints a random private
// lane (an infohash) and allows it for 24 hours, which the rendezvous's tracker then serves, so the first offer, and the first
// address a peer learns of the other, comes after approval.
//
// Messages (every one is a JSON text frame of at most MAX_PAIR_BYTES with v: 1, action and an optional rid that the direct reply
// echoes; a failure reply is { action, rid?, 'failure reason': <text> }). C = client, R = this module:
//   C pair-open   { channel, box, rid }            -> R { action: 'pair-open', channel, rid }   (one code per socket; opening again replaces it)
//   C pair-knock  { channel, box, rid }            -> R to the requester { action: 'pair-knock', knock, rid }, to the owner
//                                                     { action: 'pair-request', knock, channel, box }
//   C pair-accept { knock, proof, rid } (owner)    -> owner { action: 'pair-accepted', knock, lane, rid }, requester
//                                                     { action: 'pair-accepted', knock, lane, channel, box: <the owner's box>, proof }
//                                                     (proof: 86 base64url characters, the owner's signature over the channel and the knock;
//                                                     this module checks its shape and passes it on unchanged, the requester's page checks it)
//   C pair-reject { knock, rid } (owner)           -> requester { action: 'pair-rejected', knock, reason: 'rejected' }, owner { action: 'pair-reject', knock, rid }
//   C pair-cancel { knock, rid? } (requester)      -> owner { action: 'pair-cancelled', knock }
//   C pair-close  { channel?, rid? } (owner)       -> pending knocks get { action: 'pair-rejected', knock, reason: 'closed' }
//   rooms: room-open (mints and allows the lane at open: R { action: 'room-open', channel, lane, rid }; at most maxRooms per
//   socket), room-knock, room-accept ({ knock, proof, rid }: requester { action: 'room-accepted', knock, lane, channel, box, proof },
//   owner { action: 'room-accepted', knock, rid }), room-reject, room-cancel, room-close ({ channel } names the room).
// Other things R sends: reason 'expired' (a knock older than KNOCK_TTL_MS, or its code expired), reason 'gone' (the owner's
// socket closed), { action: 'pair-cancelled', knock } to an owner whose requester went away, and { action: 'pair-close',
// channel, reason: 'expired' } to an owner whose code ran out (CHANNEL_TTL_MS; the same for room-close).
//
// The relay lane (plan relay-first-2026-11-07, sections 3.1 to 3.4): after the accept both sides may join the lane the accept
// minted and pass sealed frames through the rendezvous socket they already hold, which is what carries a message when the two
// browsers cannot reach each other. Each action has a pair- and a room- form ("kind" below); C = client, R = this module:
//   C <kind>-join  { lane, rid? }    -> R { action, lane, peers, rid? } (peers = the OTHER sockets in the lane), and to each of
//                                       them { action: '<kind>-joined', lane, peers }; a second join by a member is the reply alone
//   C <kind>-relay { lane, f, rid? } -> R to every other member { action: '<kind>-relayed', lane, f }; to the sender, only with a rid,
//                                       { action, lane, peers, rid } (peers = sockets written to, 0 when alone)
//   C <kind>-leave { lane, rid? }    -> the others get { action: '<kind>-left', lane, peers }; the sender is answered only with a rid;
//                                       a socket that closes leaves every lane it joined, with the same push
//   C pair-ping (exactly PING_TEXT)  -> R { action: 'pair-pong' } (PONG_TEXT); changes nothing; like any message, the 151st of a
//                                       minute fails with 'too many messages' (and the host closes the socket). It counts toward
//                                       messagesPerMin like any message that reaches this module and toward no relay cap (DECISIONS
//                                       DEC-2): on the Worker the platform answers the exact text before the object wakes, so only a
//                                       ping of another shape gets here, and a flood of those must close the socket like any flood
// A lane is the 40-hex id the host allowed (laneExpiry(hex) answers its expiry in ms, 0 when it was never minted or has run out);
// a pair lane holds 2 sockets, a room lane 16, a socket joins 8 lanes at most, and a lane has one kind, the kind of its first joiner.
// A member that vanished must not block its own replacement (DECISIONS DEC-1): a phone that changed networks leaves a half-open socket
// here that no close ever reaches. So a join to a full lane first reads each member's last sign of life, the later of its last message
// here and what the host knows (liveness(conn): in the Worker the time the platform last answered the socket's ping, read at that
// moment for the members of that lane only); a member silent for longer than caps.memberStaleMs leaves the lane as a closed socket
// does (the others get <kind>-left with the new count), the newcomer takes its place, and message() lists it under evicted for the host
// to close (code 1000) and release. A lane whose members are all live still answers lane full; the page asks again later.
// f is the sealed frame as 4 to 7,700 base64url characters. This module never parses, stores or logs f: it checks the alphabet and
// the length, passes the same string on, and counts characters. Failures (the usual { action, rid?, 'failure reason' }, never naming
// the lane): invalid lane, unknown lane (not minted, run out, or the sender is not a member), lane full, too many lanes,
// invalid frame, too many relays (a minute's cap), relay is busy (the UTC day's cap), relay is off on this rendezvous (option relay false).
// Membership is in memory and nothing about it is written to storage; a host that hibernates keeps it in the socket's attachment
// as l: [[lane, kind], ...] (8 at most, beside c and q: far under the 2 KB limit) and attach() gives it back.
//
// Persistence is the host's job: persist(ops) is called synchronously, before message() returns, with [['put', key, value] |
// ['delete', key]] for the rows 'chan:<channel>' -> { kind, box, lane, exp } (the Durable Object keeps them in ctx.storage);
// allowLane(hex, expMs) is called when a lane is minted and answers false when the host refuses another lane. A host that
// hibernates keeps the state of a socket in its attachment: attachmentOf(conn) gives { c: owned codes, q: pending knocks of the
// requester, l: relay lanes when there are any } (a few hundred bytes), attach(conn, saved) takes it back after a wake (and reads the
// host's t, the seconds of the socket's last message, as its last sign of life; without one the wake is), and load(entries) takes the
// stored rows back first. Pending knocks are therefore not written to storage, and they survive a
// hibernation on the requester's socket. A host that gives no laneExpiry gets the lanes this module minted itself (allowLane
// answered true), which is enough for a host that keeps no lanes of its own across a restart.

/** The protocol version every message carries as v. */
export const PAIR_VERSION = 1;
/** A message longer than this (UTF-8 bytes) is refused. */
export const MAX_PAIR_BYTES = 8192;
/** The largest box, as the JSON of { iv, ct }. */
export const MAX_BOX_BYTES = 2048;
/** The 32 characters of a code (no 0, 1, l or o); the first CHANNEL_LENGTH are the channel, the last SECRET_LENGTH the secret. */
export const CODE_ALPHABET = 'abcdefghijkmnpqrstuvwxyz23456789';
export const CHANNEL_LENGTH = 4;
export const SECRET_LENGTH = 8;
export const CODE_LENGTH = CHANNEL_LENGTH + SECRET_LENGTH;
/** A knock pends this long, then the requester gets reason 'expired'. */
export const KNOCK_TTL_MS = 10 * 60 * 1000;
/** A minted lane is allowed this long. */
export const LANE_TTL_MS = 24 * 60 * 60 * 1000;
/** A code stays open this long unless its owner closes it or its socket closes. */
export const CHANNEL_TTL_MS = 24 * 60 * 60 * 1000;
/** The default cap of allowed lanes in all (the hosts apply it in their allowLane). */
export const MAX_LANES = 10000;
/** Storage keys of the Durable Object. */
export const CHAN_KEY = 'chan:';
export const LANE_KEY = 'lane:';
/** The reply to a message of the other protocol on a classified socket. */
export const MIXED = 'socket already used for another protocol';
/** At most this many characters in a hello's name. */
export const MAX_NAME_CHARS = 32;
/**
 * The keepalive ping of a client and its answer, byte for byte. The Worker hands this pair to the platform
 * (setWebSocketAutoResponse), which answers it without waking the object (plan 3.4, D6); this module answers a ping too, so the
 * Node tracker and the unit tests behave the same.
 */
export const PING_TEXT = '{"v":1,"action":"pair-ping"}';
export const PONG_TEXT = '{"action":"pair-pong"}';
/** The longest relayed frame f, in base64url characters: the largest sealed frame (5,634 bytes) is 7,512, and a request with 7,700 stays under MAX_PAIR_BYTES. */
export const MAX_FRAME_CHARS = 7700;
export const DEFAULT_CAPS = Object.freeze({
  maxChannels: 4096, // codes in all; more get 'too many codes'
  maxPendingPerChannel: 16, // pending knocks on one code
  maxPendingPerSocket: 8, // pending knocks one requester holds (they ride in its attachment, which stays under 2 KB)
  maxKnocksPerMinute: 10, // knocks one socket may send
  maxOpensPerMinute: 10, // codes one socket may open
  maxRooms: 4, // rooms one socket may own
  relayPerMin: 120, // relayed frames one socket may send in a minute; more get 'too many relays'
  messagesPerMin: 150, // messages of any kind one socket may send in a minute, a ping that reaches this module included (DEC-2); the next one closes the socket (1008)
  relayDayMax: 20000, // relayed frames per object per UTC day, for each run of the object; then 'relay is busy' (the Free plan counts 100,000 requests a day: README, "Relay")
  lanesPerSocket: 8, // relay lanes one socket may join (the list rides in its attachment, which stays under 2 KB)
  pairLaneMembers: 2, // sockets in a pair lane
  roomLaneMembers: 16, // sockets in a room lane
  memberStaleMs: 120000, // a member of a full lane silent for longer (no message, no keepalive the host saw) makes room for a joiner (DEC-1): about 2.4 keepalives of 50 s
});

const CHANNEL_RE = new RegExp('^[' + CODE_ALPHABET + ']{' + CHANNEL_LENGTH + '}$');
const CODE_RE = new RegExp('^[' + CODE_ALPHABET + ']{' + CODE_LENGTH + '}$');
const KNOCK_RE = /^[A-Za-z0-9_-]{16}$/;
const LANE_RE = /^[0-9a-f]{40}$/;
// a relayed frame: base64url without padding, 4 to MAX_FRAME_CHARS characters (checked for length first, so a long string is never scanned)
const FRAME_RE = new RegExp('^[A-Za-z0-9_-]{4,' + MAX_FRAME_CHARS + '}$');
const IV_RE = /^[A-Za-z0-9_-]{16}$/;
const CT_RE = /^[A-Za-z0-9_-]{22,}$/;
const KEY_RE = /^p256:[A-Za-z0-9_-]{87}$/;
const NONCE_RE = /^[A-Za-z0-9_-]{16}$/;
const SIG_RE = /^[A-Za-z0-9_-]{86}$/;
const HELLO_KEYS = new Set(['pub', 'ek', 'name', 't', 'n', 'sig']);
// Hyphens, the dash characters a phone keyboard may type (U+2010 to U+2015, U+2212) and whitespace are removed from typed codes.
const DASH_CHARS = [0x2010, 0x2011, 0x2012, 0x2013, 0x2014, 0x2015, 0x2212].map((c) => String.fromCharCode(c)).join('');
const DASHES = new RegExp('[\\s\\-' + DASH_CHARS + ']+', 'g');
const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
const MINUTE_MS = 60000;
const DAY_MS = 24 * 60 * 60 * 1000;
const KINDS = new Set(['pair', 'room']);

/**
 * isPairAction(action) -> true for any pair-* or room-* action: such a message marks its socket as a pair socket. The relay's
 * actions (pair-join, pair-relay, pair-leave, pair-ping and the room forms) are pair actions by this rule, so a socket whose first
 * frame is a ping or a join is classified like any other pair socket, and the frame-size guard of the hosts applies to them.
 */
export function isPairAction(action) {
  return typeof action === 'string' && (action.startsWith('pair-') || action.startsWith('room-'));
}

/**
 * isRelayAction(action) -> true for the actions of the relay lane: <kind>-join, <kind>-relay, <kind>-leave and pair-ping. None of
 * them opens a code or a knock, so the host has no new expiry to wake for after one (worker.js leaves its alarm alone).
 */
export function isRelayAction(action) {
  return typeof action === 'string' && (action === 'pair-ping' || /^(?:pair|room)-(?:join|relay|leave)$/.test(action));
}

/** utcDay(ms) -> the UTC date of a time as a number, yyyymmdd (20261107): the day the relay's counters belong to. */
export function utcDay(ms) {
  const d = new Date(ms);
  return d.getUTCFullYear() * 10000 + (d.getUTCMonth() + 1) * 100 + d.getUTCDate();
}

/** dayStartMs(ms) -> 00:00 UTC of the UTC day that ms falls in, in ms since 1970 (a UTC day is 86,400,000 ms in the time JavaScript counts): where the relay's counts of a day begin. */
function dayStartMs(ms) {
  return Math.floor(ms / DAY_MS) * DAY_MS;
}

/** normalizeCode(text) -> the 12-character code of what a person typed (lowercase, hyphens, dashes and spaces removed), or null for anything of another length. */
export function normalizeCode(text) {
  if (typeof text !== 'string' || text.length > 64) return null;
  const code = text.toLowerCase().replace(DASHES, '');
  return CODE_RE.test(code) ? code : null;
}

/** formatCode(code) -> 'xxxx-xxxx-xxxx' (channel, then the secret in two groups), or null when code is not a code. */
export function formatCode(code) {
  const c = normalizeCode(code);
  return c === null ? null : c.slice(0, CHANNEL_LENGTH) + '-' + c.slice(CHANNEL_LENGTH, CHANNEL_LENGTH + 4) + '-' + c.slice(CHANNEL_LENGTH + 4);
}

/** isChannel(text) -> true for the 4 characters of a channel in canonical form. */
export function isChannel(text) {
  return typeof text === 'string' && CHANNEL_RE.test(text);
}

/** boxProblem(box) -> null for a box of exactly { iv: 16 b64url chars (12 bytes), ct: b64url of at least a 16-byte tag } within MAX_BOX_BYTES, else 'box invalid'. */
export function boxProblem(box) {
  if (!box || typeof box !== 'object' || Array.isArray(box)) return 'box invalid';
  const keys = Object.keys(box);
  if (keys.length !== 2 || !keys.includes('iv') || !keys.includes('ct')) return 'box invalid';
  if (typeof box.iv !== 'string' || !IV_RE.test(box.iv)) return 'box invalid';
  if (typeof box.ct !== 'string' || box.ct.length > MAX_BOX_BYTES || !CT_RE.test(box.ct)) return 'box invalid';
  if (JSON.stringify({ iv: box.iv, ct: box.ct }).length > MAX_BOX_BYTES) return 'box invalid';
  return null;
}

/**
 * helloProblem(hello) -> null for a well-formed hello (the plaintext inside a box: { pub, ek, name?, t, n, sig }), else why not.
 * The rendezvous cannot open a box, so it never calls this; the clients do, and the tests pin the shape.
 */
export function helloProblem(hello) {
  if (!hello || typeof hello !== 'object' || Array.isArray(hello)) return 'hello invalid';
  for (const k of Object.keys(hello)) if (!HELLO_KEYS.has(k)) return 'hello has an unknown field';
  if (typeof hello.pub !== 'string' || !KEY_RE.test(hello.pub)) return 'pub invalid';
  if (typeof hello.ek !== 'string' || !KEY_RE.test(hello.ek)) return 'ek invalid';
  if (hello.name !== undefined) {
    if (typeof hello.name !== 'string' || Array.from(hello.name).length > MAX_NAME_CHARS || hasControl(hello.name)) return 'name invalid';
  }
  if (typeof hello.t !== 'number' || !Number.isSafeInteger(hello.t) || hello.t <= 0) return 't invalid';
  if (typeof hello.n !== 'string' || !NONCE_RE.test(hello.n)) return 'n invalid';
  if (typeof hello.sig !== 'string' || !SIG_RE.test(hello.sig)) return 'sig invalid';
  return null;
}

function hasControl(s) {
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c < 0x20 || c === 0x7f) return true;
  }
  return false;
}

function utf8Length(s) {
  let n = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c < 0x80) n += 1;
    else if (c < 0x800) n += 2;
    else if (c >= 0xd800 && c <= 0xdbff && i + 1 < s.length && (s.charCodeAt(i + 1) & 0xfc00) === 0xdc00) { n += 4; i++; } else n += 3;
  }
  return n;
}

/** frameTooLarge(text) -> true when the text frame is longer than MAX_PAIR_BYTES in UTF-8 (cheap for the common short frame). */
export function frameTooLarge(text) {
  if (typeof text !== 'string') return true;
  if (text.length > MAX_PAIR_BYTES) return true;
  return text.length * 3 > MAX_PAIR_BYTES && utf8Length(text) > MAX_PAIR_BYTES;
}

function b64url(bytes) {
  let out = '';
  let i = 0;
  for (; i + 3 <= bytes.length; i += 3) {
    const x = (bytes[i] << 16) | (bytes[i + 1] << 8) | bytes[i + 2];
    out += B64[x >>> 18] + B64[(x >>> 12) & 63] + B64[(x >>> 6) & 63] + B64[x & 63];
  }
  if (bytes.length - i === 1) {
    const x = bytes[i] << 16;
    out += B64[x >>> 18] + B64[(x >>> 12) & 63];
  } else if (bytes.length - i === 2) {
    const x = (bytes[i] << 16) | (bytes[i + 1] << 8);
    out += B64[x >>> 18] + B64[(x >>> 12) & 63] + B64[(x >>> 6) & 63];
  }
  return out;
}

function hexOf(bytes) {
  let out = '';
  for (let i = 0; i < bytes.length; i++) out += (bytes[i] < 16 ? '0' : '') + bytes[i].toString(16);
  return out;
}

function defaultRandom(n) {
  const bytes = new Uint8Array(n);
  globalThis.crypto.getRandomValues(bytes);
  return bytes;
}

export function createPairing({ random = defaultRandom, now = () => Date.now(), allowLane = null, laneExpiry = null, liveness = null, persist = null, caps = {}, relay = true } = {}) {
  const cap = Object.assign({}, DEFAULT_CAPS, caps);
  const relayOn = relay !== false; // RELAY_LANE / --no-relay-lane: off answers every join, relay and leave with 'relay is off on this rendezvous'
  const channels = new Map(); // channel -> { kind, owner: conn|null, box, lane: hex|null, exp: ms, knocks: Set<knock> }
  const owned = new Map(); // conn -> Set<channel>
  const knocks = new Map(); // knock -> { channel, kind, requester: conn, at: ms } (the requester's box is forwarded, never kept)
  const asked = new Map(); // conn -> Set<knock> (the pending knocks a requester holds)
  const knockLog = new Map(); // conn -> [ms] (the last minute's knocks)
  const openLog = new Map(); // conn -> [ms] (the last minute's opens)
  const relayLog = new Map(); // conn -> [ms] (the last minute's relayed frames; only frames that passed the checks)
  const messageLog = new Map(); // conn -> [ms] (the last minute's messages of any kind, a ping that reaches this module included: DEC-2)
  const relays = new Map(); // lane -> { kind, members: Set<conn>, exp: ms } (memory only: a relay keeps no row and no frame)
  const joined = new Map(); // conn -> Set<lane> (the lanes a socket is a member of, 8 at most)
  const minted = new Map(); // lane -> exp ms: the lanes this core allowed, kept only when the host gives no laneExpiry
  const lastMsg = new Map(); // conn -> ms of its last message here, a ping included: half of a member's liveness (DEC-1); the host's liveness(conn) is the other half
  const touched = new Set(); // conns whose attachment-relevant state moved since takeTouched()
  // The relay's counters belong to one UTC day (relayDay) and start again when it changes. They are in memory: a core that is built
  // again (a new deployment, or the Worker's object waking from hibernation) starts them at 0 as well, so they count from the moment
  // this core was built, within relayDay (README, "Relay"). relaySince is where they began, in ms since 1970 UTC: the later of 00:00 UTC
  // of relayDay and the build (finding A F3 of the 8.2 audit, decision P3.D1). It is read from the clock, never stored, and a difference
  // of two reads counts every frame between them only if relaySince is equal in both. Each "today" below means since relaySince. They
  // hold counts and characters only, never a frame or a lane.
  const builtAt = now();
  let relayDay = utcDay(builtAt);
  let relaySince = builtAt;
  let relayed = 0; // frames accepted for forwarding today (one sent while the other side was away counts: it cost a request)
  let relayBytes = 0; // characters of f in those frames
  let relayBusy = 0; // frames refused by the day cap today
  let relayRate = 0; // frames refused by the per-minute cap today
  let joinsRefused = 0; // joins refused today, for any reason
  let evicted = 0; // members evicted today from a full lane they had gone silent in (DEC-1)
  let cur = null; // the operation in progress: { replies, ops, problem, touched, close, evicted }

  const say = (to, obj) => { cur.replies.push([to, obj]); };
  const mark = (conn) => { if (conn) { touched.add(conn); cur.touched.add(conn); } };
  const op = (...args) => { cur.ops.push(args); };
  const fail = (conn, action, rid, why) => {
    const r = { action };
    if (rid) r.rid = rid;
    r['failure reason'] = why;
    if (cur.problem === null) cur.problem = why;
    say(conn, r);
  };
  const withRid = (obj, rid) => (rid ? Object.assign(obj, { rid }) : obj);

  /** run(fn) -> the finished operation; its storage ops go to persist() before the caller sends any reply. */
  function run(fn) {
    const outer = cur;
    cur = { replies: [], ops: [], problem: null, touched: new Set(), close: null, evicted: [] };
    try {
      fn();
    } catch (err) {
      cur = outer;
      throw err;
    }
    const done = cur;
    cur = outer;
    if (done.ops.length && persist) persist(done.ops);
    return done;
  }

  function mintId(bytes, encode, taken) {
    for (let i = 0; i < 8; i++) {
      const id = encode(random(bytes));
      if (!taken || !taken(id)) return id;
    }
    throw new Error('random() did not give a fresh value');
  }

  function rateExceeded(log, conn, t, max) {
    let list = log.get(conn);
    if (!list) log.set(conn, (list = []));
    while (list.length && t - list[0] >= MINUTE_MS) list.shift();
    if (list.length >= max) return true;
    list.push(t);
    return false;
  }

  function ownedSet(conn) {
    let set = owned.get(conn);
    if (!set) owned.set(conn, (set = new Set()));
    return set;
  }

  function askedSet(conn) {
    let set = asked.get(conn);
    if (!set) asked.set(conn, (set = new Set()));
    return set;
  }

  function joinedSet(conn) {
    let set = joined.get(conn);
    if (!set) joined.set(conn, (set = new Set()));
    return set;
  }

  /** rollDay(t): the relay's counters belong to one UTC day; when the day changes they start again at 0, from 00:00 UTC of the new day (a clock set back never puts relaySince before the build). */
  function rollDay(t) {
    const day = utcDay(t);
    if (day === relayDay) return;
    relayDay = day;
    relaySince = Math.max(builtAt, dayStartMs(t));
    relayed = relayBytes = relayBusy = relayRate = joinsRefused = evicted = 0;
  }

  /** noteLane(hex, exp): remembers a lane this core allowed, when the host gives no laneExpiry to ask. */
  function noteLane(hex, exp) {
    if (typeof laneExpiry !== 'function') minted.set(hex, exp);
  }

  /** laneExp(hex, t) -> the lane's expiry in ms, or 0 when it was never minted or has run out (the host answers; its answer is checked against the clock here as well). */
  function laneExp(hex, t) {
    const exp = typeof laneExpiry === 'function' ? laneExpiry(hex) : minted.get(hex);
    return typeof exp === 'number' && Number.isFinite(exp) && exp > t ? exp : 0;
  }

  function dropKnock(knock) {
    const k = knocks.get(knock);
    if (!k) return null;
    knocks.delete(knock);
    const ch = channels.get(k.channel);
    if (ch) ch.knocks.delete(knock);
    const set = asked.get(k.requester);
    if (set) { set.delete(knock); if (!set.size) asked.delete(k.requester); }
    mark(k.requester);
    return k;
  }

  /** closeChannel(channel, reason): the code is released; every pending knock on it gets { <kind>-rejected, reason }. */
  function closeChannel(channel, reason) {
    const ch = channels.get(channel);
    if (!ch) return;
    channels.delete(channel);
    if (ch.owner) {
      const set = owned.get(ch.owner);
      if (set) { set.delete(channel); if (!set.size) owned.delete(ch.owner); }
      mark(ch.owner);
    }
    op('delete', CHAN_KEY + channel);
    for (const knock of Array.from(ch.knocks)) {
      const k = dropKnock(knock);
      if (k) say(k.requester, { action: ch.kind + '-rejected', knock, reason });
    }
  }

  function expireKnock(knock) {
    const k = knocks.get(knock);
    if (!k) return;
    const ch = channels.get(k.channel);
    dropKnock(knock);
    say(k.requester, { action: k.kind + '-rejected', knock, reason: 'expired' });
    if (ch && ch.owner) say(ch.owner, { action: k.kind + '-cancelled', knock });
  }

  const details = (ch) => ({ kind: ch.kind, box: ch.box, lane: ch.lane, exp: ch.exp });
  const ridOf = (msg) => {
    if (msg.rid === undefined || msg.rid === null) return undefined;
    if (typeof msg.rid !== 'string' || msg.rid.length < 1 || msg.rid.length > 16) return false;
    return msg.rid;
  };

  function open(conn, msg, rid, kind) {
    const action = kind + '-open';
    if (!isChannel(msg.channel)) return fail(conn, action, rid, 'invalid channel');
    if (boxProblem(msg.box)) return fail(conn, action, rid, 'box invalid');
    const channel = msg.channel;
    const t = now();
    const existing = channels.get(channel);
    if (existing && (existing.owner !== conn || existing.kind !== kind)) return fail(conn, action, rid, 'channel taken');
    if (rateExceeded(openLog, conn, t, cap.maxOpensPerMinute)) return fail(conn, action, rid, 'too many codes');
    let previous = null;
    if (!existing) {
      let rooms = 0;
      for (const c of owned.get(conn) || []) {
        const other = channels.get(c);
        if (!other) continue;
        if (kind === 'pair' && other.kind === 'pair') previous = c;
        if (kind === 'room' && other.kind === 'room') rooms++;
      }
      // a socket that replaces its own code frees the slot it takes
      if (channels.size - (previous === null ? 0 : 1) >= cap.maxChannels) return fail(conn, action, rid, 'too many codes');
      if (kind === 'room' && rooms >= cap.maxRooms) return fail(conn, action, rid, 'too many codes');
    }
    const box = { iv: msg.box.iv, ct: msg.box.ct };
    let ch = existing;
    if (!ch) {
      let lane = null;
      if (kind === 'room') {
        lane = mintId(20, hexOf);
        if (allowLane && allowLane(lane, t + LANE_TTL_MS) === false) return fail(conn, action, rid, 'too many lanes');
        noteLane(lane, t + LANE_TTL_MS);
      }
      ch = { kind, owner: conn, box, lane, exp: t + (kind === 'room' ? LANE_TTL_MS : CHANNEL_TTL_MS), knocks: new Set() };
      channels.set(channel, ch);
      ownedSet(conn).add(channel);
      mark(conn);
    } else {
      ch.box = box;
      if (kind === 'pair') ch.exp = t + CHANNEL_TTL_MS; // a room keeps its first expiry: its lane runs out then
    }
    op('put', CHAN_KEY + channel, details(ch));
    if (previous !== null && previous !== channel) closeChannel(previous, 'closed'); // one code per socket: opening again replaces it
    const reply = { action, channel };
    if (kind === 'room') reply.lane = ch.lane;
    say(conn, withRid(reply, rid));
  }

  function knock(conn, msg, rid, kind) {
    const action = kind + '-knock';
    if (!isChannel(msg.channel)) return fail(conn, action, rid, 'invalid channel');
    if (boxProblem(msg.box)) return fail(conn, action, rid, 'box invalid');
    const t = now();
    if (rateExceeded(knockLog, conn, t, cap.maxKnocksPerMinute)) return fail(conn, action, rid, 'too many requests');
    const ch = channels.get(msg.channel);
    if (!ch || ch.kind !== kind || !ch.owner || ch.owner === conn || ch.exp <= t) return fail(conn, action, rid, 'unknown code');
    if (ch.knocks.size >= cap.maxPendingPerChannel) return fail(conn, action, rid, 'too many requests');
    const mine = asked.get(conn);
    if (mine && mine.size >= cap.maxPendingPerSocket) return fail(conn, action, rid, 'too many requests');
    const id = mintId(12, b64url, (x) => knocks.has(x));
    knocks.set(id, { channel: msg.channel, kind, requester: conn, at: t });
    ch.knocks.add(id);
    askedSet(conn).add(id);
    mark(conn);
    say(conn, withRid({ action, knock: id }, rid));
    say(ch.owner, { action: kind + '-request', knock: id, channel: msg.channel, box: { iv: msg.box.iv, ct: msg.box.ct } });
  }

  /** ownersKnock(conn, action, rid, kind, msg) -> { k, ch } for a live knock on a code this socket owns, else a failure reply and null. */
  function ownersKnock(conn, action, rid, kind, msg) {
    if (typeof msg.knock !== 'string' || !KNOCK_RE.test(msg.knock)) { fail(conn, action, rid, 'invalid knock'); return null; }
    const k = knocks.get(msg.knock);
    const ch = k ? channels.get(k.channel) : null;
    if (!k || !ch || ch.owner !== conn || ch.kind !== kind) { fail(conn, action, rid, 'unknown knock'); return null; }
    // a knock that ran out, or a code that ran out and is not swept yet (a room's lane runs out with it): nothing is handed out
    if (now() - k.at >= KNOCK_TTL_MS) { expireKnock(msg.knock); fail(conn, action, rid, 'unknown knock'); return null; }
    if (ch.exp <= now()) { fail(conn, action, rid, 'unknown knock'); return null; }
    return { k, ch };
  }

  function accept(conn, msg, rid, kind) {
    const action = kind + '-accept';
    const found = ownersKnock(conn, action, rid, kind, msg);
    if (!found) return;
    // The owner signs { channel, knock } and the requester's page checks it before it loads anything or joins the lane (ADV-7); this
    // module cannot check a signature (it never sees a key) and only refuses an accept that carries no proof of the right shape.
    if (typeof msg.proof !== 'string' || !SIG_RE.test(msg.proof)) return fail(conn, action, rid, 'proof invalid');
    const { k, ch } = found;
    let lane = ch.lane;
    if (kind === 'pair') {
      lane = mintId(20, hexOf);
      const laneUntil = now() + LANE_TTL_MS;
      if (allowLane && allowLane(lane, laneUntil) === false) return fail(conn, action, rid, 'too many lanes');
      noteLane(lane, laneUntil);
    }
    dropKnock(msg.knock);
    if (kind === 'pair') say(conn, withRid({ action: 'pair-accepted', knock: msg.knock, lane }, rid));
    else say(conn, withRid({ action: 'room-accepted', knock: msg.knock }, rid));
    say(k.requester, { action: kind + '-accepted', knock: msg.knock, lane, channel: k.channel, box: { iv: ch.box.iv, ct: ch.box.ct }, proof: msg.proof });
  }

  function reject(conn, msg, rid, kind) {
    const action = kind + '-reject';
    const found = ownersKnock(conn, action, rid, kind, msg);
    if (!found) return;
    dropKnock(msg.knock);
    say(found.k.requester, { action: kind + '-rejected', knock: msg.knock, reason: 'rejected' });
    say(conn, withRid({ action, knock: msg.knock }, rid));
  }

  function cancel(conn, msg, rid, kind) {
    const action = kind + '-cancel';
    if (typeof msg.knock !== 'string' || !KNOCK_RE.test(msg.knock)) return fail(conn, action, rid, 'invalid knock');
    const k = knocks.get(msg.knock);
    if (!k || k.requester !== conn || k.kind !== kind) return fail(conn, action, rid, 'unknown knock');
    const ch = channels.get(k.channel);
    dropKnock(msg.knock);
    if (ch && ch.owner) say(ch.owner, { action: kind + '-cancelled', knock: msg.knock });
    if (rid) say(conn, { action, knock: msg.knock, rid });
  }

  function closeOwn(conn, msg, rid, kind) {
    const action = kind + '-close';
    let channel = msg.channel;
    if (channel !== undefined && channel !== null) {
      if (!isChannel(channel)) return fail(conn, action, rid, 'invalid channel');
    } else {
      const mine = Array.from(owned.get(conn) || []).filter((c) => channels.get(c) && channels.get(c).kind === kind);
      if (mine.length === 0) return fail(conn, action, rid, 'unknown code');
      if (mine.length > 1) return fail(conn, action, rid, 'invalid channel');
      channel = mine[0];
    }
    const ch = channels.get(channel);
    if (!ch || ch.owner !== conn || ch.kind !== kind) return fail(conn, action, rid, 'unknown code');
    closeChannel(channel, 'closed');
    if (rid) say(conn, { action, channel, rid });
  }

  // ---- the relay lane (plan 3.1): join, relay, leave -------------------------------------------------------------------------

  const isLane = (lane) => typeof lane === 'string' && LANE_RE.test(lane);

  /** refuseJoin(conn, action, rid, why): a join that is refused; every refusal is counted for today, whatever the reason (plan 3.2). */
  function refuseJoin(conn, action, rid, why) {
    rollDay(now());
    joinsRefused++;
    return fail(conn, action, rid, why);
  }

  /** leaveLane(conn, lane, rec): conn is no longer a member; the others are told, and the record goes with its last member. */
  function leaveLane(conn, lane, rec) {
    rec.members.delete(conn);
    const set = joined.get(conn);
    if (set) { set.delete(lane); if (!set.size) joined.delete(conn); }
    mark(conn);
    if (!rec.members.size) { relays.delete(lane); return; }
    for (const other of rec.members) say(other, { action: rec.kind + '-left', lane, peers: rec.members.size - 1 });
  }

  /**
   * liveAt(conn) -> ms: the socket's last sign of life, the later of its last message here (a ping included) and what the host knows
   * (liveness(conn): in the Worker the time the platform last answered its keepalive ping, read at this moment; DECISIONS DEC-1).
   */
  function liveAt(conn) {
    let at = lastMsg.get(conn) || 0;
    if (typeof liveness === 'function') {
      const known = liveness(conn);
      if (typeof known === 'number' && Number.isFinite(known) && known > at) at = known;
    }
    return at;
  }

  /**
   * evictStale(lane, rec, t): a join found the lane full (DEC-1). Every member silent for longer than cap.memberStaleMs leaves through
   * the path of a socket that closed (the others get <kind>-left with the new count) and is listed for the host to close and release.
   * The host is asked about these members only, never about every socket.
   */
  function evictStale(lane, rec, t) {
    for (const member of Array.from(rec.members)) {
      if (t - liveAt(member) <= cap.memberStaleMs) continue;
      leaveLane(member, lane, rec);
      cur.evicted.push(member);
      rollDay(t);
      evicted++;
    }
  }

  function relayJoin(conn, msg, rid, kind) {
    const action = kind + '-join';
    if (!relayOn) return refuseJoin(conn, action, rid, 'relay is off on this rendezvous');
    if (!isLane(msg.lane)) return refuseJoin(conn, action, rid, 'invalid lane');
    const lane = msg.lane;
    const t = now();
    const exp = laneExp(lane, t);
    if (!exp) return refuseJoin(conn, action, rid, 'unknown lane');
    let rec = relays.get(lane);
    if (rec && rec.kind !== kind) return refuseJoin(conn, action, rid, 'unknown lane'); // a lane has one kind: its first joiner's
    if (rec && rec.members.has(conn)) { // idempotent: the reply, no push, nothing to store (a client sends this again after every reconnect)
      say(conn, withRid({ action, lane, peers: rec.members.size - 1 }, rid));
      return;
    }
    // the joiner's own cap first: nobody is evicted for a socket that could not join anyway (DEC-1)
    if (joined.has(conn) && joined.get(conn).size >= cap.lanesPerSocket) return refuseJoin(conn, action, rid, 'too many lanes');
    const seats = kind === 'room' ? cap.roomLaneMembers : cap.pairLaneMembers;
    if (rec && rec.members.size >= seats) {
      evictStale(lane, rec, t);
      rec = relays.get(lane); // gone when every member had vanished: the joiner starts the lane again
      if (rec && rec.members.size >= seats) return refuseJoin(conn, action, rid, 'lane full');
    }
    if (!rec) relays.set(lane, (rec = { kind, members: new Set(), exp }));
    rec.members.add(conn);
    joinedSet(conn).add(lane);
    mark(conn);
    say(conn, withRid({ action, lane, peers: rec.members.size - 1 }, rid));
    for (const other of rec.members) if (other !== conn) say(other, { action: kind + '-joined', lane, peers: rec.members.size - 1 });
  }

  function relayFrame(conn, msg, rid, kind) {
    const action = kind + '-relay';
    if (!relayOn) return fail(conn, action, rid, 'relay is off on this rendezvous');
    if (!isLane(msg.lane)) return fail(conn, action, rid, 'invalid lane');
    const t = now();
    const rec = relays.get(msg.lane);
    if (!rec || rec.kind !== kind || rec.exp <= t || !rec.members.has(conn)) return fail(conn, action, rid, 'unknown lane');
    const f = msg.f;
    if (typeof f !== 'string' || f.length > MAX_FRAME_CHARS || !FRAME_RE.test(f)) return fail(conn, action, rid, 'invalid frame');
    rollDay(t);
    // The day cap is asked first: on a busy day every frame is refused for it and none burns a slot of the minute's cap, so each
    // refusal is counted where it belongs. The frame is never opened: only its alphabet and length were checked, and the same string goes on.
    if (relayed >= cap.relayDayMax) { relayBusy++; return fail(conn, action, rid, 'relay is busy'); }
    if (rateExceeded(relayLog, conn, t, cap.relayPerMin)) { relayRate++; return fail(conn, action, rid, 'too many relays'); }
    relayed++;
    relayBytes += f.length;
    let peers = 0;
    for (const other of rec.members) {
      if (other === conn) continue;
      say(other, { action: kind + '-relayed', lane: msg.lane, f });
      peers++;
    }
    if (rid) say(conn, { action, lane: msg.lane, peers, rid });
  }

  function relayLeave(conn, msg, rid, kind) {
    const action = kind + '-leave';
    if (!relayOn) return fail(conn, action, rid, 'relay is off on this rendezvous');
    if (!isLane(msg.lane)) return fail(conn, action, rid, 'invalid lane');
    // leaving a lane one is not in (a conversation deleted while the socket was down, a lane that ran out) is a quiet no-op, as joining twice is
    const rec = relays.get(msg.lane);
    if (rec && rec.kind === kind && rec.members.has(conn)) leaveLane(conn, msg.lane, rec);
    if (rid) say(conn, { action, lane: msg.lane, rid });
  }

  function handle(conn, msg) {
    const action = msg.action;
    const rid = ridOf(msg);
    // Every message that reaches this module counts against the socket's minute (plan 3.2), a ping included (DECISIONS DEC-2): over
    // the cap the host closes the socket with 1008. The refused message gets one failure reply, so a request in flight fails at once
    // with the reason instead of timing out.
    if (rateExceeded(messageLog, conn, now(), cap.messagesPerMin)) {
      cur.close = 'too many messages';
      return fail(conn, String(action).slice(0, 64), rid === false ? undefined : rid, 'too many messages');
    }
    // A keepalive ping is answered whatever it carries and changes nothing (plan 3.4); it counted above like any message (DEC-2): on
    // the Worker the platform answers the exact PING_TEXT before the object wakes, so a ping that gets here woke it, and a flood of
    // such pings must close the socket like a flood of anything else. The Node tracker and the unit tests get every ping here.
    if (action === 'pair-ping') return say(conn, { action: 'pair-pong' });
    if (rid === false) return fail(conn, action, undefined, 'invalid rid');
    if (msg.v !== PAIR_VERSION) return fail(conn, action, rid, 'unsupported version');
    switch (action) {
      case 'pair-open': return open(conn, msg, rid, 'pair');
      case 'room-open': return open(conn, msg, rid, 'room');
      case 'pair-knock': return knock(conn, msg, rid, 'pair');
      case 'room-knock': return knock(conn, msg, rid, 'room');
      case 'pair-accept': return accept(conn, msg, rid, 'pair');
      case 'room-accept': return accept(conn, msg, rid, 'room');
      case 'pair-reject': return reject(conn, msg, rid, 'pair');
      case 'room-reject': return reject(conn, msg, rid, 'room');
      case 'pair-cancel': return cancel(conn, msg, rid, 'pair');
      case 'room-cancel': return cancel(conn, msg, rid, 'room');
      case 'pair-close': return closeOwn(conn, msg, rid, 'pair');
      case 'room-close': return closeOwn(conn, msg, rid, 'room');
      case 'pair-join': return relayJoin(conn, msg, rid, 'pair');
      case 'room-join': return relayJoin(conn, msg, rid, 'room');
      case 'pair-relay': return relayFrame(conn, msg, rid, 'pair');
      case 'room-relay': return relayFrame(conn, msg, rid, 'room');
      case 'pair-leave': return relayLeave(conn, msg, rid, 'pair');
      case 'room-leave': return relayLeave(conn, msg, rid, 'room');
      default: return fail(conn, String(action).slice(0, 64), rid, 'invalid action');
    }
  }

  /**
   * message(conn, msg) -> { replies: [[conn, obj], ...], changed, problem, close?, evicted? }: msg is a parsed JSON object whose action
   * isPairAction. close is set (to the reason, 'too many messages') when the socket is over its allowance: the host closes it with code
   * 1008. evicted lists the members a join to a full lane evicted (DEC-1): the host closes each with code 1000 and calls close() for it.
   */
  function message(conn, msg) {
    lastMsg.set(conn, now()); // every message is a sign of life, a ping too (DEC-1)
    const done = run(() => handle(conn, msg));
    const out = { replies: done.replies, changed: done.touched.has(conn), problem: done.problem };
    if (done.close !== null) out.close = done.close;
    if (done.evicted.length) out.evicted = done.evicted;
    return out;
  }

  /** close(conn) -> replies: the socket is gone; its codes are released (pending knocks get 'gone'), its own knocks are cancelled and it leaves its relay lanes. */
  function close(conn) {
    const done = run(() => {
      for (const channel of Array.from(owned.get(conn) || [])) closeChannel(channel, 'gone');
      for (const knock of Array.from(asked.get(conn) || [])) {
        const k = knocks.get(knock);
        const ch = k ? channels.get(k.channel) : null;
        dropKnock(knock);
        if (k && ch && ch.owner) say(ch.owner, { action: k.kind + '-cancelled', knock });
      }
      for (const lane of Array.from(joined.get(conn) || [])) {
        const rec = relays.get(lane);
        if (rec) leaveLane(conn, lane, rec);
      }
    });
    knockLog.delete(conn);
    openLog.delete(conn);
    relayLog.delete(conn);
    messageLog.delete(conn);
    lastMsg.delete(conn);
    owned.delete(conn);
    asked.delete(conn);
    joined.delete(conn);
    touched.delete(conn);
    return done.replies;
  }

  /** sweep(nowMs) -> replies: codes that ran out or lost their owner, knocks that ran out or lost their code. */
  function sweep(t = now()) {
    const done = run(() => {
      for (const [channel, ch] of Array.from(channels)) {
        if (!ch.owner) closeChannel(channel, 'gone');
        else if (ch.exp <= t) {
          const owner = ch.owner;
          closeChannel(channel, 'expired');
          say(owner, { action: ch.kind + '-close', channel, reason: 'expired' });
        }
      }
      for (const [knock, k] of Array.from(knocks)) {
        if (!channels.has(k.channel)) {
          dropKnock(knock);
          say(k.requester, { action: k.kind + '-rejected', knock, reason: 'gone' });
        } else if (t - k.at >= KNOCK_TTL_MS) expireKnock(knock);
      }
      // a relay lane past its expiry is dead: its record goes and nobody is told (a member's next relay finds no lane); the saved
      // state of each member moves, so the host writes it again without that lane
      for (const [lane, rec] of Array.from(relays)) {
        if (rec.exp > t) continue;
        for (const member of rec.members) {
          const set = joined.get(member);
          if (set) { set.delete(lane); if (!set.size) joined.delete(member); }
          mark(member);
        }
        relays.delete(lane);
      }
      for (const [lane, exp] of Array.from(minted)) if (exp <= t) minted.delete(lane);
    });
    for (const log of [knockLog, openLog, relayLog, messageLog]) {
      for (const [conn, list] of log) {
        while (list.length && t - list[0] >= MINUTE_MS) list.shift();
        if (!list.length) log.delete(conn);
      }
    }
    return done.replies;
  }

  /** load(entries): the stored rows ('chan:' stripped) of codes, before any socket is attached; an unreadable row is deleted. */
  function load(entries) {
    run(() => {
      for (const [channel, d] of entries || []) {
        const room = d && d.kind === 'room';
        const good = isChannel(channel) && d && typeof d === 'object' && KINDS.has(d.kind) && !boxProblem(d.box) &&
          typeof d.exp === 'number' && Number.isFinite(d.exp) && (room ? typeof d.lane === 'string' && LANE_RE.test(d.lane) : d.lane === null || d.lane === undefined || (typeof d.lane === 'string' && LANE_RE.test(d.lane)));
        if (!good) { if (typeof channel === 'string') op('delete', CHAN_KEY + channel); continue; }
        channels.set(channel, { kind: d.kind, owner: null, box: { iv: d.box.iv, ct: d.box.ct }, lane: d.lane || null, exp: d.exp, knocks: new Set() });
      }
    });
  }

  /**
   * attach(conn, saved) -> replies: a socket restored after a wake takes back its codes (c), its pending knocks (q) and its relay lanes
   * (l). Its last sign of life (DEC-1) is the host's time of its last message when the host keeps one in the attachment (t, in seconds:
   * rtc.js writes it), else the wake itself, so a wake never makes a live member look silent to the next join of its full lane.
   */
  function attach(conn, saved) {
    const replies = [];
    if (!saved || typeof saved !== 'object') return replies;
    const t = now();
    lastMsg.set(conn, typeof saved.t === 'number' && saved.t > 0 ? saved.t * 1000 : t);
    if (Array.isArray(saved.c)) {
      for (const entry of saved.c.slice(0, cap.maxRooms + 1)) {
        const channel = Array.isArray(entry) ? entry[0] : null;
        const ch = isChannel(channel) ? channels.get(channel) : null;
        if (!ch || ch.owner || ch.kind !== entry[1]) continue;
        ch.owner = conn;
        ownedSet(conn).add(channel);
      }
    }
    if (Array.isArray(saved.q)) {
      for (const entry of saved.q.slice(0, cap.maxPendingPerSocket)) {
        const [knock, channel, atSec, kind] = Array.isArray(entry) ? entry : [];
        if (typeof knock !== 'string' || !KNOCK_RE.test(knock) || !isChannel(channel) || !KINDS.has(kind) || typeof atSec !== 'number' || knocks.has(knock)) continue;
        const at = atSec * 1000;
        if (t - at >= KNOCK_TTL_MS) {
          replies.push([conn, { action: kind + '-rejected', knock, reason: 'expired' }]);
          touched.add(conn);
          continue;
        }
        const ch = channels.get(channel);
        knocks.set(knock, { channel, kind, requester: conn, at });
        if (ch) ch.knocks.add(knock);
        askedSet(conn).add(knock);
      }
    }
    if (Array.isArray(saved.l)) {
      // The relay lanes the socket was in. A lane the host says is gone is dropped quietly (and the socket is marked, so the host
      // writes its saved state again without it); with the relay off nothing is rebuilt. Nobody is told: the others never left.
      for (const entry of saved.l.slice(0, cap.lanesPerSocket)) {
        const [lane, kind] = Array.isArray(entry) ? entry : [];
        if (!isLane(lane) || !KINDS.has(kind)) continue;
        const exp = relayOn ? laneExp(lane, t) : 0;
        if (!exp) { touched.add(conn); continue; }
        let rec = relays.get(lane);
        if (rec && (rec.kind !== kind || rec.members.size >= (kind === 'room' ? cap.roomLaneMembers : cap.pairLaneMembers))) continue;
        if (!rec) relays.set(lane, (rec = { kind, members: new Set(), exp }));
        rec.members.add(conn);
        joinedSet(conn).add(lane);
      }
    }
    return replies;
  }

  /** attachmentOf(conn) -> { c: [[channel, kind]], q: [[knock, channel, atSeconds, kind]], l?: [[lane, kind]] }: the socket's part of the state (l only when it is in a relay lane). */
  function attachmentOf(conn) {
    const c = [];
    for (const channel of owned.get(conn) || []) {
      const ch = channels.get(channel);
      if (ch) c.push([channel, ch.kind]);
    }
    const q = [];
    for (const knock of asked.get(conn) || []) {
      const k = knocks.get(knock);
      if (k) q.push([knock, k.channel, Math.floor(k.at / 1000), k.kind]);
    }
    const l = [];
    for (const lane of joined.get(conn) || []) {
      const rec = relays.get(lane);
      if (rec) l.push([lane, rec.kind]);
    }
    return l.length ? { c, q, l } : { c, q };
  }

  /** takeTouched() -> the conns whose attachment-relevant state moved since the last call (the host rewrites their attachments). */
  function takeTouched() {
    const list = Array.from(touched);
    touched.clear();
    return list;
  }

  /** nextExpiry() -> the earliest ms at which a knock, a code or a lane in use runs out (Infinity when there is none): when to wake the sweep. */
  function nextExpiry() {
    let at = Infinity;
    for (const k of knocks.values()) if (k.at + KNOCK_TTL_MS < at) at = k.at + KNOCK_TTL_MS;
    for (const ch of channels.values()) if (ch.exp < at) at = ch.exp;
    for (const rec of relays.values()) if (rec.exp < at) at = rec.exp;
    return at;
  }

  /** ownsLive(conn) -> true while conn owns a code: its idle sweep waits for the code to run out (a relay member is not exempt: it pings). */
  function ownsLive(conn) {
    const set = owned.get(conn);
    return Boolean(set && set.size);
  }

  /**
   * stats() -> counts only (plan 3.2, DEC-1): codes and knocks held now, relay lanes with a member (read back from the sockets after a wake, so
   * a gauge and not a counter), and the relay counters (evicted among them) with the UTC day they belong to (relayDay) and the moment they
   * began (relaySince): a core that was built again after a wake counts from the build, not from 00:00 UTC (finding A F3).
   */
  function stats() {
    rollDay(now());
    return { codes: channels.size, knocks: knocks.size, relays: relays.size, relayed, relayBytes, relayDay, relaySince, relayBusy, relayRate, joinsRefused, evicted };
  }

  return { message, close, sweep, attach, attachmentOf, load, takeTouched, nextExpiry, ownsLive, stats };
}
