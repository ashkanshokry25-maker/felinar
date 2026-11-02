// src/loader/apps.js: the service of the apps on the door page (ARCHITECTURE 15.21): direct messages by code and rooms by code.
//
//   createApps({ api, config, loadTm, lang, now, random, randomBytes, setTimeoutFn, clearTimeoutFn, limits, createLink, link,
//                WebSocketImpl }) -> apps
//     api      { identity: { info() -> { pub, short, name } | null, keys() -> WorkingKeys | null, onChange(fn) } } (A.api)
//     config   the door's apps block { rendezvous: [wss URL], stun: [...], idp }; the first rendezvous is the pair socket
//     loadTm   () -> Promise<TorrentManager>, called once, at the first accept (nothing joins a lane before approval)
//     lang     kept for the UI (this service shows no text of its own); now, random, timers: injected clocks for tests
//
// Nothing leaves the device until the person acts: createApps opens no socket and loads no manager. openCode / createRoom /
// knock / joinRoom open the pair socket (the UI shows the price first); only accept (and the requester's side of an accepted
// knock) loads the torrent manager and joins the private lane, so the first offer, the first answer and the first network address
// move after approval. After that the two talk over mw_apps1 (apps-crypto.js frames): every message is sealed with the project's
// deniable direct-message box under K_pair of the two chat keys; rooms use the group box under one room secret that the owner
// seals to each accepted member. Nothing is stored at a door: state lives in memory for the visit (exportJson gives a file).
//
// state() -> {
//   signedIn, me: { pub, short, name } | null, ready, link: 'connecting' | 'open' | 'closed', tm (manager loaded), notice,
//   code: 'xxxx-xxxx-xxxx' | null, conversations: [conversation], rooms: [room], requests: [request], snippets: [{ id, text }],
//   blocked: [pub] }
//   conversation { id, peer: { pub, short, name, nick }, status: 'waiting' | 'connecting' | 'connected' | 'rejected' | 'left' |
//     'blocked', reason, silent, knock, code, incoming, connectedAt, lastSeenAt, unread, markedUnread, muted, pinned, archived,
//     favorite, hidden, cfg: { exp, receipts, typing }, peerCfg: { exp, receipts }, compare, compareText, draft, note, typingPeer,
//     lastT, pending, messages: [message] }
//   message { id, t, mine, text, fmt, reply, status: 'queued' | 'sent' | 'delivered' | 'read' | 'failed' | null, readAt, edits:
//     [{ t, text }] (earlier texts, oldest first), editedAt, deleted, reactions: { emoji: [pub] }, pinned, saved, important, prio,
//     exp, expAt, sendAt, scheduled }
//   room { id, owner, status: 'waiting' | 'open' | 'connecting' | 'connected' | 'rejected' | 'closed', reason, silent, knock,
//     code, codeClosed, ownerPub, members: [{ pub, short, name, you, owner }], messages: [{ id, t, mine, from: { pub, short,
//     name }, text, fmt, status: 'queued' | 'sent' | null }], unread, draft, peers }
//   request { knock, kind: 'pair' | 'room', roomId, from: { pub, short, name }, at }
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
import { createLink } from './apps-link.js'
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
  byeGraceMs: 200 // how long a goodbye is given to leave the wire before the lane is left
})

