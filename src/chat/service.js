// The chat service (SVC contract, shared with the idp, media and sdk lanes): every chat.* method of R 2.11.2
// behind one object the loader mounts.
//
//   createChatService(deps) -> { methods, on(event, fn) -> unsubscribe, destroy() }
//   methods[name] = async (params, ctx) => result, ctx = { activation, tab: 'leader' | 'follower', signal? }
//   failures: Object.assign(new Error(msg), { code }) with R 2.11.2 codes only.
//
// deps: { keys (WorkingKeys: pub, sign(bytes), and a chat key as keys.chat = { pub, ecdh } or keys.chatPub with
// keys.ecdh), ledgerId, node (ChainNode: roles, bans, mw.ck; never written for conversation), cfg() (_mw.cfg),
// deviceClass ('desktop' | 'android' | 'ios'), hostOnly, ownTracker, wires (TorrentManager seam), store (sealed
// IndexedDB: get/set), prompt(kind, data) -> Promise<boolean>, now, random, setTimeout?, clearTimeout?, shareOnNetwork?
// (Android only: the person chose "Share on this network") }.
//
// Rules carried here: host-only mode answers E_HOST_ONLY before any network request; UI methods need a
// loader-verified click (ctx.activation) and the loader's own card (deps.prompt); follower tabs hold no keys
// (only reads run there); conversation never goes to the ledger (the only ledger write is the opt-in mw.ck
// copy, which needs the person's answer to its card).
//
// C2 calls: the returned object carries `sig`, the internal SIG seam of src/calls/service.js (never a method,
// so the site cannot reach it; docs/deviations/calls.md):
//   sig.send(pub, payload, { group }) -> Promise<{ reached, route, bucket }>: payload (bytes, at most 15,000) sealed
//     with sealDm under KIND.sig into a SIG frame (0x0B), 10-bit stamp, never FLAG_HOLD, never FLAG_STRANGER, own
//     counter and replay conversation 'sig|' + pub; never remembered in history, never ACKed. Allowed to an accepted
//     contact, a key in an active listen set, or (calls on) a member of `group` that this tab holds too.
//   sig.onReceive(fn(pub, payload, meta)) -> unsubscribe: KIND.sig inside a SIG frame from an accepted, unblocked
//     contact, a key in an active listen set, or (calls on) a member of a group both hold; meta = { contact, listen,
//     groups, t, id, n, gap, via }. KIND.sig inside ENV, any other kind inside SIG, held or stranger SIG: dropped.
//   sig.listen(pubs, untilMs) -> stop: those keys' pair tags join the lane interest for SIG only, until untilMs
//     (at most 2 h from now).
//   sig.contact(pub), sig.groupMembers(groupId), sig.state() -> { on, calls }, sig.ckOf(pub), sig.learn(ck).
//
// Review round (R 5.3, 2026-10-24; docs/deviations/review-round-chat.md):
//   - deps.ckShare: 'reason' sends the own CK to a neighbour only when there is a reason (PRIV-2, STALK-2): the neighbour is
//     a contact, group member or call-roster key whose CK this tab holds; this tab is looking for the chat key of one of
//     those; message requests are open (strangers need the key to write); presence is public. A neighbour's CK of such a
//     key is answered with ours. The default ('all', every new neighbour) stays until the loader passes 'reason' and the
//     calls fixture and the e2e chat lab add contacts before they wait for chat keys (requests in
//     docs/deviations/review-round-chat.md). A CK never makes a 'presence' event (only a verified PRES does);
//   - contact and SIG tags are directional (tags.js contactTagFrom), stranger frames carry only the first byte of the inbox
//     tag, and contact mail carries the COLLECTED hash lock (seal.js; PRIV-1, STALK-7, SYB-15, HUB-8);
//   - the CK cache keeps known signers apart from strangers (MP-5, SYB-5) and a CK that changes nothing rebuilds nothing;
//   - message requests: one per sender, the oldest goes when 200 are open (requestsDropped counts them), decline takes
//     { all: true } or { from } too; 'introduced' takes no requests until introductions are built (SYB-14, STALK-9);
//   - chat stays on across reloads once the person turned it on (UX-14): chat.state and resume() turn it back on without a
//     card while the site and its tracker are the same, and the joined rooms come back;
//   - room events carry the author's short id (UX-6); a signed room message is shown once (MP-13); room t is rounded down
//     to the minute and other values are refused (STALK-12); at most 64 groups, 16 from one inviter (SYB-16).
//
// Shared code: Node >= 22 and browsers.

import { utf8, hex, b64url, concatBytes } from '../chain/canonical.js';
import { sha256Sync } from '../chain/sha256-sync.js';
import { isPublicKeyString, publicKeyBytes, sha256, verify as verifySig } from '../chain/crypto.js';
import { roleOf, isBanned } from '../chain/state.js';
import { T, encode, envBody, roomBody, ckBody, presBody, irespBody, frameId as frameIdOf, collectedBody } from './frames.js';
import { utcDay, headerDay, fullDay } from './stamp.js';
import { contactTagFrom, inboxTag, groupTag, listenDays, heldDays, tagKey, buildWant, hmac, secureRandom } from './tags.js';
import { sealDm, openDm, pairKey, sealGroup, openGroup, groupKey, collectSecret } from './seal.js';
import { makeCk, CkCache, ledgerCopy, checkCkShape } from './ck.js';
import { ReplayGuard } from './replay.js';
import { ChatLane } from './lane.js';
import { registerChatWire } from './wire.js';
import { Holder, inboxProof } from './holder.js';
import { Outbox, AckBatcher } from './outbox.js';
import { GroupState } from './groups.js';
import { presFields, readPres, PresenceBook, PRES_LABEL } from './presence.js';
import {
  KIND, FLAG_HOLD, FLAG_STRANGER, STAMP_BITS_STRANGER_DEFAULT, STAMP_BITS_CONTACT, STAMP_BITS_MAX, TEXT_MAX,
  DM_PER_MIN, ROOM_PREFIX, ROOM_SKEW_MS, ROOM_BUCKET, ROOM_BUCKET_MS, ROOM_TEXT_MAX, ROOM_NAME_MAX, ROOM_HISTORY,
  GROUP_MAX, PRES_INTERVAL_MS, PRES_STATUS, DEVICE, WANT_INTERVAL_MS, CK_TTL_MS, ACK_REQUEUE_MS, DELIVERED_MAX,
  REPLAY_SAVE_MS, CK_PERSIST_MAX, GROUP_SKEW_MS, HELD_DAYS, REQUESTS_MAX, GROUPS_MAX, GROUPS_PER_INVITER, ROOM_SEEN_MAX,
  ROOM_T_STEP_MS,
} from './limits.js';

/** C2 calls (SZ 3.5): a SIG body is at most 15,000 bytes; a listen set lasts at most 2 h and names at most 32 keys. */
const SIG_BODY_MAX = 15000;
const SIG_LISTEN_MAX_MS = 2 * 3600000;
const SIG_LISTEN_PUBS_MAX = 32;
const CALLS_ON = 'contacts';

export const CHAT_METHODS = Object.freeze([
  'chat.enable', 'chat.disable', 'chat.state',
  'chat.presence.set', 'chat.presence.list',
  'chat.contacts.list', 'chat.contacts.add', 'chat.contacts.remove', 'chat.contacts.block', 'chat.contacts.unblock',
  'chat.contacts.verify',
  'chat.requests.list', 'chat.requests.accept', 'chat.requests.decline', 'chat.requests.setOpen',
  'chat.dm.send', 'chat.dm.history', 'chat.dm.keepHistory',
  'chat.room.join', 'chat.room.leave', 'chat.room.send',
  'chat.group.create', 'chat.group.invite', 'chat.group.remove', 'chat.group.leave', 'chat.group.send',
  'chat.holder.set', 'chat.direct.connect',
]);
export const CHAT_EVENTS = Object.freeze(['message', 'delivery', 'request', 'presence', 'room', 'group', 'state', 'keychange']);
/** Methods that need a loader-verified click (presence.set only with public: true). */
export const UI_CHAT_METHODS = Object.freeze(['chat.enable', 'chat.requests.setOpen', 'chat.holder.set', 'chat.direct.connect']);
const READ_METHODS = new Set(['chat.state', 'chat.presence.list', 'chat.contacts.list', 'chat.requests.list', 'chat.dm.history']);
const HISTORY_MAX = 500;
const STORE_KEY = 'mw-chat-state';

function fail(code, msg) {
  return Object.assign(new Error(msg), { code });
}

function args(params, names) {
  if (Array.isArray(params)) {
    const out = {};
    if (typeof params[0] === 'object' && params[0] !== null && !Array.isArray(params[0])) return Object.assign(out, params[0]);
    names.forEach((n, i) => { if (params[i] !== undefined) out[n] = params[i]; });
    if (params[names.length] && typeof params[names.length] === 'object') Object.assign(out, params[names.length]);
    if (typeof params[1] === 'object' && params[1] !== null) Object.assign(out, params[1]);
    return out;
  }
  if (params && typeof params === 'object') return Object.assign({}, params);
  if (params !== undefined && names.length) return { [names[0]]: params };
  return {};
}

function needPub(pub) {
  if (!isPublicKeyString(pub)) throw fail('E_BAD_REQUEST', 'expected a p256: key');
  return pub;
}

function textOf(x, max) {
  if (typeof x !== 'string' || x.length === 0) throw fail('E_BAD_REQUEST', 'text must be a non-empty string');
  if (x.length > max) throw fail('E_LIMIT', 'text over ' + max + ' characters');
  return x;
}

function chatKeyOf(keys) {
  if (!keys) return null;
  if (keys.chat && typeof keys.chat.ecdh === 'function' && typeof keys.chat.pub === 'string') return keys.chat;
  if (typeof keys.ecdh === 'function' && typeof keys.chatPub === 'string') return { pub: keys.chatPub, ecdh: (p) => keys.ecdh(p) };
  return null;
}

function cfgMode(cfg, field, dflt) {
  const v = cfg && cfg[field];
  return typeof v === 'string' ? v : dflt;
}

/**
 * The site takes message requests (R 2.5.5): any mode but 'off', except 'introduced', which stays closed until
 * introductions are built (review round, STALK-9: it used to behave as 'on' while the owner was told strangers need one).
 */
function requestsOn(cfg) {
  const m = cfgMode(cfg, 'requests', 'off');
  return m !== 'off' && m !== 'introduced';
}

/**
 * shortId(pub) -> 'k3f9-2xq1': 8 base32 characters of SHA-256(pub), the identity cards' short form (src/idp/cards.js
 * shortId; the same function here so chat events need no card code). Every room and direct message event carries it (UX-6).
 */
export function shortId(pub) {
  const h = sha256Sync(utf8.encode(String(pub || '')));
  const A = 'abcdefghijkmnpqrstuvwxyz23456789';
  let s = '';
  for (let i = 0; i < 8; i++) s += A[h[i] & 31];
  return s.slice(0, 4) + '-' + s.slice(4);
}

