// src/loader/apps.js: the service of the apps on the door page (ARCHITECTURE 15.21): direct messages by code and rooms by code.
//
//   createApps({ api, config, loadTm, lang, now, random, randomBytes, setTimeoutFn, clearTimeoutFn, limits, createLink, link,
//                WebSocketImpl, report, linkOptions, onVisible, onOnline }) -> apps
//     api      { identity: { info() -> { pub, short, name } | null, keys() -> WorkingKeys | null, onChange(fn) } } (A.api)
//     config   the door's apps block { rendezvous: [wss URL], stun: [...], idp, relay, direct }; the first rendezvous is the pair socket.
//              relay 'rendezvous' (the default) | 'none' and direct 'off' | 'on': after an accept both people join a relay lane on the pair
//              socket and every sealed frame goes through the rendezvous, which carries it and cannot open it; the direct link (WebRTC, which
//              shows each side the other's address) is made only when direct is 'on' and is then preferred. Absent, direct is 'off' beside
//              the relay and 'on' without it, so relay 'none' alone is the transport of before the relay existed. state().cfg shows them.
//     loadTm   () -> Promise<TorrentManager>, called once, at the first accept and only when direct is 'on' (nothing joins a lane before
//              approval, and with direct off no manager is made and no peer connection exists)
//     lang     kept for the UI (this service shows no text of its own); now, random, timers: injected clocks for tests
//     onVisible, onOnline   (fn) -> off: the page's visibility and network events, each calls link.connect() (a socket that went away while
//              the tab slept is opened again at once); tests pass fakes, the page passes nothing and the service listens through globalThis
//     report   (name, fields), optional: usage reports (docs/OBSERVABILITY.md; the page adds a prefix to every name). The service names
//              code, knock, request, conv, wire, lane, msg, room and notice, one report per transition. A field is a short word, a count,
//              a boolean, the local id of a conversation or a room, or the 4-character channel of a code; never a text, a name, a
//              nickname, a key, a box, a proof, a knock token, a lane or the secret half of a code. A field without a value is left out,
//              and a report that throws is ignored.
//     linkOptions  more options for the pair socket this service makes (the page passes { report } for the socket's own reports)
//
// Nothing leaves the device until the person acts: createApps opens no socket and loads no manager. openCode / createRoom /
// knock / joinRoom open the pair socket (the UI shows the price first); only accept (and the requester's side of an accepted
// knock) joins the private lane (the relay lane at the rendezvous and, with direct on, the lane of the torrent manager, which is
// loaded then), so the first frame, the first offer and the first network address move after approval. After that the two talk
// over mw_apps1 (apps-crypto.js frames): every message is sealed with the project's deniable direct-message box under K_pair of the
// two chat keys; rooms use the group box under one room secret that the owner seals to each accepted member. A frame goes out by
// _put on the best path that is ready: a direct wire first, else the relay (the rendezvous sees when and how much, never what).
// Nothing is stored at a door: state lives in memory for the visit (exportJson gives a file).
//
// state() -> {
//   signedIn, me: { pub, short, name } | null, ready, link: 'connecting' | 'open' | 'closed', tm (manager loaded), notice,
//   cfg: { relay: 'rendezvous' | 'none', direct: 'off' | 'on' } (the door's tokens as resolved above),
//   code: 'xxxx-xxxx-xxxx' | null, conversations: [conversation], rooms: [room], requests: [request], snippets: [{ id, text }],
//   blocked: [pub] }
//   conversation { id, peer: { pub, short, name, nick }, status: 'waiting' | 'connecting' | 'connected' | 'rejected' | 'left' |
//     'blocked', reason, silent, knock, code, incoming, connectedAt, lastSeenAt, unread, markedUnread, muted, pinned, archived,
//     favorite, hidden, cfg: { exp, receipts, typing }, peerCfg: { exp, receipts }, compare, compareText, draft, note, typingPeer,
//     via: 'direct' | 'relay' | null (the path a frame would take now), lastT, pending, messages: [message] }
//   message { id, t, mine, text, fmt, reply, status: 'queued' | 'sent' | 'delivered' | 'read' | 'failed' | null, readAt, edits:
//     [{ t, text }] (earlier texts, oldest first), editedAt, deleted, reactions: { emoji: [pub] }, pinned, saved, important, prio,
//     exp, expAt, sendAt, scheduled }
//   room { id, owner, status: 'waiting' | 'open' | 'connecting' | 'connected' | 'rejected' | 'closed', reason, silent, knock,
//     code, codeClosed, ownerPub, members: [{ pub, short, name, you, owner }], messages: [{ id, t, mine, from: { pub, short,
//     name }, text, fmt, status: 'queued' | 'sent' | null }], unread, draft, peers, via }
//   request { knock, kind: 'pair' | 'room', roomId, from: { pub, short, name }, at }
//   reason, on a conversation or a room, is a word of this file; 'no-path' says the door's rendezvous refused the only path for good (its
//     relay is off, or it is from before the relay) and no direct link is tried, so nothing would ever connect (DECISIONS DEC-5); it is
//     cleared when a join works again. A full lane is not a reason: its join is asked again (DEC-1).
// Calls return Promises that resolve to a result or { error: <one of ERRORS> } and never reject (the names in docs/INTERFACES.md
// are kept; a few are added). The synchronous ones are marked (sync).
//   code      openCode() -> { code }   newCode() -> { code }   closeCode() -> { ok }
//   pairing   knock(codeText) -> { knock, id }   cancelKnock(knock | id)   accept(knock) -> { id }   reject(knock)
//   messages  send(convId, text, { reply, exp, prio, at }) -> { id }   resend / retry(convId, id)   cancelSend(convId, id)
//             edit(convId, id, text)   remove(convId, id, { both })   react(convId, id, emoji | null)   markRead / markUnread(convId)
//             typing(convId, on)   setCfg(convId, { exp, receipts, typing })   setNickname(convId, name)   setFlags / setFlag
//             setMessageFlag(convId, id, 'pinned' | 'saved' | 'important', on)   verifyCode(convId) -> { code }
//   people    block(pub)   unblock(pub)
//   history   clear(convId)   leave(convId)   search(convId, query) (sync)   exportJson(convId) (sync: the JSON text)
//             exportData(convId) (sync: { fileName, mime, text, data })   setDraft / setNote(convId, text) (sync)
//             addSnippet(text) / removeSnippet(id) (sync)
//   rooms     createRoom() -> { id, code }   joinRoom(codeText) -> { knock, id }   acceptMember / rejectMember(knock)
//             sendRoom(roomId, text) -> { id }   leaveRoom(roomId)   markRoomRead(roomId)
//   state() (sync)   onChange(fn) -> off (sync)   destroy() (sync)
// A text must fit one frame: 3,500 characters at most (apps-format.js TEXT_MAX) and, sealed, 4,064 bytes of JSON (3,989 plain
// letters; about 2,000 Persian letters, so a long text in such a script can still answer 'too long'); a room message 2,000
// characters and 3,935 bytes. Longer texts resolve to { error: 'too long' } (nothing is cut).
//
// Shared code: no DOM access, no Buffer, no node: imports.

import { b64url } from '../chain/canonical.js'
import { secureRandom } from '../chat/tags.js'
import {
  EXT_NAME, T, FRAME_MAX, NAME_MAX, DM_BODY_MAX, ROOM_BODY_MAX, HELLO_SKEW_MS,
  randomBytes, randomId, shortIdOf, kPairOf, compareCode, formatCompare, formatCode, splitCode, generateCode, codeKey,
  sealHello, openHello, signAccept, verifyAccept, encodeFrame, decodeFrame, sealDmBody, openDmBody, dmBodySize, roomBodySize,
  sealRoomKey, openRoomKey, sealRoster, openRoster, ROSTER_MAX, sealGroupBody, openGroupBody, envFromWire
} from './apps-crypto.js'
import { createLink, reportWord as word, reasonWord, KEEPALIVE_MS } from './apps-link.js'
import { sanitizeText, isEmoji, searchMessages, exportConversation, exportFileName, TEXT_MAX, ROOM_TEXT_MAX } from './apps-format.js'

const MS_DAY = 86400000
const LANE_RE = /^[0-9a-f]{40}$/
const ID_RE = /^[A-Za-z0-9_-]{16}$/
const MAX_TIMER_MS = 2147483647

/**
 * The error codes a call can resolve to ({ error }). They read like the rendezvous' failure reasons ('unknown code', 'too many
 * requests'), so the UI can show them or map them to its own strings.
 */
export const ERRORS = Object.freeze([
  'not signed in', 'not ready', 'no rendezvous', 'link down', 'bad code', 'own code', 'already knocked', 'rate limited',
  'unknown code', 'channel taken', 'too many codes', 'too many requests', 'box invalid', 'no conversation', 'no room',
  'no message', 'no request', 'waiting', 'rejected', 'left', 'blocked', 'empty', 'too long', 'too far', 'not yours',
  'not scheduled', 'no manager', 'manager busy', 'room full', 'too many rooms', 'no key', 'bad lane', 'bad input', 'pairing off', 'failed'
])
const ERROR_SET = new Set(ERRORS)

/** Every limit of the service in one place (the plan's numbers; tests shorten the times through createApps({ limits })). */
export const LIMITS = Object.freeze({
  textMax: TEXT_MAX,
  roomTextMax: ROOM_TEXT_MAX,
  convMessagesMax: 5000,
  roomMessagesMax: 2000,
  sendPerMin: 60, // frames a lane may send a minute (acks and typing marks are exempt)
  acceptPerMin: 120, // frames a lane accepts a minute
  ackTimeoutMs: 20000, // a message without an ack after this long is 'failed' (and retried on the next wire)
  typingSendMs: 3000, // at most one typing mark every 3 seconds
  typingShowMs: 6000, // a typing mark lasts this long
  knockPerMin: 10,
  knocksOutMax: 8, // the rendezvous allows a socket 8 pending knocks
  badKnocksMax: 5, // unopenable knocks before the owner closes the code
  requestTtlMs: 600000, // a knock pends for 10 minutes at the rendezvous
  frameFutureMs: 600000,
  framePastMs: 7 * MS_DAY,
  strikesMax: 3, // garbage frames before a wire is closed
  floodMax: 100, // frames over the accept rate before a wire is closed
  wiresPerPair: 4,
  wiresPerRoom: 24,
  wiresSilentMax: 8, // wires of a lane that have not yet said they speak mw_apps1 (the oldest is closed past this)
  wireSilentMs: 30000, // a wire whose peer has not advertised mw_apps1 by then is closed (ADV-4)
  editsMax: 20, // earlier texts kept per message; the oldest go first (ADV-5)
  roomsOwnedMax: 4,
  roomMembersMax: 16,
  scheduleMaxMs: 7 * MS_DAY,
  expMinMs: 1000,
  expRecvMinMs: 10000, // a timer the other person sets on what they write counts at least this long (the page's smallest choice)
  expMaxMs: 30 * MS_DAY,
  cfgSkewMs: 300000, // a settings frame whose time is further than this from the clock is dropped (ADV-2)
  blockedRejectDelayMs: Object.freeze([3000, 12000]),
  reknockMax: 3,
  reknockDelayMs: 3000, // the owner may be reconnecting too: a knock that finds no code is made again after this long
  seenMax: 8192,
  pendingGroupMax: 32,
  pendingGroupMs: 30000,
  roomAcceptPerMin: 600, // a room lane also carries relayed copies
  relayLanesMax: 8, // lanes one socket may hold at the rendezvous (plan 3.1); the rest are joined when one ends
  byeGraceMs: 200 // how long a goodbye is given to leave the wire before the lane is left
})

function noop () {}

// The relay st's wire (plan 3.6): the three members the code asks of a wire, none of which does anything. A frame for the relay goes through
// _put to the rendezvous, never through this object.
const RELAY_WIRE = Object.freeze({ destroyed: false, extended () {}, destroy () {} })

// What a failure of the relay lane is called in a report (apps.lane { ev }): words of this file, never the rendezvous' own text. A socket that
// holds its 8 lanes is 'full' like a lane that holds its members; the minute and the message caps are 'rate'. 'invalid action' as the answer
// to a join is a rendezvous from before the relay existed: the relay is off there (DECISIONS DEC-1).
const LANE_FAIL = Object.freeze({
  'invalid-lane': 'invalid', 'unknown-lane': 'unknown', 'lane-full': 'full', 'too-many-lanes': 'full', 'relay-is-off-on-this-rendezvous': 'off',
  'invalid-action': 'off', 'relay-is-busy': 'busy', 'too-many-relays': 'rate', 'too-many-messages': 'rate'
})

// A join refused with 'lane full' is not final (DEC-1): the member in the way may be a socket the rendezvous has not found dead yet (a phone
// that changed networks leaves one behind), which it evicts on a later join once that socket is stale. The join is asked again after these
// waits, the last one again and again, while the conversation or room exists and the socket is open. The relay being off is final (DEC-5).
const FULL_RETRY_MS = Object.freeze([3000, 10000, 30000, 60000])

// The refusals that mean the rendezvous carries no messages at all: its switch is off, or it is from before the relay (DEC-1, DEC-5)
const isRelayOff = (reason) => reason === 'relay-is-off-on-this-rendezvous' || reason === 'invalid-action'

// The page's own events (amendment A3). The service takes deps.onVisible(fn) -> off and deps.onOnline(fn) -> off so that tests fake them, and
// without them it listens itself, through globalThis and guarded by typeof, so that Node never throws. The two functions name the page's
// document and the DOM event of the network coming back plainly (DECISIONS DEC-4: the code says what it does); the wording scan of
// test/unit/loader-apps.test.mjs, which bans that event's name as presence wording and the document as DOM access everywhere else in this
// file, cuts these two functions out as its one documented exception.

function pageVisible (fn) {
  if (typeof globalThis === 'undefined' || typeof globalThis.document !== 'object' || !globalThis.document) return noop
  if (typeof globalThis.document.addEventListener !== 'function') return noop
  const h = () => { if (globalThis.document.visibilityState === 'visible') fn() }
  globalThis.document.addEventListener('visibilitychange', h)
  return () => { try { globalThis.document.removeEventListener('visibilitychange', h) } catch (_) { /* gone */ } }
}

function pageBack (fn) {
  if (typeof globalThis === 'undefined' || typeof globalThis.addEventListener !== 'function') return noop
  globalThis.addEventListener('online', fn)
  return () => { try { globalThis.removeEventListener('online', fn) } catch (_) { /* gone */ } }
}

// How the opening of this person's code is told in a report: 'opened' (asked for, or after the socket came back), 'new' (the person asked
// for another one) or 'replaced' (the service made another one itself), and why.
const OPEN_EVS = new Set(['opened', 'new', 'replaced'])
function openHow (how) {
  const h = how && typeof how === 'object' ? how : {}
  return { ev: OPEN_EVS.has(h.ev) ? h.ev : 'opened', why: word(h.why === undefined ? 'user' : h.why) }
}

// The calls that return a Promise (see the header): each is wrapped so that it resolves to { error } instead of rejecting.
const ASYNC_API = Object.freeze([
  'openCode', 'newCode', 'closeCode', 'knock', 'cancelKnock', 'accept', 'reject', 'send', 'resend', 'cancelSend', 'edit', 'remove',
  'react', 'markRead', 'markUnread', 'typing', 'block', 'unblock', 'setCfg', 'setNickname', 'setFlags', 'setFlag', 'retry',
  'setMessageFlag', 'clear', 'leave', 'verifyCode', 'createRoom', 'joinRoom', 'acceptMember', 'rejectMember', 'sendRoom',
  'leaveRoom', 'markRoomRead'
])

function toBytes (buf) {
  if (buf instanceof Uint8Array) return buf
  if (buf instanceof ArrayBuffer) return new Uint8Array(buf)
  if (buf && ArrayBuffer.isView(buf)) return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength)
  return null
}

function advertises (handshake, name) {
  const m = handshake && handshake.m
  return !!(m && typeof m === 'object' && m[name] !== undefined && m[name] !== null && Number(m[name]) > 0)
}

/** A display name: one line, no controls, at most max code points; '' when nothing is left. */
function cleanName (s, max = NAME_MAX) {
  if (typeof s !== 'string') return ''
  return Array.from(sanitizeText(s).replace(/\s+/g, ' ').trim()).slice(0, max).join('')
}

function appsBlockOf (config) {
  const c = config && typeof config === 'object' ? (config.apps && typeof config.apps === 'object' ? config.apps : config) : {}
  const list = Array.isArray(c.rendezvous) ? c.rendezvous : (typeof c.rendezvous === 'string' ? [c.rendezvous] : [])
  // The two tokens of the door (amendment A2): relay 'rendezvous' (also when absent or anything else) or 'none'; direct 'on' or 'off'. Without a
  // direct token, direct is off beside the relay and on without it, so relay 'none' alone is the transport of before the relay existed: the
  // rollback of plan D9. The pair relay 'none' and direct 'off' has no transport; it is not an error here (a conversation just does not connect).
  const relay = c.relay === 'none' ? 'none' : 'rendezvous'
  const direct = c.direct === 'on' ? 'on' : (c.direct === 'off' ? 'off' : (relay === 'none' ? 'on' : 'off'))
  return {
    rendezvous: list.filter((u) => typeof u === 'string' && u),
    stun: Array.isArray(c.stun) ? c.stun.filter((u) => typeof u === 'string') : [],
    idp: typeof c.idp === 'string' ? c.idp : null,
    relay,
    direct
  }
}

/** A token bucket: take() true while tokens last; tokens come back at perMin a minute. */
class Bucket {
  constructor (cap, perMin, now) {
    this.cap = cap
    this.perMs = perMin / 60000
    this.tokens = cap
    this.at = now()
    this.now = now
  }

  take () {
    const t = this.now()
    this.tokens = Math.min(this.cap, this.tokens + Math.max(0, t - this.at) * this.perMs)
    this.at = t
    if (this.tokens >= 1) {
      this.tokens -= 1
      return true
    }
    return false
  }

  /** ms until one token is back. */
  wait () {
    return this.tokens >= 1 ? 0 : Math.ceil((1 - this.tokens) / this.perMs)
  }
}

function errorOf (reason) {
  const phrase = String(reason).replace(/-/g, ' ')
  if (ERROR_SET.has(phrase)) return phrase
  if (reason === 'closed' || reason === 'timeout') return 'link down'
  if (reason === 'pairing-is-off-on-this-rendezvous') return 'pairing off'
  if (reason === 'too-many-lanes') return 'too many requests'
  return 'failed'
}

function snapMessage (m) {
  const reactions = {}
  for (const e of Object.keys(m.reactions)) if (m.reactions[e].length) reactions[e] = m.reactions[e].slice()
  return {
    id: m.id, t: m.t, mine: m.mine, text: m.text, fmt: 'md1', reply: m.reply, status: m.status, readAt: m.readAt,
    edits: m.edits.map((e) => ({ t: e.t, text: e.text })), editedAt: m.editedAt, deleted: m.deleted, reactions,
    pinned: m.pinned, saved: m.saved, important: m.important, prio: m.prio, exp: m.exp, expAt: m.expAt,
    sendAt: m.sendAt, scheduled: m.scheduled
  }
}

