// deploy/rtc-worker/pair.js: the pairing and room protocol of the rendezvous (mw-pair-v1; ARCHITECTURE 15.21).
// Pure, no platform code and no dependency, so rtc.js (the Cloudflare Worker's core), tools/tracker.mjs (the Node tracker) and
// the unit tests drive the same state machine with fake connections.
//
//   createPairing({ random, now, allowLane, persist, caps })
//     -> { message(conn, msg), close(conn), sweep(nowMs), attach(conn, saved), attachmentOf(conn), load(entries),
//          takeTouched(), nextExpiry(), ownsLive(conn), stats() }
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
// Persistence is the host's job: persist(ops) is called synchronously, before message() returns, with [['put', key, value] |
// ['delete', key]] for the rows 'chan:<channel>' -> { kind, box, lane, exp } (the Durable Object keeps them in ctx.storage);
// allowLane(hex, expMs) is called when a lane is minted and answers false when the host refuses another lane. A host that
// hibernates keeps the state of a socket in its attachment: attachmentOf(conn) gives { c: owned codes, q: pending knocks of the
// requester } (a few hundred bytes), attach(conn, saved) takes it back after a wake, and load(entries) takes the stored rows
// back first. Pending knocks are therefore not written to storage, and they survive a hibernation on the requester's socket.

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
export const DEFAULT_CAPS = Object.freeze({
  maxChannels: 4096, // codes in all; more get 'too many codes'
  maxPendingPerChannel: 16, // pending knocks on one code
  maxPendingPerSocket: 8, // pending knocks one requester holds (they ride in its attachment, which stays under 2 KB)
  maxKnocksPerMinute: 10, // knocks one socket may send
  maxOpensPerMinute: 10, // codes one socket may open
  maxRooms: 4, // rooms one socket may own
});

const CHANNEL_RE = new RegExp('^[' + CODE_ALPHABET + ']{' + CHANNEL_LENGTH + '}$');
const CODE_RE = new RegExp('^[' + CODE_ALPHABET + ']{' + CODE_LENGTH + '}$');
const KNOCK_RE = /^[A-Za-z0-9_-]{16}$/;
const LANE_RE = /^[0-9a-f]{40}$/;
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
const KINDS = new Set(['pair', 'room']);

/** isPairAction(action) -> true for any pair-* or room-* action: such a message marks its socket as a pair socket. */
export function isPairAction(action) {
  return typeof action === 'string' && (action.startsWith('pair-') || action.startsWith('room-'));
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

export function createPairing({ random = defaultRandom, now = () => Date.now(), allowLane = null, persist = null, caps = {} } = {}) {
  const cap = Object.assign({}, DEFAULT_CAPS, caps);
  const channels = new Map(); // channel -> { kind, owner: conn|null, box, lane: hex|null, exp: ms, knocks: Set<knock> }
  const owned = new Map(); // conn -> Set<channel>
  const knocks = new Map(); // knock -> { channel, kind, requester: conn, at: ms } (the requester's box is forwarded, never kept)
  const asked = new Map(); // conn -> Set<knock> (the pending knocks a requester holds)
  const knockLog = new Map(); // conn -> [ms] (the last minute's knocks)
  const openLog = new Map(); // conn -> [ms] (the last minute's opens)
  const touched = new Set(); // conns whose attachment-relevant state moved since takeTouched()
  let cur = null; // the operation in progress: { replies, ops, problem, touched }

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
    cur = { replies: [], ops: [], problem: null, touched: new Set() };
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
      if (allowLane && allowLane(lane, now() + LANE_TTL_MS) === false) return fail(conn, action, rid, 'too many lanes');
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

  function handle(conn, msg) {
    const action = msg.action;
    const rid = ridOf(msg);
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
      default: return fail(conn, String(action).slice(0, 64), rid, 'invalid action');
    }
  }

  /** message(conn, msg) -> { replies: [[conn, obj], ...], changed, problem }: msg is a parsed JSON object whose action isPairAction. */
  function message(conn, msg) {
    const done = run(() => handle(conn, msg));
    return { replies: done.replies, changed: done.touched.has(conn), problem: done.problem };
  }

  /** close(conn) -> replies: the socket is gone; its codes are released (pending knocks get 'gone') and its own knocks are cancelled. */
  function close(conn) {
    const done = run(() => {
      for (const channel of Array.from(owned.get(conn) || [])) closeChannel(channel, 'gone');
      for (const knock of Array.from(asked.get(conn) || [])) {
        const k = knocks.get(knock);
        const ch = k ? channels.get(k.channel) : null;
        dropKnock(knock);
        if (k && ch && ch.owner) say(ch.owner, { action: k.kind + '-cancelled', knock });
      }
    });
    knockLog.delete(conn);
    openLog.delete(conn);
    owned.delete(conn);
    asked.delete(conn);
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
    });
    for (const log of [knockLog, openLog]) {
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

  /** attach(conn, saved) -> replies: a socket restored after a wake takes back its codes (c) and its pending knocks (q). */
  function attach(conn, saved) {
    const replies = [];
    if (!saved || typeof saved !== 'object') return replies;
    const t = now();
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
    return replies;
  }

  /** attachmentOf(conn) -> { c: [[channel, kind]], q: [[knock, channel, atSeconds, kind]] }: the socket's part of the state. */
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
    return { c, q };
  }

  /** takeTouched() -> the conns whose attachment-relevant state moved since the last call (the host rewrites their attachments). */
  function takeTouched() {
    const list = Array.from(touched);
    touched.clear();
    return list;
  }

  /** nextExpiry() -> the earliest ms at which a knock or a code runs out (Infinity when there is none): when to wake the sweep. */
  function nextExpiry() {
    let at = Infinity;
    for (const k of knocks.values()) if (k.at + KNOCK_TTL_MS < at) at = k.at + KNOCK_TTL_MS;
    for (const ch of channels.values()) if (ch.exp < at) at = ch.exp;
    return at;
  }

  /** ownsLive(conn) -> true while conn owns a code: its idle sweep waits for the code to run out. */
  function ownsLive(conn) {
    const set = owned.get(conn);
    return Boolean(set && set.size);
  }

  const stats = () => ({ codes: channels.size, knocks: knocks.size });

  return { message, close, sweep, attach, attachmentOf, load, takeTouched, nextExpiry, ownsLive, stats };
}