function noop () {}

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
  return {
    rendezvous: list.filter((u) => typeof u === 'string' && u),
    stun: Array.isArray(c.stun) ? c.stun.filter((u) => typeof u === 'string') : [],
    idp: typeof c.idp === 'string' ? c.idp : null
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
      this.cfg = appsBlockOf({ rendezvous: deps.rendezvous, stun: deps.stun || this.cfg.stun, idp: deps.idp || this.cfg.idp })
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
    for (const rec of Array.from(this.lanes.values())) this._leaveLane(rec)
    this.lanes.clear()
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
      incoming: !!c.incoming, connectedAt: c.connectedAt, lastSeenAt: c.lastSeenAt, unread: c.unread,
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
      members, unread: r.unread, draft: r.draft, peers: this._readyCount(r),
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
        this.link = this._makeLink({
          url: this.cfg.rendezvous[0], WebSocketImpl: this._WS, setTimeoutFn: this._setT, clearTimeoutFn: this._clearT, random: this.random
        })
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
    }
    return this.link
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

  /** openCode() -> { code: 'xxxx-xxxx-xxxx' } | { error }: opens (or returns) the code others type to message this person. */
  async openCode () {
    if (this.codeRec) return { code: formatCode(this.codeRec.code) }
    if (this._opening) return this._opening
    const p = this._openCode()
    this._opening = p
    try {
      return await p
    } finally {
      if (this._opening === p) this._opening = null
    }
  }

  async _openCode () {
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
        return { code: formatCode(code) }
      }
      if (r.reason !== 'channel-taken') return { error: errorOf(r.reason) }
    }
    return { error: 'channel taken' }
  }

  /** newCode() -> { code } | { error }: closes the code and opens another. */
  async newCode () {
    await this._closeCode()
    return this.openCode()
  }

  /** closeCode() -> { ok: true }: nobody can knock any more; pending knocks end. */
  async closeCode () {
    await this._closeCode()
    return { ok: true }
  }

  async _closeCode () {
    const rec = this.codeRec
    if (!rec) return
    this.codeRec = null
    for (const q of Array.from(this.requests.values())) if (q.kind === 'pair') this._dropRequest(q.knock)
    this._touch()
    if (this.link) await this.link.closeCode({ kind: 'pair' })
  }

  async _replaceCode (why) {
    await this._closeCode()
    const r = await this.openCode()
    this.notice = { kind: r.error ? 'code-closed' : 'code-replaced', why, at: this.now() }
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
    if (!sp) return { error: 'bad code' }
    const g = this._gate()
    if (g.error) return g
    if (this.codeRec && this.codeRec.code === sp.code) return { error: 'own code' }
    for (const c of this.convs.values()) if (c.status === 'waiting' && c.channel === sp.channel) return { error: 'already knocked' }
    if (this._waitingCount() >= this.limits.knocksOutMax || !this._knockOk()) return { error: 'rate limited' }
    const keyCode = await codeKey(sp.secret, sp.channel)
    const { box } = await sealHello({ keyCode, channel: sp.channel, role: 'knock', keys: g.keys, name: this._me().name, now: this.now(), random: this.randomBytes })
    if (g.epoch !== this._epoch) return { error: 'not signed in' }
    const r = await g.link.knock({ kind: 'pair', channel: sp.channel, box })
    if (g.epoch !== this._epoch) return { error: 'not signed in' }
    if (!r.ok) return { error: errorOf(r.reason) }
    const conv = this._newConv({ status: 'waiting', knock: r.knock, channel: sp.channel, keyCode, codeText: formatCode(sp.code), incoming: false })
    this._touch()
    return { knock: r.knock, id: conv.id }
  }

  /** cancelKnock(knock) -> { ok: true }: withdraws a knock that has not been answered (the waiting conversation goes). */
  async cancelKnock (knock) {
    for (const c of Array.from(this.convs.values())) {
      if (c.status === 'waiting' && (c.knock === knock || c.id === knock)) {
        this.convs.delete(c.id)
        if (this.link && c.knock) await this.link.cancel({ kind: 'pair', knock: c.knock })
        this._touch()
        return { ok: true }
      }
    }
    for (const r of Array.from(this.rooms.values())) {
      if (r.status === 'waiting' && (r.knock === knock || r.id === knock)) {
        this.rooms.delete(r.id)
        if (this.link && r.knock) await this.link.cancel({ kind: 'room', knock: r.knock })
        this._touch()
        return { ok: true }
      }
    }
    return { error: 'no request' }
  }

  _dropRequest (knock) {
    const q = this.requests.get(knock)
    if (!q) return
    this._cancel(q.timer)
    this.requests.delete(knock)
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
    const turnAway = () => { if (this.link) this.link.reject({ kind: ev.kind, knock: ev.knock }).then(undefined, noop) }
    if (own.seen.has(h.n)) {
      turnAway()
      return
    }
    own.seen.add(h.n)
    if (own.seen.size > 256) own.seen.delete(own.seen.values().next().value)
    if (h.pub === this._pub || h.ek === keys.chat.pub || (room && room.members.some((m) => m.pub === h.pub)) || (room && room.members.length >= this.limits.roomMembersMax)) {
      turnAway()
      return
    }
    if (this.blocked.has(h.pub)) {
      this._answerLater(ev)
      return
    }
    const q = { knock: ev.knock, kind: ev.kind, channel: ev.channel, room, hello: h, at: this.now(), timer: null }
    q.timer = this._later(this.limits.requestTtlMs, () => {
      this.requests.delete(q.knock)
      this._touch()
    })
    this.requests.set(q.knock, q)
    this._touch()
  }

  /**
   * accept(knock) -> { id } | { error }: approves a request (a person's, or a person asking into a room). Only now is the torrent
   * manager loaded and the private lane joined; the other side joins when it hears the answer.
   */
  async accept (knock) {
    const q = this.requests.get(knock)
    if (!q) return { error: 'no request' }
    const g = this._gate()
    if (g.error) return g
    if (q.kind === 'room') return this._acceptMember(q, g)
    try {
      await this._ensureTm()
    } catch (err) {
      return { error: err && err.code === 'E_EXISTS' ? 'manager busy' : 'no manager' }
    }
    if (g.epoch !== this._epoch || this.requests.get(knock) !== q) return { error: 'no request' }
    // The accept goes to the rendezvous with this person's signature over the channel and the knock; the requester loads nothing and
    // joins nothing unless that signature checks (ADV-7)
    const proof = await signAccept({ keys: g.keys, channel: q.channel, knock })
    if (g.epoch !== this._epoch || this.requests.get(knock) !== q) return { error: 'no request' }
    const r = await g.link.accept({ kind: 'pair', knock, proof })
    this._dropRequest(knock)
    if (g.epoch !== this._epoch) return { error: 'not signed in' }
    if (!r.ok) return { error: errorOf(r.reason) }
    const h = q.hello
    const conv = this._newConv({ status: 'connecting', peer: { pub: h.pub, ek: h.ek, name: cleanName(h.name || '') || null }, incoming: true })
    await this._startConv(conv, r.lane)
    return { id: conv.id }
  }

  /** reject(knock) -> { ok: true }: declines a request; the other person sees 'rejected' and nothing was joined. */
  async reject (knock) {
    const q = this.requests.get(knock)
    if (!q) return { error: 'no request' }
    this._dropRequest(knock)
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
      this._touch()
      return
    }
    try {
      await this._ensureTm()
    } catch (err) {
      rec.status = 'rejected'
      rec.reason = 'no-tm'
      rec.knock = null
      this._touch()
      return
    }
    if (epoch !== this._epoch || rec.status !== 'waiting') return
    const h = opened.hello
    rec.knock = null
    if (ev.kind === 'room') {
      rec.ownerPub = h.pub
      rec.ownerEk = h.ek
      rec.members = [{ pub: h.pub, ek: h.ek, name: cleanName(h.name || '') }]
      rec.status = 'connecting'
      rec.p.keyCode = null
      this._joinRoomLane(rec, ev.lane)
      this._touch()
      return
    }
    rec.peer = { pub: h.pub, ek: h.ek, name: cleanName(h.name || '') || null, nick: null }
    rec.status = 'connecting'
    rec.codeText = null // the typed code, with the secret in it, is not kept once the answer is in
    rec.p.keyCode = null
    await this._startConv(rec, ev.lane)
  }

  _onRejected (ev) {
    const rec = this._waitingByKnock(ev.kind, ev.knock)
    if (!rec) return
    rec.status = 'rejected'
    rec.reason = ev.reason
    rec.knock = null
    this._touch()
  }

  _onSilent (ev) {
    const rec = this._waitingByKnock(ev.kind, ev.knock)
    if (!rec) return
    rec.silent = true
    this._touch()
  }

  _onCancelled (ev) {
    this._dropRequest(ev.knock)
  }

  _onLinkGone () {
    for (const q of Array.from(this.requests.values())) this._dropRequest(q.knock)
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
    const rec = this.codeRec
    if (rec && !rec.registered) {
      const { box } = await sealHello({ keyCode: rec.keyCode, channel: rec.channel, role: 'owner', keys, name: this._me().name, now: this.now(), random: this.randomBytes })
      if (epoch !== this._epoch || this.codeRec !== rec) return
      rec.box = box
      const r = await link.openCode({ kind: 'pair', channel: rec.channel, box })
      if (epoch !== this._epoch || this.codeRec !== rec) return
      if (r.ok) {
        rec.registered = true
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
      this._touch()
      return
    }
    const { box } = await sealHello({ keyCode: rec.p.keyCode, channel: rec.channel, role: 'knock', keys, name: this._me().name, now: this.now(), random: this.randomBytes })
    if (epoch !== this._epoch || rec.status !== 'waiting') return
    const r = await this.link.knock({ kind, channel: rec.channel, box })
    if (epoch !== this._epoch || rec.status !== 'waiting') return
    if (r.ok) {
      rec.knock = r.knock
      rec.lostKnock = null
      rec.silent = false
    } else if (r.reason === 'unknown-code') {
      this._later(this.limits.reknockDelayMs, () => {
        if (rec.status === 'waiting' && !rec.knock && rec.lostKnock) this._reknock(rec, kind).then(undefined, noop)
      })
    } else if (r.reason !== 'link-down' && r.reason !== 'closed') {
      rec.status = 'rejected'
      rec.reason = r.reason
      rec.lostKnock = null
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
      for (const q of Array.from(this.requests.values())) if (q.room === room) this._dropRequest(q.knock)
      this._touch()
      return
    }
    const rec = this.codeRec
    if (!rec || rec.channel !== ev.channel) return
    this.codeRec = null
    for (const q of Array.from(this.requests.values())) if (q.kind === 'pair') this._dropRequest(q.knock)
    const r = await this.openCode()
    this.notice = { kind: r.error ? 'code-closed' : 'code-replaced', why: ev.reason, at: this.now() }
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

  _leaveLane (rec) {
    if (!rec || !rec.p) return
    for (const [lane, handle] of Array.from(rec.p.lanes)) {
      if (this.lanes.get(lane) === rec) this.lanes.delete(lane)
      try { if (handle && typeof handle.leave === 'function') handle.leave() } catch (_) { /* gone */ }
    }
    rec.p.lanes.clear()
    for (const st of Array.from(rec.p.wires)) {
      st.dead = true
      try { st.wire.destroy() } catch (_) { /* gone */ }
    }
    rec.p.wires.clear()
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
    const st = { wire, rec, lane: ih, ready: false, queue: Promise.resolve(), strikes: 0, drops: 0, dead: false, silent: null, heldRoster: null }
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

  _readyWire (rec) {
    for (const st of rec.p.wires) if (st.ready && !st.dead && !st.wire.destroyed) return st
    return null
  }

  _readyCount (rec) {
    let n = 0
    for (const st of rec.p.wires) if (st.ready && !st.dead && !st.wire.destroyed) n++
    return n
  }

  _wireReady (st) {
    if (st.ready || st.dead || st.rec.gone) return
    const rec = st.rec
    if (this._readyCount(rec) >= (rec.isRoom ? this.limits.wiresPerRoom : this.limits.wiresPerPair)) {
      this._kill(st, 'surplus')
      return
    }
    st.ready = true
    this._cancel(st.silent)
    st.silent = null
    rec.p.wireEpoch++
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
    if (rec.gone) return
    if (!rec.isRoom) {
      if (!this._readyWire(rec)) {
        if (rec.status === 'connected') rec.status = 'connecting'
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
    st.dead = true
    this._cancel(st.silent)
    st.silent = null
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

  async _handleDm (st, payload) {
    const conv = st.rec
    const keys = this._keys()
    if (!keys || !conv.peer.ek) return
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
    if (m && m.mine && (m.status === 'queued' || m.status === 'sent' || m.status === 'failed')) m.status = 'delivered'
  }

  _rxRead (conv, b) {
    if (!conv.cfg.receipts || !Number.isSafeInteger(b.upTo)) return
    const now = this.now()
    for (const m of conv.messages) {
      if (m.mine && !m.scheduled && m.t <= b.upTo && m.status !== 'read') {
        m.status = 'read'
        m.readAt = now
      }
    }
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
    const conv = {
      id: 'c' + this._newId(), isRoom: false, gone: false,
      peer: Object.assign({ pub: null, ek: null, name: null, nick: null }, o.peer || {}),
      status: o.status, reason: null, silent: false, knock: o.knock || null, channel: o.channel || null, lostKnock: null,
      codeText: o.codeText || null, incoming: !!o.incoming, createdAt: this.now(), connectedAt: null, lastSeenAt: null,
      unread: 0, markedUnread: false, muted: false, pinned: false, archived: false, favorite: false, hidden: false,
      cfg: { exp: null, receipts: true, typing: true }, peerCfg: { exp: null, receipts: true }, peerCfgT: 0,
      compare: null, draft: '', note: '', typingPeer: false, messages: [], byId: new Map(),
      p: {
        lanes: new Map(), wires: new Set(), wireEpoch: 0, kPair: null, sendN: 0, outbox: [], flushP: null, flushing: false, flushAgain: false,
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
      this._touch()
      return false
    }
    if (epoch !== this._epoch || conv.gone) return false
    if (!this._joinLane(conv, lane, 'chat')) {
      conv.status = 'rejected'
      conv.reason = 'bad-lane'
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
    try {
      st.wire.extended(EXT_NAME, bytes)
    } catch (_) {
      return false
    }
    return true
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
              if (m && m.mine && (m.status === 'queued' || m.status === 'failed')) m.status = 'sent'
              this._cancel(item.timer)
              item.timer = this._later(this.limits.ackTimeoutMs, () => this._ackTimeout(conv, item))
              this._touch()
            }
          }
        } while (p.flushAgain)
      } finally {
        p.flushing = false
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
    if (on) {
      if (t - p.typingSentAt < this.limits.typingSendMs) return { ok: true }
      p.typingSentAt = t
      p.typingSentOn = true
      this._sendBody(conv, { k: 'typing', on: true }).then(undefined, noop)
    } else if (p.typingSentOn) {
      p.typingSentOn = false
      p.typingSentAt = 0
      this._sendBody(conv, { k: 'typing', on: false }).then(undefined, noop)
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
    }
    for (const q of Array.from(this.requests.values())) {
      if (q.hello.pub !== pub) continue
      this._dropRequest(q.knock)
      if (this.link) this.link.reject({ kind: q.kind, knock: q.knock }).then(undefined, noop)
    }
    this._touch()
    return { ok: true }
  }

  /** unblock(pub) -> { ok }: knocks are shown again; a blocked conversation becomes 'left' (a new code starts a new one). */
  async unblock (pub) {
    this.blocked.delete(pub)
    for (const c of this.convs.values()) if (c.peer.pub === pub && c.status === 'blocked') c.status = 'left'
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
    this._arm()
    this._touch()
    return { ok: true }
  }

  // ---- rooms ----------------------------------------------------------------------------------

  _newRoom (o) {
    const lim = this.limits
    const room = {
      id: 'r' + this._newId(), isRoom: true, gone: false, owner: !!o.owner, status: o.status, reason: null, silent: false,
      knock: o.knock || null, channel: o.channel || null, lostKnock: null, code: o.code || null, box: o.box || null,
      keyCode: o.keyCode || null, codeOpen: !!o.codeOpen, codeClosed: null, registered: !!o.registered, bad: 0, seen: new Set(),
      ownerPub: o.ownerPub || null, ownerEk: o.ownerEk || null, members: o.members || [], seq: o.seq || 0, lane: o.lane || null,
      messages: [], byId: new Map(), unread: 0, draft: '',
      p: {
        lanes: new Map(), wires: new Set(), wireEpoch: 0, secret: o.secret || null, keyCode: o.keyCode || null, sendN: 0,
        seen: new Map(), rx: this._bucket(lim.roomAcceptPerMin, lim.roomAcceptPerMin), tx: this._bucket(lim.sendPerMin, lim.sendPerMin),
        pending: [], outq: [], rosters: new Map(), keyFrames: new Map(), cache: { roster: null, keys: new Map() }, flushP: null, flushing: false, flushAgain: false, flushTimer: null, reknocks: 0
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
    if (!sp) return { error: 'bad code' }
    const g = this._gate()
    if (g.error) return g
    for (const r of this.rooms.values()) if (r.owner && r.code === sp.code) return { error: 'own code' }
    for (const r of this.rooms.values()) if (r.status === 'waiting' && r.channel === sp.channel) return { error: 'already knocked' }
    if (this._waitingCount() >= this.limits.knocksOutMax || !this._knockOk()) return { error: 'rate limited' }
    const keyCode = await codeKey(sp.secret, sp.channel)
    const { box } = await sealHello({ keyCode, channel: sp.channel, role: 'knock', keys: g.keys, name: this._me().name, now: this.now(), random: this.randomBytes })
    if (g.epoch !== this._epoch) return { error: 'not signed in' }
    const r = await g.link.knock({ kind: 'room', channel: sp.channel, box })
    if (g.epoch !== this._epoch) return { error: 'not signed in' }
    if (!r.ok) return { error: errorOf(r.reason) }
    const room = this._newRoom({ owner: false, status: 'waiting', knock: r.knock, channel: sp.channel, keyCode })
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
      this._dropRequest(q.knock)
      return { error: 'no request' }
    }
    if (room.members.length >= this.limits.roomMembersMax) return { error: 'room full' }
    try {
      await this._ensureTm()
    } catch (err) {
      return { error: err && err.code === 'E_EXISTS' ? 'manager busy' : 'no manager' }
    }
    if (g.epoch !== this._epoch || this.requests.get(q.knock) !== q) return { error: 'no request' }
    const proof = await signAccept({ keys: g.keys, channel: q.channel, knock: q.knock })
    if (g.epoch !== this._epoch || this.requests.get(q.knock) !== q) return { error: 'no request' }
    const r = await g.link.accept({ kind: 'room', knock: q.knock, proof })
    this._dropRequest(q.knock)
    if (g.epoch !== this._epoch) return { error: 'not signed in' }
    if (!r.ok) return { error: errorOf(r.reason) }
    const h = q.hello
    room.members.push({ pub: h.pub, ek: h.ek, name: cleanName(h.name || '') })
    room.seq++
    this._joinRoomLane(room, room.lane)
    this._touch()
    await this._publishRoster(room)
    return { id: room.id }
  }

  _joinRoomLane (room, lane) {
    if (!room.lane) room.lane = lane
    if (!this._joinLane(room, lane, 'group')) {
      room.status = room.owner ? room.status : 'rejected'
      room.reason = 'bad-lane'
      return false
    }
    return true
  }

  async _closeRoomCode (room, why) {
    if (!room.codeOpen) return
    room.codeOpen = false
    room.codeClosed = why
    for (const q of Array.from(this.requests.values())) if (q.room === room) this._dropRequest(q.knock)
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
    } else if (r.ok) {
      room.codeOpen = false
      room.codeClosed = 'lane-changed'
      await this.link.closeCode({ kind: 'room', channel: room.channel })
    } else if (r.reason === 'channel-taken') {
      room.codeOpen = false
      room.codeClosed = 'channel-taken'
    }
    this._touch()
  }

  _roomBroadcast (room, bytes, exceptSt) {
    let n = 0
    for (const st of room.p.wires) {
      if (st === exceptSt || !st.ready || st.dead || st.wire.destroyed) continue
      try {
        st.wire.extended(EXT_NAME, bytes)
        n++
      } catch (_) { /* a closing wire */ }
    }
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

  async _keyFrames (room) {
    const keys = this._keys()
    const out = []
    for (const m of room.members) {
      if (m.pub === room.ownerPub) continue
      let bytes = room.p.keyFrames.get(m.pub)
      if (!bytes) {
        const payload = await sealRoomKey({ keys, memberEk: m.ek, secret: room.p.secret, lane: room.lane, ownerPub: room.ownerPub })
        bytes = encodeFrame(T.ROOM_KEY, payload)
        room.p.keyFrames.set(m.pub, bytes)
      }
      out.push(bytes)
    }
    return out
  }

  /**
   * The owner gives every wire the roster sealed under the room secret, then the secret sealed to each member's key. The roster goes
   * first: a member that has no secret yet keeps it, and reads it when its secret arrives, so the room shows its members when it shows
   * as connected. A wire that is not a member's sees boxes it cannot open.
   */
  async _publishRoster (room) {
    const epoch = this._epoch
    if (!room.owner || !this._keys()) return
    const roster = await this._rosterFrame(room)
    const keys = await this._keyFrames(room)
    if (epoch !== this._epoch || room.gone) return
    this._roomBroadcast(room, roster, null)
    for (const k of keys) this._roomBroadcast(room, k, null)
  }

  async _sendRoomState (room, st) {
    const epoch = this._epoch
    const roster = await this._rosterFrame(room)
    const keys = await this._keyFrames(room)
    if (epoch !== this._epoch || room.gone || st.dead || st.wire.destroyed) return
    try {
      st.wire.extended(EXT_NAME, roster)
      for (const k of keys) st.wire.extended(EXT_NAME, k)
    } catch (_) { /* a closing wire */ }
  }

  _roomWireUp (room, st) {
    if (room.owner) {
      this._sendRoomState(room, st).then(undefined, noop)
    } else {
      // a member passes on what it holds (the roster, and the sealed room secrets it could not open) over a new wire, so a member
      // the owner has no wire to still gets its box through the others, whatever order the wires came up in
      const c = room.p.cache
      try {
        if (c.roster) st.wire.extended(EXT_NAME, c.roster)
        for (const b of c.keys.values()) st.wire.extended(EXT_NAME, b)
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
      if (secret) {
        room.p.secret = secret
        // the roster that came first is read now (it names who may write, and who is in the room), and only then does the room show as
        // connected; then the frames that waited for the secret are looked at
        await this._applyHeldRoster(room)
        if (epoch !== this._epoch || room.gone) return
        if (room.status === 'connecting' || room.status === 'waiting') room.status = 'connected'
        this._applyHeld(room).then(undefined, noop)
        this._flushRoom(room)
        this._touch()
        return
      }
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
    for (const st of room.p.wires) {
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
    room.members = r.members.map((m) => ({ pub: m.pub, ek: null, name: cleanName(m.name) }))
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
    if (b.k === 'bye') {
      if (from === room.ownerPub && !room.owner) {
        room.status = 'closed'
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
    if (!m.mine) room.unread++
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
            if (!bytes || !this._roomBroadcast(room, bytes, null)) break
            p.outq.shift()
            m.status = 'sent'
            delete m.body
            this._touch()
          }
        } while (p.flushAgain)
      } catch (_) {
        /* a failed seal leaves the message queued */
      } finally {
        p.flushing = false
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
      this._touch()
      return { ok: true }
    }
    if (room.owner) {
      await this._closeRoomCode(room, 'closed')
      if (room.p.secret && this._readyCount(room)) {
        try {
          const sealed = await sealGroupBody({ keys: this._keys(), secret: room.p.secret, lane: room.lane, body: { k: 'bye' }, now: this.now(), n: room.p.sendN++, random: this.randomBytes })
          const bytes = encodeFrame(T.GROUP, sealed.payload)
          if (bytes) this._roomBroadcast(room, bytes, null)
        } catch (_) { /* the room closes anyway */ }
        if (this.limits.byeGraceMs > 0) await new Promise((resolve) => this._later(this.limits.byeGraceMs, resolve))
      }
    }
    room.gone = true
    for (const q of Array.from(this.requests.values())) if (q.room === room) this._dropRequest(q.knock)
    this._cancel(room.p.flushTimer)
    this._leaveLane(room)
    this.rooms.delete(room.id)
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