export class Apps {
  constructor (deps = {}) {
    this.api = deps.api || null
    this.cfg = appsBlockOf(deps.config)
    // the door page may pass the three fields of the apps block beside config
    if (!this.cfg.rendezvous.length && deps.rendezvous) {
      this.cfg = appsBlockOf({ rendezvous: deps.rendezvous, stun: deps.stun || this.cfg.stun, idp: deps.idp || this.cfg.idp, relay: this.cfg.relay, direct: this.cfg.direct })
    }
    this.loadTm = typeof deps.loadTm === 'function' ? deps.loadTm : null
    this.lang = deps.lang || 'en'
    this.now = typeof deps.now === 'function' ? deps.now : () => Date.now()
    this.random = typeof deps.random === 'function' ? deps.random : secureRandom
    this.randomBytes = typeof deps.randomBytes === 'function' ? deps.randomBytes : randomBytes
    this._setT = deps.setTimeoutFn || ((fn, ms) => setTimeout(fn, ms))
    this._clearT = deps.clearTimeoutFn || ((t) => clearTimeout(t))
    this.limits = Object.assign({}, LIMITS, deps.limits || {})
    // a roster lists at most ROSTER_MAX people, so that the sealed roster always fits one frame
    this.limits.roomMembersMax = Math.min(this.limits.roomMembersMax, ROSTER_MAX)
    this._makeLink = typeof deps.createLink === 'function' ? deps.createLink : createLink
    this._WS = deps.WebSocketImpl || null
    this._log = typeof deps.log === 'function' ? deps.log : noop
    this._report = typeof deps.report === 'function' ? deps.report : null
    this._linkOptions = deps.linkOptions && typeof deps.linkOptions === 'object' ? deps.linkOptions : null
    this.link = deps.link || null
    this._linkOffs = []
    this.tm = null
    this._tmP = null
    this._offExt = null
    this._listeners = new Set()
    this._timers = new Map()
    this._timerSeq = 0
    this._epoch = 0
    this._version = 0
    this._snapVersion = -1
    this._snap = null
    this._notifyQueued = false
    this._pub = null
    this._destroyed = false
    this._sweepTimer = null
    this._sweepAt = 0
    this._initState()
    // the page's visibility and network events (amendment A3); both come off in destroy()
    this._offPage = [typeof deps.onVisible === 'function' ? deps.onVisible : pageVisible, typeof deps.onOnline === 'function' ? deps.onOnline : pageBack].map((on) => {
      try {
        const off = on(() => this._wake())
        return typeof off === 'function' ? off : noop
      } catch (_) {
        return noop
      }
    })
    const id = this._identity()
    if (id && typeof id.onChange === 'function') {
      try { this._offIdentity = id.onChange(() => this._onIdentity()) } catch (_) { this._offIdentity = null }
    }
    const me = this._info()
    this._pub = me ? me.pub : null
    // A call never rejects: whatever goes wrong inside it (a key that went away mid-way, a bug) comes back as { error: 'failed' }.
    for (const name of ASYNC_API) {
      const fn = this[name]
      this[name] = async (...args) => {
        try {
          return await fn.apply(this, args)
        } catch (err) {
          this._log('api', name, err)
          return { error: 'failed' }
        }
      }
    }
  }

  _initState () {
    this.convs = new Map() // id -> conversation (the public fields plus .p, the private ones)
    this.rooms = new Map()
    this.requests = new Map() // knock -> request
    this.lanes = new Map() // lane hex -> conversation | room
    this._laneEnds = 0 // lanes this socket gave up at the rendezvous (a leave sent): a 'too many lanes' answer that crossed one is out of date
    this.blocked = new Set()
    this.snippets = []
    this.codeRec = null // the pair code this person owns
    this.notice = null
    this.knockTimes = [] // times of this person's knocks (rate limit)
    this._opening = null
  }

  // ---- plumbing -------------------------------------------------------------------------------

  _identity () {
    const a = this.api
    return a && a.identity ? a.identity : a
  }

  _info () {
    const id = this._identity()
    try {
      const i = id && typeof id.info === 'function' ? id.info() : null
      return i && typeof i.pub === 'string' ? i : null
    } catch (_) {
      return null
    }
  }

  _keys () {
    const id = this._identity()
    try {
      return id && typeof id.keys === 'function' ? id.keys() : null
    } catch (_) {
      return null
    }
  }

  _me () {
    const i = this._info()
    return i ? { pub: i.pub, short: shortIdOf(i.pub), name: cleanName(i.name || '') || null } : null
  }

  _later (ms, fn) {
    const id = ++this._timerSeq
    const h = this._setT(() => {
      this._timers.delete(id)
      if (!this._destroyed) fn()
    }, Math.max(0, Math.min(MAX_TIMER_MS, Math.round(ms))))
    this._timers.set(id, h)
    return id
  }

  _cancel (id) {
    if (id === null || id === undefined) return
    const h = this._timers.get(id)
    if (h === undefined) return
    this._timers.delete(id)
    try { this._clearT(h) } catch (_) { /* gone */ }
  }

  // ---- usage reports --------------------------------------------------------------------------

  // What happened, never what was said (the fields are listed in the header). A field without a value is left out, and a throw in the
  // page's function stops here: a report never changes what the service does.
  _rep (name, fields) {
    if (!this._report) return
    const f = {}
    for (const k of Object.keys(fields)) if (fields[k] !== null && fields[k] !== undefined) f[k] = fields[k]
    try { this._report(name, f) } catch (_) { /* a report never breaks the service */ }
  }

  _repConv (conv) {
    // via: the path a connected conversation talks on (left out of every other status)
    this._rep('conv', { id: conv.id, status: conv.status, reason: conv.reason ? word(conv.reason) : null, incoming: !!conv.incoming, via: conv.status === 'connected' ? this._viaOf(conv) : null })
  }

  _repRoom (room, why) {
    this._rep('room', { id: room.id, status: room.status, reason: why || (room.reason ? word(room.reason) : null), members: room.members.length })
  }

  _repRec (rec) {
    if (rec.isRoom) this._repRoom(rec)
    else this._repConv(rec)
  }

  // A conversation or a room that leaves the list gets one last report, so that no id stays open in the reports.
  _repGone (rec, why) {
    if (rec.isRoom) this._rep('room', { id: rec.id, status: 'removed', reason: why, members: rec.members.length })
    else this._rep('conv', { id: rec.id, status: 'removed', reason: why, incoming: !!rec.incoming })
  }

  _repCode (ev, why, channel, kind = 'pair') {
    this._rep('code', { ev, kind, why, channel })
  }

  // kind is what the lane is (pair or room); via is the carrier (direct or relay) and the only new meaning (plan 3.6)
  _repWire (st, ev, reason) {
    this._rep('wire', { conv: st.rec.id, ev, kind: st.rec.isRoom ? 'room' : 'pair', via: st.relay ? 'relay' : 'direct', reason: reason ? word(reason) : null })
  }

  // The relay lane in a report: a word and how many others are in it. Never the lane id and never a frame: the reporter's mask would cut a long run
  // to 8 characters, but a field that never held the id is the rule (plan 3.6).
  _repLane (ev, peers) {
    this._rep('lane', { ev, peers: Number.isInteger(peers) ? peers : null })
  }

  _repMsg (rec, status, n) {
    if (n > 0) this._rep('msg', { conv: rec.id, status, count: n })
  }

  // A knock that did not go through: the reason is one of this service's own error texts or the slug of the rendezvous' answer.
  _knockFail (kind, channel, error, reason) {
    this._rep('knock', { ev: 'error', kind, channel, reason: reason || word(String(error).replace(/ /g, '-')) })
    return { error }
  }

  _touch () {
    this._version++
    if (this._notifyQueued || !this._listeners.size) return
    this._notifyQueued = true
    Promise.resolve().then(() => {
      this._notifyQueued = false
      if (this._destroyed) return
      const s = this.state()
      for (const fn of Array.from(this._listeners)) {
        try { fn(s) } catch (_) { /* a listener's bug */ }
      }
    })
  }

  /** onChange(fn) -> off: fn(state) runs (once per tick at most) after every change. */
  onChange (fn) {
    if (typeof fn !== 'function') throw new TypeError('onChange: fn')
    this._listeners.add(fn)
    return () => { this._listeners.delete(fn) }
  }

  _bucket (cap, perMin) {
    return new Bucket(cap, perMin, this.now)
  }

  _newId () {
    return randomId(this.randomBytes)
  }

  // ---- identity -------------------------------------------------------------------------------

  _onIdentity () {
    const i = this._info()
    const pub = i ? i.pub : null
    if (pub !== this._pub) {
      this._pub = pub
      this._resetAll()
    } else {
      this._touch()
    }
  }

  /** Signing out (or becoming someone else) drops everything: sockets, lanes, conversations, timers. Nothing was stored. */
  _resetAll () {
    this._epoch++
    for (const h of this._timers.values()) {
      try { this._clearT(h) } catch (_) { /* gone */ }
    }
    this._timers.clear()
    this._sweepTimer = null
    this._sweepAt = 0
    for (const rec of Array.from(this.lanes.values())) this._leaveLane(rec, true)
    this.lanes.clear()
    // what this visit held ends here, and each of it says so once
    for (const rec of this.convs.values()) this._repGone(rec, 'reset')
    for (const rec of this.rooms.values()) this._repGone(rec, 'reset')
    if (this.codeRec) this._repCode('closed', 'reset', this.codeRec.channel)
    if (this.link) {
      try { this.link.close() } catch (_) { /* gone */ }
    }
    this._initState()
    this._touch()
  }

  /** destroy(): stops everything for good (the page is going away). */
  destroy () {
    this._resetAll()
    this._destroyed = true
    if (this._offIdentity) {
      try { this._offIdentity() } catch (_) { /* gone */ }
    }
    for (const off of this._linkOffs.splice(0)) {
      try { off() } catch (_) { /* gone */ }
    }
    for (const off of this._offPage.splice(0)) {
      try { off() } catch (_) { /* gone */ }
    }
    if (this._offExt) {
      try { this._offExt() } catch (_) { /* gone */ }
      this._offExt = null
    }
    this._listeners.clear()
  }

  // ---- state ----------------------------------------------------------------------------------

  state () {
    if (this._snap === null || this._snapVersion !== this._version) {
      this._snap = this._buildState()
      this._snapVersion = this._version
    }
    return this._snap
  }

  _buildState () {
    const me = this._me()
    const ls = this.link ? this.link.state : 'idle'
    return {
      signedIn: !!me,
      me,
      ready: !!(me && this._keys()),
      link: ls === 'open' ? 'open' : (ls === 'connecting' || ls === 'backoff' ? 'connecting' : 'closed'),
      tm: !!this.tm,
      notice: this.notice ? { kind: this.notice.kind, why: this.notice.why || null, at: this.notice.at } : null,
      cfg: { relay: this.cfg.relay, direct: this.cfg.direct },
      code: this.codeRec ? formatCode(this.codeRec.code) : null,
      conversations: Array.from(this.convs.values()).map((c) => this._snapConv(c)),
      rooms: Array.from(this.rooms.values()).map((r) => this._snapRoom(r)),
      requests: Array.from(this.requests.values()).map((q) => ({
        knock: q.knock, kind: q.kind, roomId: q.room ? q.room.id : null,
        from: { pub: q.hello.pub, short: shortIdOf(q.hello.pub), name: cleanName(q.hello.name || '') || null }, at: q.at
      })),
      snippets: this.snippets.map((s) => ({ id: s.id, text: s.text })),
      blocked: Array.from(this.blocked)
    }
  }

  _snapConv (c) {
    const last = c.messages.length ? c.messages[c.messages.length - 1].t : c.createdAt
    return {
      id: c.id,
      peer: { pub: c.peer.pub, short: c.peer.pub ? shortIdOf(c.peer.pub) : null, name: c.peer.name || null, nick: c.peer.nick || null },
      status: c.status, reason: c.reason || null, silent: !!c.silent, knock: c.knock || null, code: c.codeText || null,
      via: this._viaOf(c), incoming: !!c.incoming, connectedAt: c.connectedAt, lastSeenAt: c.lastSeenAt, unread: c.unread,
      markedUnread: !!c.markedUnread, muted: c.muted, pinned: c.pinned, archived: c.archived, favorite: c.favorite, hidden: c.hidden,
      cfg: { exp: c.cfg.exp, receipts: c.cfg.receipts, typing: c.cfg.typing },
      peerCfg: { exp: c.peerCfg.exp, receipts: c.peerCfg.receipts },
      compare: c.compare, compareText: c.compare ? formatCompare(c.compare) : null, verify: c.compare,
      draft: c.draft, note: c.note, typingPeer: !!c.typingPeer, lastT: last, pending: c.p.outbox.length,
      messages: c.messages.map(snapMessage)
    }
  }

  _snapRoom (r) {
    const members = r.members.map((m) => ({
      pub: m.pub, short: shortIdOf(m.pub), name: m.name || null, you: m.pub === this._pub, owner: m.pub === r.ownerPub
    }))
    return {
      id: r.id, owner: r.owner, status: r.status, reason: r.reason || null, silent: !!r.silent, knock: r.knock || null,
      code: r.owner && r.codeOpen ? formatCode(r.code) : null, codeClosed: r.codeClosed || null, ownerPub: r.ownerPub,
      members, unread: r.unread, draft: r.draft, peers: this._readyCount(r), via: this._viaOf(r),
      messages: r.messages.map((m) => ({
        id: m.id, t: m.t, mine: m.mine, from: { pub: m.from, short: shortIdOf(m.from), name: this._roomName(r, m.from) },
        text: m.text, fmt: 'md1', status: m.status
      }))
    }
  }

  _roomName (r, pub) {
    const m = r.members.find((x) => x.pub === pub)
    return m && m.name ? m.name : null
  }

  // ---- the pair socket: codes, knocks, requests -----------------------------------------------

  _ensureLink () {
    if (!this.link) {
      if (!this.cfg.rendezvous.length) return null
      try {
        // the keepalive of the pair socket is on here (plan 3.4); a caller's linkOptions may set it otherwise, and this service's own fields win
        this.link = this._makeLink(Object.assign({ keepaliveMs: KEEPALIVE_MS }, this._linkOptions, {
          url: this.cfg.rendezvous[0], WebSocketImpl: this._WS, setTimeoutFn: this._setT, clearTimeoutFn: this._clearT, random: this.random, now: this.now
        }))
      } catch (_) {
        return null
      }
    }
    if (!this._linked) {
      this._linked = true
      const link = this.link
      const hook = (ev, fn) => this._linkOffs.push(link.on(ev, (d) => {
        try {
          const r = fn(d)
          if (r && typeof r.then === 'function') r.then(undefined, noop)
        } catch (_) { /* a handler's bug never reaches the socket */ }
      }))
      hook('state', () => this._touch())
      hook('open', () => this._onLinkOpen())
      hook('gone', () => this._onLinkGone())
      hook('request', (d) => this._onRequest(d))
      hook('accepted', (d) => this._onAccepted(d))
      hook('rejected', (d) => this._onRejected(d))
      hook('cancelled', (d) => this._onCancelled(d))
      hook('silent', (d) => this._onSilent(d))
      hook('closed', (d) => this._onCodeClosed(d))
      hook('relayed', (d) => this._onRelayed(d))
      hook('joined', (d) => this._onJoined(d))
      hook('left', (d) => this._onLeft(d))
    }
    return this.link
  }

  // The tab came back or the network did (amendment A3): a socket the page lost while it slept is opened again at once, not at the end of its
  // back off. Nothing else: a link that was never started, or was closed on a sign-out, stays as it is.
  _wake () {
    const link = this.link
    if (this._destroyed || !link || link.state === 'idle') return
    try { link.connect() } catch (_) { /* a socket that cannot be made */ }
  }

  /** The three things every network call needs: a signed-in person with keys, a rendezvous, and the epoch to check afterwards. */
  _gate () {
    if (!this._me()) return { error: 'not signed in' }
    const keys = this._keys()
    if (!keys) return { error: 'not ready' }
    const link = this._ensureLink()
    if (!link) return { error: 'no rendezvous' }
    return { keys, link, epoch: this._epoch }
  }

  /**
   * openCode() -> { code: 'xxxx-xxxx-xxxx' } | { error }: opens (or returns) the code others type to message this person. The argument
   * is for this file's own calls and says how the opening is reported ({ ev: 'opened' | 'new' | 'replaced', why }).
   */
  async openCode (how) {
    if (this.codeRec) return { code: formatCode(this.codeRec.code) }
    if (this._opening) return this._opening
    const p = this._openCode(openHow(how))
    this._opening = p
    try {
      const r = await p
      if (r.error) this._rep('code', { ev: 'error', kind: 'pair', why: word(String(r.error).replace(/ /g, '-')) })
      return r
    } finally {
      if (this._opening === p) this._opening = null
    }
  }

  async _openCode (how) {
    const g = this._gate()
    if (g.error) return g
    for (let attempt = 0; attempt < 5; attempt++) {
      const code = generateCode(this.randomBytes)
      const sp = splitCode(code)
      const keyCode = await codeKey(sp.secret, sp.channel)
      const { box } = await sealHello({ keyCode, channel: sp.channel, role: 'owner', keys: g.keys, name: this._me().name, now: this.now(), random: this.randomBytes })
      if (g.epoch !== this._epoch) return { error: 'not signed in' }
      const r = await g.link.openCode({ kind: 'pair', channel: sp.channel, box })
      if (g.epoch !== this._epoch) return { error: 'not signed in' }
      if (r.ok) {
        this.codeRec = { code, channel: sp.channel, keyCode, box, registered: true, bad: 0, seen: new Set() }
        this._touch()
        this._repCode(how.ev, how.why, sp.channel)
        return { code: formatCode(code) }
      }
      if (r.reason !== 'channel-taken') return { error: errorOf(r.reason) }
    }
    return { error: 'channel taken' }
  }

  /** newCode() -> { code } | { error }: closes the code and opens another. */
  async newCode () {
    const old = this.codeRec ? this.codeRec.channel : null
    await this._closeCode()
    const r = await this.openCode({ ev: 'new', why: 'user' })
    if (r.error && old) this._repCode('closed', 'new-failed', old)
    return r
  }

  /** closeCode() -> { ok: true }: nobody can knock any more; pending knocks end. */
  async closeCode () {
    const channel = this.codeRec ? this.codeRec.channel : null
    await this._closeCode()
    if (channel) this._repCode('closed', 'user', channel)
    return { ok: true }
  }

  async _closeCode () {
    const rec = this.codeRec
    if (!rec) return
    this.codeRec = null
    for (const q of Array.from(this.requests.values())) if (q.kind === 'pair') this._dropRequest(q.knock, 'code-closed')
    this._touch()
    if (this.link) await this.link.closeCode({ kind: 'pair' })
  }