export function createChatService(deps) {
  const d = Object.assign({
    deviceClass: DEVICE.desktop, hostOnly: false, ownTracker: null, wires: null, store: null,
    prompt: async () => false, now: () => Date.now(), random: secureRandom, cfg: () => ({}), ckShare: 'all',
  }, deps || {});
  // Decoys, presence slots, jitter and relay subsets never draw from Math.random (SEC-10): a caller that passes it (the
  // loader does) gets crypto.getRandomValues; a test may inject any other function.
  if (d.random === Math.random || typeof d.random !== 'function') d.random = secureRandom;
  const now = d.now;
  // hostOnly may be a boolean or a function (the SVC deps of the media and files services take a function, so a
  // host-only choice made after the service was mounted counts at once; integration I-8).
  const hostOnlyNow = () => (typeof d.hostOnly === 'function' ? Boolean(d.hostOnly()) : Boolean(d.hostOnly));
  const listeners = new Map();
  const S = {
    on: false, lane: null, unregister: null, ck: null, ckCache: null, replay: null, outbox: null, acks: null,
    holder: null, presence: { on: false, public: false, timer: null, visible: true }, book: new PresenceBook({ now }),
    contacts: new Map(), // site pub -> { pub, nick, blocked, accepted, keepHistory, verified }
    counters: new Map(), // site pub -> next n
    history: new Map(), // site pub -> [messages]
    requests: new Map(), // id -> { id, from, chat, t, size, message }
    requestsOpen: false,
    rooms: new Map(), // name -> { joined, messages: [] }
    roomBuckets: new Map(), // author -> [times]
    groups: new Map(), // groupId -> GroupState
    gesture: { contacts: false, history: false },
    interest: new Map(), // tag hex -> { kind, pub?, groupId?, epochId?, secret? }
    interestDay: -1,
    interestGen: 0,
    interestRun: null, // the newest refreshInterest build (a promise)
    pairs: new Map(), // chat pub -> K_pair
    sent: [], // DM send times (rate)
    timers: new Set(),
    destroyed: false,
    sigListeners: new Set(), // C2 calls: the calls service's onReceive
    listens: new Map(), // C2 calls: id -> { pubs: Set, until }
    listenSeq: 0,
    delivered: new Map(), // message id -> { pub, ackAt }: messages this device delivered and ACKed (a lost ACK is re-sent)
    savedCks: [], // CK records restored from the sealed store, put into the cache at enable
    replayTimer: null,
    unhook: null, // removes the pagehide and visibilitychange listeners
    consented: false, // the person turned chat on (and has not turned it off): kept in the store, so a reload resumes (UX-14)
    savedRooms: [], // room names joined before the reload
    resuming: null, // the running resume (a promise)
    ckSent: new Set(), // wire ids this tab's CK went to (PRIV-2: once per wire, and only with a reason)
    requestsDropped: 0, // requests pushed out by a full inbox (SYB-14)
    roomSeen: new Map(), // author|id -> arrival (MP-13)
    inboxFirsts: new Set(), // first bytes of this tab's inbox tags (blinded stranger tags, STALK-7)
  };

  // -------------------------------------------------------------------------------------------
  // Plumbing
  // -------------------------------------------------------------------------------------------

  function emit(event, data) {
    const set = listeners.get(event);
    if (!set) return;
    for (const fn of Array.from(set)) {
      try { fn(data); } catch (_) { /* a listener must not break chat */ }
    }
  }

  const setT = d.setTimeout || ((fn, ms) => setTimeout(fn, ms));
  const clearT = d.clearTimeout || ((h) => clearTimeout(h));
  function later(fn, ms) {
    const h = setT(() => { S.timers.delete(h); fn(); }, ms);
    S.timers.add(h);
    return h;
  }

  function chatKey() {
    return chatKeyOf(d.keys);
  }

  function signer() {
    const k = d.keys;
    if (!k || typeof k.sign !== 'function' || !isPublicKeyString(k.pub)) return null;
    return { pub: k.pub, sign: (bytes) => k.sign(bytes) };
  }

  function ledger() {
    const node = d.node;
    const st = () => {
      try { return node && node.state; } catch (_) { return null; }
    };
    return {
      // Code review v0.3 (round 2, ledger-tools request): without the node's own clock-aware roleOf and isBanned, the reduced
      // state is read with this service's clock (policy.banned holds permanent bans only; a temporary ban counts until it ends).
      role(pub) {
        if (node && typeof node.roleOf === 'function') return node.roleOf(pub);
        return roleOf(pub, st(), now());
      },
      banned(pub) {
        if (node && typeof node.isBanned === 'function') return !!node.isBanned(pub);
        const s = st();
        return !!(s && s.owner !== pub && isBanned(pub, s, now()));
      },
      /** rotated(pub) -> true when the ledger shows the key as rotated away (MF-20): its chat keys are refused. */
      rotated(pub) {
        const s = st();
        return !!(s && s.rotations instanceof Map && s.rotations.has(pub));
      },
      syncing() {
        if (!node) return false;
        if (typeof node.isSyncing === 'function') return !!node.isSyncing();
        return node.syncing === true;
      },
      ckRecords() {
        const s = st();
        const items = s && s.lists && typeof s.lists.get === 'function' ? s.lists.get('mw.ck') || [] : [];
        return items.filter((it) => it && it.v && it.v.signer === it.author).map((it) => it.v);
      },
    };
  }

  function cfg() {
    try { return d.cfg() || {}; } catch (_) { return {}; }
  }

  function chatBits() {
    const b = cfg().chatBits;
    return Number.isInteger(b) && b >= STAMP_BITS_CONTACT && b <= STAMP_BITS_MAX ? b : STAMP_BITS_STRANGER_DEFAULT;
  }

  function isPhone() {
    return d.deviceClass === DEVICE.ios || d.deviceClass === DEVICE.android;
  }

  function callsOn() {
    return cfgMode(cfg(), 'calls', 'off') === CALLS_ON;
  }

  // C2 calls: keys whose SIG this tab takes besides contacts (listen sets of call rosters), and the groups a key
  // shares with this tab.
  function sigListenPubs() {
    const t = now();
    const out = new Set();
    for (const [id, l] of S.listens) {
      if (l.until <= t) {
        S.listens.delete(id);
        continue;
      }
      for (const p of l.pubs) out.add(p);
    }
    return out;
  }

  // Membership decides with the union of removals of concurrent rekeys applied (R 2.7.7): a member a losing admin
  // removed is out of shares, call rosters and SIG at once, before an admin re-applies the removal.
  function membersOf(g) {
    try { return g.effectiveMembers(); } catch (_) { return []; }
  }

  function groupsWith(pub) {
    const mine = d.keys && d.keys.pub;
    const out = [];
    for (const [gid, g] of S.groups) {
      if (g.left) continue;
      const m = membersOf(g);
      if (m.indexOf(pub) >= 0 && m.indexOf(mine) >= 0) out.push(gid);
    }
    return out;
  }

  /** pub -> [groupId]: listen-set keys and, while calls are on, the members of the groups this tab holds. */
  function sigPeers() {
    const peers = new Map();
    for (const p of sigListenPubs()) peers.set(p, []);
    if (callsOn()) {
      const mine = d.keys && d.keys.pub;
      for (const [gid, g] of S.groups) {
        if (g.left) continue;
        const members = membersOf(g);
        if (members.indexOf(mine) < 0) continue;
        for (const m of members) {
          if (m === mine) continue;
          if (!peers.has(m)) peers.set(m, []);
          peers.get(m).push(gid);
        }
      }
    }
    return peers;
  }

  async function persist() {
    if (!d.store || typeof d.store.set !== 'function') return;
    const contacts = Array.from(S.contacts.values());
    const counters = {};
    for (const [k, v] of S.counters) counters[k] = v;
    const history = {};
    for (const [k, v] of S.history) {
      const c = S.contacts.get(k);
      if (c && c.keepHistory) history[k] = v;
    }
    // Every epoch of the grace window, with the parents its siblings are checked against (code review v0.3: a reload
    // keeps the previous epoch's secret and still accepts the sibling that wins).
    const groups = [];
    for (const g of S.groups.values()) {
      try {
        if (g.record()) groups.push(g.toJSON());
      } catch (_) { /* skip a broken state */ }
    }
    // Chat-key records of contacts and group members, kept until exp (R 2.7.2): after a reload held mail is still
    // collected and messages still go out before the contact is a neighbour again.
    const cks = [];
    if (S.ckCache) {
      const want = new Set(S.contacts.keys());
      for (const g of S.groups.values()) for (const m of membersOf(g)) want.add(m);
      for (const pub of want) {
        if (cks.length >= CK_PERSIST_MAX) break;
        const ck = S.ckCache.forSigner(pub);
        if (ck && ck.exp > now()) cks.push(ck);
      }
    }
    const delivered = [];
    for (const [id, x] of S.delivered) delivered.push([id, x.pub]);
    // Rooms joined now (or, while chat is off after a reload, the ones joined before it).
    const rooms = S.on ? Array.from(S.rooms.keys()).filter((n) => S.rooms.get(n).joined) : S.savedRooms.slice();
    try {
      await d.store.set(STORE_KEY, {
        v: 1, contacts, counters, history, requestsOpen: S.requestsOpen, groups, ckEpoch: S.ck ? S.ck.epoch : 0, cks,
        delivered: delivered.slice(-DELIVERED_MAX), on: S.consented, tracker: S.consented ? d.ownTracker : null,
        rooms: rooms.slice(0, 32),
      });
    } catch (_) {
      // storage may be full or evicted; chat keeps running in memory
    }
  }

  async function restore() {
    if (!d.store || typeof d.store.get !== 'function') return null;
    let v;
    try { v = await d.store.get(STORE_KEY); } catch (_) { return null; }
    if (!v || v.v !== 1) return null;
    for (const c of v.contacts || []) if (c && isPublicKeyString(c.pub)) S.contacts.set(c.pub, c);
    for (const [k, n] of Object.entries(v.counters || {})) if (Number.isSafeInteger(n)) S.counters.set(k, n);
    for (const [k, h] of Object.entries(v.history || {})) if (Array.isArray(h)) S.history.set(k, h.slice(-HISTORY_MAX));
    S.requestsOpen = v.requestsOpen === true;
    for (const g of v.groups || []) {
      try {
        let st = null;
        if (g && g.v === 2) {
          st = await GroupState.fromJSON(g, { ledgerId: d.ledgerId, me: d.keys.pub, now });
        } else if (g && g.record && typeof g.secret === 'string') {
          // the 0.3 format before code review v0.3: the current epoch only
          st = new GroupState({ ledgerId: d.ledgerId, groupId: g.record.groupId, me: d.keys.pub, now });
          const r = await st.adopt(g.record, b64url.decode(g.secret));
          if (!r.ok) st = null;
        }
        if (st && st.current) S.groups.set(st.groupId, st);
      } catch (_) { /* skip a broken record */ }
    }
    S.savedCks = Array.isArray(v.cks) ? v.cks.slice(0, CK_PERSIST_MAX) : [];
    S.savedRooms = Array.isArray(v.rooms) ? v.rooms.filter((n) => typeof n === 'string' && n.length > 0 && n.length <= ROOM_NAME_MAX).slice(0, 32) : [];
    S.delivered.clear();
    for (const x of Array.isArray(v.delivered) ? v.delivered.slice(-DELIVERED_MAX) : []) {
      if (Array.isArray(x) && typeof x[0] === 'string' && isPublicKeyString(x[1])) S.delivered.set(x[0], { pub: x[1], ackAt: 0 });
    }
    return v;
  }

  /**
   * Saves the replay guard (and the chat state: delivered ids for re-sent ACKs, incoming history) REPLAY_SAVE_MS after
   * an accept, debounced (MF-36: replay protection survives a reload, for group messages, SIG and requests too).
   */
  function saveReplaySoon() {
    if (!S.replay || S.replayTimer) return;
    S.replayTimer = later(() => {
      S.replayTimer = null;
      if (S.replay) S.replay.save().catch(() => {});
      persist().catch(() => {});
    }, REPLAY_SAVE_MS);
  }

  /** Saves the replay guard and the chat state now (pagehide, a hidden page, chat off). */
  function flushNow() {
    if (S.replayTimer) {
      clearT(S.replayTimer);
      S.timers.delete(S.replayTimer);
      S.replayTimer = null;
    }
    if (S.replay) S.replay.save().catch(() => {});
    persist().catch(() => {});
  }

  /** Listens for pagehide and a page going hidden (the browser may end the page without another event). */
  function hookPage() {
    const w = d.win !== undefined ? d.win : (typeof window !== 'undefined' ? window : null);
    if (!w || typeof w.addEventListener !== 'function') return null;
    const doc = w.document || null;
    const onHide = () => flushNow();
    const onVis = () => {
      if (doc && doc.visibilityState === 'hidden') flushNow();
    };
    try {
      w.addEventListener('pagehide', onHide);
      if (doc && typeof doc.addEventListener === 'function') doc.addEventListener('visibilitychange', onVis);
    } catch (_) {
      return null;
    }
    return () => {
      try {
        w.removeEventListener('pagehide', onHide);
        if (doc && typeof doc.removeEventListener === 'function') doc.removeEventListener('visibilitychange', onVis);
      } catch (_) { /* gone */ }
    };
  }

  // -------------------------------------------------------------------------------------------
  // Guards
  // -------------------------------------------------------------------------------------------

  function guardCommon(name, ctx) {
    if (S.destroyed) throw fail('E_POLICY', 'chat service destroyed');
    if (hostOnlyNow() && name !== 'chat.state') throw fail('E_HOST_ONLY', 'chat needs peers; this site is open in host-only mode');
    const c = ctx || {};
    if (c.tab === 'follower' && !READ_METHODS.has(name)) throw fail('E_POLICY', 'chat runs in the leader tab');
  }

  function needGesture(ctx) {
    if (!ctx || ctx.activation !== true) throw fail('E_NEEDS_GESTURE', 'call this from a click');
  }

  function needOn() {
    if (!S.on) throw fail('E_POLICY', 'turn on messages first (mw.chat.enable)');
  }

  function chatAllowed() {
    const mode = cfgMode(cfg(), 'chat', 'off');
    if (mode === 'off') throw fail('E_POLICY', 'this site has messages turned off');
    if (mode === 'members') {
      const k = signer();
      const r = k ? ledger().role(k.pub) : 'reader';
      if (r === 'reader') throw fail('E_POLICY', 'messages on this site are for members');
    }
    return mode;
  }

  async function card(kind, data) {
    let ok = false;
    try { ok = await d.prompt(kind, data); } catch (_) { ok = false; }
    if (ok !== true) throw fail('E_USER_CANCELLED', 'cancelled');
  }

  // -------------------------------------------------------------------------------------------
  // Keys, tags and interest
  // -------------------------------------------------------------------------------------------

  async function kPairWith(chatPub) {
    let k = S.pairs.get(chatPub);
    if (!k) {
      k = await pairKey(chatKey(), chatPub, d.ledgerId);
      S.pairs.set(chatPub, k);
    }
    return k;
  }

  function ckFor(pub) {
    if (!S.ckCache) return null;
    const c = S.ckCache.forSigner(pub);
    if (c) return c;
    if (ledger().rotated(pub)) return null; // a rotated-away key has no chat key, not even its ledger copy (MF-20)
    for (const rec of ledger().ckRecords()) if (rec.signer === pub && checkCkShape(rec).ok && rec.exp > now()) return rec;
    return null;
  }

  async function cacheLedgerCks() {
    for (const rec of ledger().ckRecords()) {
      try { await S.ckCache.put(rec); } catch (_) { /* skip */ }
    }
  }

  async function refreshInterest(force = false) {
    if (!S.on) return;
    const day = utcDay(now());
    if (!force && S.interestDay === day) return;
    let mine = buildInterest(day);
    S.interestRun = mine;
    await mine;
    // Code review v0.3 (round 2): a refresh begun after this one replaces it, so whoever awaits this one (the next frame
    // of the wire a CK frame came on, a contact change) waits for the newest too and reads a map with what it just added.
    while (S.interestRun && S.interestRun !== mine) {
      mine = S.interestRun;
      try { await mine; } catch (_) { /* that refresh's own caller hears of it */ }
    }
  }

  async function buildInterest(day) {
    // Refreshes overlap (a CK frame, an invite, a contact change, the day change): the one started last wins, so a slower
    // one begun before a group change cannot put back a map without the new epoch's tags.
    const gen = ++S.interestGen;
    const map = new Map();
    // Incoming contact mail carries the directional tag of its sender's chat key (PRIV-1).
    for (const c of S.contacts.values()) {
      if (c.blocked) continue;
      const ck = ckFor(c.pub);
      if (!ck) continue;
      const kp = await kPairWith(ck.ek);
      for (const dd of listenDays(day)) map.set(tagKey(await contactTagFrom(kp, dd, ck.ek)), { kind: 'contact', pub: c.pub, chat: ck.ek, live: true });
      // Held mail keeps the tag of the day it was sent on: the older days of the 7-day hold count only for frames a
      // holder hands back (via 'held'), and their prefixes go in WANT-TAGS.
      for (const dd of heldDays(day, HELD_DAYS)) {
        const k = tagKey(await contactTagFrom(kp, dd, ck.ek));
        if (!map.has(k)) map.set(k, { kind: 'contact', pub: c.pub, chat: ck.ek, live: false });
      }
    }
    // Stranger mail: the full inbox tag (the R 2.7.4 form) or only its first byte (blinded, STALK-7).
    const firsts = new Set();
    for (const dd of listenDays(day)) {
      const it = await inboxTag(chatKey().pub, dd);
      map.set(tagKey(it), { kind: 'inbox', live: true });
      firsts.add(it[0]);
    }
    for (const [gid, g] of S.groups) {
      for (const e of g.listening()) {
        const kG = await groupKey(e.secret, d.ledgerId, gid, e.epochId);
        for (const dd of listenDays(day)) map.set(tagKey(await groupTag(kG, dd)), { kind: 'group', groupId: gid, epochId: e.epochId, secret: e.secret, live: true });
      }
    }
    // C2 calls: SIG-only interest for call rosters and members of held groups who are not contacts.
    for (const pub of sigPeers().keys()) {
      const c = S.contacts.get(pub);
      if (c) continue; // a contact's tags are in already; a blocked key never
      const ck = ckFor(pub);
      if (!ck) continue;
      const kp = await kPairWith(ck.ek);
      for (const dd of listenDays(day)) {
        const k = tagKey(await contactTagFrom(kp, dd, ck.ek));
        if (!map.has(k)) map.set(k, { kind: 'sig', pub, chat: ck.ek, live: true });
      }
    }
    if (gen !== S.interestGen) return;
    S.interest = map;
    S.inboxFirsts = firsts;
    S.interestDay = day;
  }

  /**
   * The interest entry of a tag; the older days of the hold count only for held mail (via 'held'). A stranger-flagged frame
   * whose tag starts with the first byte of one of this tab's inbox tags is tried as stranger mail (blinded inbox tags,
   * STALK-7; one in 256 stranger frames on the lane, under the decrypt budgets).
   */
  function interestOf(tag, via, decoded = null) {
    const it = S.interest.get(tagKey(tag)) || null;
    if (!it) {
      if (decoded && decoded.header && (decoded.header.flags & FLAG_STRANGER) && decoded.type === T.ENV && S.inboxFirsts && S.inboxFirsts.has(tag[0])) {
        return { kind: 'inbox', live: true };
      }
      return null;
    }
    if (it.live === false && via !== 'held') return null;
    return it;
  }

  // -------------------------------------------------------------------------------------------
  // Sending
  // -------------------------------------------------------------------------------------------

  function nextCounter(pub) {
    const n = S.counters.get(pub) || 0;
    S.counters.set(pub, n + 1);
    return n;
  }

  async function stampEnvelope({ sealed, hold, stranger, signal }) {
    const flags = (hold ? FLAG_HOLD : 0) | (stranger ? FLAG_STRANGER : 0);
    const bits = stranger ? chatBits() : STAMP_BITS_CONTACT;
    try {
      return await S.lane.stamped(T.ENV, { flags, body: envBody(sealed), bits, signal });
    } catch (e) {
      throw fail('E_STAMP', 'could not finish the anti-spam stamp');
    }
  }

  async function sendEnvelope({ chat, sealed, hold, stranger, signal }) {
    const frame = await stampEnvelope({ sealed, hold, stranger, signal });
    return S.lane.send(frame, { to: chat, tag: sealed.tag });
  }

  async function sealFor(entry) {
    const p = entry.payload;
    return sealDm({
      myChat: chatKey(), theirChatPub: p.chat, ledgerId: d.ledgerId, day: utcDay(now()), message: p.message,
      stranger: p.stranger, ck: p.stranger ? S.ck : null, directional: true, blindInbox: true, collectLock: true,
    });
  }

  // One sealed copy per message, UTC day and hold flag (code review v0.3): re-sends and re-holds carry the same
  // frame (same epk, same frameId), so holders, which dedupe by frameId, keep a message once.
  async function outboxSend(entry, { hold }) {
    if (!S.on || !S.lane) return { reached: 0 };
    const day = utcDay(now());
    if (!entry.cache || entry.cache.day !== day) entry.cache = { day };
    const key = hold ? 'held' : 'live';
    if (!entry.cache[key]) {
      const sealed = await sealFor(entry);
      const frame = await stampEnvelope({ sealed, hold, stranger: entry.payload.stranger });
      entry.cache[key] = { frame, tag: sealed.tag };
    }
    if (!S.on || !S.lane) return { reached: 0 };
    const c = entry.cache[key];
    return S.lane.send(c.frame, { to: entry.payload.chat, tag: c.tag });
  }

  async function sendAcks(toPub, ids) {
    const ck = ckFor(toPub);
    if (!ck || !S.on) return;
    const body = concatBytes(...ids.map((x) => b64url.decode(x)));
    const sealed = await sealDm({
      myChat: chatKey(), theirChatPub: ck.ek, ledgerId: d.ledgerId, day: utcDay(now()),
      message: { t: now(), n: 0, kind: KIND.ack, body }, directional: true, collectLock: true,
    });
    await sendEnvelope({ chat: ck.ek, sealed, hold: false, stranger: false });
  }

  function remember(pub, msg) {
    if (!S.history.has(pub)) S.history.set(pub, []);
    const h = S.history.get(pub);
    h.push(msg);
    if (h.length > HISTORY_MAX) h.splice(0, h.length - HISTORY_MAX);
  }

  // -------------------------------------------------------------------------------------------
  // Receiving
  // -------------------------------------------------------------------------------------------

  /** COLLECTED for a held frame: the proof is the frame's hash-lock secret (seal.js collectSecret; SYB-15, HUB-8). */
  async function sendCollected(wire, frameIdBytes, kp, env) {
    const proof = await collectSecret(kp, env.tag, env.epk);
    const f = await S.lane.stamped(T.COLLECTED, { body: collectedBody({ frameId: frameIdBytes, proof }) });
    S.lane.sendTo(wire, f);
  }

  // A frame that fails to open is the fault of the wire only when that neighbour made it (hop 0): a relay
  // cannot check the AEAD, and anyone can address junk to a public inbox tag.
  function strikeOrigin(decoded, wire) {
    if (S.lane && decoded.header.hop === 0) S.lane.strike(wire, 'aead');
  }

  async function onEnvelope({ decoded, wire, via }) {
    const it = interestOf(decoded.fields.tag, via, decoded);
    if (!it) return;
    const env = decoded.fields;
    const stranger = !!(decoded.header.flags & FLAG_STRANGER);
    const sigFrame = decoded.type === T.SIG;
    if (it.kind === 'contact' || it.kind === 'sig') {
      if (stranger) return;
      const c = S.contacts.get(it.pub);
      if (it.kind === 'contact' && (!c || c.blocked)) return;
      if (it.kind === 'sig' && (!sigFrame || (c && c.blocked))) return; // a roster key sends nothing but SIG
      const kp = await kPairWith(it.chat);
      const o = await openDm({ myChat: chatKey(), ledgerId: d.ledgerId, env, theirChatPub: it.chat, kPair: kp, now: now() });
      if (!o.ok) {
        strikeOrigin(decoded, wire);
        return;
      }
      if (sigFrame || o.message.kind === KIND.sig) return deliverSig(it.pub, it.chat, o.message, { frame: decoded.type, flags: decoded.header.flags, via });
      if (via === 'held') await sendCollected(wire, frameIdOf(decoded), kp, env);
      return deliver(c.pub, it.chat, o.message, { fromRequest: false });
    }
    if (it.kind === 'inbox') {
      if (!stranger || sigFrame) return; // SIG is never stranger mail
      if (!requestsOn(cfg()) || !S.requestsOpen) return;
      const o = await openDm({ myChat: chatKey(), ledgerId: d.ledgerId, env, stranger: true, now: now() });
      if (!o.ok) {
        // A blinded tag matches by its first byte only, so a frame for someone else fails here: never a strike then.
        if (S.interest.has(tagKey(env.tag))) strikeOrigin(decoded, wire);
        return;
      }
      await S.ckCache.put(o.ck);
      if (via === 'held') await sendCollected(wire, frameIdOf(decoded), o.kPair, env);
      const from = o.ck.signer;
      const known = S.contacts.get(from);
      if (known && known.blocked) return;
      if (known && known.accepted) return deliver(from, o.ck.ek, o.message, { fromRequest: true });
      const r = S.replay.accept(o.ck.ek, { id: o.message.id, t: o.message.t });
      if (!r.ok) return;
      saveReplaySoon();
      // One open request per sender key (the newer replaces it); a full inbox lets its oldest request go (SYB-14).
      for (const [rid, q] of S.requests) if (q.from === from) S.requests.delete(rid);
      while (S.requests.size >= REQUESTS_MAX) {
        S.requests.delete(S.requests.keys().next().value);
        S.requestsDropped++;
      }
      const id = b64url.encode(o.message.id);
      S.requests.set(id, { id, from, chat: o.ck.ek, t: o.message.t, size: o.message.body.length, message: o.message });
      emit('request', { id, from, short: shortId(from), t: o.message.t, size: o.message.body.length });
      return;
    }
    if (it.kind === 'group') {
      if (sigFrame) return; // calls signal per pair (K_pair), never under a group tag
      const g = S.groups.get(it.groupId);
      if (!g) return;
      const o = await openGroup({ groupSecret: it.secret, ledgerId: d.ledgerId, groupId: it.groupId, epochId: it.epochId, env });
      if (!o.ok) return;
      const epochHex = hex.encode(it.epochId);
      const rec = g.epochs.get(epochHex);
      if (!rec || rec.record.members.indexOf(o.from) < 0) return;
      if (o.from === (d.keys && d.keys.pub)) return;
      // The sender must be a member of the current epoch after the union of removals (R 2.7.7), and under a replaced
      // epoch only what was written before the replacement counts: the 7-day grace is for late delivery, so a member
      // removed by the rekey cannot keep posting through the epoch it still holds (code review v0.3).
      if (g.effectiveMembers().indexOf(o.from) < 0) return;
      if (epochHex !== g.current && (!Number.isFinite(rec.replacedAt) || o.message.t > rec.replacedAt + GROUP_SKEW_MS)) return;
      const r = S.replay.accept('g|' + o.from, { id: o.message.id, t: o.message.t, n: o.message.n, conv: 'g|' + it.groupId + '|' + o.from });
      if (!r.ok) return;
      saveReplaySoon();
      emit('group', {
        groupId: it.groupId, from: o.from, id: b64url.encode(o.message.id), t: o.message.t,
        text: utf8.decode(o.message.body), gap: r.gap,
      });
    }
  }

  // C2 calls: KIND.sig only inside SIG, SIG only with KIND.sig; never held or stranger-flagged; from an accepted,
  // unblocked contact, a key in an active listen set, or (calls on) a member of a group both hold. No history, no ACK.
  function deliverSig(pub, chat, m, { frame, flags, via }) {
    if (frame !== T.SIG || m.kind !== KIND.sig) return;
    if (flags & (FLAG_HOLD | FLAG_STRANGER)) return;
    if (via === 'held') return;
    if (!S.sigListeners.size) return;
    const c = S.contacts.get(pub);
    if (c && c.blocked) return;
    const contact = !!(c && c.accepted);
    const listen = sigListenPubs().has(pub);
    const groups = callsOn() ? groupsWith(pub) : [];
    if (!contact && !listen && !groups.length) return;
    const r = S.replay.accept(chat, { id: m.id, t: m.t, n: m.n, conv: 'sig|' + pub });
    if (!r.ok) return;
    saveReplaySoon();
    const meta = { contact, listen, groups, t: m.t, id: b64url.encode(m.id), n: m.n, gap: r.gap, via };
    for (const fn of Array.from(S.sigListeners)) {
      try { fn(pub, m.body, meta); } catch (_) { /* the calls service must not break chat */ }
    }
  }

  function noteDelivered(pub, id) {
    S.delivered.delete(id);
    S.delivered.set(id, { pub, ackAt: 0 }); // ackAt: the last re-sent ACK (the first copy's ACK is not counted)
    while (S.delivered.size > DELIVERED_MAX) S.delivered.delete(S.delivered.keys().next().value);
  }

  // The receiver ACKs a message once; when that ACK is lost the sender keeps re-sending a message this device already
  // shows, and the replay guard drops every copy. A copy refused as a replay of a message this device delivered gets
  // its ACK again (at most once a minute per id), with no second message event (code review v0.3).
  function reAck(pub, id) {
    const x = S.delivered.get(id);
    if (!x || x.pub !== pub) return;
    const c = S.contacts.get(pub);
    if (!c || !c.accepted || c.blocked) return;
    const t = now();
    if (t - x.ackAt < ACK_REQUEUE_MS) return;
    x.ackAt = t;
    S.acks.queue(pub, id);
  }

  async function deliver(pub, chat, m, { fromRequest }) {
    const id = b64url.encode(m.id);
    const r = S.replay.accept(chat, { id: m.id, t: m.t, n: m.n, conv: m.kind === KIND.ack ? undefined : pub });
    if (!r.ok) {
      if (r.reason === 'replay' && m.kind !== KIND.ack) reAck(pub, id);
      return;
    }
    saveReplaySoon();
    if (m.kind === KIND.ack) {
      const ids = [];
      for (let i = 0; i + 16 <= m.body.length; i += 16) ids.push(b64url.encode(m.body.subarray(i, i + 16)));
      S.outbox.ack(ids);
      return;
    }
    const ackable = !fromRequest || !!(S.contacts.get(pub) || {}).accepted;
    if (m.kind === KIND.invite) {
      await onInvite(pub, chat, m);
      // Invites are ACKed like messages, so the admin's outbox stops sending (and holders stop keeping) them.
      if (ackable) {
        noteDelivered(pub, id);
        S.acks.queue(pub, id);
      }
      return;
    }
    if (m.kind !== KIND.text && m.kind !== KIND.grant) return;
    let text = null;
    let grant = null;
    if (m.kind === KIND.text) text = utf8.decode(m.body);
    else {
      try { grant = JSON.parse(utf8.decode(m.body, { fatal: true })); } catch (_) { return; }
    }
    const msg = { id, from: pub, short: shortId(pub), dir: 'in', t: m.t, n: m.n, text, grant, gap: r.gap };
    remember(pub, msg);
    if (ackable) {
      noteDelivered(pub, id);
      S.acks.queue(pub, id);
    }
    emit('message', msg);
  }

  async function onInvite(pub, chat, m) {
    let inv;
    try { inv = JSON.parse(utf8.decode(m.body, { fatal: true })); } catch (_) { return; }
    if (!inv || typeof inv.g !== 'string' || !inv.rec || typeof inv.s !== 'string') return;
    if (inv.rec.creator !== pub) return; // the inviter must be the admin who made this epoch
    let secret;
    try { secret = b64url.decode(inv.s); } catch (_) { return; }
    let g = S.groups.get(inv.g);
    let r;
    if (!g) {
      // At most 64 groups, and at most 16 adopted from one inviter's invites (SYB-16): an accepted contact cannot grow the
      // interest rebuild and the sealed store without end.
      if (S.groups.size >= GROUPS_MAX) return;
      let fromInviter = 0;
      for (const x of S.groups.values()) if (x.invitedBy === pub) fromInviter++;
      if (fromInviter >= GROUPS_PER_INVITER) return;
      g = new GroupState({ ledgerId: d.ledgerId, groupId: inv.g, me: d.keys.pub, now });
      r = await g.adopt(inv.rec, secret);
      if (!r.ok) return;
      g.invitedBy = pub;
      S.groups.set(inv.g, g);
    } else {
      r = await g.receive(inv.rec, secret);
      if (!r.ok && r.reason === 'unknown-parent') {
        // An epoch whose parent this member never got (its held invites expired, or it followed a rekey that lost):
        // taken as a newcomer takes its first epoch, only from an admin of the current epoch and only when it lists
        // this member (such an admin could rekey this member's group anyway).
        if (!g.isAdmin(pub) || !Array.isArray(inv.rec.members) || inv.rec.members.indexOf(d.keys.pub) < 0) return;
        r = await g.readopt(inv.rec, secret);
      }
      if (!r.ok) return;
      if (((r.reapply && r.reapply.length) || (r.readd && r.readd.length)) && g.isAdmin(d.keys.pub)) {
        // Concurrent rekeys: every admin re-applies the union of removals on top of the winner, and the admin whose
        // rekey lost re-applies its additions (R 2.7.7).
        later(() => { reapplyGroup(g).catch(() => {}); }, 0);
      }
    }
    await refreshInterest(true);
    shareCk(); // members this tab has no chat key for yet (PRIV-2: a group member is a key this tab wants)
    persist();
    emit('group', { groupId: inv.g, event: r.conflict ? 'conflict' : 'epoch', epochId: g.current, members: g.effectiveMembers(), left: g.left });
  }

  /** Re-applies what the group's plan still lacks when the timer runs (nothing when another admin already did). */
  async function reapplyGroup(g) {
    if (!S.on || S.groups.get(g.groupId) !== g) return;
    const plan = g.reapplyPlan();
    const add = plan.add.filter((m) => !!ckFor(m));
    if (!plan.remove.length && !add.length) return;
    const rec = await rekeyAndInvite(g, { add, remove: plan.remove });
    emit('group', { groupId: g.groupId, event: 'epoch', epochId: rec.epochId, members: g.effectiveMembers(), left: g.left });
  }

  async function onRoomFrame(decoded) {
    const f = decoded.fields;
    const mode = cfgMode(cfg(), 'chat', 'off');
    if (mode === 'off') return false;
    const L = ledger();
    if (L.banned(f.author)) return false;
    if (mode === 'members' && L.role(f.author) === 'reader') return false;
    const t = now();
    const times = (S.roomBuckets.get(f.author) || []).filter((x) => t - x < ROOM_BUCKET_MS);
    if (times.length >= ROOM_BUCKET) return false;
    if (Math.abs(t - f.t) > ROOM_SKEW_MS) return false;
    // t is rounded down to the minute (STALK-12): a millisecond clock would let anyone connected fingerprint the device.
    if (f.t % ROOM_T_STEP_MS !== 0) return false;
    // A signed message is shown and relayed once (MP-13): the seen-set of the lane can be flushed, this list cannot.
    if (S.roomSeen.has(f.author + '|' + f.id)) return false;
    const ok = await verifySig(f.author, await roomSigningBytes(f), f.sig);
    if (!ok) return false;
    times.push(t);
    S.roomBuckets.set(f.author, times);
    if (S.roomBuckets.size > 10000) S.roomBuckets.delete(S.roomBuckets.keys().next().value);
    return true;
  }

  async function roomSigningBytes({ room, id, t, text }) {
    return utf8.encode(ROOM_PREFIX + d.ledgerId + '\n' + room + '\n' + id + '\n' + t + '\n' + hex.encode(await sha256(utf8.encode(text))));
  }

  /** Remembers a room message (author, id) while its t can still pass the skew check (MP-13). */
  function roomSeen(author, id) {
    const t = now();
    S.roomSeen.set(author + '|' + id, t);
    if (S.roomSeen.size > ROOM_SEEN_MAX) {
      for (const [k, at] of S.roomSeen) {
        if (t - at <= 2 * ROOM_SKEW_MS && S.roomSeen.size <= ROOM_SEEN_MAX) break;
        S.roomSeen.delete(k);
      }
    }
  }

  function onRoom({ decoded }) {
    const f = decoded.fields;
    roomSeen(f.author, f.id);
    const r = S.rooms.get(f.room);
    if (!r || !r.joined) return;
    const msg = { room: f.room, id: f.id, from: f.author, short: shortId(f.author), t: f.t, text: f.text, arrived: now() };
    r.messages.push(msg);
    if (r.messages.length > ROOM_HISTORY) r.messages.shift();
    emit('room', msg);
  }

  // -------------------------------------------------------------------------------------------
  // Who gets this tab's CK (review round, PRIV-2 and STALK-2)
  // -------------------------------------------------------------------------------------------

  /** Site keys this tab has a reason to know: accepted unblocked contacts, members of its groups, call-roster keys. */
  function wantedPubs() {
    const out = new Set();
    for (const c of S.contacts.values()) if (c.accepted && !c.blocked) out.add(c.pub);
    const mine = d.keys && d.keys.pub;
    for (const g of S.groups.values()) {
      if (g.left) continue;
      for (const m of membersOf(g)) if (m !== mine) out.add(m);
    }
    for (const p of sigListenPubs()) out.add(p);
    return out;
  }

  /** True when a site key is one this tab keeps (the CK cache never lets a stranger's CK push its CK out). */
  function knownSigner(pub) {
    if (pub === (d.keys && d.keys.pub)) return true;
    const c = S.contacts.get(pub);
    if (c && c.accepted) return true;
    return wantedPubs().has(pub);
  }

  /** True when one of the keys this tab wants has no chat key here yet: then it shows its own CK to its neighbours. */
  function lookingForCk() {
    for (const p of wantedPubs()) if (!ckFor(p)) return true;
    return false;
  }

  /**
   * The reason to send this tab's CK on a wire, or null. A neighbour learns the site key only when: it is a key this tab
   * wants (its chat key is the wire's static key); this tab is looking for a wanted key's chat key; message requests are
   * open (a stranger needs the key to write); presence is public.
   */
  function ckReason(remote) {
    if (!S.ck) return null;
    if (d.ckShare !== 'reason') return 'all';
    if (S.presence.on && S.presence.public) return 'presence';
    if (S.requestsOpen && requestsOn(cfg())) return 'requests';
    const ck = remote ? S.ckCache.forEk(remote) : null;
    if (ck && ck.ek === remote && wantedPubs().has(ck.signer)) return 'known';
    if (lookingForCk()) return 'looking';
    return null;
  }

  function sendCkTo(wire) {
    if (!S.ck || !S.lane || S.ckSent.has(wire)) return false;
    if (!S.lane.sendTo(wire, encode(T.CK, { day: headerDay(now()) }, ckBody(S.ck)))) return false;
    S.ckSent.add(wire);
    return true;
  }

  /** Sends this tab's CK to every current neighbour that has a reason to get it (after a contact, request or presence change). */
  function shareCk() {
    if (!S.on || !S.lane) return;
    for (const p of S.lane.peers()) if (ckReason(p.remote)) sendCkTo(p.id);
  }

  async function onCk({ ck, wire, remote }) {
    const res = await S.ckCache.put(ck);
    if (!res.ok) {
      // A CK of a key this copy of the ledger shows as rotated away, or one whose epoch jumps, is refused because of what this
      // device knows (an honest neighbour's copy may lag): not taken, and the wire is not struck for it.
      if (S.lane && res.reason !== 'ck-rotated' && res.reason !== 'ck-epoch-jump') S.lane.strike(wire, res.reason);
      return;
    }
    if (res.changed) emit('keychange', { pub: ck.signer, epoch: ck.epoch });
    // A CK never says who is connected (only a verified PRES does; PRIV-2). A wanted key's CK on its own wire is answered
    // with this tab's CK, so two contacts who were both waiting find each other.
    const wanted = wantedPubs().has(ck.signer);
    if (wanted && ck.ek === remote) sendCkTo(wire);
    // Awaited (the lane waits for this before it reads the wire's next frame; code review v0.3, round 2). A CK that changed
    // nothing, or one of a key the interest does not use, rebuilds nothing (MP-5, SYB-10).
    if (!res.fresh || !(wanted || S.contacts.has(ck.signer))) return;
    try { await refreshInterest(true); } catch (_) { /* keep the interest it had */ }
    if (wanted) persist(); // a contact's or member's chat key learned after it was added survives a reload (R 2.7.2)
  }

  async function onPeer({ wire, remote }) {
    if (!S.ck) return;
    if (ckReason(remote)) sendCkTo(wire);
    if (S.presence.on) sendPresTo(wire).catch(() => {});
  }

  async function onPres({ fields, wire, remote, day }) {
    const ck = S.ckCache.forEk(remote);
    if (!ck) return;
    const c = S.contacts.get(ck.signer);
    const kp = c && !c.blocked ? await kPairWith(remote) : null;
    const r = await readPres(fields, { day: fullDay(day, now()), kPair: kp, signerPub: fields.mode === 1 ? ck.signer : null });
    if (!r) return;
    if (S.book.update(ck.signer, r.status, wire)) emit('presence', { pub: ck.signer, status: r.status === 2 ? 'away' : 'online' });
  }

  async function onIchal({ fields, wire }) {
    if (!requestsOn(cfg()) || !S.requestsOpen) return;
    const proof = await inboxProof(chatKey(), fields.hepk, fields.challenge);
    S.lane.sendTo(wire, encode(T.IRESP, { day: headerDay(now()) }, irespBody({ ek: publicKeyBytes(chatKey().pub), proof })));
  }

  function onHolding({ fields, wire }) {
    // Unauthenticated: one neighbour wire counts once per message (MF-35, code review v0.3).
    const e = S.outbox.holding(hex.encode(fields.frameId), wire);
    if (e) emit('delivery', { id: e.id, to: e.to, state: 'handed', handed: e.handed, at: e.handedAt });
  }

  // -------------------------------------------------------------------------------------------
  // Presence
  // -------------------------------------------------------------------------------------------

  async function sendPresTo(wire) {
    const peer = S.lane.peers().find((p) => p.id === wire);
    if (!peer) return;
    const ck = S.ckCache.forEk(peer.remote);
    const c = ck && S.contacts.get(ck.signer);
    const kp = c && !c.blocked ? await kPairWith(peer.remote) : null;
    const status = S.presence.visible ? PRES_STATUS.online : PRES_STATUS.away;
    const f = await presFields({ day: utcDay(now()), status, kPair: kp, publicSigner: S.presence.public ? signer() : null, random: d.random });
    S.lane.sendTo(wire, encode(T.PRES, { day: headerDay(now()) }, presBody(f)));
  }

  function presenceTick() {
    if (!S.on || !S.presence.on) return;
    // Hidden tabs send one "away" and then nothing until visible again.
    const send = S.presence.visible || !S.presence.awaySent;
    if (!S.presence.visible) S.presence.awaySent = true;
    if (send) for (const p of S.lane.peers()) sendPresTo(p.id).catch(() => {});
    S.presence.timer = later(presenceTick, PRES_INTERVAL_MS);
  }

  async function wantTick() {
    if (!S.on || !S.lane) return;
    later(() => { wantTick().catch(() => {}); }, WANT_INTERVAL_MS);
    // Every tag moves with the UTC day: a long-lived tab may see no new neighbour and no CK frame for days, so the
    // interest is recomputed here (a no-op within the same day; code review v0.3).
    try { await refreshInterest(); } catch (_) { /* keep the interest it had */ }
    if (!S.on || !S.lane) return;
    const interests = [];
    for (const [k, v] of S.interest) if (v.kind !== 'inbox') interests.push({ tag: hex.decode(k), kind: v.kind === 'group' ? 'group' : 'contact' });
    if (interests.length) {
      try { S.lane.sendWant(buildWant(interests, { random: d.random })); } catch (_) { /* no neighbours */ }
    }
  }

  // -------------------------------------------------------------------------------------------
  // Groups
  // -------------------------------------------------------------------------------------------

  async function sendInvites(g, record, secret, members) {
    const s = b64url.encode(secret);
    const body = utf8.encode(JSON.stringify({ g: g.groupId, rec: record, s }));
    for (const m of members) {
      if (m === d.keys.pub) continue;
      const ck = ckFor(m);
      if (!ck) continue;
      const id = new Uint8Array(16);
      globalThis.crypto.getRandomValues(id);
      await S.outbox.add({
        id: b64url.encode(id), to: m, deliverLater: true,
        payload: { chat: ck.ek, stranger: false, message: { id, t: now(), n: nextCounter(m), kind: KIND.invite, body } },
      });
    }
  }

  async function rekeyAndInvite(g, { add = [], remove = [] }) {
    const { record, secret } = await g.rekey({ signer: signer(), add, remove });
    await sendInvites(g, record, secret, record.members);
    await refreshInterest(true);
    persist();
    return record;
  }

  function groupOf(groupId) {
    const g = S.groups.get(groupId);
    if (!g || g.left) throw fail('E_NOT_MEMBER', 'not a member of this group');
    return g;
  }

  // -------------------------------------------------------------------------------------------
  // Methods
  // -------------------------------------------------------------------------------------------

  const methods = {};
  function def(name, fn) {
    methods[name] = async (params, ctx) => {
      guardCommon(name, ctx);
      return fn(params, ctx || {});
    };
  }

  def('chat.state', async (params, ctx) => {
    // A leader tab picks chat up again after a reload when the person had turned it on (UX-14).
    if (!S.on && !(ctx && ctx.tab === 'follower')) await resume();
    return {
      state: S.on ? 'on' : 'off',
      hostOnly: hostOnlyNow(),
      peers: S.lane ? S.lane.peers().length : 0,
      lane: S.lane ? !!S.lane.laneJoined : false,
      holder: !!S.holder,
      presence: { on: S.presence.on, public: S.presence.public },
      requestsOpen: S.requestsOpen,
      requestsDropped: S.requestsDropped,
      chatKey: S.ck ? S.ck.ek : null,
      label: PRES_LABEL,
    };
  });

  def('chat.enable', async (params, ctx) => {
    needGesture(ctx);
    chatAllowed();
    if (!d.ownTracker) throw fail('E_NO_OWN_TRACKER', 'this site has not named its own tracker for messages');
    const me = signer();
    const ck = chatKey();
    if (!me || !ck) throw fail('E_NOT_SIGNED_IN', 'sign in first');
    if (S.on) return { state: 'on' };
    if (S.resuming) {
      await S.resuming;
      if (S.on) return { state: 'on' };
    }
    const p = args(params, []);
    await card('chat.enable', { ledgerCopy: p.ledgerCopy === true, tracker: d.ownTracker });
    return enableCore(p);
  });

  /**
   * UX-14: chat stays on across reloads. When the sealed store says the person turned chat on for this site (and its
   * tracker is the one the card named), chat comes back on without a card; nothing else is asked again. Leader tabs only;
   * never in host-only mode; never when the site turned chat off or this visitor may not use it.
   */
  async function resume() {
    if (S.on || S.destroyed || hostOnlyNow()) return false;
    if (S.resuming) return S.resuming;
    S.resuming = (async () => {
      try {
        if (!d.ownTracker || !signer() || !chatKey() || !d.store || typeof d.store.get !== 'function') return false;
        try { chatAllowed(); } catch (_) { return false; }
        let v;
        try { v = await d.store.get(STORE_KEY); } catch (_) { return false; }
        if (!v || v.v !== 1 || v.on !== true || v.tracker !== d.ownTracker) return false;
        if (S.on || S.destroyed || hostOnlyNow()) return S.on;
        await enableCore({});
        return true;
      } catch (_) {
        return false;
      } finally {
        S.resuming = null;
      }
    })();
    return S.resuming;
  }

  async function enableCore(p) {
    const me = signer();
    const ck = chatKey();
    const saved = await restore();
    S.ckCache = new CkCache({ ledgerId: d.ledgerId, now, rotated: (pub) => ledger().rotated(pub), known: (pub) => knownSigner(pub) });
    S.replay = new ReplayGuard({ store: d.store, now });
    await S.replay.load();
    const epoch = saved && Number.isSafeInteger(saved.ckEpoch) && saved.ckEpoch > 0 ? saved.ckEpoch : 1;
    S.ck = await makeCk({ signer: me, ledger: d.ledgerId, ek: ck.pub, epoch, now: now(), exp: now() + CK_TTL_MS });
    await S.ckCache.put(S.ck);
    // Contacts' chat keys from the sealed store, verified again and kept until exp (R 2.7.2): after a reload held
    // mail is still asked for and collected, and messages go out before the contact is a neighbour again.
    for (const rec of S.savedCks) {
      try { await S.ckCache.put(rec); } catch (_) { /* expired or broken */ }
    }
    S.savedCks = [];
    await cacheLedgerCks();
    if (p.ledgerCopy === true) {
      await card('chat.ck.ledger', { ck: S.ck });
      await ledgerCopy(d.node, S.ck, { consented: true });
    }
    // chatBits is read live by the lane (SEC-7): the site setting may change or arrive after the lane started.
    S.lane = new ChatLane({
      ledgerId: d.ledgerId, chatKey: ck, hello: { site: d.ledgerId, owner: null }, torrentManager: d.wires,
      deviceClass: d.deviceClass, policy: { shareOnNetwork: d.shareOnNetwork === true }, holder: null, ownTracker: d.ownTracker, chatBits: () => chatBits(), now,
      setTimeout: d.setTimeout, clearTimeout: d.clearTimeout, random: d.random,
    });
    S.lane.setInterest((tag, dec, via) => !!interestOf(tag, via, dec));
    S.lane.setRoomFilter((dec) => onRoomFrame(dec));
    S.lane.on('envelope', (e) => { onEnvelope(e).catch(() => {}); });
    S.lane.on('room', onRoom);
    S.lane.on('ck', (e) => onCk(e).catch(() => {})); // returned: the lane reads the next frame after it
    S.lane.on('peer', (e) => { onPeer(e).catch(() => {}); });
    S.lane.on('peer-gone', (e) => {
      S.ckSent.delete(e.wire);
      if (S.book.dropWire(e.wire)) emit('presence', { pub: null, connected: false });
    });
    S.lane.on('pres', (e) => { onPres(e).catch(() => {}); });
    S.lane.on('ichal', (e) => { onIchal(e).catch(() => {}); });
    S.lane.on('holding', onHolding);
    S.outbox = new Outbox({
      send: outboxSend, now, setTimeout: d.setTimeout, clearTimeout: d.clearTimeout,
      onState: (e) => {
        if (e.payload && e.payload.message && e.payload.message.kind !== KIND.text && e.payload.message.kind !== KIND.grant) return;
        emit('delivery', { id: e.id, to: e.to, state: e.state, handed: e.handed, at: e.handedAt });
      },
    });
    S.acks = new AckBatcher({ sendAcks, random: d.random, setTimeout: d.setTimeout, clearTimeout: d.clearTimeout });
    S.on = true;
    S.consented = true;
    // The rooms joined before a reload come back (UX-14).
    for (const name of S.savedRooms) if (!S.rooms.has(name)) S.rooms.set(name, { joined: true, messages: [] });
    S.lane.enable();
    try {
      S.unregister = registerChatWire(d.wires, S.lane);
    } catch (e) {
      S.unregister = null; // the seam is missing; the lane runs without wires until the loader adds it
    }
    await refreshInterest(true);
    later(() => { wantTick().catch(() => {}); }, WANT_INTERVAL_MS);
    if (!S.unhook) S.unhook = hookPage();
    persist();
    emit('state', { state: 'on' });
    return { state: 'on' };
  }

  async function turnOff() {
    if (!S.on) return;
    if (S.consented) S.savedRooms = Array.from(S.rooms.keys()).filter((n) => S.rooms.get(n).joined);
    S.on = false;
    try { if (S.unregister) S.unregister(); } catch (_) { /* gone */ }
    S.unregister = null;
    if (S.outbox) S.outbox.destroy();
    if (S.acks) S.acks.destroy();
    if (S.lane) S.lane.disable();
    for (const h of S.timers) clearT(h);
    S.timers.clear();
    S.replayTimer = null;
    if (S.unhook) S.unhook();
    S.unhook = null;
    S.presence.on = false;
    S.book.clear();
    if (S.replay) await S.replay.save().catch(() => {});
    await persist();
    S.lane = null;
    S.holder = null;
    S.ckSent.clear();
    emit('state', { state: 'off' });
  }

  def('chat.disable', async () => {
    // The person's own choice: chat stays off after a reload too (UX-14).
    S.consented = false;
    S.savedRooms = [];
    if (!S.on) {
      await persistConsent();
      return { state: 'off' };
    }
    await turnOff();
    return { state: 'off' };
  });

  /** Writes the consent flag when chat is already off (the rest of the stored state is left as it is). */
  async function persistConsent() {
    if (!d.store || typeof d.store.get !== 'function' || typeof d.store.set !== 'function') return;
    try {
      const v = await d.store.get(STORE_KEY);
      if (v && v.v === 1 && v.on === true) await d.store.set(STORE_KEY, Object.assign({}, v, { on: false, tracker: null, rooms: [] }));
    } catch (_) { /* storage may be full or evicted */ }
  }

  def('chat.presence.set', async (params, ctx) => {
    needOn();
    const p = args(params, ['on']);
    const on = p.on === true;
    const pub = on && p.public === true;
    if (pub) {
      needGesture(ctx);
      await card('chat.presence.public', { text: 'Everyone who can reach you on this site will see which name is online, and from which address.' });
    }
    S.presence.on = on;
    S.presence.public = pub;
    if (S.presence.timer) clearT(S.presence.timer);
    S.presence.timer = null;
    if (on) presenceTick();
    if (pub) shareCk(); // public presence shows the key to everyone who can reach you (its card says so)
    return { on, public: pub };
  });

  def('chat.presence.list', async () => {
    if (!S.on) return [];
    return S.book.list().map((e) => ({ pub: e.pub, status: e.status, since: e.since }));
  });

  def('chat.contacts.list', async (params, ctx) => {
    if (!S.gesture.contacts) {
      needGesture(ctx);
      await card('chat.contacts.list', {});
      S.gesture.contacts = true;
    }
    return Array.from(S.contacts.values()).filter((c) => c.accepted || c.blocked).map((c) => ({
      pub: c.pub, nick: c.nick || '', blocked: !!c.blocked, verified: !!c.verified, hasChatKey: !!ckFor(c.pub),
    }));
  });

  def('chat.contacts.add', async (params) => {
    needOn();
    const p = args(params, ['pub']);
    const pub = needPub(p.pub);
    const nick = typeof p.nick === 'string' ? p.nick.slice(0, 48) : '';
    const c = Object.assign(S.contacts.get(pub) || { pub }, { nick, accepted: true, blocked: false });
    S.contacts.set(pub, c);
    await refreshInterest(true);
    shareCk(); // looking for this contact's chat key, or the contact is a neighbour already
    persist();
    return { pub, nick, hasChatKey: !!ckFor(pub) };
  });

  def('chat.contacts.remove', async (params) => {
    needOn();
    const pub = needPub(args(params, ['pub']).pub);
    S.contacts.delete(pub);
    await refreshInterest(true);
    persist();
    return { removed: true };
  });

  def('chat.contacts.block', async (params) => {
    needOn();
    const pub = needPub(args(params, ['pub']).pub);
    S.contacts.set(pub, Object.assign(S.contacts.get(pub) || { pub }, { blocked: true }));
    for (const [id, r] of S.requests) if (r.from === pub) S.requests.delete(id);
    await refreshInterest(true);
    persist();
    return { blocked: true };
  });

  def('chat.contacts.unblock', async (params) => {
    needOn();
    const pub = needPub(args(params, ['pub']).pub);
    const c = S.contacts.get(pub);
    if (c) c.blocked = false;
    await refreshInterest(true);
    persist();
    return { blocked: false };
  });

  def('chat.contacts.verify', async (params) => {
    needOn();
    const pub = needPub(args(params, ['pub']).pub);
    const ck = ckFor(pub);
    if (!ck) throw fail('E_NO_CHAT_KEY', 'this person has not turned on messages on this site');
    const kp = await kPairWith(ck.ek);
    const m = await hmac(kp, 'verify|' + d.ledgerId);
    const n = (((m[0] << 24) >>> 0) + (m[1] << 16) + (m[2] << 8) + m[3]) % 100000000;
    return { code: String(n).padStart(8, '0') };
  });

  def('chat.requests.list', async () => {
    if (!S.on) return [];
    return Array.from(S.requests.values()).map((r) => ({ id: r.id, from: r.from, t: r.t, size: r.size }));
  });

  def('chat.requests.accept', async (params) => {
    needOn();
    const id = args(params, ['id']).id;
    const r = S.requests.get(id);
    if (!r) throw fail('E_BAD_REQUEST', 'no such request');
    S.requests.delete(id);
    S.contacts.set(r.from, Object.assign(S.contacts.get(r.from) || { pub: r.from }, { accepted: true, blocked: false }));
    await refreshInterest(true);
    const m = r.message;
    const text = m.kind === KIND.text ? utf8.decode(m.body) : null;
    const msg = { id: r.id, from: r.from, dir: 'in', t: m.t, n: m.n, text, grant: null, gap: false };
    remember(r.from, msg);
    emit('message', msg);
    persist();
    return { accepted: true, pub: r.from };
  });

  /** decline({ id }) one request; decline({ from: pub }) every request of that key; decline({ all: true }) every one (SYB-14). */
  def('chat.requests.decline', async (params) => {
    needOn();
    const p = args(params, ['id']);
    if (p.all === true) {
      const n = S.requests.size;
      S.requests.clear();
      return { declined: n > 0, count: n };
    }
    if (p.from !== undefined) {
      const from = needPub(p.from);
      let n = 0;
      for (const [id, r] of S.requests) if (r.from === from) { S.requests.delete(id); n++; }
      return { declined: n > 0, count: n };
    }
    return { declined: S.requests.delete(p.id) };
  });

  def('chat.requests.setOpen', async (params, ctx) => {
    needGesture(ctx);
    needOn();
    const p = args(params, ['open']);
    const open = p.open === true || p.on === true;
    if (open && !requestsOn(cfg())) throw fail('E_POLICY', 'this site does not take message requests');
    await card('chat.requests.open', { open });
    S.requestsOpen = open;
    if (open) shareCk(); // strangers need the chat key to write
    persist();
    return { open };
  });

  def('chat.dm.send', async (params, ctx) => {
    needOn();
    chatAllowed();
    const p = args(params, ['pub']);
    const pub = needPub(p.pub);
    if (ledger().syncing()) throw fail('E_SYNCING', 'this site is still catching up; try again in a moment');
    const c = S.contacts.get(pub);
    if (c && c.blocked) throw fail('E_BLOCKED', 'you blocked this person');
    let kind;
    let body;
    if (p.grant !== undefined) {
      kind = KIND.grant;
      body = utf8.encode(JSON.stringify(p.grant));
    } else {
      kind = KIND.text;
      body = utf8.encode(textOf(p.text, TEXT_MAX));
    }
    const t = now();
    S.sent = S.sent.filter((x) => t - x < 60000);
    if (S.sent.length >= DM_PER_MIN) throw fail('E_RATE', 'too many messages; wait a moment');
    const ck = ckFor(pub);
    if (!ck) throw fail('E_NO_CHAT_KEY', 'this person has not turned on messages on this site');
    const stranger = !(c && c.accepted);
    if (stranger && !requestsOn(cfg())) throw fail('E_POLICY', 'this site does not take message requests; add this person as a contact first');
    const id = new Uint8Array(16);
    globalThis.crypto.getRandomValues(id);
    const idStr = b64url.encode(id);
    const message = { id, t, n: stranger ? 0 : nextCounter(pub), kind, body };
    const probe = { payload: { chat: ck.ek, stranger, message } };
    try {
      await sealFor(probe); // size check before anything leaves (E_LIMIT)
    } catch (e) {
      throw fail(e && e.code === 'E_LIMIT' ? 'E_LIMIT' : 'E_BAD_REQUEST', 'message too long');
    }
    S.sent.push(t);
    let entry;
    try {
      entry = await S.outbox.add({ id: idStr, to: pub, stranger, deliverLater: p.deliverLater === true, payload: probe.payload });
    } catch (e) {
      if (e && e.code) throw fail(e.code, e.message);
      throw e;
    }
    remember(pub, { id: idStr, from: d.keys.pub, to: pub, dir: 'out', t, n: message.n, text: kind === KIND.text ? p.text : null, grant: kind === KIND.grant ? p.grant : null });
    persist();
    return { id: idStr, state: entry.state };
  });

  def('chat.dm.history', async (params, ctx) => {
    if (!S.gesture.history) {
      needGesture(ctx);
      await card('chat.dm.history', {});
      S.gesture.history = true;
    }
    const p = args(params, ['pub']);
    const pub = needPub(p.pub);
    let h = (S.history.get(pub) || []).slice();
    if (Number.isSafeInteger(p.before)) h = h.filter((m) => m.t < p.before);
    h.sort((a, b) => a.t - b.t || (a.n || 0) - (b.n || 0) || (a.id < b.id ? -1 : 1));
    const limit = Number.isSafeInteger(p.limit) && p.limit > 0 ? Math.min(p.limit, HISTORY_MAX) : 50;
    return h.slice(-limit);
  });

  def('chat.dm.keepHistory', async (params) => {
    needOn();
    const p = args(params, ['pub', 'on']);
    const pub = needPub(p.pub);
    const on = p.on === true || p.keep === true;
    S.contacts.set(pub, Object.assign(S.contacts.get(pub) || { pub }, { keepHistory: on }));
    persist();
    return { keepHistory: on };
  });

  function roomName(p) {
    const name = p.name === undefined ? 'Lobby' : p.name;
    if (typeof name !== 'string' || name.length === 0 || name.length > ROOM_NAME_MAX || /[\u0000-\u001f]/.test(name)) {
      throw fail('E_BAD_REQUEST', 'room names are 1 to ' + ROOM_NAME_MAX + ' characters');
    }
    return name;
  }

  def('chat.room.join', async (params) => {
    needOn();
    chatAllowed();
    const name = roomName(args(params, ['name']));
    const me = signer();
    if (ledger().banned(me.pub)) throw fail('E_BANNED', 'you are banned on this site');
    if (!S.rooms.has(name)) S.rooms.set(name, { joined: true, messages: [] });
    S.rooms.get(name).joined = true;
    persist(); // joined rooms come back after a reload (UX-14)
    return { name, joined: true, label: 'Public and signed. Anyone connected can read this, and a recording proves what you wrote.' };
  });

  def('chat.room.leave', async (params) => {
    needOn();
    const name = roomName(args(params, ['name']));
    S.rooms.delete(name);
    persist();
    return { name, joined: false };
  });

  def('chat.room.send', async (params) => {
    needOn();
    chatAllowed();
    const p = args(params, ['name']);
    const name = roomName(p);
    const text = textOf(p.text, ROOM_TEXT_MAX);
    const me = signer();
    if (ledger().banned(me.pub)) throw fail('E_BANNED', 'you are banned on this site');
    const room = S.rooms.get(name);
    if (!room || !room.joined) throw fail('E_POLICY', 'join the room first');
    const now0 = now();
    const times = (S.roomBuckets.get(me.pub) || []).filter((x) => now0 - x < ROOM_BUCKET_MS);
    if (times.length >= ROOM_BUCKET) throw fail('E_RATE', 'too many messages; wait a moment');
    // The signed t is rounded down to the minute (STALK-12); the list shows messages by arrival anyway (R 2.7.4).
    const t = Math.floor(now0 / ROOM_T_STEP_MS) * ROOM_T_STEP_MS;
    const idBytes = new Uint8Array(16);
    globalThis.crypto.getRandomValues(idBytes);
    const id = b64url.encode(idBytes);
    const sig = b64url.encode(await me.sign(await roomSigningBytes({ room: name, id, t, text })));
    let frame;
    try {
      frame = await S.lane.stamped(T.ROOM, { body: roomBody({ room: name, id, t, text, author: me.pub, sig }) });
    } catch (e) {
      throw fail('E_STAMP', 'could not finish the anti-spam stamp');
    }
    times.push(now0);
    S.roomBuckets.set(me.pub, times);
    roomSeen(me.pub, id);
    const r = S.lane.send(frame, {});
    const msg = { room: name, id, from: me.pub, short: shortId(me.pub), t, text, arrived: now0 };
    room.messages.push(msg);
    if (room.messages.length > ROOM_HISTORY) room.messages.shift();
    return { id, reached: r.reached };
  });

  def('chat.group.create', async (params) => {
    needOn();
    chatAllowed();
    const p = args(params, []);
    const members = Array.isArray(p.members) ? p.members.map(needPub) : [];
    const me = signer();
    const others = Array.from(new Set(members.filter((m) => m !== me.pub)));
    if (others.length + 1 > GROUP_MAX) throw fail('E_LIMIT', 'a group has at most ' + GROUP_MAX + ' members');
    for (const m of others) {
      const c = S.contacts.get(m);
      if (c && c.blocked) throw fail('E_BLOCKED', 'you blocked a member');
      if (!ckFor(m)) throw fail('E_NO_CHAT_KEY', 'a member has not turned on messages on this site');
    }
    let created;
    try {
      created = await GroupState.create({ ledgerId: d.ledgerId, name: typeof p.name === 'string' ? p.name : '', creator: me, members: others, now });
    } catch (e) {
      throw fail(e.code || 'E_BAD_REQUEST', e.message);
    }
    S.groups.set(created.state.groupId, created.state);
    await sendInvites(created.state, created.record, created.secret, created.record.members);
    await refreshInterest(true);
    persist();
    return { groupId: created.state.groupId, epochId: created.state.current, members: created.state.members() };
  });

  def('chat.group.invite', async (params) => {
    needOn();
    const p = args(params, ['groupId', 'pub']);
    const g = groupOf(p.groupId);
    const pub = needPub(p.pub);
    if (!g.isAdmin(d.keys.pub)) throw fail('E_NOT_ADMIN', 'only an admin of the group can add people');
    if (g.members().length >= GROUP_MAX && g.members().indexOf(pub) < 0) throw fail('E_LIMIT', 'a group has at most ' + GROUP_MAX + ' members');
    if (!ckFor(pub)) throw fail('E_NO_CHAT_KEY', 'this person has not turned on messages on this site');
    const rec = await rekeyAndInvite(g, { add: [pub] });
    return { groupId: g.groupId, epochId: rec.epochId, members: rec.members };
  });

  def('chat.group.remove', async (params) => {
    needOn();
    const p = args(params, ['groupId', 'pub']);
    const g = groupOf(p.groupId);
    const pub = needPub(p.pub);
    if (!g.isAdmin(d.keys.pub)) throw fail('E_NOT_ADMIN', 'only an admin of the group can remove people');
    if (g.members().indexOf(pub) < 0) throw fail('E_NOT_MEMBER', 'not a member of this group');
    const rec = await rekeyAndInvite(g, { remove: [pub] });
    return { groupId: g.groupId, epochId: rec.epochId, members: rec.members };
  });

  def('chat.group.leave', async (params) => {
    needOn();
    const p = args(params, ['groupId']);
    groupOf(p.groupId);
    S.groups.delete(p.groupId);
    await refreshInterest(true);
    persist();
    return { left: true };
  });

  def('chat.group.send', async (params) => {
    needOn();
    chatAllowed();
    const p = args(params, ['groupId']);
    const g = groupOf(p.groupId);
    const text = textOf(p.text, TEXT_MAX);
    const r = g.record();
    const secret = g.secretFor(r.epochId);
    if (!secret || g.effectiveMembers().indexOf(d.keys.pub) < 0) throw fail('E_NOT_MEMBER', 'not a member of this group');
    const t = now();
    const sealed = await sealGroup({
      groupSecret: secret, ledgerId: d.ledgerId, groupId: g.groupId, epochId: hex.decode(r.epochId), day: utcDay(t),
      sender: signer(), message: { t, n: nextCounter('g|' + g.groupId), kind: KIND.group, body: utf8.encode(text) },
    });
    let frame;
    try {
      frame = await S.lane.stamped(T.ENV, { body: envBody(sealed) });
    } catch (e) {
      throw fail('E_STAMP', 'could not finish the anti-spam stamp');
    }
    const out = S.lane.send(frame, { tag: sealed.tag });
    return { id: b64url.encode(sealed.id), state: out.reached > 0 ? 'sent-unknown' : 'not-delivered' };
  });

  def('chat.holder.set', async (params, ctx) => {
    needGesture(ctx);
    needOn();
    if (isPhone()) throw fail('E_POLICY', 'phones do not hold messages for others');
    const on = args(params, ['on']).on === true;
    if (on) {
      await card('chat.holder', { quota: '4 MiB, 7 days' });
      if (!S.holder) S.holder = new Holder({ now });
    } else if (S.holder) {
      S.holder.clear();
      S.holder = null;
    }
    S.lane.holder = S.holder;
    return { on: !!S.holder };
  });

  def('chat.direct.connect', async (params, ctx) => {
    needGesture(ctx);
    needOn();
    needPub(args(params, ['pub']).pub);
    if (!callsOn()) throw fail('E_POLICY', 'this site has calls turned off');
    // Direct data channels stay P2 (R 2.7.8); calls (mw.calls, SZ 3.5) are the one RTCPeerConnection path.
    throw fail('E_UNSUPPORTED', 'direct data channels are not available in this version; calls are (mw.calls)');
  });

  // -------------------------------------------------------------------------------------------
  // C2 calls: the SIG seam (src/calls/service.js; docs/deviations/calls.md)
  // -------------------------------------------------------------------------------------------

  async function sigSend(pub, payload, opts = {}) {
    if (S.destroyed) throw fail('E_POLICY', 'chat service destroyed');
    if (hostOnlyNow()) throw fail('E_HOST_ONLY', 'chat needs peers; this site is open in host-only mode');
    if (!S.on || !S.lane) throw fail('E_POLICY', 'turn on messages first (mw.chat.enable)');
    needPub(pub);
    let body;
    if (payload instanceof Uint8Array) body = payload;
    else if (typeof payload === 'string') body = utf8.encode(payload);
    else throw fail('E_BAD_REQUEST', 'a SIG payload is bytes or a string');
    if (body.length === 0 || body.length > SIG_BODY_MAX) throw fail('E_LIMIT', 'a SIG payload is 1 to ' + SIG_BODY_MAX + ' bytes');
    const c = S.contacts.get(pub);
    if (c && c.blocked) throw fail('E_BLOCKED', 'you blocked this person');
    const group = opts && typeof opts.group === 'string' ? opts.group : null;
    const allowed = (c && c.accepted) || sigListenPubs().has(pub) || (group !== null && callsOn() && groupsWith(pub).indexOf(group) >= 0);
    if (!allowed) throw fail('E_NOT_CONTACT', 'SIG goes to contacts, call rosters and members of a shared group only');
    const ck = ckFor(pub);
    if (!ck) throw fail('E_NO_CHAT_KEY', 'this person has not turned on messages on this site');
    const t = now();
    const id = new Uint8Array(16);
    globalThis.crypto.getRandomValues(id);
    const message = { id, t, n: nextCounter('sig|' + pub), kind: KIND.sig, body };
    let sealed;
    try {
      sealed = await sealDm({ myChat: chatKey(), theirChatPub: ck.ek, ledgerId: d.ledgerId, day: utcDay(t), message, directional: true });
    } catch (e) {
      throw fail(e && e.code === 'E_LIMIT' ? 'E_LIMIT' : 'E_BAD_REQUEST', 'SIG payload too long');
    }
    let frame;
    try {
      frame = await S.lane.stamped(T.SIG, { flags: 0, bits: STAMP_BITS_CONTACT, body: envBody(sealed) });
    } catch (e) {
      throw fail('E_STAMP', 'could not finish the anti-spam stamp');
    }
    if (!S.on || !S.lane) throw fail('E_POLICY', 'messages were turned off');
    const r = S.lane.send(frame, { to: ck.ek, tag: sealed.tag });
    return { reached: r.reached, route: r.route, bucket: sealed.bucket };
  }

  function sigListen(pubs, untilMs) {
    const mine = d.keys && d.keys.pub;
    const list = (Array.isArray(pubs) ? pubs : [pubs]).filter((p) => isPublicKeyString(p) && p !== mine).slice(0, SIG_LISTEN_PUBS_MAX);
    const t = now();
    const cap = t + SIG_LISTEN_MAX_MS;
    const until = Number.isFinite(untilMs) && untilMs > t ? Math.min(untilMs, cap) : cap;
    const id = ++S.listenSeq;
    S.listens.set(id, { pubs: new Set(list), until });
    refreshInterest(true).catch(() => {});
    shareCk(); // a roster key whose chat key this tab lacks: show ours so it can answer
    const h = later(() => {
      S.listens.delete(id);
      refreshInterest(true).catch(() => {});
    }, until - t);
    let stopped = false;
    return () => {
      if (stopped) return;
      stopped = true;
      S.listens.delete(id);
      clearT(h);
      S.timers.delete(h);
      refreshInterest(true).catch(() => {});
    };
  }

  function heldGroupMembers(groupId) {
    const g = groupOf(groupId);
    const mine = d.keys && typeof d.keys.pub === 'string' ? d.keys.pub : null;
    return membersOf(g).filter((m) => m !== mine);
  }

  const sig = Object.freeze({
    send: sigSend,
    onReceive(fn) {
      if (typeof fn !== 'function') throw new TypeError('sig.onReceive needs a function');
      S.sigListeners.add(fn);
      refreshInterest(true).catch(() => {});
      return () => { S.sigListeners.delete(fn); };
    },
    listen: sigListen,
    contact(pub) {
      const c = S.contacts.get(pub);
      if (!c) return null;
      return { pub: c.pub, nick: c.nick || '', accepted: !!c.accepted, blocked: !!c.blocked, verified: !!c.verified, hasChatKey: !!ckFor(c.pub) };
    },
    groupMembers: heldGroupMembers,
    state() {
      return { on: S.on, calls: callsOn() };
    },
    ckOf(pub) {
      const ck = ckFor(pub);
      return ck ? Object.assign({}, ck) : null;
    },
    async learn(ck) {
      if (!S.ckCache) return false;
      let r;
      try { r = await S.ckCache.put(ck); } catch (_) { return false; }
      if (r && r.ok) refreshInterest(true).catch(() => {});
      return !!(r && r.ok);
    },
  });

  for (const n of CHAT_METHODS) if (!methods[n]) throw new Error('chat service: missing method ' + n);

  return {
    methods,
    on(event, fn) {
      if (CHAT_EVENTS.indexOf(event) < 0) throw new TypeError('unknown chat event ' + event);
      if (!listeners.has(event)) listeners.set(event, new Set());
      listeners.get(event).add(fn);
      return () => listeners.get(event).delete(fn);
    },
    /** Visibility from the loader (presence says "away" while hidden; nothing goes out from hidden tabs). */
    setVisible(visible) {
      S.presence.visible = !!visible;
      if (visible) S.presence.awaySent = false;
    },
    /**
     * groupMembers(groupId) -> [site pub]: the members of a group this tab belongs to, without this tab's own key
     * (media.share({ to: groupId }) and files sharing to a group, R 2.9.7; v0.3 reconciliation). E_NOT_MEMBER for a
     * group this tab does not hold.
     */
    groupMembers(groupId) {
      return heldGroupMembers(groupId);
    },
    /** C2 calls: the SIG seam for src/calls/service.js (loader only; see the header). */
    sig,
    /**
     * resume() -> Promise<boolean>: turns chat back on without a card when the sealed store says the person turned it on for
     * this site and tracker (UX-14). The loader may call it once the working keys are there; chat.state calls it too.
     */
    resume,
    /** Test and diagnostics hook: the running lane (null when off). */
    get lane() {
      return S.lane;
    },
    async destroy() {
      await turnOff();
      S.destroyed = true;
      listeners.clear();
      S.sigListeners.clear();
      S.listens.clear();
    },
  };
}