  async _replaceCode (why) {
    const old = this.codeRec ? this.codeRec.channel : null
    await this._closeCode()
    const r = await this.openCode({ ev: 'replaced', why })
    this.notice = { kind: r.error ? 'code-closed' : 'code-replaced', why, at: this.now() }
    if (r.error && old) this._repCode('closed', why, old)
    this._rep('notice', { kind: this.notice.kind, why: word(why) })
    this._touch()
  }

  _knockOk () {
    const t = this.now()
    this.knockTimes = this.knockTimes.filter((x) => t - x < 60000)
    if (this.knockTimes.length >= this.limits.knockPerMin) return false
    this.knockTimes.push(t)
    return true
  }

  _waitingCount () {
    let n = 0
    for (const c of this.convs.values()) if (c.status === 'waiting') n++
    for (const r of this.rooms.values()) if (r.status === 'waiting') n++
    return n
  }

  /**
   * knock(codeText) -> { knock, id } | { error }: asks the owner of a code to message. Only a sealed hello and the channel (the
   * first four characters) go to the rendezvous; the last eight characters (the secret) never leave. The conversation shows 'waiting' until
   * the owner decides; nothing is joined before then.
   */
  async knock (codeText) {
    const sp = splitCode(codeText)
    if (!sp) return this._knockFail('pair', null, 'bad code')
    const g = this._gate()
    if (g.error) return this._knockFail('pair', sp.channel, g.error)
    if (this.codeRec && this.codeRec.code === sp.code) return this._knockFail('pair', sp.channel, 'own code')
    for (const c of this.convs.values()) if (c.status === 'waiting' && c.channel === sp.channel) return this._knockFail('pair', sp.channel, 'already knocked')
    if (this._waitingCount() >= this.limits.knocksOutMax || !this._knockOk()) return this._knockFail('pair', sp.channel, 'rate limited')
    const keyCode = await codeKey(sp.secret, sp.channel)
    const { box } = await sealHello({ keyCode, channel: sp.channel, role: 'knock', keys: g.keys, name: this._me().name, now: this.now(), random: this.randomBytes })
    if (g.epoch !== this._epoch) return { error: 'not signed in' }
    this._rep('knock', { ev: 'sent', kind: 'pair', channel: sp.channel })
    const r = await g.link.knock({ kind: 'pair', channel: sp.channel, box })
    if (g.epoch !== this._epoch) return { error: 'not signed in' }
    if (!r.ok) return this._knockFail('pair', sp.channel, errorOf(r.reason), reasonWord(r.reason))
    const conv = this._newConv({ status: 'waiting', knock: r.knock, channel: sp.channel, keyCode, codeText: formatCode(sp.code), incoming: false })
    this._rep('knock', { ev: 'ok', kind: 'pair', channel: sp.channel })
    this._repConv(conv)
    this._touch()
    return { knock: r.knock, id: conv.id }
  }

  /** cancelKnock(knock) -> { ok: true }: withdraws a knock that has not been answered (the waiting conversation goes). */
  async cancelKnock (knock) {
    for (const c of Array.from(this.convs.values())) {
      if (c.status === 'waiting' && (c.knock === knock || c.id === knock)) {
        this.convs.delete(c.id)
        this._repGone(c, 'cancelled')
        if (this.link && c.knock) await this.link.cancel({ kind: 'pair', knock: c.knock })
        this._touch()
        return { ok: true }
      }
    }
    for (const r of Array.from(this.rooms.values())) {
      if (r.status === 'waiting' && (r.knock === knock || r.id === knock)) {
        this.rooms.delete(r.id)
        this._repGone(r, 'cancelled')
        if (this.link && r.knock) await this.link.cancel({ kind: 'room', knock: r.knock })
        this._touch()
        return { ok: true }
      }
    }
    return { error: 'no request' }
  }

  // why: set when the request ends without this person's answer (the requester took it back, the code or the socket went); the answers of
  // accept and reject say so themselves.
  _dropRequest (knock, why) {
    const q = this.requests.get(knock)
    if (!q) return
    this._cancel(q.timer)
    this.requests.delete(knock)
    if (why) this._rep('request', { ev: 'dropped', kind: q.kind, reason: why })
    this._touch()
  }

  _answerLater (ev) {
    const [lo, hi] = this.limits.blockedRejectDelayMs
    this._later(lo + this.random() * Math.max(0, hi - lo), () => {
      if (this.link) this.link.reject({ kind: ev.kind, knock: ev.knock }).then(undefined, noop)
    })
  }

  async _onRequest (ev) {
    const epoch = this._epoch
    const keys = this._keys()
    if (!keys) return
    const room = ev.kind === 'room' ? this._roomByChannel(ev.channel) : null
    const own = ev.kind === 'room' ? room : (this.codeRec && this.codeRec.channel === ev.channel ? this.codeRec : null)
    if (!own || (room && !room.codeOpen)) return
    const opened = await openHello({ keyCode: own.keyCode, channel: ev.channel, role: 'knock', box: ev.box, now: this.now() })
    if (epoch !== this._epoch) return
    if (room ? !this.rooms.has(room.id) || !room.codeOpen : this.codeRec !== own) return
    if (!opened.ok) {
      own.bad = (own.bad || 0) + 1
      this._rep('request', { ev: 'turned-away', kind: ev.kind, reason: 'bad-box' })
      if (own.bad >= this.limits.badKnocksMax) {
        if (room) await this._closeRoomCode(room, 'bad-knocks')
        else await this._replaceCode('bad-knocks')
      }
      return
    }
    const h = opened.hello
    // A box this code already took is a replay (ADV-8): it is turned away at once, so that replays cannot sit in the 16 places of the
    // code for ten minutes and push honest requesters out. A hello that carries this person's own chat key is not a person (ADV-9):
    // K_pair of a key with itself opens this person's own frames, which a sender could reflect as presence and receipts.
    const turnAway = (why) => {
      this._rep('request', { ev: 'turned-away', kind: ev.kind, reason: why })
      if (this.link) this.link.reject({ kind: ev.kind, knock: ev.knock }).then(undefined, noop)
    }
    if (own.seen.has(h.n)) {
      turnAway('replay')
      return
    }
    own.seen.add(h.n)
    if (own.seen.size > 256) own.seen.delete(own.seen.values().next().value)
    if (h.pub === this._pub || h.ek === keys.chat.pub || (room && room.members.some((m) => m.pub === h.pub)) || (room && room.members.length >= this.limits.roomMembersMax)) {
      turnAway(h.pub === this._pub || h.ek === keys.chat.pub ? 'self' : (room.members.some((m) => m.pub === h.pub) ? 'member' : 'full'))
      return
    }
    if (this.blocked.has(h.pub)) {
      this._rep('request', { ev: 'turned-away', kind: ev.kind, reason: 'blocked' })
      this._answerLater(ev)
      return
    }
    const q = { knock: ev.knock, kind: ev.kind, channel: ev.channel, room, hello: h, at: this.now(), timer: null }
    q.timer = this._later(this.limits.requestTtlMs, () => {
      this.requests.delete(q.knock)
      this._rep('request', { ev: 'expired', kind: q.kind })
      this._touch()
    })
    this.requests.set(q.knock, q)
    this._rep('request', { ev: 'in', kind: q.kind })
    this._touch()
  }

  /**
   * accept(knock) -> { id } | { error }: approves a request (a person's, or a person asking into a room). Only now is the torrent
   * manager loaded and the private lane joined; the other side joins when it hears the answer.
   */
  async accept (knock) {
    const q = this.requests.get(knock)
    const r = await this._accept(knock, q)
    // the accept itself is told where the rendezvous took it; here only the ones that did not go through
    if (q && r.error) this._rep('request', { ev: 'accept-error', kind: q.kind, reason: word(String(r.error).replace(/ /g, '-')) })
    return r
  }

  async _accept (knock, q) {
    if (!q) return { error: 'no request' }
    const g = this._gate()
    if (g.error) return g
    if (q.kind === 'room') return this._acceptMember(q, g)
    const direct = await this._directGate()
    if (direct.error && this.cfg.relay !== 'rendezvous') return { error: direct.error.code === 'E_EXISTS' ? 'manager busy' : 'no manager' }
    if (g.epoch !== this._epoch || this.requests.get(knock) !== q) return { error: 'no request' }
    if (direct.error) this._repLane('direct-unavailable', null) // the relay carries the conversation without it (plan 3.6)
    // The accept goes to the rendezvous with this person's signature over the channel and the knock; the requester loads nothing and
    // joins nothing unless that signature checks (ADV-7)
    const proof = await signAccept({ keys: g.keys, channel: q.channel, knock })
    if (g.epoch !== this._epoch || this.requests.get(knock) !== q) return { error: 'no request' }
    const r = await g.link.accept({ kind: 'pair', knock, proof })
    this._dropRequest(knock)
    if (g.epoch !== this._epoch) return { error: 'not signed in' }
    if (!r.ok) return { error: errorOf(r.reason) }
    this._rep('request', { ev: 'accept', kind: 'pair' })
    const h = q.hello
    const conv = this._newConv({ status: 'connecting', peer: { pub: h.pub, ek: h.ek, name: cleanName(h.name || '') || null }, incoming: true })
    this._repConv(conv)
    await this._startConv(conv, r.lane)
    return { id: conv.id }
  }

  /** reject(knock) -> { ok: true }: declines a request; the other person sees 'rejected' and nothing was joined. */
  async reject (knock) {
    const q = this.requests.get(knock)
    if (!q) return { error: 'no request' }
    this._dropRequest(knock)
    this._rep('request', { ev: 'reject', kind: q.kind, reason: 'user' })
    if (this.link) await this.link.reject({ kind: q.kind, knock })
    return { ok: true }
  }

  _waitingByKnock (kind, knock) {
    if (kind === 'room') {
      for (const r of this.rooms.values()) if (r.status === 'waiting' && r.knock === knock) return r
      return null
    }
    for (const c of this.convs.values()) if (c.status === 'waiting' && c.knock === knock) return c
    return null
  }

  async _onAccepted (ev) {
    const epoch = this._epoch
    const rec = this._waitingByKnock(ev.kind, ev.knock)
    if (!rec) return
    const opened = await openHello({ keyCode: rec.p.keyCode, channel: ev.channel, role: 'owner', box: ev.box, now: this.now(), pastMs: MS_DAY })
    if (epoch !== this._epoch || rec.status !== 'waiting') return
    if (opened.ok) {
      // The accept must carry the owner's signature over this channel and this knock, made with the key in the owner's hello. An
      // accept without one is not acted on: the request stays as it is and nothing is loaded or joined (ADV-7).
      const proved = await verifyAccept({ ownerPub: opened.hello.pub, channel: rec.channel, knock: ev.knock, proof: ev.proof })
      if (epoch !== this._epoch || rec.status !== 'waiting') return
      if (!proved) {
        this._log('accept-proof', ev.kind)
        return
      }
    }
    const keys = this._keys()
    // The owner's hello must be another person's: not this person's own identity key or chat key (ADV-9), and not a blocked person's.
    // This is settled before the manager is loaded and before any lane is joined.
    const own = opened.ok && keys && (opened.hello.pub === this._pub || opened.hello.ek === keys.chat.pub)
    if (!opened.ok || !keys || own || this.blocked.has(opened.hello.pub)) {
      rec.status = 'rejected'
      rec.reason = !opened.ok ? 'bad-box' : (own || !keys ? 'bad-key' : 'blocked')
      rec.knock = null
      this._repRec(rec)
      this._touch()
      return
    }
    const direct = await this._directGate()
    if (direct.error && this.cfg.relay !== 'rendezvous') {
      rec.status = 'rejected'
      rec.reason = 'no-tm'
      rec.knock = null
      this._repRec(rec)
      this._touch()
      return
    }
    if (epoch !== this._epoch || rec.status !== 'waiting') return
    if (direct.error) this._repLane('direct-unavailable', null)
    const h = opened.hello
    rec.knock = null
    if (ev.kind === 'room') {
      rec.ownerPub = h.pub
      rec.ownerEk = h.ek
      rec.members = [{ pub: h.pub, ek: h.ek, name: cleanName(h.name || '') }]
      rec.status = 'connecting'
      rec.p.keyCode = null
      this._repRoom(rec)
      await this._joinRoomLane(rec, ev.lane)
      this._touch()
      return
    }
    rec.peer = { pub: h.pub, ek: h.ek, name: cleanName(h.name || '') || null, nick: null }
    rec.status = 'connecting'
    rec.codeText = null // the typed code, with the secret in it, is not kept once the answer is in
    rec.p.keyCode = null
    this._repConv(rec)
    await this._startConv(rec, ev.lane)
  }

  _onRejected (ev) {
    const rec = this._waitingByKnock(ev.kind, ev.knock)
    if (!rec) return
    rec.status = 'rejected'
    rec.reason = ev.reason
    rec.knock = null
    this._repRec(rec)
    this._touch()
  }

  _onSilent (ev) {
    const rec = this._waitingByKnock(ev.kind, ev.knock)
    if (!rec) return
    rec.silent = true
    this._rep('knock', { ev: 'error', kind: ev.kind, channel: rec.channel, reason: 'silent' })
    this._touch()
  }

  _onCancelled (ev) {
    this._dropRequest(ev.knock, 'cancelled')
  }

  _onLinkGone () {
    // the rendezvous drops the lanes of a lost socket: every relay lane is out of use until it is joined again on the next open; a join that
    // waited to be asked again (DEC-1) waits for that open instead, where _rejoinAll asks
    for (const rec of Array.from(this.lanes.values())) {
      const st = rec.p ? rec.p.rst : null
      if (!st) continue
      this._cancel(st.retry)
      st.retry = null
      if (!st.left && !st.dead) this._relayState(st, { joined: false, peers: 0, why: 'link-lost' })
    }
    for (const q of Array.from(this.requests.values())) this._dropRequest(q.knock, 'link-lost')
    if (this.codeRec) this.codeRec.registered = false
    for (const r of this.rooms.values()) if (r.owner) r.registered = false
    for (const rec of [...this.convs.values(), ...this.rooms.values()]) {
      if (rec.status === 'waiting' && rec.knock) {
        rec.lostKnock = rec.knock
        rec.knock = null
      }
    }
    this._touch()
  }

  async _onLinkOpen () {
    const epoch = this._epoch
    const link = this.link
    const keys = this._keys()
    if (!link || !keys) return
    this._rejoinAll().then(undefined, noop) // the conversations and rooms come first: their lanes are joined while the code is registered again
    const rec = this.codeRec
    if (rec && !rec.registered) {
      const { box } = await sealHello({ keyCode: rec.keyCode, channel: rec.channel, role: 'owner', keys, name: this._me().name, now: this.now(), random: this.randomBytes })
      if (epoch !== this._epoch || this.codeRec !== rec) return
      rec.box = box
      const r = await link.openCode({ kind: 'pair', channel: rec.channel, box })
      if (epoch !== this._epoch || this.codeRec !== rec) return
      if (r.ok) {
        rec.registered = true
        this._repCode('opened', 'reconnect', rec.channel)
        this._touch()
      } else if (r.reason === 'channel-taken') {
        await this._replaceCode('reopen-failed')
      }
    }
    for (const room of Array.from(this.rooms.values())) {
      if (room.owner && !room.registered && room.codeOpen) await this._reopenRoom(room)
    }
    for (const c of Array.from(this.convs.values())) {
      if (c.status === 'waiting' && !c.knock && c.lostKnock) await this._reknock(c, 'pair')
    }
    for (const room of Array.from(this.rooms.values())) {
      if (room.status === 'waiting' && !room.knock && room.lostKnock) await this._reknock(room, 'room')
    }
  }

  // The owner may be slow to answer, so a knock lost with the socket is made again (a fresh hello), a few times. A knock that finds
  // no code is tried again after a short wait: the owner's socket may be coming back too.
  async _reknock (rec, kind) {
    const epoch = this._epoch
    const keys = this._keys()
    if (!keys || !this.link) return
    rec.p.reknocks = (rec.p.reknocks || 0) + 1
    if (rec.p.reknocks > this.limits.reknockMax) {
      rec.status = 'rejected'
      rec.reason = 'gone'
      rec.lostKnock = null
      this._repRec(rec)
      this._touch()
      return
    }
    const { box } = await sealHello({ keyCode: rec.p.keyCode, channel: rec.channel, role: 'knock', keys, name: this._me().name, now: this.now(), random: this.randomBytes })
    if (epoch !== this._epoch || rec.status !== 'waiting') return
    this._rep('knock', { ev: 'sent', kind, channel: rec.channel, reason: 'again' })
    const r = await this.link.knock({ kind, channel: rec.channel, box })
    if (epoch !== this._epoch || rec.status !== 'waiting') return
    if (r.ok) {
      rec.knock = r.knock
      rec.lostKnock = null
      rec.silent = false
      this._rep('knock', { ev: 'ok', kind, channel: rec.channel, reason: 'again' })
    } else if (r.reason === 'unknown-code') {
      this._rep('knock', { ev: 'error', kind, channel: rec.channel, reason: 'unknown-code' })
      this._later(this.limits.reknockDelayMs, () => {
        if (rec.status === 'waiting' && !rec.knock && rec.lostKnock) this._reknock(rec, kind).then(undefined, noop)
      })
    } else if (r.reason !== 'link-down' && r.reason !== 'closed') {
      this._rep('knock', { ev: 'error', kind, channel: rec.channel, reason: reasonWord(r.reason) })
      rec.status = 'rejected'
      rec.reason = r.reason
      rec.lostKnock = null
      this._repRec(rec)
    }
    this._touch()
  }

  // The rendezvous ended a code this person owns (a code runs out after 24 hours): a pair code is replaced by a new one, a room
  // code stays closed (the lane of the room is the same; members already inside are not affected).
  async _onCodeClosed (ev) {
    if (ev.kind === 'room') {
      const room = this._roomByChannel(ev.channel)
      if (!room) return
      room.codeOpen = false
      room.codeClosed = ev.reason === 'expired' ? 'expired' : 'closed'
      this._repCode('closed', room.codeClosed, ev.channel, 'room')
      for (const q of Array.from(this.requests.values())) if (q.room === room) this._dropRequest(q.knock, 'code-closed')
      this._touch()
      return
    }
    const rec = this.codeRec
    if (!rec || rec.channel !== ev.channel) return
    this.codeRec = null
    for (const q of Array.from(this.requests.values())) if (q.kind === 'pair') this._dropRequest(q.knock, 'code-closed')
    const r = await this.openCode({ ev: 'replaced', why: word(ev.reason) })
    this.notice = { kind: r.error ? 'code-closed' : 'code-replaced', why: ev.reason, at: this.now() }
    if (r.error) this._repCode('closed', word(ev.reason), rec.channel)
    this._rep('notice', { kind: this.notice.kind, why: word(ev.reason) })
    this._touch()
  }

  // ---- the torrent manager and the wires ------------------------------------------------------

  /** The manager is loaded once, at the first accept, and the wire extension is registered once for chat and group lanes. */
  async _ensureTm () {
    if (this.tm) return this.tm
    if (!this._tmP) {
      this._tmP = (async () => {
        if (!this.loadTm) throw Object.assign(new Error('no torrent manager loader'), { code: 'E_NO_TM' })
        const tm = await this.loadTm()
        if (!tm || typeof tm.joinLane !== 'function' || typeof tm.registerWireExtension !== 'function') {
          throw Object.assign(new Error('the manager has no lanes'), { code: 'E_NO_TM' })
        }
        const self = this
        this._offExt = tm.registerWireExtension(EXT_NAME, { onWire (wire, kind, info) { self._onWire(wire, kind, info || {}) } }, { swarms: ['chat', 'group'] })
        this.tm = tm
        this._touch()
        return tm
      })()
      this._tmP.then(undefined, () => { this._tmP = null })
    }
    return this._tmP
  }

  _joinLane (rec, lane, kind) {
    if (!LANE_RE.test(String(lane)) || !this.tm || !this.cfg.rendezvous.length) return false
    if (rec.p.lanes.has(lane)) return true
    this.lanes.set(lane, rec)
    try {
      const handle = this.tm.joinLane({ kind, infoHash: lane, announce: [this.cfg.rendezvous[0]] })
      rec.p.lanes.set(lane, handle)
      return true
    } catch (_) {
      this.lanes.delete(lane)
      return false
    }
  }

  // quiet: a sign-out or a destroy ends every lane, so none of them needs a place filled (_fillLanes) while they go
  _leaveLane (rec, quiet = false) {
    if (!rec || !rec.p) return
    for (const [lane, handle] of Array.from(rec.p.lanes)) {
      if (this.lanes.get(lane) === rec) this.lanes.delete(lane)
      try { if (handle && typeof handle.leave === 'function') handle.leave() } catch (_) { /* gone */ }
    }
    rec.p.lanes.clear()
    for (const st of Array.from(rec.p.wires)) {
      st.dead = true
      st.left = true // this service closes it: _wireClosed does not report that as a loss of the connection
      try { st.wire.destroy() } catch (_) { /* gone */ }
    }
    rec.p.wires.clear()
    const r = rec.p.rst
    if (r && !r.left) {
      // the relay lane: leave it at the rendezvous (the other side hears pair-left) and mark the st dead with left set, as a wire is
      const wasUsable = this._relayUsable(r)
      const inLane = r.joined
      this._cancel(r.retry) // a join that waited to be asked again (DEC-1) ends with the lane
      r.retry = null
      r.left = true
      r.dead = true
      r.ready = false
      r.joined = false
      r.peers = 0
      if (this.lanes.get(r.lane) === rec) this.lanes.delete(r.lane)
      if (this.link) {
        // the lane's frames that wait for the socket's minute never go and stop keeping the other lanes waiting (finding A-6 of verify round 1):
        // leave() drops them, and a lane the socket is not in just now (the relay was refused) has them dropped without a leave to send
        if (inLane) {
          this._laneEnds++
          this.link.leave(r.lane, r.kind).then(undefined, noop)
        } else {
          this.link.dropHeld(r.lane)
        }
      }
      if (wasUsable) this._relayDown(r, 'left')
      if (!quiet) this._fillLanes()
    }
  }

  // ---- the relay lane: sealed frames through the rendezvous (plan relay-first-2026-11-07 3.6) -------------------------------------

  /**
   * One st per lane, shaped like a wire's, with RELAY_WIRE for a wire (the carrier seam of plan 3.11: another carrier would be another st
   * with its own _put and its own source of frames). It lives in rec.p.rst, not among the direct wires, so the counts of a lane's wires
   * (wiresPerPair, wiresPerRoom, the silent ones) are about wires only. peers counts the OTHER sockets in the lane; ready = joined and
   * peers above 0 and not dead; pending marks a lane the socket had no place for (it is joined when another lane ends).
   */
  _newRelaySt (rec, lane, kind) {
    return {
      wire: RELAY_WIRE, rec, lane, kind, ready: false, queue: Promise.resolve(), strikes: 0, drops: 0, dead: false, left: false, silent: null,
      heldRoster: null, relay: true, peers: 0, joined: false, pending: false,
      // the join asked again after 'lane full' (DEC-1): its timer, how many times it was asked again, and whether 'full' was told this episode
      retry: null, tries: 0, fullTold: false
    }
  }

  _relayUsable (st) {
    return st.ready && !st.dead && !st.left
  }

  /** How many other sockets a lane of this kind can hold: one for a pair, the members less this person for a room. */
  _peersMax (st) {
    return st.kind === 'room' ? Math.max(1, this.limits.roomMembersMax - 1) : 1
  }

  /** A count the rendezvous gave, when it can be one for this kind of lane; null otherwise (the push or the reply is then not acted on). */
  _peersOk (st, n) {
    return Number.isInteger(n) && n >= 0 && n <= this._peersMax(st) ? n : null
  }

  /** The carrier a frame would take now: 'direct' | 'relay' | null (what _readyWire gives). rec.via is this. */
  _viaOf (rec) {
    const st = this._readyWire(rec)
    return st ? (st.relay ? 'relay' : 'direct') : null
  }

  /** Whether a live relay st of a live conversation or room holds this lane now (a leave for it would take its seat away). */
  _relayHolds (lane) {
    const rec = this.lanes.get(lane)
    const st = rec && rec.p ? rec.p.rst : null
    return !!st && st.lane === lane && !st.left && !rec.gone
  }

  /** The relay st that a push of the link is about: the lane must be one this service joined and not left, of the same kind. */
  _relayOf (ev) {
    const rec = this.lanes.get(ev.lane)
    const st = rec && rec.p ? rec.p.rst : null
    if (!st || st.lane !== ev.lane || st.kind !== ev.kind || st.dead || st.left || rec.gone) return null
    return st
  }

  _onRelayed (ev) {
    const st = this._relayOf(ev)
    if (st) this._wireMessage(st, ev.bytes) // the size, the accept rate, the strikes, the flood and the _fresh check apply as on a wire
  }

  _onJoined (ev) {
    const st = this._relayOf(ev)
    const n = st ? this._peersOk(st, ev.peers) : null
    if (n === null) return
    this._repLane('joined', n)
    const wasUsable = this._relayUsable(st)
    const more = n > st.peers
    this._relayState(st, { joined: true, peers: n })
    // a member came into a room this person owns while the lane was in use: the roster goes again, with the sealed secrets of the members the
    // owner has not heard from, so that the one who came has what it needs (when the lane comes into use, _relayUp sends them; a direct wire
    // gets the whole state when it comes up). A burst of such pushes makes one more run, not one each (_relayRoomState)
    if (wasUsable && more && st.rec.isRoom && st.rec.owner && this._relayUsable(st)) this._relayRoomState(st.rec).then(undefined, noop)
  }

  _onLeft (ev) {
    const st = this._relayOf(ev)
    const n = st ? this._peersOk(st, ev.peers) : null
    if (n === null) return
    this._repLane('left', n)
    this._relayState(st, { peers: n, why: 'peer-left' })
  }

  /**
   * The one place a relay st changes between usable and not (plan 3.6): usable = joined, someone else in the lane, not dead. A change moves
   * the epoch of the conversation (so _flush resends what the other path never acked), is told as apps.wire up or down with via relay, and
   * wakes the path or lets the conversation fall back to connecting.
   */
  _relayState (st, { joined, peers, why } = {}) {
    const was = this._relayUsable(st)
    if (joined !== undefined) st.joined = joined
    if (peers !== undefined) st.peers = peers
    st.ready = st.joined && st.peers > 0 && !st.dead
    const now = this._relayUsable(st)
    if (now === was) {
      if (peers !== undefined) this._touch() // a room shows how many are in the lane
      return
    }
    if (now) this._relayUp(st)
    else this._relayDown(st, why || null)
  }

  _relayUp (st) {
    const rec = st.rec
    rec.p.wireEpoch++
    this._repWire(st, 'up')
    // A conversation with a direct wire up already needs nothing said again: that wire carries everything and the relay only waits. A room is
    // another matter: the members of its lane are not the peers of its wires, so the owner gives the room state to the lane whatever wires are up.
    if (rec.isRoom) this._roomWireUp(rec, st)
    else if (!this._readyDirect(rec)) this._convWireUp(rec)
    this._touch()
  }

  _relayDown (st, why) {
    const rec = st.rec
    rec.p.wireEpoch++
    this._repWire(st, 'down', why)
    if (rec.gone) return
    if (!rec.isRoom) {
      if (!this._readyWire(rec)) {
        if (rec.status === 'connected') {
          rec.status = 'connecting'
          if (why !== 'left') this._repConv(rec)
        }
        rec.typingPeer = false
      } else {
        // a direct wire to the same person is up: what the relay carried and nobody acked goes again
        this._flush(rec)
      }
    }
    this._touch()
  }

  /**
   * The one place a frame is written to a path (plan 3.6). A direct wire takes it at once and says true (a closing wire throws, and the
   * caller catches). The relay hands it to the rendezvous and says true when it reached someone: nobody there, or a refusal, is false and the
   * frame stays in the outbox. With nobody there the lane is not usable until the next joined push, and the frame goes again then.
   */
  _put (st, bytes) {
    if (st.relay) return this._putRelay(st, bytes)
    st.wire.extended(EXT_NAME, bytes)
    return true
  }

  async _putRelay (st, bytes) {
    const link = this.link
    if (!link || !this._relayUsable(st)) return false
    const epoch = this._epoch
    const r = await link.relay(st.lane, st.kind, bytes)
    if (epoch !== this._epoch || st.dead || st.left) return false
    if (r.ok) {
      if (r.peers > 0) return true
      this._relayState(st, { peers: 0, why: 'peer-left' })
      return false
    }
    this._relayFailed(st, r.reason)
    return false
  }

  // A frame the rendezvous refused. The rate and the day caps leave the lane in use (the frame waits, the person may retry). 'unknown lane' after
  // the lane was joined means the rendezvous forgot this socket (it evicted it as stale, or its object restarted: DEC-1): the lane is out of use
  // and joined once more at once; what nobody acked goes again when it is usable (_relayUp moves the epoch); a second refusal is told by
  // _relayJoin and the lane waits for the next open of the socket. A rendezvous that switched relaying off is out of use until a join works
  // again, and the conversation says no-path when it has no other path (DEC-5).
  _relayFailed (st, reason) {
    const ev = LANE_FAIL[reason]
    if (ev) this._repLane(ev, st.peers)
    if (reason === 'unknown-lane') {
      this._relayState(st, { joined: false, peers: 0, why: ev })
      this._relayJoin(st, false).then(undefined, noop)
    } else if (isRelayOff(reason)) {
      this._relayState(st, { joined: false, peers: 0, why: ev })
      this._noPath(st.rec)
    }
  }

  /**
   * Joins the relay lane of a conversation ('pair') or a room ('room') at the rendezvous: null when the door has no relay, else
   * { ok: true } or { ok: false, reason }. A lane joined already (a room's second member) is not joined again.
   */
  async _joinRelay (rec, lane, kind) {
    if (this.cfg.relay !== 'rendezvous') return null
    if (!this._ensureLink()) return { ok: false, reason: 'no-rendezvous' }
    let st = rec.p.rst
    if (st && st.joined && !st.dead && !st.left) return { ok: true }
    if (!st || st.dead || st.left) {
      st = this._newRelaySt(rec, lane, kind)
      rec.p.rst = st
    }
    this.lanes.set(lane, rec)
    return this._relayJoin(st, false)
  }

  async _relayJoin (st, again) {
    const rec = st.rec
    const link = this.link
    if (!link) return { ok: false, reason: 'link-down' }
    const epoch = this._epoch
    const ends = this._laneEnds
    this._repLane('join', st.peers)
    const r = await link.join(st.lane, st.kind)
    if (epoch !== this._epoch || rec.gone || st.dead || st.left) {
      // The conversation or room ended while the join was on its way, so _leaveLane had nothing to leave yet, and the rendezvous made this socket
      // a member all the same: it is left now. Otherwise the socket would keep a seat in the lane, and one of its 8, until it closes, and the
      // other side would write to a page that drops what it gets (finding A-2 of verify round 0). A path that strikes closed (dead, not left)
      // keeps its seat as _kill does; after a sign-out the socket itself is closed. The seat this frees goes to a lane that waits for one, as at
      // any other end of a lane (plan 3.6; finding A-5 of verify round 1): the leave is on the socket first, so the rendezvous frees the seat
      // before the join that _fillLanes sends.
      if (r.ok && epoch === this._epoch && this.link === link && (st.left || rec.gone) && !this._relayHolds(st.lane)) {
        this._laneEnds++
        link.leave(st.lane, st.kind).then(undefined, noop)
        this._fillLanes()
      }
      return { ok: false, reason: 'stopped' }
    }
    if (r.ok) {
      const n = this._peersOk(st, r.peers)
      this._repLane('joined', n === null ? 0 : n)
      st.pending = false
      st.tries = 0
      st.fullTold = false
      this._cancel(st.retry)
      st.retry = null
      if (rec.reason === 'no-path') rec.reason = null // the rendezvous carries messages after all (DEC-5)
      if (again) rec.p.wireEpoch++ // a lane joined again after the socket came back: what nobody acked goes again
      this._relayState(st, { joined: true, peers: n === null ? 0 : n })
      return { ok: true }
    }
    if (r.reason === 'lane-full') {
      // DEC-1: 'full' is told once per episode (the first refusal), and the join is asked again on the schedule of FULL_RETRY_MS
      if (!st.fullTold) {
        st.fullTold = true
        this._repLane('full', st.peers)
      }
      this._retryJoin(st)
    } else {
      const ev = LANE_FAIL[r.reason]
      if (ev) this._repLane(ev, st.peers)
      if (r.reason === 'too-many-lanes') {
        st.pending = true
        // a lane this socket gave up while the join was on its way may have come free after the rendezvous counted the join: the lanes that wait
        // are given the places again. Only then, once per such answer, so that a count of places that is off (a lane that strikes closed keeps its
        // seat, and _fillLanes does not count it) cannot make the page ask again in a loop (finding A-5 of verify round 1)
        if (this._laneEnds !== ends) this._fillLanes()
      }
      if (isRelayOff(r.reason)) this._noPath(rec) // the only path is refused for good: nothing is asked again (DEC-5)
    }
    return { ok: false, reason: r.reason }
  }

  /**
   * DEC-1: the join of a full lane is asked again after 3 s, 10 s, 30 s and then every 60 s (through the injected setTimeout, so tests drive
   * it), for as long as the conversation or room exists and the socket is open. A socket that is lost ends the schedule (_onLinkGone):
   * _rejoinAll asks on the next open, and a refusal there starts the schedule again without telling 'full' a second time.
   */
  _retryJoin (st) {
    this._cancel(st.retry)
    const wait = FULL_RETRY_MS[Math.min(st.tries, FULL_RETRY_MS.length - 1)]
    st.tries++
    st.retry = this._later(wait, () => {
      st.retry = null
      if (st.rec.gone || st.dead || st.left || st.joined || !this.link || this.link.state !== 'open') return
      this._relayJoin(st, false).then(undefined, noop)
    })
  }

  /**
   * DEC-5: a conversation or room whose only path the rendezvous refused for good (its relay is off, or it is from before the relay) says so
   * with reason 'no-path' instead of 'connecting' for ever; state() shows it and the UI tells the person. A direct lane the manager holds
   * (direct on, with WebRTC on the page) is a path that may still come up, so nothing is said then. _relayJoin clears it when a join works.
   */
  _noPath (rec) {
    if (rec.gone || rec.p.lanes.size > 0 || rec.reason === 'no-path') return
    rec.reason = 'no-path'
    if (rec.isRoom) this._repRoom(rec)
    else this._repConv(rec)
    this._touch()
  }

  /**
   * The socket came back (plan 3.6): the lanes of the live conversations and rooms are joined again, newest first and at most 8 (the socket's
   * own cap; the rest join when one of the 8 ends). A lane that strikes had closed starts clean. A lane the cap leaves out is marked pending,
   * as one refused with 'too many lanes' is, so that _fillLanes joins it when a place comes free; without the mark a lane that had been joined
   * before the socket went would wait for the next loss of the socket instead (finding A-1 of verify round 0).
   */
  async _rejoinAll () {
    if (!this.link) return
    const list = []
    const seen = new Set()
    for (const rec of Array.from(this.lanes.values()).reverse()) {
      let st = rec.p ? rec.p.rst : null
      if (!st || st.left || rec.gone || seen.has(rec)) continue
      seen.add(rec)
      if (st.dead) {
        st = this._newRelaySt(rec, st.lane, st.kind)
        rec.p.rst = st
      }
      this._cancel(st.retry) // the socket is back: a full lane is asked now, or when a place is free, not by the schedule of before (DEC-1)
      st.retry = null
      if (list.length < this.limits.relayLanesMax) list.push(st)
      else st.pending = true
    }
    await Promise.all(list.map((st) => this._relayJoin(st, true)))
  }

  // A lane ended: a lane the socket had no place for is joined now.
  _fillLanes () {
    let held = 0
    const waiting = []
    for (const rec of Array.from(this.lanes.values()).reverse()) {
      const st = rec.p ? rec.p.rst : null
      if (!st || st.left || st.dead || rec.gone) continue
      if (st.joined) held++
      else if (st.pending) waiting.push(st)
    }
    for (const st of waiting) {
      if (held >= this.limits.relayLanesMax) break
      held++
      this._relayJoin(st, false).then(undefined, noop)
    }
  }

  // A conversation or a room that got no lane: its relay st goes with its place in this.lanes, so that no later open of the socket joins it.
  _abandonRelay (rec) {
    const r = rec.p.rst
    if (!r || r.left) return
    this._cancel(r.retry)
    r.retry = null
    r.left = true
    r.dead = true
    r.ready = false
    if (this.lanes.get(r.lane) === rec) this.lanes.delete(r.lane)
  }

  /** The direct join of a lane: null when the door has no direct link, else whether the manager took the lane. */
  _joinDirect (rec, lane, kind) {
    if (this.cfg.direct !== 'on') return null
    return this._joinLane(rec, lane, kind)
  }

  /**
   * A conversation or a room with no lane to talk on: the direct join failed and there is no relay to fall back on, or the rendezvous does
   * not know the lane and no direct lane was joined. Any other failure of the relay (a full lane, a rendezvous with the relay off) leaves
   * it connecting, as a door with no transport does. direct and relay are the answers of _joinDirect and _joinRelay.
   */
  _noLane (direct, relay) {
    if (direct === true) return false
    if (relay === null) return direct === false
    return !relay.ok && (relay.reason === 'unknown-lane' || relay.reason === 'invalid-lane')
  }

  /**
   * Direct is the door's opt-in (plan D3): with it off nothing here touches the manager or WebRTC. Resolves to { off: true }, { ok: true }
   * once the manager is loaded, or { error } when it could not be (no WebRTC on this page, a manager that has the extension already).
   */
  async _directGate () {
    if (this.cfg.direct !== 'on') return { off: true }
    try {
      await this._ensureTm()
      return { ok: true }
    } catch (err) {
      return { error: err || new Error('no manager') }
    }
  }

  _onWire (wire, kind, info) {
    const ih = String(info.infoHash || (wire && wire.__mwInfoHash) || '').toLowerCase()
    const rec = this.lanes.get(ih)
    if (!rec || rec.gone || !wire || wire.type === 'webSeed' || wire.destroyed || typeof wire.use !== 'function') return
    // Wires that have not said they speak mw_apps1 are few and short-lived (ADV-4): past wiresSilentMax the oldest of them is closed,
    // so that wires which never speak cannot keep the real peer out. The wires that do speak are held to wiresPerPair / wiresPerRoom
    // when each one becomes ready (_wireReady).
    let silent = 0
    let oldest = null
    for (const x of rec.p.wires) {
      if (!x.ready && !x.dead) {
        silent++
        if (!oldest) oldest = x
      }
    }
    if (silent >= this.limits.wiresSilentMax) this._kill(oldest, 'crowded')
    const self = this
    const st = { wire, rec, lane: ih, ready: false, queue: Promise.resolve(), strikes: 0, drops: 0, dead: false, left: false, silent: null, heldRoster: null }
    class MwAppsExtension {
      constructor (w) { this.wire = w }
      onHandshake () {}
      onExtendedHandshake (h) { if (advertises(h, EXT_NAME)) self._wireReady(st) }
      onMessage (buf) { return self._wireMessage(st, buf) }
    }
    MwAppsExtension.prototype.name = EXT_NAME
    const late = info.late === true || wire._extendedHandshakeSent === true
    try { wire.use(MwAppsExtension) } catch (_) { return }
    rec.p.wires.add(st)
    if (typeof wire.once === 'function') wire.once('close', () => this._wireClosed(st))
    // A wire whose peer never says it speaks mw_apps1 would hold a place for good, and a few of them (a pair lane takes four) keep
    // the real peer out (ADV-4): it is closed when the time runs out.
    st.silent = this._later(this.limits.wireSilentMs, () => {
      st.silent = null
      if (!st.ready) this._kill(st, 'silent')
    })
    if (late) {
      if (typeof wire._sendExtendedHandshake === 'function') {
        try { wire._sendExtendedHandshake() } catch (_) { /* closing */ }
      }
      const mapping = wire.peerExtendedMapping
      if (mapping && mapping[EXT_NAME]) this._wireReady(st)
    }
  }

  _readyDirect (rec) {
    for (const st of rec.p.wires) if (st.ready && !st.dead && !st.wire.destroyed) return st
    return null
  }

  // The path a frame takes: the first ready direct wire, else the relay st when it is usable (plan 3.6)
  _readyWire (rec) {
    const d = this._readyDirect(rec)
    if (d) return d
    const r = rec.p.rst
    return r && this._relayUsable(r) ? r : null
  }

  _directCount (rec) {
    let n = 0
    for (const st of rec.p.wires) if (st.ready && !st.dead && !st.wire.destroyed) n++
    return n
  }

  // Who can be reached now: the ready direct wires, or the others in a usable relay lane when that is more
  _readyCount (rec) {
    const n = this._directCount(rec)
    const r = rec.p.rst
    return r && this._relayUsable(r) ? Math.max(n, r.peers) : n
  }

  _wireReady (st) {
    if (st.ready || st.dead || st.rec.gone) return
    const rec = st.rec
    if (this._directCount(rec) >= (rec.isRoom ? this.limits.wiresPerRoom : this.limits.wiresPerPair)) {
      this._kill(st, 'surplus')
      return
    }
    st.ready = true
    this._cancel(st.silent)
    st.silent = null
    rec.p.wireEpoch++
    this._repWire(st, 'up')
    if (rec.isRoom) this._roomWireUp(rec, st)
    else this._convWireUp(rec)
    this._touch()
  }

  _wireClosed (st) {
    st.dead = true
    this._cancel(st.silent)
    st.silent = null
    const rec = st.rec
    rec.p.wires.delete(st)
    this._repWire(st, 'down', st.left ? 'left' : (st.ready ? null : 'never-ready'))
    if (rec.gone) return
    if (!rec.isRoom) {
      if (!this._readyWire(rec)) {
        if (rec.status === 'connected') {
          rec.status = 'connecting'
          if (!st.left) this._repConv(rec)
        }
        rec.typingPeer = false
      } else {
        // another wire to the same person is up: what the closed one carried and nobody acked goes again
        rec.p.wireEpoch++
        this._flush(rec)
      }
    }
    this._touch()
  }

  _kill (st, reason) {
    if (st.dead) return
    const wasUsable = st.relay === true && this._relayUsable(st)
    st.dead = true
    this._repWire(st, 'kill', reason)
    this._cancel(st.silent)
    st.silent = null
    if (st.relay) {
      // the relay path of this lane is closed (until the next open of the socket joins it again): nothing is told to the manager, which has no
      // wire here, and the other side is not told either, the lane just goes unused
      st.ready = false
      this._repLane('dead', st.peers)
      if (wasUsable) this._relayDown(st, 'dead')
      return
    }
    st.rec.p.wires.delete(st) // the place is free at once, whether or not the manager closes the wire
    const tm = this.tm
    if (tm && typeof tm.ignoreWire === 'function') {
      try { tm.ignoreWire(st.wire, EXT_NAME + ':' + reason) } catch (_) { /* gone */ }
    } else {
      try { st.wire.destroy() } catch (_) { /* gone */ }
    }
  }

  _strike (st, reason) {
    if (st.dead) return
    this._repWire(st, 'strike', reason)
    st.strikes++
    if (st.strikes >= this.limits.strikesMax) this._kill(st, reason)
  }

  _wireMessage (st, buf) {
    if (st.dead || st.rec.gone) return undefined
    const raw = toBytes(buf)
    const bytes = raw ? new Uint8Array(raw) : null // a copy: frames are used after awaits and may be passed on
    if (!bytes || bytes.length > FRAME_MAX) {
      this._strike(st, 'size')
      return undefined
    }
    if (!st.rec.p.rx.take()) {
      st.drops++
      if (st.drops >= this.limits.floodMax) this._kill(st, 'flood')
      return undefined
    }
    const frame = decodeFrame(bytes)
    if (!frame) {
      this._strike(st, 'frame')
      return undefined
    }
    st.queue = st.queue.then(() => this._handleFrame(st, frame, bytes)).then(undefined, noop)
    return st.queue
  }

  async _handleFrame (st, frame, bytes) {
    const rec = st.rec
    if (st.dead || rec.gone) return undefined
    if (rec.isRoom) return this._handleRoomFrame(st, frame, bytes)
    if (frame.type !== T.DM) {
      this._strike(st, 'type')
      return undefined
    }
    return this._handleDm(st, frame.payload)
  }

  /** A frame id is accepted once, and only while its t is in the window. */
  _fresh (seen, id, t) {
    const now = this.now()
    if (!Number.isSafeInteger(t) || t > now + this.limits.frameFutureMs || t < now - this.limits.framePastMs) return false
    if (seen.has(id)) return false
    seen.set(id, t)
    if (seen.size > this.limits.seenMax) {
      let n = 0
      for (const k of seen.keys()) {
        seen.delete(k)
        if (++n > this.limits.seenMax / 4) break
      }
    }
    return true
  }

  // ---- direct messages: receiving -------------------------------------------------------------

  // The ivs of the frames this side sent lately, a bounded set (a frame has a fresh iv of its own). A frame that comes back with one of them is
  // this side's own, sent back by the rendezvous: it would not open here (it is sealed for the other direction) and it is not the other person's.
  _noteSent (p, iv) {
    if (typeof iv !== 'string') return
    p.sentIv.add(iv)
    if (p.sentIv.size > this.limits.seenMax) p.sentIv.delete(p.sentIv.values().next().value)
  }

  async _handleDm (st, payload) {
    const conv = st.rec
    const keys = this._keys()
    if (!keys || !conv.peer.ek) return
    if (payload && typeof payload.iv === 'string' && conv.p.sentIv.has(payload.iv)) return // this side's own frame, sent back
    const epoch = this._epoch
    const r = await openDmBody({ keys, peerEk: conv.peer.ek, payload, kPair: conv.p.kPair, now: this.now() })
    if (epoch !== this._epoch || conv.gone) return
    if (!r.ok) {
      this._strike(st, 'open-' + r.reason)
      return
    }
    conv.p.kPair = r.kPair
    if (!this._fresh(conv.p.seen, r.id, r.t)) return
    const t = this.now()
    conv.lastSeenAt = t
    // a frame that was still being opened when its wire closed does not make the person look connected
    if (conv.status === 'connecting' && !st.dead && this._readyWire(conv)) {
      conv.status = 'connected'
      conv.connectedAt = t
      this._repConv(conv)
    }
    this._applyBody(conv, r.body, st)
    this._touch()
  }

  _applyBody (conv, b, st) {
    switch (b.k) {
      case 'msg': return this._rxMsg(conv, b, st)
      case 'ack': return this._rxAck(conv, b)
      case 'read': return this._rxRead(conv, b)
      case 'typing': return this._rxTyping(conv, b)
      case 'react': return this._rxReact(conv, b, st)
      case 'edit': return this._rxEdit(conv, b, st)
      case 'del': return this._rxDel(conv, b, st)
      case 'cfg': return this._rxCfg(conv, b, st)
      case 'name': return this._rxName(conv, b)
      case 'bye': return this._rxBye(conv)
      default: return undefined // a kind a later version adds
    }
  }

  _ackOp (conv, b) {
    if (typeof b.o === 'string' && b.o.length <= 32) this._sendBody(conv, { k: 'ack', id: b.o }).then(undefined, noop)
  }

  _rxMsg (conv, b, st) {
    const text = typeof b.text === 'string' ? sanitizeText(b.text) : ''
    if (typeof b.id !== 'string' || !ID_RE.test(b.id) || !text || text.length > this.limits.textMax || !Number.isSafeInteger(b.t)) {
      this._strike(st, 'body')
      return
    }
    if (conv.byId.has(b.id) || conv.p.removed.has(b.id)) {
      // a repeat (our ack was lost) or a message this person already removed: acked again, not shown again
      this._sendBody(conv, { k: 'ack', id: b.id }).then(undefined, noop)
      return
    }
    const now = this.now()
    // The timer on a message is its author's: it applies to this message only, never below the page's smallest choice (ADV-2)
    const exp = Number.isSafeInteger(b.exp) && b.exp >= 1 && b.exp <= this.limits.expMaxMs ? Math.max(b.exp, this.limits.expRecvMinMs) : null
    const m = this._newMessage({
      id: b.id, t: Math.min(b.t, now), st: b.t, mine: false, text, reply: typeof b.reply === 'string' && ID_RE.test(b.reply) ? b.reply : null,
      prio: b.prio === true, exp, expAt: exp ? now + exp : null
    })
    this._insert(conv, m)
    conv.unread++
    this._repMsg(conv, 'received', 1)
    this._sendBody(conv, { k: 'ack', id: b.id }).then(undefined, noop)
    this._arm()
  }

  _rxAck (conv, b) {
    const id = typeof b.id === 'string' ? b.id : ''
    const at = conv.p.outbox.findIndex((x) => x.oid === id)
    if (at >= 0) {
      const item = conv.p.outbox.splice(at, 1)[0]
      this._cancel(item.timer)
    }
    const m = conv.byId.get(id)
    if (m && m.mine && (m.status === 'queued' || m.status === 'sent' || m.status === 'failed')) {
      m.status = 'delivered'
      this._repMsg(conv, 'delivered', 1)
    }
  }

  _rxRead (conv, b) {
    if (!conv.cfg.receipts || !Number.isSafeInteger(b.upTo)) return
    const now = this.now()
    let n = 0
    for (const m of conv.messages) {
      if (m.mine && !m.scheduled && m.t <= b.upTo && m.status !== 'read') {
        m.status = 'read'
        m.readAt = now
        n++
      }
    }
    this._repMsg(conv, 'read', n)
  }

  _rxTyping (conv, b) {
    if (!conv.cfg.typing) return
    this._cancel(conv.p.typingClear)
    conv.p.typingClear = null
    conv.typingPeer = b.on === true
    if (conv.typingPeer) {
      conv.p.typingClear = this._later(this.limits.typingShowMs, () => {
        conv.p.typingClear = null
        conv.typingPeer = false
        this._touch()
      })
    }
  }

  _rxReact (conv, b, st) {
    const m = typeof b.id === 'string' ? conv.byId.get(b.id) : null
    if (b.emoji !== null && !isEmoji(b.emoji)) {
      this._strike(st, 'body')
      return
    }
    if (m && !m.deleted) {
      const t = Number.isSafeInteger(b.t) ? b.t : this.now()
      if ((m.reactT[conv.peer.pub] || 0) <= t) {
        m.reactT[conv.peer.pub] = t
        this._setReaction(m, conv.peer.pub, b.emoji)
      }
    }
    this._ackOp(conv, b)
  }

  _rxEdit (conv, b, st) {
    const text = typeof b.text === 'string' ? sanitizeText(b.text) : ''
    if (typeof b.id !== 'string' || !text || text.length > this.limits.textMax || !Number.isSafeInteger(b.t)) {
      this._strike(st, 'body')
      return
    }
    const m = conv.byId.get(b.id)
    const t = Math.min(b.t, this.now())
    if (m && !m.mine && !m.deleted && t > (m.editedAt || m.t) && text !== m.text) {
      this._pushEdit(m, { t: m.editedAt || m.t, text: m.text })
      m.text = text
      m.editedAt = t
    }
    this._ackOp(conv, b)
  }

  _rxDel (conv, b, st) {
    if (typeof b.id !== 'string') {
      this._strike(st, 'body')
      return
    }
    const m = conv.byId.get(b.id)
    if (m && !m.mine) this._blank(m)
    else if (!m) this._tomb(conv, b.id)
    this._ackOp(conv, b)
  }

  // The other person's settings say what THEY do (ADV-2): their timer is for what they write, and it reaches this person's messages
  // only as the exp each of those carries. It never changes this person's own timer. A frame whose time is far from this clock is
  // dropped (acked, so the sender does not keep sending it): t = 2^53-1 would otherwise outrank every later frame of theirs.
  _rxCfg (conv, b, st) {
    if (!Number.isSafeInteger(b.t) || (b.exp !== null && b.exp !== undefined && !Number.isSafeInteger(b.exp))) {
      this._strike(st, 'body')
      return
    }
    if (Math.abs(b.t - this.now()) > this.limits.cfgSkewMs) {
      if (!conv.p.skewLogged) {
        conv.p.skewLogged = true
        this._log('cfg-time', b.t - this.now())
      }
      this._ackOp(conv, b)
      return
    }
    if (b.t >= conv.peerCfgT) {
      conv.peerCfgT = b.t
      if (typeof b.receipts === 'boolean') conv.peerCfg.receipts = b.receipts
      if (b.exp === undefined || b.exp === null) conv.peerCfg.exp = null
      else if (b.exp >= 1 && b.exp <= this.limits.expMaxMs) conv.peerCfg.exp = Math.max(b.exp, this.limits.expRecvMinMs)
    }
    this._ackOp(conv, b)
  }

  /** The earlier texts of a message are kept to editsMax; the oldest go first (ADV-5: 120 edits a minute of 3,500 characters). */
  _pushEdit (m, entry) {
    m.edits.push(entry)
    if (m.edits.length > this.limits.editsMax) m.edits.splice(0, m.edits.length - this.limits.editsMax)
  }

  _rxName (conv, b) {
    const name = cleanName(b.name)
    if (name) conv.peer.name = name
  }

  _rxBye (conv) {
    if (conv.status === 'left') return
    conv.status = 'left'
    this._repConv(conv)
    conv.typingPeer = false
    for (const item of conv.p.outbox) this._cancel(item.timer)
    conv.p.outbox.length = 0
    this._leaveLane(conv)
  }

  // ---- direct messages: model helpers ---------------------------------------------------------

  _newMessage (o) {
    return {
      id: o.id, t: o.t, st: o.st === undefined ? o.t : o.st, mine: o.mine, text: o.text, fmt: 'md1', reply: o.reply || null, status: o.mine ? (o.status || 'queued') : null,
      readAt: null, edits: [], editedAt: null, deleted: false, reactions: Object.create(null), reactT: Object.create(null), pinned: false, saved: false, important: false,
      prio: !!o.prio, exp: o.exp || null, expAt: o.expAt || null, sendAt: o.sendAt || null, scheduled: !!o.scheduled
    }
  }

  /** Messages stay in order of t (a late arrival with an older t goes before newer ones). */
  _insert (conv, m) {
    const list = conv.messages
    let i = list.length
    while (i > 0 && list[i - 1].t > m.t) i--
    list.splice(i, 0, m)
    conv.byId.set(m.id, m)
    this._trim(list, conv.byId, this.limits.convMessagesMax)
  }

  /**
   * Over the cap the oldest message of the other person goes first; what this person wrote, pinned or saved goes only when nothing
   * else is left. Otherwise a flood from the other side would push this person's own messages out of their history (ADV-3).
   */
  _trim (list, byId, max) {
    while (list.length > max) {
      let at = list.findIndex((x) => !x.mine && !x.pinned && !x.saved)
      if (at < 0) at = 0
      const old = list.splice(at, 1)[0]
      byId.delete(old.id)
    }
  }

  _setReaction (m, pub, emoji) {
    for (const e of Object.keys(m.reactions)) {
      const list = m.reactions[e]
      const at = list.indexOf(pub)
      if (at >= 0) list.splice(at, 1)
      if (!list.length) delete m.reactions[e]
    }
    if (emoji) {
      if (!m.reactions[emoji]) m.reactions[emoji] = []
      m.reactions[emoji].push(pub)
    }
  }

  _blank (m) {
    m.deleted = true
    m.text = ''
    m.edits = []
    m.reactions = Object.create(null)
    m.exp = null
    m.expAt = null
  }

  _newConv (o) {
    const lim = this.limits
    const svc = this
    const conv = {
      id: 'c' + this._newId(), isRoom: false, gone: false,
      get via () { return svc._viaOf(this) }, // 'direct' | 'relay' | null: what _readyWire would give now (plan 3.6)
      peer: Object.assign({ pub: null, ek: null, name: null, nick: null }, o.peer || {}),
      status: o.status, reason: null, silent: false, knock: o.knock || null, channel: o.channel || null, lostKnock: null,
      codeText: o.codeText || null, incoming: !!o.incoming, createdAt: this.now(), connectedAt: null, lastSeenAt: null,
      unread: 0, markedUnread: false, muted: false, pinned: false, archived: false, favorite: false, hidden: false,
      cfg: { exp: null, receipts: true, typing: true }, peerCfg: { exp: null, receipts: true }, peerCfgT: 0,
      compare: null, draft: '', note: '', typingPeer: false, messages: [], byId: new Map(),
      p: {
        lanes: new Map(), wires: new Set(), rst: null, wireEpoch: 0, kPair: null, sendN: 0, sentIv: new Set(), outbox: [], flushP: null, flushing: false, flushAgain: false,
        flushTimer: null, removed: new Set(), seen: new Map(), rx: this._bucket(lim.acceptPerMin, lim.acceptPerMin), tx: this._bucket(lim.sendPerMin, lim.sendPerMin),
        typingSentAt: 0, typingSentOn: false, typingClear: null, lastReadSent: 0, keyCode: o.keyCode || null, reknocks: 0, skewLogged: false
      }
    }
    this.convs.set(conv.id, conv)
    return conv
  }

  /** Both sides know both chat keys once a knock is accepted: K_pair and the compare code are ready before any wire. */
  async _startConv (conv, lane) {
    const keys = this._keys()
    const epoch = this._epoch
    try {
      conv.p.kPair = await kPairOf(keys, conv.peer.ek)
      conv.compare = await compareCode(conv.p.kPair)
    } catch (_) {
      conv.status = 'rejected'
      conv.reason = 'bad-key'
      this._repConv(conv)
      this._touch()
      return false
    }
    if (epoch !== this._epoch || conv.gone) return false
    // Both lanes (plan 3.6): the manager's when direct is on, and the relay's when the door has it, joined right after the accept
    const direct = this._joinDirect(conv, lane, 'chat')
    if (direct === false && this.tm && this.cfg.relay === 'rendezvous') this._repLane('direct-unavailable', null)
    const relay = await this._joinRelay(conv, lane, 'pair')
    if (epoch !== this._epoch || conv.gone) return false
    if (this._noLane(direct, relay)) {
      this._abandonRelay(conv)
      conv.status = 'rejected'
      conv.reason = 'bad-lane'
      this._repConv(conv)
      this._touch()
      return false
    }
    this._touch()
    return true
  }

  // ---- direct messages: sending ---------------------------------------------------------------

  async _sendBody (conv, body) {
    const keys = this._keys()
    if (!keys || !conv.peer.ek || !this._readyWire(conv)) return false
    const epoch = this._epoch
    let sealed
    try {
      sealed = await sealDmBody({ keys, peerEk: conv.peer.ek, body, now: this.now(), n: conv.p.sendN++, random: this.randomBytes })
    } catch (_) {
      return false
    }
    if (epoch !== this._epoch || conv.gone) return false
    if (!conv.p.kPair) conv.p.kPair = sealed.kPair
    const st = this._readyWire(conv)
    const bytes = st ? encodeFrame(T.DM, sealed.payload) : null
    if (!bytes) return false
    // The frame is known to this side before it leaves: a rendezvous that sends it back to its sender finds it dropped (_handleDm), so an echo
    // shows no message twice, settles no receipt of ours and costs no strike (plan 6.5)
    this._noteSent(conv.p, sealed.payload.iv)
    try {
      return await this._put(st, bytes)
    } catch (_) {
      return false
    }
  }

  _enqueue (conv, body, { msg = false } = {}) {
    const item = { oid: msg ? body.id : body.o, body, msg, tries: 0, sentEpoch: -1, timer: null, resend: false }
    conv.p.outbox.push(item)
    if (msg) item.timer = this._later(this.limits.ackTimeoutMs, () => this._ackTimeout(conv, item))
    this._flush(conv)
    return item
  }

  _ackTimeout (conv, item) {
    item.timer = null
    if (!conv.p.outbox.includes(item)) return
    const m = conv.byId.get(item.oid)
    if (m && m.mine && (m.status === 'queued' || m.status === 'sent')) {
      m.status = 'failed'
      this._repMsg(conv, 'failed', 1)
      this._touch()
    }
  }

  _flushLater (conv, ms) {
    if (conv.p.flushTimer !== null) return
    conv.p.flushTimer = this._later(ms + 5, () => {
      conv.p.flushTimer = null
      this._flush(conv)
    })
  }

  /** Sends what waits, in order, on the first ready wire: once per wire generation, paced by the lane's send rate. */
  _flush (conv) {
    const p = conv.p
    if (p.flushing) {
      p.flushAgain = true
      return p.flushP
    }
    p.flushing = true
    const epoch = this._epoch
    p.flushP = (async () => {
      let went = 0 // the messages whose status became 'sent' in this flush, told once at its end
      try {
        do {
          p.flushAgain = false
          for (const item of p.outbox.slice()) {
            if (epoch !== this._epoch || conv.gone) return
            if (!p.outbox.includes(item)) continue
            if (item.sentEpoch === p.wireEpoch && !item.resend) continue
            if (!this._readyWire(conv)) break
            if (!p.tx.take()) {
              this._flushLater(conv, p.tx.wait())
              break
            }
            item.resend = false
            const ok = await this._sendBody(conv, item.body)
            if (!ok) break
            item.sentEpoch = p.wireEpoch
            item.tries++
            if (item.msg) {
              const m = conv.byId.get(item.oid)
              if (m && m.mine && (m.status === 'queued' || m.status === 'failed')) {
                m.status = 'sent'
                went++
              }
              this._cancel(item.timer)
              item.timer = this._later(this.limits.ackTimeoutMs, () => this._ackTimeout(conv, item))
              this._touch()
            }
          }
        } while (p.flushAgain)
      } finally {
        p.flushing = false
        if (epoch === this._epoch && !conv.gone) this._repMsg(conv, 'sent', went)
      }
    })()
    return p.flushP
  }

  /** A wire came up: say who we are and what we set, then send what waited (the next wire resends what was not acked). */
  _convWireUp (conv) {
    const me = this._me()
    if (me && me.name) this._sendBody(conv, { k: 'name', name: me.name }).then(undefined, noop)
    this._sendBody(conv, { k: 'cfg', exp: conv.cfg.exp, receipts: conv.cfg.receipts, t: this.now() }).then(undefined, noop)
    if (conv.p.lastReadSent && conv.cfg.receipts) this._sendBody(conv, { k: 'read', upTo: conv.p.lastReadSent }).then(undefined, noop)
    this._flush(conv)
  }

  // ---- timers that come due: disappearing messages and send later -----------------------------

  _arm () {
    let next = Infinity
    for (const c of this.convs.values()) {
      for (const m of c.messages) {
        if (m.expAt && m.expAt < next) next = m.expAt
        if (m.scheduled && m.sendAt < next) next = m.sendAt
      }
    }
    if (next === Infinity) {
      this._cancel(this._sweepTimer)
      this._sweepTimer = null
      this._sweepAt = 0
      return
    }
    if (this._sweepTimer !== null && this._sweepAt <= next) return
    this._cancel(this._sweepTimer)
    this._sweepAt = next
    this._sweepTimer = this._later(Math.max(0, next - this.now()), () => {
      this._sweepTimer = null
      this._sweepAt = 0
      this._sweep()
    })
  }

  _sweep () {
    const t = this.now()
    for (const c of Array.from(this.convs.values())) {
      for (const m of c.messages.slice()) {
        if (m.scheduled && m.sendAt <= t) this._release(c, m)
        else if (m.expAt && m.expAt <= t) this._expire(c, m)
      }
    }
    this._touch()
    this._arm()
  }

  _tomb (conv, id) {
    const set = conv.p.removed
    set.add(id)
    if (set.size > this.limits.convMessagesMax) set.delete(set.values().next().value)
  }

  _forget (conv, m) {
    if (!m.mine) this._tomb(conv, m.id)
    const at = conv.messages.indexOf(m)
    if (at >= 0) conv.messages.splice(at, 1)
    conv.byId.delete(m.id)
    const o = conv.p.outbox.findIndex((x) => x.oid === m.id)
    if (o >= 0) this._cancel(conv.p.outbox.splice(o, 1)[0].timer)
  }

  _expire (conv, m) {
    this._forget(conv, m)
  }

  _msgBody (m) {
    const b = { k: 'msg', id: m.id, t: m.t, text: m.text, fmt: 'md1' }
    if (m.reply) b.reply = m.reply
    if (m.exp) b.exp = m.exp
    if (m.prio) b.prio = true
    return b
  }

  _release (conv, m) {
    const t = this.now()
    conv.messages.splice(conv.messages.indexOf(m), 1)
    m.scheduled = false
    m.sendAt = null
    m.t = t
    m.expAt = m.exp ? t + m.exp : null
    m.status = 'queued'
    this._insert(conv, m)
    this._repMsg(conv, 'queued', 1)
    this._enqueue(conv, this._msgBody(m), { msg: true })
  }

  // ---- direct messages: the calls -------------------------------------------------------------

  _conv (id) {
    return this.convs.get(id) || null
  }

  _sendBlock (conv) {
    if (!conv) return 'no conversation'
    if (conv.status === 'waiting') return 'waiting'
    if (conv.status === 'rejected') return 'rejected'
    if (conv.status === 'left') return 'left'
    if (conv.status === 'blocked') return 'blocked'
    return null
  }

  _expOf (v) {
    if (v === null || v === undefined) return { ok: true, exp: null }
    const n = Number(v)
    if (!Number.isFinite(n) || n < this.limits.expMinMs || n > this.limits.expMaxMs) return { ok: false }
    return { ok: true, exp: Math.round(n) }
  }

  /**
   * send(convId, text, { reply, exp, prio, at }) -> { id } | { error }. The message is sealed and sent as soon as a wire is up and
   * queued (status 'queued', then 'failed' after 20 s without an ack, retried on the next wire) while the other side is away.
   * at: a time in ms in the future makes it a scheduled message (cancelSend until it goes). exp: it disappears on both sides that
   * long after it was sent (the reader counts from receipt, and never less than 10 s); the default is this person's own setting for the
   * conversation, never the other person's (ADV-2). Errors: no-conversation, waiting, rejected, left, blocked,
   * not-ready, empty, too-long (3,500 characters, and the sealed body must fit one frame), too-far, bad-input.
   */
  async send (convId, text, opts = {}) {
    const conv = this._conv(convId)
    const bad = this._sendBlock(conv)
    if (bad) return { error: bad }
    if (!this._keys()) return { error: 'not ready' }
    const clean = sanitizeText(text)
    if (!clean.trim()) return { error: 'empty' }
    if (clean.length > this.limits.textMax) return { error: 'too long' }
    const o = opts || {}
    const e = this._expOf(o.exp === undefined ? conv.cfg.exp : o.exp)
    if (!e.ok) return { error: 'bad input' }
    const now = this.now()
    const at = o.at === undefined || o.at === null ? null : Number(o.at)
    if (at !== null && !Number.isFinite(at)) return { error: 'bad input' }
    const later = at !== null && at > now + 1000
    if (later && at - now > this.limits.scheduleMaxMs) return { error: 'too far' }
    const m = this._newMessage({
      id: this._newId(), t: later ? Math.round(at) : now, mine: true, text: clean,
      reply: typeof o.reply === 'string' && conv.byId.has(o.reply) ? o.reply : null, prio: o.prio === true, exp: e.exp,
      expAt: !later && e.exp ? now + e.exp : null, scheduled: later, sendAt: later ? Math.round(at) : null, status: 'queued'
    })
    const body = this._msgBody(m)
    if (dmBodySize(body) > DM_BODY_MAX) return { error: 'too long' }
    this._insert(conv, m)
    this._repMsg(conv, later ? 'scheduled' : 'queued', 1)
    if (later) this._arm()
    else {
      if (m.expAt) this._arm()
      this._enqueue(conv, body, { msg: true })
    }
    this._touch()
    return { id: m.id }
  }

  /** resend(convId, id) -> { ok }: tries a failed (or waiting) message again now. */
  async resend (convId, id) {
    const conv = this._conv(convId)
    if (!conv) return { error: 'no conversation' }
    const item = conv.p.outbox.find((x) => x.oid === id)
    if (!item) return { error: 'no message' }
    item.resend = true
    this._flush(conv)
    return { ok: true }
  }

  /** cancelSend(convId, id) -> { ok } | { error: 'not scheduled' }: a scheduled message that has not gone yet is removed. */
  async cancelSend (convId, id) {
    const conv = this._conv(convId)
    if (!conv) return { error: 'no conversation' }
    const m = conv.byId.get(id)
    if (!m || !m.scheduled) return { error: 'not scheduled' }
    this._forget(conv, m)
    this._arm()
    this._touch()
    return { ok: true }
  }

  /** edit(convId, id, text) -> { ok } | { error }: changes one of this person's messages; the earlier text stays in edits. */
  async edit (convId, id, text) {
    const conv = this._conv(convId)
    const bad = this._sendBlock(conv)
    if (bad) return { error: bad }
    const m = conv.byId.get(id)
    if (!m) return { error: 'no message' }
    if (!m.mine || m.deleted) return { error: 'not yours' }
    const clean = sanitizeText(text)
    if (!clean.trim()) return { error: 'empty' }
    if (clean.length > this.limits.textMax) return { error: 'too long' }
    if (clean === m.text) return { ok: true }
    const now = this.now()
    if (m.scheduled) {
      m.text = clean
      this._touch()
      return { ok: true }
    }
    const body = { k: 'edit', id, text: clean, t: now, o: this._newId() }
    if (dmBodySize(body) > DM_BODY_MAX) return { error: 'too long' }
    this._pushEdit(m, { t: m.editedAt || m.t, text: m.text })
    m.text = clean
    m.editedAt = now
    this._enqueue(conv, body)
    this._touch()
    return { ok: true }
  }

  /**
   * remove(convId, id, { both }) -> { ok } | { error }: both false removes the message here only; both true (own messages) shows it
   * as deleted here and asks the other side to do the same.
   */
  async remove (convId, id, opts = {}) {
    const conv = this._conv(convId)
    if (!conv) return { error: 'no conversation' }
    const m = conv.byId.get(id)
    if (!m) return { error: 'no message' }
    const both = !!(opts && opts.both)
    if (m.scheduled || !both) {
      this._forget(conv, m)
    } else {
      if (!m.mine) return { error: 'not yours' }
      if (!m.deleted) {
        const first = conv.p.outbox.find((x) => x.oid === id && x.msg)
        const never = !!first && first.tries === 0
        conv.p.outbox = conv.p.outbox.filter((x) => {
          const drop = x.body.id === id && x.body.k !== 'del' && (x.msg || x.tries === 0)
          if (drop) this._cancel(x.timer)
          return !drop
        })
        if (never) {
          this._forget(conv, m)
        } else {
          this._blank(m)
          this._enqueue(conv, { k: 'del', id, o: this._newId() })
        }
      }
    }
    this._arm()
    this._touch()
    return { ok: true }
  }

  /** react(convId, id, emoji | null) -> { ok }: one reaction per person per message; null takes it back. */
  async react (convId, id, emoji) {
    const conv = this._conv(convId)
    const bad = this._sendBlock(conv)
    if (bad) return { error: bad }
    const m = conv.byId.get(id)
    if (!m || m.deleted) return { error: 'no message' }
    if (emoji !== null && !isEmoji(emoji)) return { error: 'bad input' }
    const t = this.now()
    m.reactT[this._pub] = t
    this._setReaction(m, this._pub, emoji)
    conv.p.outbox = conv.p.outbox.filter((x) => {
      const drop = x.body.k === 'react' && x.body.id === id && x.tries === 0
      if (drop) this._cancel(x.timer)
      return !drop
    })
    this._enqueue(conv, { k: 'react', id, emoji, t, o: this._newId() })
    this._touch()
    return { ok: true }
  }

  /** markRead(convId) -> { ok }: the unread counter goes to 0 and, when read receipts are on, the other side is told. */
  async markRead (convId) {
    const conv = this._conv(convId)
    if (!conv) return { error: 'no conversation' }
    const now = this.now()
    let upTo = 0
    for (const m of conv.messages) {
      if (m.mine) continue
      if (m.readAt === null) m.readAt = now
      if (m.st > upTo) upTo = m.st
    }
    const had = conv.unread > 0 || conv.markedUnread
    conv.unread = 0
    conv.markedUnread = false
    if (conv.cfg.receipts && upTo > conv.p.lastReadSent) {
      conv.p.lastReadSent = upTo
      this._sendBody(conv, { k: 'read', upTo }).then(undefined, noop)
    }
    if (had) this._touch()
    return { ok: true }
  }

  /** markUnread(convId) -> { ok }: shows the conversation as unread again. */
  async markUnread (convId) {
    const conv = this._conv(convId)
    if (!conv) return { error: 'no conversation' }
    conv.markedUnread = true
    this._touch()
    return { ok: true }
  }

  /** typing(convId, on) -> { ok }: at most one mark every 3 seconds, never stored, only when the typing setting is on. */
  async typing (convId, on) {
    const conv = this._conv(convId)
    if (!conv) return { error: 'no conversation' }
    if (!conv.cfg.typing || (conv.status !== 'connected' && conv.status !== 'connecting')) return { ok: true }
    const p = conv.p
    const t = this.now()
    // over the relay a mark never competes with a frame that waits: none while the outbox is not empty (plan 3.6); a mark that was not sent
    // is not a mark sent, and the other side's indicator runs out by itself
    const way = this._readyWire(conv)
    const busy = !!way && way.relay === true && p.outbox.length > 0
    if (on) {
      if (busy || t - p.typingSentAt < this.limits.typingSendMs) return { ok: true }
      p.typingSentAt = t
      p.typingSentOn = true
      this._sendBody(conv, { k: 'typing', on: true }).then(undefined, noop)
    } else if (p.typingSentOn) {
      p.typingSentOn = false
      p.typingSentAt = 0
      if (!busy) this._sendBody(conv, { k: 'typing', on: false }).then(undefined, noop)
    }
    return { ok: true }
  }

  /** block(pub) -> { ok }: ends conversations with that key and refuses its knocks (silently, after a random wait). */
  async block (pub) {
    if (typeof pub !== 'string' || !pub) return { error: 'bad input' }
    this.blocked.add(pub)
    for (const c of this.convs.values()) {
      if (c.peer.pub !== pub || c.status === 'blocked') continue
      this._wind(c)
      c.status = 'blocked'
      this._repConv(c)
    }
    for (const q of Array.from(this.requests.values())) {
      if (q.hello.pub !== pub) continue
      this._dropRequest(q.knock)
      this._rep('request', { ev: 'reject', kind: q.kind, reason: 'blocked' })
      if (this.link) this.link.reject({ kind: q.kind, knock: q.knock }).then(undefined, noop)
    }
    this._touch()
    return { ok: true }
  }

  /** unblock(pub) -> { ok }: knocks are shown again; a blocked conversation becomes 'left' (a new code starts a new one). */
  async unblock (pub) {
    this.blocked.delete(pub)
    for (const c of this.convs.values()) {
      if (c.peer.pub === pub && c.status === 'blocked') {
        c.status = 'left'
        this._repConv(c)
      }
    }
    this._touch()
    return { ok: true }
  }

  /** Ends the traffic of a conversation: its lane is left, queued work is dropped. */
  _wind (conv) {
    for (const item of conv.p.outbox) this._cancel(item.timer)
    conv.p.outbox.length = 0
    this._cancel(conv.p.typingClear)
    this._cancel(conv.p.flushTimer)
    conv.p.typingClear = null
    conv.p.flushTimer = null
    conv.typingPeer = false
    this._leaveLane(conv)
  }

  /**
   * setCfg(convId, { exp, receipts, typing }) -> { ok } | { error }. exp (ms or null) and receipts are told to the other side.
   * The timer is per author: it is the default timer of the messages this person writes (each carries its own exp), and it never
   * changes what the other person writes; the other person's timer reaches this side as peerCfg.exp, for display only. typing is
   * this person's own setting.
   */
  async setCfg (convId, patch = {}) {
    const conv = this._conv(convId)
    if (!conv) return { error: 'no conversation' }
    const p = patch || {}
    let announce = false
    if (Object.prototype.hasOwnProperty.call(p, 'exp')) {
      const e = this._expOf(p.exp)
      if (!e.ok) return { error: 'bad input' }
      if (e.exp !== conv.cfg.exp) {
        conv.cfg.exp = e.exp
        announce = true
      }
    }
    if (typeof p.receipts === 'boolean' && p.receipts !== conv.cfg.receipts) {
      conv.cfg.receipts = p.receipts
      announce = true
    }
    if (typeof p.typing === 'boolean') conv.cfg.typing = p.typing
    if (announce && !this._sendBlock(conv)) {
      conv.p.outbox = conv.p.outbox.filter((x) => {
        const drop = x.body.k === 'cfg' && x.tries === 0
        return !drop
      })
      this._enqueue(conv, { k: 'cfg', exp: conv.cfg.exp, receipts: conv.cfg.receipts, t: this.now(), o: this._newId() })
    }
    this._touch()
    return { ok: true }
  }

  /** setNickname(convId, name) -> { ok }: a name only this person sees. */
  async setNickname (convId, name) {
    const conv = this._conv(convId)
    if (!conv) return { error: 'no conversation' }
    conv.peer.nick = cleanName(name) || null
    this._touch()
    return { ok: true }
  }

  /** setFlags(convId, { muted, pinned, archived, favorite, hidden }) -> { ok }: this person's own marks on a conversation. */
  async setFlags (convId, patch = {}) {
    const conv = this._conv(convId)
    if (!conv) return { error: 'no conversation' }
    for (const k of ['muted', 'pinned', 'archived', 'favorite', 'hidden']) {
      if (patch && typeof patch[k] === 'boolean') conv[k] = patch[k]
    }
    this._touch()
    return { ok: true }
  }

  /** setFlag(convId, flag, on) -> { ok }: one mark of setFlags. */
  setFlag (convId, flag, on) {
    return this.setFlags(convId, { [flag]: !!on })
  }

  /** retry(convId, id) -> { ok }: the same as resend (the button on a failed message). */
  retry (convId, id) {
    return this.resend(convId, id)
  }

  /** setMessageFlag(convId, id, 'pinned' | 'saved' | 'important', on) -> { ok }: this person's own marks on a message. */
  async setMessageFlag (convId, id, flag, on) {
    const conv = this._conv(convId)
    if (!conv) return { error: 'no conversation' }
    const m = conv.byId.get(id)
    if (!m) return { error: 'no message' }
    if (flag !== 'pinned' && flag !== 'saved' && flag !== 'important') return { error: 'bad input' }
    m[flag] = !!on
    this._touch()
    return { ok: true }
  }

  /** setDraft(convId, text) / setNote(convId, text): kept in memory per conversation; they do not raise a change event. */
  setDraft (convId, text) {
    return this._keep(convId, 'draft', String(text === undefined || text === null ? '' : text).slice(0, this.limits.textMax))
  }

  setNote (convId, text) {
    return this._keep(convId, 'note', String(text === undefined || text === null ? '' : text).slice(0, 2000))
  }

  _keep (id, field, value) {
    const rec = this.convs.get(id) || this.rooms.get(id)
    if (!rec) return { error: 'no conversation' }
    rec[field] = value
    if (this._snap) {
      const list = rec.isRoom ? this._snap.rooms : this._snap.conversations
      const s = list.find((x) => x.id === id)
      if (s && field in s) s[field] = value
    }
    return { ok: true }
  }

  /** addSnippet(text) -> { id } | { error }; removeSnippet(id) -> { ok }: short texts kept for this visit. */
  addSnippet (text) {
    const clean = sanitizeText(text).trim().slice(0, 500)
    if (!clean) return { error: 'empty' }
    if (this.snippets.length >= 50) return { error: 'too long' }
    const s = { id: this._newId(), text: clean }
    this.snippets.push(s)
    this._touch()
    return { id: s.id }
  }

  removeSnippet (id) {
    const at = this.snippets.findIndex((s) => s.id === id)
    if (at < 0) return { error: 'no message' }
    this.snippets.splice(at, 1)
    this._touch()
    return { ok: true }
  }

  /** search(convId, query) -> [{ id, index, t, mine, ranges }]: see apps-format.js searchMessages. */
  search (convId, query) {
    const conv = this._conv(convId)
    return conv ? searchMessages(conv.messages, query) : []
  }

  /** exportData(convId) -> { ok, fileName, mime, text, data } | { error }: the conversation as a file the visitor saves. */
  exportData (convId) {
    const conv = this._conv(convId)
    if (!conv) return { error: 'no conversation' }
    const snap = this._snapConv(conv)
    const data = exportConversation({ conv: snap, me: this._me(), now: this.now() })
    return { ok: true, fileName: exportFileName(snap, this.now()), mime: 'application/json', text: JSON.stringify(data, null, 2), data }
  }

  /** exportJson(convId) -> the JSON text of the export (a string), or { error }; exportData also gives the file name. */
  exportJson (convId) {
    const r = this.exportData(convId)
    return r.ok ? r.text : r
  }

  /** verifyCode(convId) -> { code: '12345678' } | { error }: the 8 digits both people read to each other (from K_pair). */
  async verifyCode (convId) {
    const conv = this._conv(convId)
    if (!conv) return { error: 'no conversation' }
    if (!conv.compare) return { error: 'waiting' }
    return { code: conv.compare }
  }

  /** clear(convId) -> { ok }: removes every message of the conversation here (the other side keeps its own). */
  async clear (convId) {
    const conv = this._conv(convId)
    if (!conv) return { error: 'no conversation' }
    for (const item of conv.p.outbox) this._cancel(item.timer)
    conv.p.outbox.length = 0
    for (const m of conv.messages) if (!m.mine) this._tomb(conv, m.id)
    conv.messages.length = 0
    conv.byId.clear()
    conv.unread = 0
    conv.markedUnread = false
    this._arm()
    this._touch()
    return { ok: true }
  }

  /** leave(convId) -> { ok }: tells the other side, leaves the lane and removes the conversation (export first to keep it). */
  async leave (convId) {
    const conv = this._conv(convId)
    if (!conv) return { error: 'no conversation' }
    if (conv.status === 'waiting') {
      if (conv.knock) return this.cancelKnock(conv.knock)
      this.convs.delete(conv.id)
      this._repGone(conv, 'cancelled')
      this._touch()
      return { ok: true }
    }
    if (conv.status === 'connected' || conv.status === 'connecting') {
      await this._sendBody(conv, { k: 'bye' })
      if (this.limits.byeGraceMs > 0) await new Promise((resolve) => this._later(this.limits.byeGraceMs, resolve))
    }
    this._wind(conv)
    conv.gone = true
    this.convs.delete(conv.id)
    this._repGone(conv, 'left')
    this._arm()
    this._touch()
    return { ok: true }
  }

  // ---- rooms ----------------------------------------------------------------------------------

  _newRoom (o) {
    const lim = this.limits
    const svc = this
    const room = {
      id: 'r' + this._newId(), isRoom: true, gone: false, owner: !!o.owner, status: o.status, reason: null, silent: false,
      get via () { return svc._viaOf(this) },
      knock: o.knock || null, channel: o.channel || null, lostKnock: null, code: o.code || null, box: o.box || null,
      keyCode: o.keyCode || null, codeOpen: !!o.codeOpen, codeClosed: null, registered: !!o.registered, bad: 0, seen: new Set(),
      ownerPub: o.ownerPub || null, ownerEk: o.ownerEk || null, members: o.members || [], seq: o.seq || 0, lane: o.lane || null,
      messages: [], byId: new Map(), unread: 0, draft: '',
      p: {
        lanes: new Map(), wires: new Set(), rst: null, wireEpoch: 0, secret: o.secret || null, keyCode: o.keyCode || null, sendN: 0,
        seen: new Map(), rx: this._bucket(lim.roomAcceptPerMin, lim.roomAcceptPerMin), tx: this._bucket(lim.sendPerMin, lim.sendPerMin),
        pending: [], outq: [], rosters: new Map(), keyFrames: new Map(), cache: { roster: null, keys: new Map() }, flushP: null, flushing: false, flushAgain: false, flushTimer: null, reknocks: 0,
        // the room state on the relay (finding A-3 of verify round 0). The owner's side: needKey, the members it has not heard from since it
        // accepted them, whose sealed secrets it still puts on the relay; one run of _relayRoomState at a time (stateP), and stateAgain when a
        // call came while it ran. A member's side: keyEpk, the epk of the box that gave it the secret, and inAt, when its last 'in' went on the relay.
        needKey: new Set(), stateP: null, stateBusy: false, stateAgain: false, keyEpk: null, inAt: null
      }
    }
    this.rooms.set(room.id, room)
    return room
  }

  _roomByChannel (channel) {
    for (const r of this.rooms.values()) if (r.owner && r.codeOpen && r.channel === channel) return r
    return null
  }

  /** createRoom() -> { id, code } | { error }: a room this person owns; the code lets others ask to join, the owner decides. */
  async createRoom () {
    const r = await this._createRoom()
    if (r.error) this._rep('code', { ev: 'error', kind: 'room', why: word(String(r.error).replace(/ /g, '-')) })
    return r
  }

  async _createRoom () {
    const g = this._gate()
    if (g.error) return g
    let owned = 0
    for (const r of this.rooms.values()) if (r.owner && r.status !== 'closed') owned++
    if (owned >= this.limits.roomsOwnedMax) return { error: 'too many rooms' }
    const me = this._me()
    for (let attempt = 0; attempt < 5; attempt++) {
      const code = generateCode(this.randomBytes)
      const sp = splitCode(code)
      const keyCode = await codeKey(sp.secret, sp.channel)
      const { box } = await sealHello({ keyCode, channel: sp.channel, role: 'owner', keys: g.keys, name: me.name, now: this.now(), random: this.randomBytes })
      if (g.epoch !== this._epoch) return { error: 'not signed in' }
      const r = await g.link.openCode({ kind: 'room', channel: sp.channel, box })
      if (g.epoch !== this._epoch) return { error: 'not signed in' }
      if (r.ok) {
        const room = this._newRoom({
          owner: true, status: 'open', code, channel: sp.channel, box, codeOpen: true, registered: true, keyCode,
          ownerPub: me.pub, ownerEk: g.keys.chat.pub, members: [{ pub: me.pub, ek: g.keys.chat.pub, name: me.name || '' }], seq: 1,
          lane: r.lane, secret: this.randomBytes(32)
        })
        this._repCode('opened', 'user', sp.channel, 'room')
        this._repRoom(room)
        this._touch()
        return { id: room.id, code: formatCode(code) }
      }
      if (r.reason !== 'channel-taken') return { error: errorOf(r.reason) }
    }
    return { error: 'channel taken' }
  }

  /** joinRoom(codeText) -> { knock, id } | { error }: asks the owner of a room code to let this person in. */
  async joinRoom (codeText) {
    const sp = splitCode(codeText)
    if (!sp) return this._knockFail('room', null, 'bad code')
    const g = this._gate()
    if (g.error) return this._knockFail('room', sp.channel, g.error)
    for (const r of this.rooms.values()) if (r.owner && r.code === sp.code) return this._knockFail('room', sp.channel, 'own code')
    for (const r of this.rooms.values()) if (r.status === 'waiting' && r.channel === sp.channel) return this._knockFail('room', sp.channel, 'already knocked')
    if (this._waitingCount() >= this.limits.knocksOutMax || !this._knockOk()) return this._knockFail('room', sp.channel, 'rate limited')
    const keyCode = await codeKey(sp.secret, sp.channel)
    const { box } = await sealHello({ keyCode, channel: sp.channel, role: 'knock', keys: g.keys, name: this._me().name, now: this.now(), random: this.randomBytes })
    if (g.epoch !== this._epoch) return { error: 'not signed in' }
    this._rep('knock', { ev: 'sent', kind: 'room', channel: sp.channel })
    const r = await g.link.knock({ kind: 'room', channel: sp.channel, box })
    if (g.epoch !== this._epoch) return { error: 'not signed in' }
    if (!r.ok) return this._knockFail('room', sp.channel, errorOf(r.reason), reasonWord(r.reason))
    const room = this._newRoom({ owner: false, status: 'waiting', knock: r.knock, channel: sp.channel, keyCode })
    this._rep('knock', { ev: 'ok', kind: 'room', channel: sp.channel })
    this._repRoom(room)
    this._touch()
    return { knock: r.knock, id: room.id }
  }

  acceptMember (knock) {
    return this.accept(knock)
  }

  rejectMember (knock) {
    return this.reject(knock)
  }

  async _acceptMember (q, g) {
    const room = q.room
    if (!room || !this.rooms.has(room.id) || !room.codeOpen) {
      this._dropRequest(q.knock, 'room-gone')
      return { error: 'no request' }
    }
    if (room.members.length >= this.limits.roomMembersMax) return { error: 'room full' }
    const direct = await this._directGate()
    if (direct.error && this.cfg.relay !== 'rendezvous') return { error: direct.error.code === 'E_EXISTS' ? 'manager busy' : 'no manager' }
    if (g.epoch !== this._epoch || this.requests.get(q.knock) !== q) return { error: 'no request' }
    if (direct.error) this._repLane('direct-unavailable', null)
    const proof = await signAccept({ keys: g.keys, channel: q.channel, knock: q.knock })
    if (g.epoch !== this._epoch || this.requests.get(q.knock) !== q) return { error: 'no request' }
    const r = await g.link.accept({ kind: 'room', knock: q.knock, proof })
    this._dropRequest(q.knock)
    if (g.epoch !== this._epoch) return { error: 'not signed in' }
    if (!r.ok) return { error: errorOf(r.reason) }
    this._rep('request', { ev: 'accept', kind: 'room' })
    const h = q.hello
    room.members.push({ pub: h.pub, ek: h.ek, name: cleanName(h.name || '') })
    room.p.needKey.add(h.pub) // its sealed secret goes on the relay until the owner hears from it (_relayRoomState)
    room.seq++
    await this._joinRoomLane(room, room.lane)
    this._repRoom(room, 'member-joined')
    this._touch()
    await this._publishRoster(room)
    return { id: room.id }
  }

  // Both lanes of a room: the torrent manager's when direct is on, the relay's when the door has it. With only the direct one this answers at
  // once, as it always did; with the relay it answers when the rendezvous has. A room that has no lane at all is 'bad-lane' for a member.
  _joinRoomLane (room, lane) {
    if (!room.lane) room.lane = lane
    const direct = this._joinDirect(room, lane, 'group')
    const done = (relay) => {
      if (!this._noLane(direct, relay)) return true
      this._abandonRelay(room)
      room.status = room.owner ? room.status : 'rejected'
      room.reason = 'bad-lane'
      this._repRoom(room)
      return false
    }
    if (this.cfg.relay !== 'rendezvous') return done(null)
    return this._joinRelay(room, lane, 'room').then(done)
  }

  async _closeRoomCode (room, why) {
    if (!room.codeOpen) return
    room.codeOpen = false
    room.codeClosed = why
    this._repCode('closed', why, room.channel, 'room')
    for (const q of Array.from(this.requests.values())) if (q.room === room) this._dropRequest(q.knock, 'code-closed')
    this._touch()
    if (this.link) await this.link.closeCode({ kind: 'room', channel: room.channel })
  }

  // The owner's socket came back: the room code opens again on the same channel. A lane other than the one the room has would
  // split it, so a changed lane leaves the code closed (members already inside are not affected).
  async _reopenRoom (room) {
    const epoch = this._epoch
    const keys = this._keys()
    if (!keys || !this.link) return
    const { box } = await sealHello({ keyCode: room.p.keyCode, channel: room.channel, role: 'owner', keys, name: this._me().name, now: this.now(), random: this.randomBytes })
    if (epoch !== this._epoch || !this.rooms.has(room.id)) return
    room.box = box
    const r = await this.link.openCode({ kind: 'room', channel: room.channel, box })
    if (epoch !== this._epoch || !this.rooms.has(room.id)) return
    if (r.ok && (r.lane === room.lane || (room.members.length === 1 && room.p.lanes.size === 0))) {
      // nobody is in the room yet, so the lane the rendezvous minted now is as good as the one it minted first
      room.lane = r.lane
      room.registered = true
      this._repCode('opened', 'reconnect', room.channel, 'room')
    } else if (r.ok) {
      room.codeOpen = false
      room.codeClosed = 'lane-changed'
      this._repCode('closed', 'lane-changed', room.channel, 'room')
      await this.link.closeCode({ kind: 'room', channel: room.channel })
    } else if (r.reason === 'channel-taken') {
      room.codeOpen = false
      room.codeClosed = 'channel-taken'
      this._repCode('closed', 'channel-taken', room.channel, 'room')
    }
    this._touch()
  }

  // A frame passed on to the direct wires of the room, except the one it came from. The relay is not one of them: it fanned the frame out to every
  // member already, so a frame is never put on the relay twice.
  _roomBroadcast (room, bytes, exceptSt) {
    let n = 0
    for (const st of room.p.wires) {
      if (st === exceptSt || !st.ready || st.dead || st.wire.destroyed) continue
      try {
        this._put(st, bytes)
        n++
      } catch (_) { /* a closing wire */ }
    }
    return n
  }

  // A frame this person makes (the roster, a message, the goodbye): every ready direct wire at once, and the relay once, which fans it out to the
  // other members. Resolves to how many paths took it.
  async _roomSend (room, bytes) {
    let n = this._roomBroadcast(room, bytes, null)
    const r = room.p.rst
    if (r && this._relayUsable(r) && (await this._put(r, bytes))) n++
    return n
  }

  _relay (room, st, bytes, key) {
    if (!this._fresh(room.p.seen, key, this.now())) return
    this._roomBroadcast(room, bytes, st)
  }

  // The roster goes out sealed under the room secret (ADV-1): a peer of the lane that was never accepted sees a box it cannot open.
  async _rosterFrame (room) {
    const keys = this._keys()
    const cached = room.p.rosters.get(room.lane)
    if (cached && cached.seq === room.seq) return cached.bytes
    const sealed = await sealRoster({
      keys, secret: room.p.secret, lane: room.lane, seq: room.seq, members: room.members.map((m) => ({ pub: m.pub, name: m.name || '' })),
      t: this.now(), n: room.p.sendN++, random: this.randomBytes
    })
    const bytes = encodeFrame(T.ROSTER, sealed.payload)
    room.p.rosters.set(room.lane, { seq: room.seq, bytes })
    return bytes
  }

  // The room secret sealed to each member, one box per member; with only, to the members in that set alone. The cache holds the sealing itself,
  // not only its result, so that two passes that overlap (the accept's and a joined push's) hand out the same box: a member keeps the key of the
  // box that gave it the secret and says again that it holds it when that box comes back (_sayIn), and it would take a second box for another
  // member's (found in the full run of fix round 2, a race of the code of round 1). A sealing that fails is not kept.
  async _keyFrames (room, only = null) {
    const keys = this._keys()
    const out = []
    for (const m of room.members) {
      if (m.pub === room.ownerPub || (only && !only.has(m.pub))) continue
      let box = room.p.keyFrames.get(m.pub)
      if (!box) {
        box = sealRoomKey({ keys, memberEk: m.ek, secret: room.p.secret, lane: room.lane, ownerPub: room.ownerPub }).then((payload) => encodeFrame(T.ROOM_KEY, payload))
        const sealing = box
        room.p.keyFrames.set(m.pub, sealing)
        sealing.then(undefined, () => { if (room.p.keyFrames.get(m.pub) === sealing) room.p.keyFrames.delete(m.pub) })
      }
      out.push(await box)
    }
    return out
  }

  /**
   * The owner gives every wire the roster sealed under the room secret, then the secret sealed to each member's key. The roster goes
   * first: a member that has no secret yet keeps it, and reads it when its secret arrives, so the room shows its members when it shows
   * as connected. A wire that is not a member's sees boxes it cannot open. The relay gets what _relayRoomState puts on it, not all of it, and
   * the accept does not wait for it: when the socket's minute is full (apps-link.js) those frames wait in the link, the accept does not.
   */
  async _publishRoster (room) {
    const epoch = this._epoch
    if (!room.owner || !this._keys()) return
    const roster = await this._rosterFrame(room)
    const keys = await this._keyFrames(room)
    if (epoch !== this._epoch || room.gone) return
    this._roomBroadcast(room, roster, null)
    for (const k of keys) this._roomBroadcast(room, k, null)
    this._relayRoomState(room).then(undefined, noop)
  }

  // The whole state on one direct wire (its peer may be any member); on the relay, _relayRoomState. The first frame a wire refuses ends it.
  async _sendRoomState (room, st) {
    if (st.relay) return this._relayRoomState(room)
    const epoch = this._epoch
    const roster = await this._rosterFrame(room)
    const keys = await this._keyFrames(room)
    if (epoch !== this._epoch || room.gone || st.dead || st.wire.destroyed) return
    try {
      await this._put(st, roster)
      for (const k of keys) await this._put(st, k)
    } catch (_) { /* a closing wire */ }
  }

  /**
   * The owner's room state on the relay (finding A-3 of verify round 0). One frame there reaches everyone in the lane at once, and every frame
   * counts against the owner's socket at the rendezvous (plan 3.2: 120 relays and 150 messages a minute, and the next message closes the
   * socket), so the owner no longer puts the whole state there at each accept and each joined push: a pass puts the roster once, then the
   * sealed secrets of the members in needKey only, those the owner has not heard from since it accepted them (a member says { k: 'in' } when it
   * holds the secret, _sayIn, and any frame it writes says the same, _applyGroup). One run goes at a time: the calls that come while it runs (a
   * burst of joined pushes, as when every socket of a room comes back at once) make one more pass, not one each. The first frame the relay does
   * not take ends a pass; what it did not send goes at the next call (the next joined push, or the lane coming back into use).
   */
  _relayRoomState (room) {
    const p = room.p
    if (p.stateBusy) {
      p.stateAgain = true
      return p.stateP
    }
    p.stateBusy = true
    const epoch = this._epoch
    p.stateP = (async () => {
      try {
        do {
          p.stateAgain = false
          const st = p.rst
          if (!room.owner || room.gone || epoch !== this._epoch || !st || !this._relayUsable(st) || !this._keys()) return
          const roster = await this._rosterFrame(room)
          const keys = await this._keyFrames(room, p.needKey)
          if (epoch !== this._epoch || room.gone) return
          // the roster first (a member keeps it until its secret comes); the first frame the relay does not take ends this pass, since the ones
          // after it would not go either, and a call that came meanwhile still makes one more pass
          for (const bytes of [roster, ...keys]) {
            if (!(await this._put(st, bytes))) break
          }
        } while (p.stateAgain)
      } finally {
        p.stateBusy = false
      }
    })()
    return p.stateP
  }

  /**
   * A member says once to the room that it holds the secret: { k: 'in' }, a group frame like any other, on every path it has (finding A-3 of
   * verify round 0). The owner then stops putting that member's sealed secret on the relay. When the owner puts it there again (it did not
   * hear the first word) and the member sees its own box come back, it says it again (again), at most once a minute on the relay, so a replay
   * of that box by someone else in the lane costs it little. Only on a door with the relay: without it the owner gives each new wire the whole
   * state, as it always did.
   */
  async _sayIn (room, again = false) {
    const p = room.p
    const keys = this._keys()
    if (room.owner || room.gone || !p.secret || !keys || this.cfg.relay !== 'rendezvous') return
    const t = this.now()
    if (again && p.inAt !== null && t - p.inAt < 60000) return
    const st = p.rst
    const onRelay = !!st && this._relayUsable(st)
    if (onRelay) p.inAt = t // before the awaits below: a second call while this word is on its way does not say it twice
    const epoch = this._epoch
    const sealed = await sealGroupBody({ keys, secret: p.secret, lane: room.lane, body: { k: 'in' }, now: t, n: p.sendN++, random: this.randomBytes })
    if (epoch !== this._epoch || room.gone) return
    const bytes = encodeFrame(T.GROUP, sealed.payload)
    if (!bytes) return
    this._fresh(p.seen, 'g' + sealed.id, sealed.t)
    this._roomBroadcast(room, bytes, null)
    // the word went on the relay, or it did not: then the next time the owner's box comes back it is said again at once
    if (onRelay && !(await this._put(st, bytes)) && p.inAt === t) p.inAt = null
  }

  _roomWireUp (room, st) {
    if (room.owner) {
      this._sendRoomState(room, st).then(undefined, noop)
    } else if (!st.relay) {
      // a member passes on what it holds (the roster, and the sealed room secrets it could not open) over a new wire, so a member
      // the owner has no wire to still gets its box through the others, whatever order the wires came up in. Not over the relay: the
      // owner reaches every member through it, and sixteen members putting the same frames on it would only fill its caps.
      const c = room.p.cache
      try {
        if (c.roster) this._put(st, c.roster)
        for (const b of c.keys.values()) this._put(st, b)
      } catch (_) { /* a closing wire */ }
    }
    this._flushRoom(room)
  }

  async _handleRoomFrame (st, frame, bytes) {
    const room = st.rec
    if (!this._keys()) return undefined
    if (frame.type === T.ROOM_KEY) return this._rxRoomKey(room, st, frame.payload, bytes)
    if (frame.type === T.ROSTER) return this._rxRoster(room, st, frame.payload, bytes)
    if (frame.type === T.GROUP) return this._rxGroup(room, st, frame.payload, bytes)
    this._strike(st, 'type')
    return undefined
  }

  async _rxRoomKey (room, st, payload, bytes) {
    if (room.owner) return
    if (!envFromWire(payload, { tag: false })) {
      this._strike(st, 'room-key')
      return
    }
    const epoch = this._epoch
    if (!room.p.secret) {
      const secret = await openRoomKey({ keys: this._keys(), ownerEk: room.ownerEk, payload, lane: st.lane, ownerPub: room.ownerPub })
      if (epoch !== this._epoch || room.gone) return
      if (secret && !room.p.secret) {
        room.p.secret = secret
        room.p.keyEpk = payload.epk // the box that gave it: when it comes again, the owner did not hear this member say 'in' (_sayIn)
        // the roster that came first is read now (it names who may write, and who is in the room), and only then does the room show as
        // connected; then the frames that waited for the secret are looked at
        await this._applyHeldRoster(room)
        if (epoch !== this._epoch || room.gone) return
        if (room.status === 'connecting' || room.status === 'waiting') {
          room.status = 'connected'
          this._repRoom(room)
        }
        this._applyHeld(room).then(undefined, noop)
        this._flushRoom(room)
        this._sayIn(room).then(undefined, noop) // the owner stops putting this member's secret on the relay when it hears this (finding A-3)
        this._touch()
        return
      }
      if (secret) return // the same box by another path, opened while the first was: nothing more to do
    } else if (payload.epk === room.p.keyEpk) {
      this._sayIn(room, true).then(undefined, noop) // the owner put this member's own box on the relay again: it did not hear 'in'
      return
    } else if (room.p.cache.keys.has(payload.epk)) {
      return
    }
    // Not for this member: a member that the owner cannot reach directly may get its box through others (sealed, so a relay
    // cannot read it), and a member that comes up later is handed the boxes this one holds (_roomWireUp).
    const keys = room.p.cache.keys
    keys.set(payload.epk, bytes)
    while (keys.size > 64) keys.delete(keys.keys().next().value)
    this._relay(room, st, bytes, 'k' + payload.epk)
  }

  // The roster is a group box under the room secret, from the owner (ADV-1). A member that does not hold the secret yet keeps, for each
  // wire, the newest roster frame that wire gave it (so junk on one wire cannot push out the owner's roster that came on another) and
  // reads them when the secret arrives; it passes on only what it has opened.
  async _rxRoster (room, st, payload, bytes) {
    if (room.owner) return
    if (!envFromWire(payload)) {
      this._strike(st, 'roster')
      return
    }
    if (!room.p.secret) {
      st.heldRoster = { payload, bytes, lane: st.lane }
      return
    }
    const epoch = this._epoch
    const r = await openRoster({ secret: room.p.secret, lane: st.lane, payload, ownerPub: room.ownerPub })
    if (epoch !== this._epoch || room.gone) return
    if (!r.ok) {
      this._strike(st, 'roster-' + r.reason)
      return
    }
    if (!this._fresh(room.p.seen, 'g' + r.id, r.t)) return
    this._takeRoster(room, st, r, bytes)
  }

  async _applyHeldRoster (room) {
    if (!room.p.secret) return
    const held = []
    const paths = Array.from(room.p.wires)
    if (room.p.rst) paths.push(room.p.rst) // a roster that came by the relay before the secret is held on its st, as one that came by a wire
    for (const st of paths) {
      if (st.heldRoster) held.push(st.heldRoster)
      st.heldRoster = null
    }
    for (const h of held) {
      const r = await openRoster({ secret: room.p.secret, lane: h.lane, payload: h.payload, ownerPub: room.ownerPub })
      if (room.gone) return
      if (!r.ok || !this._fresh(room.p.seen, 'g' + r.id, r.t)) continue
      this._takeRoster(room, null, r, h.bytes)
    }
  }

  /** An opened roster from the owner: only a higher seq counts; it is kept to hand to wires that come later, and passed on. */
  _takeRoster (room, st, r, bytes) {
    if (r.seq <= room.seq) return
    room.seq = r.seq
    const before = room.members.length
    room.members = r.members.map((m) => ({ pub: m.pub, ek: null, name: cleanName(m.name) }))
    if (room.members.length !== before) this._repRoom(room, 'roster')
    this._applyHeld(room).then(undefined, noop)
    room.p.cache.roster = bytes
    this._relay(room, st, bytes, 'r' + r.seq)
    this._touch()
  }

  async _rxGroup (room, st, payload, bytes) {
    const epoch = this._epoch
    if (!room.p.secret) {
      const again = room.p.pending.some((h) => h.payload && h.payload.ct === payload.ct) // the same frame by another wire
      if (!again && room.p.pending.length < this.limits.pendingGroupMax) room.p.pending.push({ r: null, payload, lane: st.lane, at: this.now() })
      return
    }
    const r = await openGroupBody({ secret: room.p.secret, lane: st.lane, payload })
    if (epoch !== this._epoch || room.gone) return
    if (!r.ok) {
      this._strike(st, 'group-' + r.reason)
      return
    }
    if (!this._fresh(room.p.seen, 'g' + r.id, r.t)) return
    this._roomBroadcast(room, bytes, st)
    this._applyGroup(room, r)
    this._touch()
  }

  // What waited for the room secret (a frame that came first) or for the roster (a writer not listed yet) is looked at again when
  // either arrives; what waits longer than pendingGroupMs is dropped.
  async _applyHeld (room) {
    const held = room.p.pending.splice(0)
    for (const h of held) {
      if (this.now() - h.at > this.limits.pendingGroupMs) continue
      if (h.r) {
        this._applyGroup(room, h.r, h.at)
      } else if (room.p.secret) {
        const r = await openGroupBody({ secret: room.p.secret, lane: h.lane, payload: h.payload })
        if (room.gone) return
        if (r.ok && this._fresh(room.p.seen, 'g' + r.id, r.t)) this._applyGroup(room, r, h.at)
      } else if (room.p.pending.length < this.limits.pendingGroupMax) {
        room.p.pending.push(h)
      }
    }
    this._touch()
  }

  _applyGroup (room, r, at = this.now()) {
    if (!r) return
    const b = r.body
    const from = r.from
    if (this.blocked.has(from)) return
    if (!room.members.some((m) => m.pub === from)) {
      if (room.p.pending.length < this.limits.pendingGroupMax) room.p.pending.push({ r, at })
      return
    }
    // whoever writes to the room holds its secret ({ k: 'in' } says only that, _sayIn): the owner stops putting that member's sealed secret on
    // the relay (_relayRoomState, finding A-3 of verify round 0)
    if (room.owner) room.p.needKey.delete(from)
    if (b.k === 'bye') {
      if (from === room.ownerPub && !room.owner) {
        room.status = 'closed'
        this._repRoom(room, 'owner-left')
        this._leaveLane(room)
      }
      return
    }
    if (b.k !== 'msg') return
    const text = typeof b.text === 'string' ? sanitizeText(b.text) : ''
    if (typeof b.id !== 'string' || !ID_RE.test(b.id) || !text || text.length > this.limits.roomTextMax || !Number.isSafeInteger(b.t)) return
    if (room.byId.has(b.id)) return
    const now = this.now()
    const m = { id: b.id, t: Math.min(b.t, now), mine: from === this._pub, from, text, status: null }
    this._insertRoom(room, m)
    if (!m.mine) {
      room.unread++
      this._repMsg(room, 'received', 1)
    }
  }

  _insertRoom (room, m) {
    const list = room.messages
    let i = list.length
    while (i > 0 && list[i - 1].t > m.t) i--
    list.splice(i, 0, m)
    room.byId.set(m.id, m)
    this._trim(list, room.byId, this.limits.roomMessagesMax)
  }

  /** sendRoom(roomId, text) -> { id } | { error }: one message to everyone in the room (2,000 characters at most). */
  async sendRoom (roomId, text) {
    const room = this.rooms.get(roomId)
    if (!room) return { error: 'no room' }
    if (room.status === 'waiting') return { error: 'waiting' }
    if (room.status === 'rejected') return { error: 'rejected' }
    if (room.status === 'closed') return { error: 'left' }
    if (!this._keys()) return { error: 'not ready' }
    const clean = sanitizeText(text)
    if (!clean.trim()) return { error: 'empty' }
    if (clean.length > this.limits.roomTextMax) return { error: 'too long' }
    if (!room.p.secret) return { error: 'no key' }
    const id = this._newId()
    const t = this.now()
    const body = { k: 'msg', id, t, text: clean, fmt: 'md1' }
    if (roomBodySize(body) > ROOM_BODY_MAX) return { error: 'too long' }
    const m = { id, t, mine: true, from: this._pub, text: clean, status: 'queued', body }
    this._insertRoom(room, m)
    room.p.outq.push(m)
    this._repMsg(room, 'queued', 1)
    this._flushRoom(room)
    this._touch()
    return { id }
  }

  _flushRoom (room) {
    const p = room.p
    if (p.flushing) {
      p.flushAgain = true
      return p.flushP
    }
    p.flushing = true
    const epoch = this._epoch
    p.flushP = (async () => {
      let went = 0 // the room messages that went out in this flush, told once at its end
      try {
        do {
          p.flushAgain = false
          while (p.outq.length && p.secret) {
            if (epoch !== this._epoch || room.gone) return
            if (!this._readyCount(room)) break
            if (!p.tx.take()) {
              if (p.flushTimer === null) {
                p.flushTimer = this._later(p.tx.wait() + 5, () => {
                  p.flushTimer = null
                  this._flushRoom(room)
                })
              }
              break
            }
            const m = p.outq[0]
            const sealed = await sealGroupBody({ keys: this._keys(), secret: p.secret, lane: room.lane, body: m.body, now: this.now(), n: p.sendN++, random: this.randomBytes })
            if (epoch !== this._epoch || room.gone) return
            const bytes = encodeFrame(T.GROUP, sealed.payload)
            this._fresh(p.seen, 'g' + sealed.id, sealed.t)
            if (!bytes || !(await this._roomSend(room, bytes))) break
            p.outq.shift()
            m.status = 'sent'
            went++
            delete m.body
            this._touch()
          }
        } while (p.flushAgain)
      } catch (_) {
        /* a failed seal leaves the message queued */
      } finally {
        p.flushing = false
        if (epoch === this._epoch && !room.gone) this._repMsg(room, 'sent', went)
      }
    })()
    return p.flushP
  }

  /** leaveRoom(roomId) -> { ok }: the owner closes the room (members see it close); a member just leaves. */
  async leaveRoom (roomId) {
    const room = this.rooms.get(roomId)
    if (!room) return { error: 'no room' }
    if (room.status === 'waiting') {
      if (room.knock) return this.cancelKnock(room.knock)
      this.rooms.delete(room.id)
      this._repGone(room, 'cancelled')
      this._touch()
      return { ok: true }
    }
    if (room.owner) {
      await this._closeRoomCode(room, 'closed')
      if (room.p.secret && this._readyCount(room)) {
        try {
          const sealed = await sealGroupBody({ keys: this._keys(), secret: room.p.secret, lane: room.lane, body: { k: 'bye' }, now: this.now(), n: room.p.sendN++, random: this.randomBytes })
          const bytes = encodeFrame(T.GROUP, sealed.payload)
          if (bytes) await this._roomSend(room, bytes)
        } catch (_) { /* the room closes anyway */ }
        if (this.limits.byeGraceMs > 0) await new Promise((resolve) => this._later(this.limits.byeGraceMs, resolve))
      }
    }
    room.gone = true
    for (const q of Array.from(this.requests.values())) if (q.room === room) this._dropRequest(q.knock, 'room-left')
    this._cancel(room.p.flushTimer)
    this._leaveLane(room)
    this.rooms.delete(room.id)
    this._repGone(room, 'left')
    this._touch()
    return { ok: true }
  }

  /** markRoomRead(roomId) -> { ok }: the room's unread counter goes to 0. */
  async markRoomRead (roomId) {
    const room = this.rooms.get(roomId)
    if (!room) return { error: 'no room' }
    if (room.unread) {
      room.unread = 0
      this._touch()
    }
    return { ok: true }
  }
}

/** createApps(deps) -> apps (see the header). */
export function createApps (deps) {
  return new Apps(deps)
}
