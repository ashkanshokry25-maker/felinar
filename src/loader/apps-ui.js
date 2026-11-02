// src/loader/apps-ui.js: the apps on the door page (ARCHITECTURE 15.21). A model-driven view: it draws what
// service.state() says (src/loader/apps.js) and calls the service for every action, so it has no protocol, no
// crypto and no network of its own. The home (tiles that stay inactive until the visitor has signed in), the Messages view (the
// visitor's code, knocking, requests, conversations, one conversation) and the Rooms views.
//
// Rules this file keeps:
//   - Text from other people (names, nicknames, messages, quotes) goes into the page with textContent and createTextNode only, never
//     as markup. A message is parsed by apps-format.js parseMd1 into a node tree (bold, italic, underline, strike, mono, line breaks,
//     http and https links) and built here with createElement; a link gets rel="noopener noreferrer" and target="_blank" and its
//     href is checked again as an http or https URL without userinfo; nothing else from a person ever becomes an attribute.
//   - Every button acts on a trusted click only (trustedOnly, as ui.js does for the loader's own decisions). Every form is
//     prevented from submitting (the door page runs under form-action 'none' after its first reload). Enter sends, Shift+Enter
//     makes a new line, and Enter during an IME composition does neither.
//   - The price card comes before the first code is opened, before the first knock and before every accept: what the
//     rendezvous sees, and that an accepted person learns the network address. Nothing is sent to the service before Continue.
//   - Plain DOM only (createElement, createTextNode, setAttribute, addEventListener, focus), so test/unit/dropin-fake-dom.mjs runs it.
//     No module-scope DOM access: app.js and the unit tests import this file in Node.
//
// What the view reads from service.state() (the shape of src/loader/apps.js; a field marked ? may be missing):
//   { signedIn, me: { pub, short, name } | null, ready, link: 'connecting' | 'open' | 'closed', code: 'xxxx-xxxx-xxxx' | null,
//     notice?: { kind, at }, snippets?: [{ id, text }], blocked?: [pub], tm?,
//     requests: [{ knock, kind: 'pair' | 'room', roomId, from: { pub, short, name }, at }],
//     conversations: [{ id, peer: { pub, short, name, nick }, status: 'waiting' | 'connecting' | 'connected' | 'rejected' | 'left' | 'blocked',
//       knock, code, connectedAt, lastSeenAt, unread, markedUnread, muted, pinned, archived, favorite, hidden, cfg: { exp, receipts, typing },
//       compare, compareText, draft, note, typingPeer, messages: [{ id, t, mine, text, reply, status, readAt, edits: [{ t, text }],
//       deleted, reactions: { [emoji]: [pub] }, pinned, saved, important, prio, exp, expAt, sendAt, scheduled }] }],
//     rooms: [{ id, owner, status: 'waiting' | 'open' | 'connecting' | 'connected' | 'rejected' | 'closed', knock, code, codeClosed,
//       members: [{ pub, short, name, you, owner }], messages: [{ id, t, mine, from: { pub, short, name }, text, status }], unread, draft }] }
// The calls of src/loader/apps.js are used as named. These are used when the service has them, and the view keeps the same state in
// memory for this visit when it does not: setFlag, setMessageFlag, markUnread, markRoomRead, verifyCode, retry, setDraft, setNote,
// addSnippet and removeSnippet, search (else apps-format.js searchMessages), exportData (else exportJson).

import { appsText as defaultAppsText, pickLang } from './strings.js'
import { trustedOnly, clockText } from './ui.js'
import { parseMd1, plainText, previewText, searchMessages as searchModel, COMMON_EMOJI, exportFileName as modelFileName, TEXT_MAX, ROOM_TEXT_MAX as ROOM_MAX } from './apps-format.js'

// The composer counts what the service accepts (apps-format.js: 3,500 characters in a conversation, 2,000 in a room).
export const DM_TEXT_MAX = TEXT_MAX
export const ROOM_TEXT_MAX = ROOM_MAX
/** The composer's picker: the 32 common emoji of apps-format.js, plain Unicode, no assets. */
export const EMOJI = COMMON_EMOJI
/** The quick reactions of a message's menu (the picker above is for the composer). */
export const REACTIONS = Object.freeze(['\u{1f44d}', '\u2764\ufe0f', '\u{1f602}', '\u{1f62e}', '\u{1f622}', '\u{1f64f}'])
/** Disappearing messages: milliseconds and the APPS_TEXT key suffix of each choice. */
export const EXPIRY_CHOICES = Object.freeze([[0, 'off'], [10000, '10s'], [60000, '1m'], [3600000, '1h'], [86400000, '1d'], [604800000, '1w']])
export const FONT_SIZES = Object.freeze(['small', 'normal', 'large'])
const TYPING_IDLE_MS = 4000
const TOAST_MS = 4000
const STATUS_ORDER = ['queued', 'sent', 'delivered', 'read']

// ---------------------------------------------------------------------------------------------
// Pure helpers (exported for the unit tests)
// ---------------------------------------------------------------------------------------------

/**
 * groupCode('abcdefgh2345') -> 'abcd-efgh-2345': a pairing code (twelve characters, CHANGED 21:30 ET: the first group is the channel the
 * rendezvous sees, the last eight the secret) as it is shown. An eight character short id ('k3f92xq1') becomes 'k3f9-2xq1'.
 * Anything else is returned as it is.
 */
export function groupCode (text) {
  const raw = text === null || text === undefined ? '' : String(text)
  const c = raw.replace(/[\s-]/g, '')
  if (/^[a-z0-9]{12}$/i.test(c)) return (c.slice(0, 4) + '-' + c.slice(4, 8) + '-' + c.slice(8)).toLowerCase()
  if (/^[a-z0-9]{8}$/i.test(c)) return (c.slice(0, 4) + '-' + c.slice(4)).toLowerCase()
  return raw
}

/** codeLooksValid(text): twelve letters or digits once spaces, hyphens, dots, underscores and invisible marks are gone (the service checks the alphabet and says "unknown code"). */
export function codeLooksValid (text) {
  if (typeof text !== 'string' || text.length > 64) return false
  const c = text.normalize('NFKC').replace(/[\s._\-\u00ad\u200b-\u200f\u202a-\u202e\u2010-\u2015\u2066-\u2069\u2212\ufeff]+/g, '')
  return /^[\p{L}\p{N}]{12}$/u.test(c)
}

/** verifyText('12345678') -> '1234 5678' (the compare line); digits only, else ''. */
export function verifyText (v) {
  const raw = v && typeof v === 'object' ? v.code : v
  const d = String(raw === null || raw === undefined ? '' : raw).replace(/\D/g, '')
  return d.length === 8 ? d.slice(0, 4) + ' ' + d.slice(4) : ''
}

/**
 * cleanName(text, max): a name from another person made safe to show: control characters and the bidirectional embedding and
 * override marks (which can reorder the text around them) become nothing, runs of spaces become one, at most `max` characters.
 */
export function cleanName (text, max = 32) {
  const t = String(text === null || text === undefined ? '' : text).replace(/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069\u200e\u200f\u061c]/g, ' ').replace(/\s+/g, ' ').trim()
  const chars = Array.from(t)
  return chars.length > max ? chars.slice(0, max - 1).join('') + '...' : t
}

function pad2 (n) { return (n < 10 ? '0' : '') + n }

/** dayNumber(ms) -> the local calendar day as a number that orders and compares (year * 10000 + month * 100 + day), or 0. */
export function dayNumber (ms) {
  const d = new Date(Number(ms))
  return Number.isFinite(d.getTime()) ? d.getFullYear() * 10000 + (d.getMonth() + 1) * 100 + d.getDate() : 0
}

/** dateText(ms, lang): 'Nov 1, 2026' by locale. */
export function dateText (ms, lang = 'en') {
  const d = new Date(Number(ms))
  if (!Number.isFinite(d.getTime())) return ''
  try { return new Intl.DateTimeFormat(lang, { year: 'numeric', month: 'short', day: 'numeric' }).format(d) } catch (_) { return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate()) }
}

/** stampText(ms, lang, nowMs): the time (hours and minutes) of a moment today, else 'Nov 1, 4:05 PM' by locale. */
export function stampText (ms, lang = 'en', nowMs = Date.now()) {
  const t = Number(ms)
  if (!Number.isFinite(t)) return ''
  if (dayNumber(t) === dayNumber(nowMs)) return clockText(t, lang)
  try { return new Intl.DateTimeFormat(lang, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }).format(new Date(t)) } catch (_) { return dateText(t, lang) + ' ' + clockText(t, lang) }
}

/** parseDay('2026-11-01', end) -> ms of the start (or, with end, the last millisecond) of that local day, or null. */
export function parseDay (value, end = false) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(value || ''))
  if (!m) return null
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), end ? 23 : 0, end ? 59 : 0, end ? 59 : 0, end ? 999 : 0)
  return Number.isFinite(d.getTime()) ? d.getTime() : null
}

/** parseLocalMoment('2026-11-01T14:30') -> ms of that local time, or null (the value of an input of type datetime-local). */
export function parseLocalMoment (value) {
  const m = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})/.exec(String(value || ''))
  if (!m) return null
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5]), 0, 0)
  return Number.isFinite(d.getTime()) ? d.getTime() : null
}

/** localMoment(ms) -> 'YYYY-MM-DDTHH:MM' in local time, the value an input of type datetime-local takes. */
export function localMoment (ms) {
  const d = new Date(Number(ms))
  return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate()) + 'T' + pad2(d.getHours()) + ':' + pad2(d.getMinutes())
}

/** avatarBits(seed) -> 25 booleans (5 by 5, mirrored left to right): the identicon of a key, from a hash of its text. */
export function avatarBits (seed) {
  let h = 0x811c9dc5
  const t = String(seed === null || seed === undefined ? '' : seed)
  for (let i = 0; i < t.length; i++) { h ^= t.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0 }
  const out = []
  for (let row = 0; row < 5; row++) {
    for (let col = 0; col < 5; col++) {
      const mc = col < 3 ? col : 4 - col
      out.push(((h >>> (row * 3 + mc)) & 1) === 1)
    }
  }
  return out
}

// ---- md1 in the page: the node tree of apps-format.js parseMd1 becomes elements --------------------------------------------------------------
//   node = { t: 'text', s } | { t: 'br' } | { t: 'code', s } | { t: 'b' | 'i' | 'u' | 's', c } | { t: 'a', href, rel, target, c: [{ t: 'text', s }] }

/** safeLink(href) -> the href when it is an http or https URL without userinfo, else null (checked again here, whatever the parser said). */
export function safeLink (href) {
  let u
  try { u = new URL(String(href)) } catch (_) { return null }
  if ((u.protocol !== 'http:' && u.protocol !== 'https:') || !u.hostname || u.username || u.password) return null
  return u.href
}

/** md1Append(doc, parent, text): builds the md1 tree of text under parent (createTextNode, createElement and the attributes of a link only). */
export function md1Append (doc, parent, text) {
  md1AppendNodes(doc, parent, parseMd1(text))
}

/** md1AppendNodes(doc, parent, nodes): the same for a node tree (exported for the tests: a link with a bad href is built as its text). */
export function md1AppendNodes (doc, parent, nodes) {
  appendNodes(doc, parent, nodes)
}

function appendNodes (doc, parent, nodes) {
  for (const n of nodes) {
    if (n.t === 'text') parent.appendChild(doc.createTextNode(String(n.s)))
    else if (n.t === 'br') parent.appendChild(doc.createElement('br'))
    else if (n.t === 'code') { const e = doc.createElement('code'); e.textContent = String(n.s); parent.appendChild(e) } else if (n.t === 'a') {
      const href = safeLink(n.href)
      if (!href) { appendNodes(doc, parent, n.c || []); continue }
      const a = doc.createElement('a')
      a.setAttribute('href', href)
      a.setAttribute('rel', 'noopener noreferrer')
      a.setAttribute('target', '_blank')
      appendNodes(doc, a, n.c || [])
      parent.appendChild(a)
    } else if (n.t === 'b' || n.t === 'i' || n.t === 'u' || n.t === 's') {
      const e = doc.createElement(n.t === 'b' ? 'strong' : n.t === 'i' ? 'em' : n.t)
      appendNodes(doc, e, n.c || [])
      parent.appendChild(e)
    }
  }
}

// ---- conversations ------------------------------------------------------------------------------------------------------------------------

/** shownMessages(conv) -> the messages array of a conversation or room (never null). */
export function messagesOf (c) {
  return c && Array.isArray(c.messages) ? c.messages : []
}

/** lastActivity(conv) -> the time of the newest message, else when the conversation connected, else 0. */
export function lastActivity (c) {
  const ms = messagesOf(c)
  let t = 0
  for (const m of ms) if (m && Number(m.t) > t) t = Number(m.t)
  return t || Number(c && (c.connectedAt || c.lastSeenAt)) || 0
}

/**
 * sortConversations(list, { flagOf, matches }) -> { active, archived }: pinned first, then the newest activity first (ties keep the
 * service's order); flagOf(conv, 'pinned' | 'archived') reads the flags with the view's own overrides; matches(conv) is the filter.
 */
export function sortConversations (list, { flagOf = (c, f) => !!(c && c[f]), matches = () => true } = {}) {
  const rows = (Array.isArray(list) ? list : []).filter((c) => c && c.id !== undefined && matches(c)).map((c, i) => ({ c, i }))
  const order = (a, b) => {
    const pa = flagOf(a.c, 'pinned') ? 1 : 0
    const pb = flagOf(b.c, 'pinned') ? 1 : 0
    return pb - pa || lastActivity(b.c) - lastActivity(a.c) || a.i - b.i
  }
  rows.sort(order)
  return { active: rows.filter((r) => !flagOf(r.c, 'archived')).map((r) => r.c), archived: rows.filter((r) => flagOf(r.c, 'archived')).map((r) => r.c) }
}

/** statusRank(status) -> 0 queued, 1 sent, 2 delivered, 3 read, -1 anything else. */
export function statusRank (status) { return STATUS_ORDER.indexOf(status) }

/**
 * errorKey(err) -> the APPS_TEXT key for what a service call answered ({ error }): one of the reasons of src/loader/apps.js ERRORS
 * ('unknown code', 'rate limited', 'own code', 'link down', ...; they read like the rendezvous' failure reasons), an Error, or a
 * client code. Anything not known is the generic line.
 */
export function errorKey (err) {
  const raw = err && typeof err === 'object' ? [err.code, err.reason, err.message].filter(Boolean).join(' ') : String(err === null || err === undefined ? '' : err)
  if (/too many (?:codes|rooms)/i.test(raw)) return 'apps.err.tooMany'
  if (/too many|E_RATE|rate limit/i.test(raw)) return 'apps.err.rate'
  if (/\b(?:your )?own code\b|\bself\b/i.test(raw)) return 'apps.err.self'
  if (/already knocked/i.test(raw)) return 'apps.err.already'
  if (/unknown|expired|not found/i.test(raw)) return 'apps.err.unknown'
  if (/bad code|invalid|malformed|E_BAD/i.test(raw)) return 'apps.err.invalid'
  if (/room full/i.test(raw)) return 'apps.err.roomFull'
  if (/blocked/i.test(raw)) return 'apps.err.blocked'
  if (/too long/i.test(raw)) return 'apps.err.tooLong'
  if (/too far/i.test(raw)) return 'apps.err.tooFar'
  if (/link|socket|rendezvous|not ready|not signed in|not connected|offline|connection|E_UNSUPPORTED/i.test(raw)) return 'apps.err.link'
  return 'apps.err.generic'
}

// ---------------------------------------------------------------------------------------------
// The view
// ---------------------------------------------------------------------------------------------

/**
 * createAppsUi({ root, ui, service, lang, appsText, actions, now }) -> { node, render, show, back, inspect, destroy, nodes }
 *   root       any element of the loader's page (its ownerDocument is used)
 *   ui         the loader's UI (createUI): showApps(node) / hideApps() place the view; download(name, text) saves an export
 *   service    the apps service (src/loader/apps.js): state(), onChange(fn), and the calls named in its header
 *   lang       a language tag; appsText(key, lang, params) gives the strings (default: strings.js)
 *   actions    { signIn() -> Promise, signOut() -> Promise, openLink() (the "Open a link" box), copy(text) -> Promise<boolean>, log(line) }
 *              each optional; without signIn the view asks ui.prompt('signin', ...); without openLink the tile stays inactive
 * The view re-renders from service.state() on every onChange (batched into one microtask). inspect() is the apps part of
 * window.__mwShell.inspect(): { view, code (the channel only), conversations, rooms, link, ... }.
 */
export function createAppsUi ({ root, ui = null, service, lang = 'en', appsText = defaultAppsText, actions = {}, now = () => Date.now(), doc = null, win = null } = {}) {
  if (!service || typeof service.state !== 'function') throw new TypeError('createAppsUi needs the apps service')
  const D = doc || (root && root.ownerDocument)
  if (!D || typeof D.createElement !== 'function') throw new TypeError('createAppsUi needs a document')
  const W = win || D.defaultView || null
  const L = pickLang(lang)
  const T = (key, params) => appsText(key, L, params)
  const act = actions || {}
  const nowMs = () => Number(now()) || Date.now()
  let destroyed = false

  const setT = (fn, ms) => {
    const h = W && typeof W.setTimeout === 'function' ? W.setTimeout(fn, ms) : setTimeout(fn, ms)
    if (h && typeof h.unref === 'function') h.unref()
    return h
  }
  const clearT = (h) => {
    if (h === null || h === undefined) return
    if (W && typeof W.clearTimeout === 'function') W.clearTimeout(h)
    else clearTimeout(h)
  }
  const log = (line) => { try { if (typeof act.log === 'function') act.log(String(line)) } catch (_) { /* a log line must not break the view */ } }

  // ----- DOM helpers: textContent and attributes only -------------------------------------------
  const el = (tag, attrs, kids) => {
    const n = D.createElement(tag)
    if (attrs) {
      for (const k of Object.keys(attrs)) {
        const v = attrs[k]
        if (v === undefined || v === null || v === false) continue
        if (k === 'class') n.className = v
        else if (k === 'text') n.textContent = String(v)
        else if (k === 'value') n.value = String(v)
        else if (k === 'checked' || k === 'disabled' || k === 'hidden') n[k] = true
        else if (k.slice(0, 2) === 'on' && typeof v === 'function') n.addEventListener(k.slice(2), v)
        else n.setAttribute(k, v === true ? '' : String(v))
      }
    }
    for (const c of kids || []) if (c) n.appendChild(typeof c === 'string' ? D.createTextNode(c) : c)
    return n
  }
  const clear = (n) => { while (n && n.firstChild) n.removeChild(n.firstChild) }
  const fill = (n, kids) => { clear(n); for (const k of kids) if (k) n.appendChild(k) }
  const fkOf = (n) => (n && typeof n.getAttribute === 'function' ? n.getAttribute('data-fk') : null)

  // A failed handler must not leave the view half drawn: the error goes to the log and the view draws again.
  const guarded = (fn) => (ev) => {
    try {
      const r = fn(ev)
      if (r && typeof r.catch === 'function') r.catch((err) => { log('handler: ' + ((err && err.message) || err)); render() })
    } catch (err) { log('handler: ' + ((err && err.message) || err)); render() }
  }
  // Decisions act on a trusted click only (a click a script made is ignored; events without isTrusted, as in unit tests, pass).
  const button = (label, onClick, cls, attrs) => el('button', Object.assign({ type: 'button', class: 'mw-btn' + (cls ? ' ' + cls : ''), text: label, onclick: trustedOnly(guarded(onClick)) }, attrs || {}))
  // A form never submits (form-action 'none'); the Enter key of its field runs the action instead (enterKey).
  const form = (cls, kids) => el('form', { class: cls, novalidate: true, onsubmit: (ev) => { if (ev && typeof ev.preventDefault === 'function') ev.preventDefault() } }, kids)
  const enterKey = (n, fn) => {
    n.addEventListener('keydown', (ev) => {
      if (!ev || ev.key !== 'Enter' || ev.isComposing || ev.keyCode === 229 || ev.isTrusted === false) return
      if (typeof ev.preventDefault === 'function') ev.preventDefault()
      guarded(fn)(ev)
    })
    return n
  }

  // ----- this visit's state of the view (nothing is stored: a reload starts from the home) -------------------------------------
  const freshState = () => ({
    view: 'home', convId: null, roomId: null,
    priceOk: false, askedStart: false, openRequested: false, card: null,
    showArchived: false, favoritesOnly: false,
    toolsOpen: false, toolsReturn: false, searchOpen: false, select: false, selected: new Set(),
    menuFor: null, reactFor: null, detailsFor: null, replyTo: null, editing: null,
    search: { ids: null, i: 0, status: '' },
    drafts: new Map(), roomDrafts: new Map(), snippets: [], font: 'normal',
    verify: new Map(), marked: new Set(), copied: ''
  })
  const st = freshState()
  const notes = { code: '', knock: '', join: '', conv: '', room: '', roomCode: '' }
  const local = { conv: new Map(), msg: new Map() }
  const memo = { signedIn: false, linkWasOpen: false, lastRead: new Map(), seen: new Map(), toastKeys: null, counts: new Map(), pendingRender: false, baseTitle: null, toastTimer: null, copiedTimer: null, stick: false }

  // ----- the model: state() read once per render, tolerant of fields the plan leaves open ----------------------------------------
  function snapshot () {
    let s = null
    try { s = service.state() } catch (err) { log('state: ' + ((err && err.message) || err)) }
    s = s && typeof s === 'object' ? s : {}
    return {
      signedIn: s.signedIn === true,
      me: s.me && typeof s.me === 'object' ? s.me : null,
      ready: s.ready !== false,
      link: s.link === 'connecting' || s.link === 'closed' ? s.link : 'open',
      code: s.code ? String(s.code) : '',
      notice: s.notice && typeof s.notice === 'object' ? s.notice : null,
      snippets: Array.isArray(s.snippets) ? s.snippets.filter((x) => x && typeof x.text === 'string') : null,
      blocked: Array.isArray(s.blocked) ? s.blocked : [],
      tm: s.tm === true,
      conversations: Array.isArray(s.conversations) ? s.conversations.filter((c) => c && c.id !== undefined && c.id !== null) : [],
      rooms: Array.isArray(s.rooms) ? s.rooms.filter((r) => r && r.id !== undefined && r.id !== null) : [],
      requests: Array.isArray(s.requests) ? s.requests.filter((r) => r && r.knock !== undefined && r.knock !== null) : []
    }
  }
  const peerOf = (c) => (c && c.peer && typeof c.peer === 'object' ? c.peer : {})
  const reqPeer = (r) => (r && r.peer && typeof r.peer === 'object' ? r.peer : (r && r.from && typeof r.from === 'object' ? r.from : {}))
  const named = (name, short) => (name ? (short ? T('apps.me', { name: cleanName(name), short: groupCode(short) }) : cleanName(name)) : (short ? groupCode(short) : T('apps.someone')))
  const pendingLabel = (c) => (c && c.code ? T('apps.conv.pendingCode', { code: groupCode(c.code) }) : T('apps.conv.pending'))
  const convLabel = (c) => { const p = peerOf(c); return cleanName(p.nick) || cleanName(p.name) || (p.short ? groupCode(p.short) : '') || pendingLabel(c) }
  const convTitle = (c) => { const p = peerOf(c); return p.nick || p.name ? named(p.nick || p.name, p.short) : (p.short ? groupCode(p.short) : pendingLabel(c)) }
  const personLabel = (p) => (p && (p.name || p.short) ? named(p.name, p.short) : T('apps.someone'))
  const pairRequests = (s) => s.requests.filter((r) => r.kind !== 'room')
  const roomRequestsOf = (s, room) => {
    const out = []
    const seen = new Set()
    const add = (r) => { if (r && r.knock !== undefined && !seen.has(r.knock)) { seen.add(r.knock); out.push(r) } }
    for (const r of s.requests) if (r.kind === 'room' && (r.roomId === undefined || r.roomId === null || r.roomId === room.id)) add(r)
    if (Array.isArray(room.requests)) for (const r of room.requests) add(r)
    return out
  }
  const allRoomRequests = (s) => {
    const out = []
    const seen = new Set()
    for (const r of s.requests) if (r.kind === 'room' && !seen.has(r.knock)) { seen.add(r.knock); out.push(r) }
    for (const room of s.rooms) for (const r of roomRequestsOf(s, room)) if (!seen.has(r.knock)) { seen.add(r.knock); out.push(r) }
    return out
  }
  const convById = (s, id) => s.conversations.find((c) => c.id === id) || null
  const roomById = (s, id) => s.rooms.find((r) => r.id === id) || null
  const ownsRoom = (r) => r.owner === true || r.role === 'owner'
  const isBlocked = (s, c) => c.status === 'blocked' || c.blocked === true || (!!peerOf(c).pub && s.blocked.indexOf(peerOf(c).pub) >= 0)

  // The view's own flags win over the service's until the service has a setter (see the header comment).
  const flagOf = (c, f) => { const o = local.conv.get(c.id); return o && Object.prototype.hasOwnProperty.call(o, f) ? !!o[f] : !!c[f] }
  const msgKey = (convId, id) => String(convId) + '\u0000' + String(id)
  const msgFlagOf = (convId, m, f) => { const o = local.msg.get(msgKey(convId, m.id)); return o && Object.prototype.hasOwnProperty.call(o, f) ? !!o[f] : !!m[f] }
  async function setFlag (c, f, on) {
    if (typeof service.setFlag === 'function') {
      await service.setFlag(c.id, f, on)
      const o = local.conv.get(c.id)
      if (o) delete o[f]
    } else {
      let o = local.conv.get(c.id)
      if (!o) { o = {}; local.conv.set(c.id, o) }
      o[f] = on
    }
    render()
  }
  async function setMsgFlag (convId, m, f, on) {
    if (typeof service.setMessageFlag === 'function') {
      await service.setMessageFlag(convId, m.id, f, on)
      const o = local.msg.get(msgKey(convId, m.id))
      if (o) delete o[f]
    } else {
      let o = local.msg.get(msgKey(convId, m.id))
      if (!o) { o = {}; local.msg.set(msgKey(convId, m.id), o) }
      o[f] = on
    }
    render()
  }

  const errText = (err) => T(errorKey(err))
  async function copyText (text) {
    try {
      if (typeof act.copy === 'function') return (await act.copy(text)) !== false
      const nav = W && W.navigator
      if (nav && nav.clipboard && typeof nav.clipboard.writeText === 'function') { await nav.clipboard.writeText(text); return true }
    } catch (_) { /* the note below says so */ }
    return false
  }
  function flashCopied (what) {
    st.copied = what
    clearT(memo.copiedTimer)
    memo.copiedTimer = setT(() => { st.copied = ''; if (!destroyed) render() }, 2500)
  }

  // ----- focus: a region that is drawn again gives the focus back to the control it replaced -------------------------------------
  function findFk (from, key) {
    if (!from || !key) return null
    for (const k of from.children || []) {
      if (fkOf(k) === key) return k
      const f = findFk(k, key)
      if (f) return f
    }
    return null
  }
  function focusFk (key) {
    const n = findFk(node, key)
    if (n && typeof n.focus === 'function') { try { n.focus() } catch (_) { /* hidden or gone */ } }
    return n
  }
  const keepFocus = (fn) => {
    const key = fkOf(D.activeElement)
    fn()
    if (!key) return
    const n = findFk(node, key)
    if (n && n !== D.activeElement && typeof n.focus === 'function') { try { n.focus() } catch (_) { /* hidden or gone */ } }
  }
  function focusTitle () { try { if (typeof titleEl.focus === 'function') titleEl.focus() } catch (_) { /* a courtesy */ } }
  const scroller = () => (node.parentNode && node.parentNode !== D ? node.parentNode : node)
  function scrollToBottom () { try { const sc = scroller(); sc.scrollTop = sc.scrollHeight } catch (_) { /* no layout */ } }
  function scrollToTop () { try { scroller().scrollTop = 0 } catch (_) { /* no layout */ } }
  function atBottom () {
    const sc = scroller()
    if (!(sc.scrollHeight > 0) || !(sc.clientHeight > 0)) return true
    return sc.scrollHeight - sc.scrollTop - sc.clientHeight < 96
  }
  // A panel opened from the header (the tools, the search) sits near the top of the view: bring it into sight (ui.css keeps it clear of the sticky header).
  function scrollToPanel (n) {
    if (n && typeof n.scrollIntoView === 'function') { try { n.scrollIntoView({ block: 'start' }) } catch (_) { /* no layout */ } }
  }
  function scrollToNode (n) {
    if (n && typeof n.scrollIntoView === 'function') { try { n.scrollIntoView({ block: 'center' }) } catch (_) { try { n.scrollIntoView() } catch (__) { /* no layout */ } } }
  }

  // ----- the persistent skeleton: inputs live as long as the view, lists are drawn again --------------------------------------------
  const node = el('div', { class: 'mw-apps-view', 'data-mw-apps': 'view' })
  const titleEl = el('h1', { class: 'mw-apps-title', tabindex: '-1', 'data-role': 'title' })
  const backBtn = button('', () => back(), 'mw-apps-back', { 'data-role': 'back', 'data-fk': 'back', hidden: true })
  const whoBox = el('div', { class: 'mw-apps-who' })
  // The line under the title in a conversation or a room: the status (and who is typing) on one side, the buttons that matter while reading on the other. It sticks with the header, so the status and the tools stay in reach at the newest message.
  // The two live lines are made once and their text is changed in place (when it differs): a screen reader hears a change in a live region that was already there, not a region that is built again with every draw.
  const statusLineEl = el('p', { class: 'mw-apps-status', role: 'status', 'aria-live': 'polite', 'data-role': 'status-line' })
  const typingLineEl = el('p', { class: 'mw-apps-typing', role: 'status', 'aria-live': 'polite', hidden: true, 'data-role': 'typing' })
  const subStatus = el('div', { class: 'mw-apps-substatus' }, [statusLineEl, typingLineEl])
  const setLine = (n, text) => { if (n.textContent !== text) n.textContent = text }
  const subActions = el('div', { class: 'mw-apps-subactions' })
  const subEl = el('div', { class: 'mw-apps-subline', hidden: true, 'data-role': 'subline' }, [subStatus, subActions])
  const headEl = el('header', { class: 'mw-apps-head' }, [backBtn, titleEl, whoBox, subEl])
  const toastEl = el('p', { class: 'mw-apps-toast', role: 'status', 'aria-live': 'polite', hidden: true, 'data-role': 'toast' })
  const cardHosts = { messages: el('div', { class: 'mw-apps-cardhost', 'data-role': 'cardhost' }), conversation: el('div', { class: 'mw-apps-cardhost', 'data-role': 'cardhost' }), rooms: el('div', { class: 'mw-apps-cardhost', 'data-role': 'cardhost' }), room: el('div', { class: 'mw-apps-cardhost', 'data-role': 'cardhost' }) }

  // ---- cards: the price before a code, a knock or an accept, and the confirmations ----------------------------
  function priceSpec (kind, { room = false, accept = false, run, onCancel } = {}) {
    const paras = [{ text: T(room ? 'apps.price.room' : 'apps.price.text') }]
    if (accept) paras.push({ text: T('apps.price.check') })
    return { kind, title: accept ? T(room ? 'apps.accept.titleRoom' : 'apps.accept.title') : T('apps.price.title'), paras, yes: T('apps.price.continue'), no: T('apps.price.notNow'), focus: 'yes', run, onCancel }
  }
  const confirmSpec = (kind, title, text, yes, run) => ({ kind, title, paras: [{ text }], yes, no: T('apps.confirm.no'), danger: true, focus: 'no', run })
  function openCard (spec) {
    st.card = Object.assign({ returnFk: fkOf(D.activeElement) }, spec)
    render()
    focusFk('card:' + (spec.focus || 'yes'))
  }
  function closeCard () {
    const c = st.card
    st.card = null
    render()
    if (c && typeof c.onCancel === 'function') { try { c.onCancel() } catch (_) { /* a courtesy */ } }
    if (c && c.returnFk) focusFk(c.returnFk)
  }
  async function runCard () {
    const c = st.card
    if (!c) return
    st.card = null
    render()
    try { await c.run() } catch (err) { log('card: ' + ((err && err.message) || err)) }
    render()
  }
  function renderCard () {
    for (const k of Object.keys(cardHosts)) clear(cardHosts[k])
    const c = st.card
    if (!c) return
    const host = cardHosts[st.view]
    if (!host) return
    const box = el('section', { class: 'mw-apps-card' + (c.danger ? ' mw-apps-card-danger' : ''), role: 'group', 'aria-label': c.title, 'data-role': 'card', 'data-kind': c.kind })
    box.appendChild(el('h2', { class: 'mw-apps-card-title', text: c.title }))
    for (const p of c.paras) box.appendChild(el('p', { class: 'mw-apps-card-text', text: p.text }))
    box.appendChild(el('div', { class: 'mw-actions' }, [
      button(c.yes, () => runCard(), c.danger ? 'mw-danger' : 'mw-primary', { 'data-role': 'card-continue', 'data-fk': 'card:yes' }),
      button(c.no, () => closeCard(), '', { 'data-role': 'card-cancel', 'data-fk': 'card:no' })
    ]))
    box.addEventListener('keydown', (ev) => { if (ev && ev.key === 'Escape') { if (typeof ev.stopPropagation === 'function') ev.stopPropagation(); guarded(closeCard)(ev) } })
    host.appendChild(box)
  }

  // ---- the header: back, the title, who is signed in --------------------------------------------------------------------------
  function avatarNode (seed) {
    const a = el('span', { class: 'mw-apps-avatar', 'aria-hidden': 'true' })
    const bits = avatarBits(seed)
    for (let i = 0; i < 25; i++) a.appendChild(el('i', { class: bits[i] ? 'mw-on' : '' }))
    return a
  }
  async function doSignIn () {
    try {
      if (typeof act.signIn === 'function') await act.signIn()
      else if (ui && typeof ui.prompt === 'function') await ui.prompt('signin', { method: 'signIn', options: {} })
    } finally { render() }
  }
  async function doSignOut () {
    try { if (typeof act.signOut === 'function') await act.signOut() } finally { render() }
  }
  function viewTitle (s) {
    if (st.view === 'messages') return T('apps.messages.title')
    if (st.view === 'conversation') { const c = convById(s, st.convId); return c ? convTitle(c) : T('apps.messages.title') }
    if (st.view === 'rooms') return T('apps.rooms.title')
    if (st.view === 'room') { const r = roomById(s, st.roomId); return r ? roomLabel(s, r) : T('apps.rooms.title') }
    return T('apps.title')
  }
  function renderHead (s) {
    const backKey = st.view === 'messages' || st.view === 'rooms' ? 'apps.back.apps' : st.view === 'conversation' ? 'apps.back.messages' : st.view === 'room' ? 'apps.back.rooms' : null
    backBtn.hidden = !backKey
    if (backKey) backBtn.textContent = T(backKey)
    titleEl.textContent = viewTitle(s)
    titleEl.setAttribute('dir', 'auto')
    if (s.signedIn) {
      const me = s.me || {}
      fill(whoBox, [
        avatarNode(me.pub || me.short || 'me'),
        el('span', { class: 'mw-apps-name', dir: 'auto', text: me.name || me.short ? named(me.name, me.short) : T('apps.you'), 'data-role': 'me' }),
        button(T('apps.signOut'), () => doSignOut(), 'mw-small', { 'data-role': 'signout', 'data-fk': 'signout' })
      ])
    } else {
      fill(whoBox, [button(T('apps.signIn'), () => doSignIn(), 'mw-primary', { 'data-role': 'signin', 'data-fk': 'signin' })])
    }
    const sub = st.view === 'conversation' || st.view === 'room'
    subEl.hidden = !sub
    headEl.className = 'mw-apps-head' + (sub ? ' mw-apps-head-sub' : '')
    if (!sub) clear(subActions)
  }

  // ---- navigation ----------------------------------------------------------------------------------------------------------------
  function saveDraft () {
    if (st.convId !== null && st.convId !== undefined) st.drafts.set(st.convId, dm.ta.value)
    if (st.roomId !== null && st.roomId !== undefined) st.roomDrafts.set(st.roomId, rm.ta.value)
  }
  function resetConvUi () {
    st.replyTo = null; st.editing = null; st.menuFor = null; st.reactFor = null; st.detailsFor = null
    st.select = false; st.selected = new Set(); st.search = { ids: null, i: 0, status: '' }
    st.toolsOpen = false; st.toolsReturn = false; st.searchOpen = false; notes.conv = ''
    dm.reset()
  }
  function back () {
    saveDraft()
    if (st.view === 'conversation') { st.view = 'messages'; st.convId = null } else if (st.view === 'room') { st.view = 'rooms'; st.roomId = null } else st.view = 'home'
    st.card = null
    render()
    focusTitle()
  }
  function enterMessages () {
    saveDraft()
    st.view = 'messages'; st.card = null
    const s = snapshot()
    if (!st.priceOk && !st.askedStart && !s.code) {
      st.askedStart = true
      render()
      openCard(priceSpec('start', { run: () => { st.priceOk = true; return startCode() } }))
      return
    }
    if (st.priceOk && !s.code && !st.openRequested) startCode()
    render()
    focusTitle()
  }
  function enterRooms () {
    saveDraft()
    st.view = 'rooms'; st.card = null
    render()
    focusTitle()
  }
  function openConv (id) {
    saveDraft()
    st.view = 'conversation'; st.convId = id; st.card = null
    resetConvUi()
    st.marked.delete(id)
    const c = convById(snapshot(), id)
    dm.ta.value = st.drafts.has(id) ? st.drafts.get(id) : (c && typeof c.draft === 'string' ? c.draft : '')
    memo.stick = true
    render()
    focusTitle()
  }
  function openRoom (id) {
    saveDraft()
    st.view = 'room'; st.roomId = id; st.card = null
    notes.room = ''
    const r = roomById(snapshot(), id)
    rm.reset()
    rm.ta.value = st.roomDrafts.has(id) ? st.roomDrafts.get(id) : (r && typeof r.draft === 'string' ? r.draft : '')
    memo.stick = true
    render()
    focusTitle()
  }

  // ---- home: the tiles ---------------------------------------------------------------------------------------------------------------
  const homeSub = el('p', { class: 'mw-apps-sub' })
  const startingNote = el('p', { class: 'mw-note', role: 'status', 'aria-live': 'polite', hidden: true, text: T('apps.starting') })
  const visitNote = el('p', { class: 'mw-note mw-apps-visit', hidden: true, text: T('apps.visitNote') })
  const tileDefs = [
    { key: 'messages', go: () => enterMessages() },
    { key: 'rooms', go: () => enterRooms() },
    { key: 'calls', soon: true },
    { key: 'files', soon: true },
    { key: 'media', soon: true },
    { key: 'link', always: true, go: () => { if (typeof act.openLink === 'function') act.openLink() } }
  ]
  function onTile (t) {
    if (t.node.getAttribute('aria-disabled') === 'true') {
      if (!t.d.soon && !t.d.always) focusFk('signin')
      return
    }
    t.d.go()
  }
  const tiles = tileDefs.map((d) => {
    const t = {
      d,
      lock: el('span', { class: 'mw-apps-lock', 'aria-hidden': 'true', hidden: true }),
      note: el('span', { class: 'mw-apps-tile-note' }),
      badge: el('span', { class: 'mw-apps-badge', hidden: true, 'data-role': 'badge' })
    }
    t.node = el('button', { type: 'button', class: 'mw-apps-tile', 'aria-disabled': 'true', 'data-app': d.key, 'data-fk': 'tile:' + d.key, onclick: trustedOnly(guarded(() => onTile(t))) }, [
      el('span', { class: 'mw-apps-tile-head' }, [el('span', { class: 'mw-apps-tile-title', text: T('apps.tile.' + d.key) }), t.badge]),
      el('span', { class: 'mw-apps-tile-text', text: T('apps.tile.' + d.key + '.text') }),
      el('span', { class: 'mw-apps-tile-foot' }, [t.lock, t.note])
    ])
    return t
  })
  const tilesBox = el('div', { class: 'mw-apps-tiles' }, tiles.map((t) => t.node))
  const homeView = el('section', { class: 'mw-apps-home', 'data-view': 'home' }, [homeSub, startingNote, tilesBox, visitNote])
  function badgeFor (key, s) {
    if (key === 'messages') return s.conversations.reduce((n, c) => n + (Number(c.unread) || 0), 0) + pairRequests(s).length
    if (key === 'rooms') return s.rooms.reduce((n, r) => n + (Number(r.unread) || 0), 0) + allRoomRequests(s).length
    return 0
  }
  function renderHome (s) {
    homeSub.textContent = s.signedIn ? T('apps.subtitle.in') : T('apps.subtitle.guest')
    startingNote.hidden = !(s.signedIn && !s.ready)
    visitNote.hidden = !s.signedIn
    for (const t of tiles) {
      const enabled = t.d.always ? typeof act.openLink === 'function' : (!t.d.soon && s.signedIn)
      t.node.setAttribute('aria-disabled', enabled ? 'false' : 'true')
      t.node.setAttribute('data-state', enabled ? 'active' : (t.d.soon ? 'soon' : 'locked'))
      const locked = !enabled && !t.d.soon && !t.d.always
      t.lock.hidden = !locked
      t.note.textContent = t.d.soon || (t.d.always && !enabled) ? T('apps.tile.notYet') : (locked ? T('apps.tile.signInFirst') : '')
      const n = enabled ? badgeFor(t.d.key, s) : 0
      t.badge.hidden = n <= 0
      t.badge.textContent = n <= 0 ? '' : (n > 9 ? '9+' : String(n))
      t.badge.setAttribute('aria-label', T('apps.conv.unread', { n }))
    }
  }

  // ---- Messages: your code, knocking, requests, the conversations -----------------------------------------------------------------
  const linkNote = el('p', { class: 'mw-note mw-apps-linknote', role: 'status', 'aria-live': 'polite', hidden: true, 'data-role': 'link-note' })
  const codeBox = el('section', { class: 'mw-apps-panel mw-apps-codebox', 'data-role': 'codebox' })
  const knockInput = el('input', {
    type: 'text', id: 'mw-apps-knock-input', class: 'mw-input mw-mono mw-apps-codeinput', autocomplete: 'off', autocapitalize: 'none', autocorrect: 'off', spellcheck: 'false',
    enterkeyhint: 'go', maxlength: '20', placeholder: 'abcd-efgh-2345', 'data-role': 'knock-input', 'data-fk': 'knock:input'
  })
  const knockNote = el('p', { class: 'mw-note', role: 'status', 'aria-live': 'polite', 'data-role': 'knock-note' })
  const knockForm = form('mw-apps-panel mw-apps-knock', [
    el('h2', { class: 'mw-apps-h2', text: T('apps.knock.title') }),
    el('label', { class: 'mw-apps-label', for: 'mw-apps-knock-input', text: T('apps.knock.label') }),
    el('div', { class: 'mw-row' }, [knockInput, button(T('apps.knock.button'), () => doKnock(), 'mw-primary', { 'data-role': 'knock-button', 'data-fk': 'knock:go' })]),
    el('p', { class: 'mw-note', text: T('apps.knock.help') }),
    knockNote
  ])
  enterKey(knockInput, () => doKnock())
  const reqBox = el('section', { class: 'mw-apps-panel mw-apps-requests', hidden: true, 'data-role': 'requests' })
  const filterInput = el('input', {
    type: 'search', id: 'mw-apps-filter-input', class: 'mw-input', autocomplete: 'off', spellcheck: 'false', 'aria-label': T('apps.conv.filter'),
    placeholder: T('apps.conv.filter.placeholder'), oninput: () => render(), 'data-role': 'filter-input', 'data-fk': 'filter:input'
  })
  const favBtn = button(T('apps.conv.favorites'), () => { st.favoritesOnly = !st.favoritesOnly; render() }, 'mw-small', { 'aria-pressed': 'false', 'data-role': 'fav-filter', 'data-fk': 'fav-filter' })
  const hiddenNote = el('p', { class: 'mw-note', hidden: true, 'data-role': 'hidden-note' })
  const convEmpty = el('p', { class: 'mw-note', text: T('apps.conv.none') })
  const convList = el('ul', { class: 'mw-apps-list', 'data-role': 'conv-list' })
  const archBtn = button('', () => { st.showArchived = !st.showArchived; render() }, 'mw-small', { 'aria-expanded': 'false', hidden: true, 'data-role': 'archived-toggle', 'data-fk': 'archived-toggle' })
  const archList = el('ul', { class: 'mw-apps-list', hidden: true, 'data-role': 'archived-list' })
  const convBox = el('section', { class: 'mw-apps-panel mw-apps-convbox', 'data-role': 'conversations' }, [
    el('h2', { class: 'mw-apps-h2', text: T('apps.conv.title') }),
    form('mw-row', [filterInput, favBtn]),
    hiddenNote, convEmpty, convList, archBtn, archList
  ])
  const messagesView = el('section', { class: 'mw-apps-messages', 'data-view': 'messages', hidden: true }, [linkNote, cardHosts.messages, codeBox, knockForm, reqBox, convBox])

  async function startCode () {
    st.openRequested = true
    notes.code = ''
    render()
    try {
      const r = await service.openCode()
      if (r && r.error) throw r.error
    } catch (err) { st.openRequested = false; notes.code = errText(err) }
    render()
  }
  function showMyCode () {
    if (!st.priceOk) { openCard(priceSpec('code', { run: () => { st.priceOk = true; return startCode() } })); return }
    return startCode()
  }
  async function newCode () {
    notes.code = ''
    try {
      const r = typeof service.newCode === 'function' ? await service.newCode() : await service.openCode()
      if (r && r.error) throw r.error
    } catch (err) { notes.code = errText(err) }
    render()
  }
  async function copyCode (shown) {
    notes.code = (await copyText(shown)) ? T('apps.code.copied') : T('apps.code.copyFailed')
    render()
  }
  async function doKnock () {
    const text = knockInput.value
    if (!codeLooksValid(text)) { notes.knock = T('apps.err.invalid'); render(); return }
    if (!st.priceOk) { openCard(priceSpec('knock', { run: () => { st.priceOk = true; return doKnock() } })); return }
    notes.knock = ''
    let r
    try { r = await service.knock(text) } catch (err) { r = { error: err } }
    if (r && r.error) notes.knock = errText(r.error)
    else { knockInput.value = ''; notes.knock = T('apps.knock.sent') }
    render()
  }
  function acceptPair (r) { openCard(priceSpec('accept', { accept: true, run: () => service.accept(r.knock) })) }
  async function rejectPair (r) { await service.reject(r.knock); render() }

  function renderCodeBox (s) {
    const kids = [el('h2', { class: 'mw-apps-h2', text: T('apps.code.title') })]
    if (s.code) {
      const shown = groupCode(s.code)
      kids.push(el('p', { class: 'mw-apps-code', 'data-role': 'code', text: shown }))
      kids.push(el('div', { class: 'mw-actions' }, [
        button(T('apps.code.copy'), () => copyCode(shown), '', { 'data-role': 'code-copy', 'data-fk': 'code:copy' }),
        button(T('apps.code.new'), () => newCode(), '', { 'data-role': 'code-new', 'data-fk': 'code:new' })
      ]))
      kids.push(el('p', { class: 'mw-note', text: T('apps.code.help') }))
    } else if (st.openRequested) {
      kids.push(el('p', { class: 'mw-note', role: 'status', text: T('apps.code.waiting') }))
    } else {
      kids.push(button(T('apps.code.show'), () => showMyCode(), 'mw-primary', { 'data-role': 'code-show', 'data-fk': 'code:show' }))
    }
    const nk = s.notice && s.notice.kind === 'code-replaced' ? 'apps.notice.codeReplaced' : (s.notice && s.notice.kind === 'code-closed' ? 'apps.notice.codeClosed' : null)
    if (nk) kids.push(el('p', { class: 'mw-note', role: 'status', 'data-role': 'code-notice', text: T(nk) }))
    if (notes.code) kids.push(el('p', { class: 'mw-note', role: 'status', 'aria-live': 'polite', 'data-role': 'code-note', text: notes.code }))
    fill(codeBox, kids)
  }
  function renderRequests (s) {
    const list = pairRequests(s)
    reqBox.hidden = !list.length
    const ul = el('ul', { class: 'mw-apps-list' })
    for (const r of list) {
      const p = reqPeer(r)
      ul.appendChild(el('li', { class: 'mw-apps-request', 'data-knock': r.knock }, [
        el('span', { class: 'mw-apps-request-text', dir: 'auto', text: T('apps.request.wants', { name: p.name ? cleanName(p.name) : T('apps.someone'), short: groupCode(p.short || '') }) }),
        el('span', { class: 'mw-apps-request-actions' }, [
          button(T('apps.request.accept'), () => acceptPair(r), 'mw-primary', { 'data-role': 'accept', 'data-fk': 'accept:' + r.knock }),
          button(T('apps.request.reject'), () => rejectPair(r), '', { 'data-role': 'reject', 'data-fk': 'reject:' + r.knock })
        ])
      ]))
    }
    fill(reqBox, [el('h2', { class: 'mw-apps-h2', text: T('apps.requests.title') }), ul])
  }
  const shortPlain = (text, max = 80) => previewText(String(text === null || text === undefined ? '' : text), max)
  function statusLine (c) {
    switch (c.status) {
      case 'connected': return T('apps.status.connected')
      case 'waiting': return T('apps.status.waiting')
      case 'rejected': return T('apps.status.rejected')
      case 'left': return T('apps.status.left')
      case 'blocked': return T('apps.status.blocked')
      default: {
        const at = Number(c.lastSeenAt || c.connectedAt)
        if (c.status === 'connecting' && !(at > 0)) return T('apps.status.connecting')
        return at > 0 ? T('apps.status.notConnected', { time: stampText(at, L, nowMs()) }) : T('apps.status.notConnectedYet')
      }
    }
  }
  function convRow (c) {
    const msgs = messagesOf(c)
    const last = msgs.length ? msgs[msgs.length - 1] : null
    const unread = Number(c.unread) || 0
    const marked = c.markedUnread === true || st.marked.has(c.id)
    const preview = c.status !== 'connected' && !last ? statusLine(c) : (last ? (last.deleted ? T('apps.conv.deletedLast') : (last.mine ? T('apps.conv.youLast', { text: shortPlain(last.text) }) : shortPlain(last.text))) : T('apps.conv.noMessages'))
    const marks = []
    if (flagOf(c, 'pinned')) marks.push(el('span', { class: 'mw-apps-mark', text: T('apps.conv.pinned') }))
    if (flagOf(c, 'favorite')) marks.push(el('span', { class: 'mw-apps-mark', text: T('apps.conv.favorite') }))
    if (flagOf(c, 'muted')) marks.push(el('span', { class: 'mw-apps-mark', text: T('apps.conv.muted') }))
    if (flagOf(c, 'hidden')) marks.push(el('span', { class: 'mw-apps-mark', text: T('apps.conv.hidden') }))
    if (marked) marks.push(el('span', { class: 'mw-apps-mark', text: T('apps.conv.markedUnread') }))
    const side = []
    const at = lastActivity(c)
    if (at > 0) side.push(el('span', { class: 'mw-apps-row-time', text: stampText(at, L, nowMs()) }))
    if (unread > 0) side.push(el('span', { class: 'mw-apps-badge', 'data-role': 'unread', 'aria-label': T('apps.conv.unread', { n: unread }), text: unread > 99 ? '99+' : String(unread) }))
    const btn = el('button', { type: 'button', class: 'mw-apps-rowbtn', 'data-conv': c.id, 'data-status': c.status || '', 'data-fk': 'conv:' + c.id, onclick: trustedOnly(guarded(() => openConv(c.id))) }, [
      el('span', { class: 'mw-apps-row-main' }, [
        el('span', { class: 'mw-apps-row-name', dir: 'auto', text: convTitle(c) }),
        marks.length ? el('span', { class: 'mw-apps-row-marks' }, marks) : null,
        el('span', { class: 'mw-apps-row-prev', dir: 'auto', text: preview })
      ]),
      el('span', { class: 'mw-apps-row-side' }, side)
    ])
    const li = el('li', { class: 'mw-apps-row' + (unread > 0 || marked ? ' mw-apps-unread' : '') }, [btn])
    if (c.status === 'waiting') li.appendChild(button(T('apps.conv.cancelRequest'), () => service.cancelKnock(c.knock !== undefined && c.knock !== null ? c.knock : c.id), 'mw-small', { 'data-role': 'cancel-knock', 'data-fk': 'cancel:' + c.id }))
    return li
  }
  // What the pair socket says, in words. The service reports 'closed' both for a socket nobody started yet (the person has not
  // agreed to the price) and for one shut for good (a sign-out): neither is a loss, so neither gets a note. A socket waiting to
  // retry reports 'connecting': before it was ever open that is "Connecting", after it was open it is a lost connection.
  function linkNoteText (s) {
    if (s.link !== 'connecting') return ''
    return T(memo.linkWasOpen ? 'apps.link.closed' : 'apps.link.connecting')
  }
  function renderMessagesView (s) {
    const linkText = linkNoteText(s)
    linkNote.hidden = !linkText
    linkNote.textContent = linkText
    renderCodeBox(s)
    knockNote.textContent = notes.knock
    renderRequests(s)
    const q = filterInput.value.trim().toLowerCase()
    const matches = (c) => {
      if (st.favoritesOnly && !flagOf(c, 'favorite')) return false
      if (!q) return !flagOf(c, 'hidden') // a hidden conversation shows only when the filter looks for it
      const last = messagesOf(c).slice(-1)[0]
      const hay = convLabel(c) + ' ' + groupCode(peerOf(c).short || '') + ' ' + (last && !last.deleted ? plainText(last.text) : '')
      return hay.toLowerCase().indexOf(q) >= 0
    }
    const { active, archived } = sortConversations(s.conversations, { flagOf, matches })
    convEmpty.hidden = s.conversations.length > 0
    const hiddenCount = s.conversations.filter((c) => flagOf(c, 'hidden')).length
    hiddenNote.hidden = !(hiddenCount > 0 && !q)
    hiddenNote.textContent = hiddenNote.hidden ? '' : T('apps.conv.hiddenNote', { n: hiddenCount })
    fill(convList, active.map(convRow))
    favBtn.setAttribute('aria-pressed', st.favoritesOnly ? 'true' : 'false')
    archBtn.hidden = !archived.length
    archBtn.textContent = T('apps.conv.archived', { n: archived.length })
    archBtn.setAttribute('aria-expanded', st.showArchived ? 'true' : 'false')
    archList.hidden = !(st.showArchived && archived.length)
    fill(archList, st.showArchived ? archived.map(convRow) : [])
  }

  // ---- messages: one list drawer for a conversation and a room -------------------------------------------------------------------
  const emojiOf = (m, mePub) => {
    const r = m && m.reactions && typeof m.reactions === 'object' ? m.reactions : {}
    for (const e of Object.keys(r)) if (Array.isArray(r[e]) && mePub && r[e].indexOf(mePub) >= 0) return e
    return null
  }
  function daySeparator (t) {
    const day = dayNumber(t)
    const text = day === dayNumber(nowMs()) ? T('apps.msg.today') : day === dayNumber(nowMs() - 86400000) ? T('apps.msg.yesterday') : dateText(t, L)
    return el('li', { class: 'mw-apps-day', role: 'separator', 'data-role': 'day' }, [el('span', { text })])
  }
  function msgSig (ctx) {
    const bits = [ctx.kind, ctx.convId, ctx.mePub || '', L, st.menuFor, st.reactFor, st.detailsFor, st.select ? Array.from(st.selected).join(',') : '-', ctx.hits ? Array.from(ctx.hits).join(',') : '', ctx.current]
    for (const m of ctx.list) {
      bits.push([m.id, m.status, m.t, m.text, m.deleted ? 1 : 0, m.readAt || '', m.deliveredAt || '', m.sendAt || '', m.scheduled ? 1 : 0, m.expAt || m.exp || '', m.reply || '', m.prio ? 1 : 0, Array.isArray(m.edits) ? m.edits.length : 0,
        JSON.stringify(m.reactions || null), ctx.kind === 'dm' ? ['pinned', 'saved', 'important'].map((f) => (msgFlagOf(ctx.convId, m, f) ? 1 : 0)).join('') : '', ctx.sender ? ctx.sender(m) : ''].join('~'))
    }
    return bits.join('\n')
  }
  function quoteNode (m, ctx) {
    const q = ctx.byId.get(m.reply)
    const who = q ? (q.mine ? T('apps.you') : (ctx.sender ? ctx.sender(q) : '')) : ''
    const text = q ? (q.deleted ? T('apps.msg.deleted') : shortPlain(q.text, 120)) : T('apps.msg.replyGone')
    return el('button', { type: 'button', class: 'mw-apps-quote', 'data-role': 'quote', 'data-quote-of': m.reply, 'data-fk': 'quote:' + m.id, onclick: trustedOnly(guarded(() => { if (q) jumpToMessage(q.id) })) }, [
      who ? el('span', { class: 'mw-apps-quote-who', dir: 'auto', text: who }) : null,
      el('span', { class: 'mw-apps-quote-text', dir: 'auto', text })
    ])
  }
  function ticksNode (m, status) {
    const label = status === 'read' ? T('apps.msg.read') : status === 'delivered' ? T('apps.msg.delivered') : status === 'queued' ? T('apps.msg.queued') : status === 'failed' ? T('apps.msg.failed') : T('apps.msg.sent')
    if (status === 'queued' || status === 'failed') return el('span', { class: 'mw-apps-state mw-apps-s-' + status, 'data-role': 'state', text: label })
    return el('span', { class: 'mw-apps-ticks mw-apps-s-' + status, role: 'img', 'aria-label': label, title: label, 'data-role': 'ticks', text: status === 'sent' ? '\u2713' : '\u2713\u2713' })
  }
  // when a message disappears: the service's expAt, else the sending time plus the timer
  const expiryOf = (m) => (Number(m.expAt) > 0 ? Number(m.expAt) : (Number(m.exp) > 0 && Number(m.t) > 0 ? Number(m.t) + Number(m.exp) : 0))
  function detailsNode (m, ctx) {
    const lines = [T('apps.details.sent', { time: stampText(m.t, L, nowMs()) })]
    if (Number(m.deliveredAt) > 0) lines.push(T('apps.details.delivered', { time: stampText(m.deliveredAt, L, nowMs()) }))
    if (Number(m.readAt) > 0) lines.push(T('apps.details.read', { time: stampText(m.readAt, L, nowMs()) }))
    if (expiryOf(m) > 0) lines.push(T('apps.details.expires', { time: stampText(expiryOf(m), L, nowMs()) }))
    const edits = Array.isArray(m.edits) ? m.edits : []
    if (edits.length) {
      lines.push(T('apps.details.edits', { n: edits.length }))
      for (const e of edits) lines.push(T('apps.details.before', { text: shortPlain(typeof e === 'string' ? e : (e && e.text) || '', 200) }))
    }
    return el('div', { class: 'mw-apps-details', 'data-role': 'details' }, lines.map((t) => el('p', { dir: 'auto', text: t })).concat([
      button(T('apps.details.close'), () => { st.detailsFor = null; render() }, 'mw-small mw-link', { 'data-role': 'details-close', 'data-fk': 'details-close:' + m.id })
    ]))
  }
  function messageActions (m, ctx, mine, deleted, pinned, saved) {
    const items = []
    if (!deleted) {
      items.push(['reply', T('apps.msg.reply'), () => startReply(m)])
      items.push(['react', T('apps.msg.react'), () => { st.reactFor = st.reactFor === m.id ? null : m.id; render() }])
      items.push(['copy', T('apps.msg.copy'), () => copyMessage(m)])
      if (mine && String(m.status) !== 'failed') items.push(['edit', T('apps.msg.edit'), () => startEdit(m)])
      items.push(['pin', pinned ? T('apps.msg.unpin') : T('apps.msg.pin'), () => { st.menuFor = null; return setMsgFlag(ctx.convId, m, 'pinned', !pinned) }])
      items.push(['save', saved ? T('apps.msg.unsave') : T('apps.msg.save'), () => { st.menuFor = null; return setMsgFlag(ctx.convId, m, 'saved', !saved) }])
      const imp = msgFlagOf(ctx.convId, m, 'important')
      items.push(['important', imp ? T('apps.msg.unmarkImportant') : T('apps.msg.markImportant'), () => { st.menuFor = null; return setMsgFlag(ctx.convId, m, 'important', !imp) }])
      items.push(['details', T('apps.msg.details'), () => { st.detailsFor = st.detailsFor === m.id ? null : m.id; render() }])
    }
    items.push(['delete-me', T('apps.msg.deleteMe'), () => deleteForMe(ctx.convId, m)])
    if (mine && !deleted) items.push(['delete-both', T('apps.msg.deleteBoth'), () => confirmDeleteBoth(ctx.convId, m)])
    return el('div', { class: 'mw-apps-menu', role: 'group', 'aria-label': T('apps.msg.menuLabel'), 'data-role': 'menu' }, items.map(([name, label, fn]) => button(label, fn, 'mw-small', { 'data-role': 'msg-' + name, 'data-fk': 'act:' + name + ':' + m.id })))
  }
  function messageNode (m, ctx) {
    const isDm = ctx.kind === 'dm'
    const mine = m.mine === true
    const deleted = m.deleted === true
    const status = mine ? String(m.status || 'sent') : ''
    const pinned = isDm && msgFlagOf(ctx.convId, m, 'pinned')
    const saved = isDm && msgFlagOf(ctx.convId, m, 'saved')
    const hit = ctx.hits && ctx.hits.has(m.id)
    const cls = 'mw-apps-msg ' + (mine ? 'mw-apps-mine' : 'mw-apps-theirs') + (deleted ? ' mw-apps-deleted' : '') + (pinned ? ' mw-apps-pinned' : '') + (hit ? ' mw-apps-hit' : '') +
      (ctx.current === m.id ? ' mw-apps-hit-current' : '') + (st.select && st.selected.has(m.id) ? ' mw-apps-selected' : '')
    const li = el('li', { class: cls, 'data-msg': m.id, 'data-status': status, 'data-mine': mine ? '1' : '0' })
    if (isDm && st.select) {
      li.appendChild(el('input', {
        type: 'checkbox', class: 'mw-apps-selbox', 'aria-label': T('apps.msg.select'), checked: st.selected.has(m.id), 'data-role': 'select', 'data-fk': 'sel:' + m.id,
        onchange: trustedOnly(guarded(() => { if (st.selected.has(m.id)) st.selected.delete(m.id); else st.selected.add(m.id); render() }))
      }))
    }
    const bubble = el('div', { class: 'mw-apps-bubble' })
    if (!isDm && !mine && ctx.sender) bubble.appendChild(el('div', { class: 'mw-apps-from', dir: 'auto', 'data-role': 'from', text: ctx.sender(m) }))
    if (m.reply && isDm) bubble.appendChild(quoteNode(m, ctx))
    const body = el('div', { class: 'mw-apps-body' + (deleted ? ' mw-apps-body-deleted' : ''), dir: 'auto', 'data-role': 'body' })
    if (deleted) body.textContent = T('apps.msg.deleted')
    else md1Append(D, body, m.text)
    bubble.appendChild(body)
    const meta = el('div', { class: 'mw-apps-meta' })
    let iso = ''
    try { iso = new Date(Number(m.t)).toISOString() } catch (_) { iso = '' }
    meta.appendChild(el('time', { class: 'mw-apps-time', datetime: iso, title: stampText(m.t, L, nowMs()), text: clockText(m.t, L) }))
    if (!deleted && Array.isArray(m.edits) && m.edits.length) meta.appendChild(el('span', { class: 'mw-apps-mark', 'data-role': 'edited', text: T('apps.msg.edited') }))
    if (pinned) meta.appendChild(el('span', { class: 'mw-apps-mark', 'data-role': 'pinned', text: T('apps.msg.pinned') }))
    if (saved) meta.appendChild(el('span', { class: 'mw-apps-mark', 'data-role': 'saved', text: T('apps.msg.saved') }))
    if (isDm && !deleted && (m.prio === true || msgFlagOf(ctx.convId, m, 'important'))) meta.appendChild(el('span', { class: 'mw-apps-mark mw-apps-important', 'data-role': 'important', text: T('apps.msg.important') }))
    if (!deleted && expiryOf(m) > 0) meta.appendChild(el('span', { class: 'mw-apps-mark', 'data-role': 'expires', text: T('apps.msg.expires', { time: stampText(expiryOf(m), L, nowMs()) }) }))
    if (mine && !deleted) {
      meta.appendChild(ticksNode(m, status))
      if (status === 'queued' && m.scheduled === true) {
        meta.appendChild(el('span', { class: 'mw-apps-mark', 'data-role': 'scheduled', text: T('apps.msg.scheduled', { time: stampText(Number(m.sendAt) > 0 ? m.sendAt : m.t, L, nowMs()) }) }))
        meta.appendChild(button(T('apps.msg.cancelSend'), () => cancelScheduled(ctx.convId, m), 'mw-small mw-link', { 'data-role': 'cancel-send', 'data-fk': 'cancel-send:' + m.id }))
      }
      if (status === 'failed') meta.appendChild(button(T('apps.msg.retry'), () => retryMessage(ctx.convId, m), 'mw-small mw-link', { 'data-role': 'retry', 'data-fk': 'retry:' + m.id }))
    }
    if (isDm && !st.select) {
      meta.appendChild(button(T('apps.msg.menu'), () => { st.menuFor = st.menuFor === m.id ? null : m.id; st.reactFor = null; render() }, 'mw-small mw-link', {
        'aria-expanded': st.menuFor === m.id ? 'true' : 'false', 'aria-label': T('apps.msg.menuLabel'), 'data-role': 'msg-menu', 'data-fk': 'menu:' + m.id
      }))
    }
    bubble.appendChild(meta)
    if (isDm && !deleted && m.reactions && typeof m.reactions === 'object') {
      const chips = []
      for (const e of Object.keys(m.reactions)) {
        const who = Array.isArray(m.reactions[e]) ? m.reactions[e] : []
        if (!who.length) continue
        const mineR = !!ctx.mePub && who.indexOf(ctx.mePub) >= 0
        chips.push(el('button', {
          type: 'button', class: 'mw-apps-react' + (mineR ? ' mw-apps-react-mine' : ''), 'aria-pressed': mineR ? 'true' : 'false', 'aria-label': (mineR ? T('apps.msg.reactRemove', { emoji: e }) : T('apps.msg.reactLabel', { emoji: e })) + ' (' + who.length + ')',
          'data-role': 'reaction', 'data-emoji': e, 'data-fk': 'react:' + e + ':' + m.id, onclick: trustedOnly(guarded(() => reactWith(ctx.convId, m, e, ctx.mePub))), text: e + ' ' + who.length
        }))
      }
      if (chips.length) bubble.appendChild(el('div', { class: 'mw-apps-reacts', 'data-role': 'reactions' }, chips))
    }
    if (isDm && !st.select && st.menuFor === m.id) {
      bubble.appendChild(messageActions(m, ctx, mine, deleted, pinned, saved))
      if (st.reactFor === m.id) {
        bubble.appendChild(el('div', { class: 'mw-apps-reactrow', role: 'group', 'aria-label': T('apps.msg.react'), 'data-role': 'react-row' }, REACTIONS.map((e) => button(e, () => reactWith(ctx.convId, m, e, ctx.mePub), 'mw-small mw-apps-emoji', { 'aria-label': T('apps.msg.reactLabel', { emoji: e }), 'data-role': 'react-pick', 'data-emoji': e, 'data-fk': 'pick:' + e + ':' + m.id }))))
      }
      if (st.detailsFor === m.id) bubble.appendChild(detailsNode(m, ctx))
    }
    li.appendChild(bubble)
    return li
  }
  // Draws the list again only when something that shows in it changed (a selection in a message survives an acknowledgement). Returns true when drawn.
  function drawMessages (listEl, ctx) {
    const sig = msgSig(ctx)
    if (listEl.__sig === sig) return false
    listEl.__sig = sig
    const sc = scroller()
    let top = 0
    try { top = sc.scrollTop || 0 } catch (_) { top = 0 }
    const kids = []
    let lastDay = 0
    for (const m of ctx.list) {
      if (!m || m.id === undefined) continue
      const day = dayNumber(m.t)
      if (day && day !== lastDay) { kids.push(daySeparator(m.t)); lastDay = day }
      kids.push(messageNode(m, ctx))
    }
    fill(listEl, kids)
    try { sc.scrollTop = top } catch (_) { /* no layout */ }
    return true
  }
  function jumpToMessage (id) {
    const n = findMsgNode(id)
    if (n) scrollToNode(n)
  }
  function findMsgNode (id) {
    const walk = (from) => {
      for (const k of from.children || []) {
        if (k.getAttribute && k.getAttribute('data-msg') === String(id)) return k
        const f = walk(k)
        if (f) return f
      }
      return null
    }
    return walk(node)
  }

  // ---- what a message's actions do ---------------------------------------------------------------------------------------------------
  function startReply (m) {
    st.replyTo = { convId: st.convId, id: m.id }
    st.menuFor = null
    render()
    try { dm.ta.focus() } catch (_) { /* hidden */ }
  }
  function startEdit (m) {
    st.editing = { convId: st.convId, id: m.id, saved: st.editing ? st.editing.saved : dm.ta.value }
    st.menuFor = null
    dm.ta.value = String(m.text || '')
    render()
    try { dm.ta.focus() } catch (_) { /* hidden */ }
  }
  async function copyMessage (m) {
    notes.conv = (await copyText(String(m.text || ''))) ? T('apps.msg.copied') : T('apps.code.copyFailed')
    st.menuFor = null
    render()
  }
  async function deleteForMe (convId, m) {
    st.menuFor = null
    await service.remove(convId, m.id, { both: false })
    render()
  }
  function confirmDeleteBoth (convId, m) {
    st.menuFor = null
    openCard(confirmSpec('delete-both', T('apps.confirm.deleteBoth.title'), T('apps.confirm.deleteBoth.text'), T('apps.msg.deleteBoth'), () => service.remove(convId, m.id, { both: true })))
  }
  async function reactWith (convId, m, emoji, mePub) {
    const mineNow = emojiOf(m, mePub)
    st.reactFor = null
    st.menuFor = null
    await service.react(convId, m.id, mineNow === emoji ? null : emoji)
    render()
  }
  async function cancelScheduled (convId, m) {
    if (typeof service.cancelSend === 'function') await service.cancelSend(convId, m.id)
    render()
  }
  async function retryMessage (convId, m) {
    if (typeof service.retry === 'function') await service.retry(convId, m.id)
    else {
      await service.remove(convId, m.id, { both: false })
      const opts = {}
      if (m.reply) opts.reply = m.reply
      if (Number(m.exp) > 0) opts.exp = Number(m.exp)
      if (m.prio) opts.prio = true
      await service.send(convId, String(m.text || ''), opts)
    }
    memo.stick = true
    render()
  }

  // ---- composers: the conversation's (text, emoji, formatting hints, snippets, send later, important, reply, edit) and the room's (text, emoji) ----
  function makeComposer (kind) {
    const isDm = kind === 'dm'
    const max = isDm ? DM_TEXT_MAX : ROOM_TEXT_MAX
    const p = { panel: null, important: false, laterAt: null, typingOn: false, typingTimer: null, error: '' }
    const idOf = () => (isDm ? st.convId : st.roomId)
    const ta = el('textarea', {
      class: 'mw-input mw-apps-ta', rows: '2', maxlength: String(max), spellcheck: 'true', autocomplete: 'off', autocapitalize: 'sentences', autocorrect: 'on', enterkeyhint: 'send',
      placeholder: T('apps.composer.placeholder'), 'aria-label': T('apps.composer.label'), 'data-role': isDm ? 'composer' : 'room-composer', 'data-fk': kind + ':ta'
    })
    const sendBtn = button(T('apps.composer.send'), () => submit(), 'mw-primary mw-apps-send', { 'data-role': isDm ? 'send' : 'room-send', 'data-fk': kind + ':send' })
    const bar = el('div', { class: 'mw-apps-bar', 'data-role': kind + '-bar' })
    const options = el('div', { class: 'mw-apps-options' })
    const panel = el('div', { class: 'mw-apps-composer-panel', 'data-role': kind + '-panel' })
    const counter = el('p', { class: 'mw-note mw-apps-counter', hidden: true, 'data-role': kind + '-counter' })
    const laterInput = el('input', { type: 'datetime-local', class: 'mw-input', 'aria-label': T('apps.composer.laterAt'), 'data-role': 'later-input', 'data-fk': 'later:input' })
    const formEl = form('mw-apps-composer', [bar, el('div', { class: 'mw-apps-compose-row' }, [ta, sendBtn]), counter, options, panel])

    function stopTyping () {
      clearT(p.typingTimer); p.typingTimer = null
      if (isDm && p.typingOn) {
        p.typingOn = false
        const id = idOf()
        if (id !== null && id !== undefined && typeof service.typing === 'function') { try { Promise.resolve(service.typing(id, false)).catch(() => {}) } catch (_) { /* a courtesy */ } }
      }
    }
    function onInput () {
      const id = idOf()
      if (id === null || id === undefined) return
      if (isDm) {
        st.drafts.set(id, ta.value)
        if (typeof service.setDraft === 'function') { try { service.setDraft(id, ta.value) } catch (_) { /* a courtesy */ } }
        const c = convById(snapshot(), id)
        const allowed = !c || !c.cfg || c.cfg.typing !== false
        if (!ta.value) stopTyping()
        else if (allowed && typeof service.typing === 'function') {
          if (!p.typingOn) { p.typingOn = true; try { Promise.resolve(service.typing(id, true)).catch(() => {}) } catch (_) { /* a courtesy */ } }
          clearT(p.typingTimer)
          p.typingTimer = setT(stopTyping, TYPING_IDLE_MS)
        }
      } else st.roomDrafts.set(id, ta.value)
      updateCounter()
    }
    function updateCounter () {
      const n = Array.from(ta.value).length
      counter.hidden = n < max * 0.85
      counter.textContent = counter.hidden ? '' : T('apps.composer.counter', { n, max })
    }
    ta.addEventListener('input', () => { try { onInput() } catch (err) { log('input: ' + ((err && err.message) || err)) } })
    ta.addEventListener('blur', () => { if (isDm) stopTyping() })
    ta.addEventListener('keydown', (ev) => {
      if (!ev || ev.key !== 'Enter' || ev.shiftKey || ev.isComposing || ev.keyCode === 229) return
      if (ev.isTrusted === false) return
      if (typeof ev.preventDefault === 'function') ev.preventDefault()
      guarded(submit)(ev)
    })
    function insertAtCursor (text) {
      const v = ta.value
      if (Array.from(v + text).length > max) return
      const a = Number.isInteger(ta.selectionStart) ? ta.selectionStart : v.length
      const b = Number.isInteger(ta.selectionEnd) ? ta.selectionEnd : v.length
      ta.value = v.slice(0, a) + text + v.slice(b)
      const pos = a + text.length
      try { ta.setSelectionRange(pos, pos) } catch (_) { /* not a text field in this DOM */ }
      onInput()
      try { ta.focus() } catch (_) { /* hidden */ }
    }
    async function submit () {
      const id = idOf()
      if (id === null || id === undefined || ta.disabled) return
      const text = ta.value.replace(/\s+$/, '')
      if (!text.trim()) return
      const c = isDm ? convById(snapshot(), id) : null
      p.error = ''
      try {
        if (isDm && st.editing && st.editing.convId === id) {
          const r = await service.edit(id, st.editing.id, text)
          if (r && r.error) throw r.error
          ta.value = st.editing.saved || ''
          st.editing = null
        } else if (isDm) {
          const opts = {}
          if (st.replyTo && st.replyTo.convId === id) opts.reply = st.replyTo.id
          const exp = c && c.cfg ? Number(c.cfg.exp) : 0
          if (exp > 0) opts.exp = exp
          if (p.important) opts.prio = true
          if (p.laterAt) opts.at = p.laterAt
          const r = await service.send(id, text, opts)
          if (r && r.error) throw r.error
          ta.value = ''
          st.replyTo = null; p.important = false; p.laterAt = null; p.panel = null
        } else {
          const r = await service.sendRoom(id, text)
          if (r && r.error) throw r.error
          ta.value = ''
        }
        if (isDm) st.drafts.set(id, ta.value)
        else st.roomDrafts.set(id, ta.value)
        stopTyping()
        memo.stick = true
      } catch (err) {
        log('send: ' + ((err && err.message) || err))
        // A text that cannot fit a frame (or a send time too far ahead) has its own words: "Try again" would never work for it (e2e APPS-2, limits).
        const why = errorKey(err)
        p.error = T(why === 'apps.err.tooLong' || why === 'apps.err.tooFar' ? why : 'apps.err.send')
      }
      updateCounter()
      render()
      try { ta.focus() } catch (_) { /* hidden */ }
    }
    function togglePanel (name) { p.panel = p.panel === name ? null : name; render() }
    function scheduleLater () {
      const at = parseLocalMoment(laterInput.value)
      if (at === null || at <= nowMs()) { p.error = T('apps.composer.laterPast'); render(); return }
      p.laterAt = at; p.panel = null; p.error = ''
      render()
    }
    // The snippets are the service's when it keeps them (addSnippet, removeSnippet, state().snippets), else this view's own for the visit.
    const snippetList = () => {
      const s = snapshot()
      if (typeof service.addSnippet === 'function' && s.snippets) return s.snippets.map((x) => ({ id: x.id, text: x.text }))
      return st.snippets.map((t, i) => ({ id: 'local:' + i, text: t }))
    }
    function saveSnippet () {
      const t = ta.value.trim()
      if (!t || Array.from(t).length > 500) return
      if (typeof service.addSnippet === 'function') { Promise.resolve(service.addSnippet(t)).then(() => render(), () => {}); return }
      st.snippets = [t].concat(st.snippets.filter((x) => x !== t)).slice(0, 20)
      render()
    }
    function removeSnippet (sn) {
      if (typeof service.removeSnippet === 'function') { Promise.resolve(service.removeSnippet(sn.id)).then(() => render(), () => {}); return }
      st.snippets = st.snippets.filter((x) => x !== sn.text)
      render()
    }

    // ctx: { enabled, closedNote, c } from the view that owns this composer
    function update (ctx) {
      ta.disabled = !ctx.enabled
      sendBtn.disabled = !ctx.enabled
      const editing = isDm && st.editing && st.editing.convId === idOf()
      sendBtn.textContent = editing ? T('apps.composer.save') : T('apps.composer.send')
      const barKids = []
      if (isDm && editing) {
        barKids.push(el('div', { class: 'mw-apps-barline', 'data-role': 'editing' }, [el('span', { text: T('apps.msg.editing') }), button(T('apps.msg.cancelEdit'), () => cancelEdit(), 'mw-small mw-link', { 'data-role': 'cancel-edit', 'data-fk': 'cancel-edit' })]))
      }
      if (isDm && st.replyTo && st.replyTo.convId === idOf() && ctx.c) {
        const q = messagesOf(ctx.c).find((x) => x.id === st.replyTo.id)
        const who = q ? (q.mine ? T('apps.you') : convLabel(ctx.c)) : ''
        barKids.push(el('div', { class: 'mw-apps-barline', 'data-role': 'replying' }, [
          el('span', { dir: 'auto', text: T('apps.msg.replyingTo', { name: who || T('apps.someone') }) + (q ? ': ' + shortPlain(q.text, 80) : '') }),
          button(T('apps.msg.cancelReply'), () => { st.replyTo = null; render() }, 'mw-small mw-link', { 'data-role': 'cancel-reply', 'data-fk': 'cancel-reply' })
        ]))
      }
      if (isDm && p.laterAt) {
        barKids.push(el('div', { class: 'mw-apps-barline', 'data-role': 'later-note' }, [
          el('span', { text: T('apps.composer.laterNote', { time: stampText(p.laterAt, L, nowMs()) }) }),
          button(T('apps.composer.laterClear'), () => { p.laterAt = null; render() }, 'mw-small mw-link', { 'data-role': 'later-clear', 'data-fk': 'later-clear' })
        ]))
      }
      if (ctx.closedNote) barKids.push(el('p', { class: 'mw-note', 'data-role': 'closed-note', text: ctx.closedNote }))
      if (p.error) barKids.push(el('p', { class: 'mw-note mw-apps-error', role: 'alert', 'data-role': 'composer-error', text: p.error }))
      fill(bar, barKids)
      const opt = [button(T('apps.composer.emoji'), () => togglePanel('emoji'), 'mw-small', { 'aria-pressed': p.panel === 'emoji' ? 'true' : 'false', 'data-role': 'emoji-toggle', 'data-fk': kind + ':emoji' })]
      if (isDm) {
        opt.push(button(T('apps.composer.format'), () => togglePanel('format'), 'mw-small', { 'aria-pressed': p.panel === 'format' ? 'true' : 'false', 'data-role': 'format-toggle', 'data-fk': 'dm:format' }))
        opt.push(button(T('apps.composer.snippets'), () => togglePanel('snippets'), 'mw-small', { 'aria-pressed': p.panel === 'snippets' ? 'true' : 'false', 'data-role': 'snippets-toggle', 'data-fk': 'dm:snippets' }))
        opt.push(button(T('apps.composer.later'), () => togglePanel('later'), 'mw-small', { 'aria-pressed': p.panel === 'later' ? 'true' : 'false', 'data-role': 'later-toggle', 'data-fk': 'dm:later' }))
        opt.push(button(T('apps.composer.important'), () => { p.important = !p.important; render() }, 'mw-small', { 'aria-pressed': p.important ? 'true' : 'false', 'data-role': 'important-toggle', 'data-fk': 'dm:important' }))
      }
      fill(options, opt)
      // The panel is drawn again only when it changes, so a date being typed in 'Send later' keeps its focus.
      const sig = String(p.panel) + (p.panel === 'snippets' ? JSON.stringify(snippetList()) : '')
      if (panel.__sig !== sig) {
        panel.__sig = sig
        const kids = []
        if (p.panel === 'emoji') {
          kids.push(el('div', { class: 'mw-apps-emojis', role: 'group', 'aria-label': T('apps.composer.emoji'), 'data-role': 'emoji-panel' }, EMOJI.map((e) => button(e, () => insertAtCursor(e), 'mw-small mw-apps-emoji', { 'aria-label': T('apps.composer.emojiLabel', { emoji: e }), 'data-role': 'emoji', 'data-emoji': e, 'data-fk': 'emoji:' + e }))))
        } else if (isDm && p.panel === 'format') {
          kids.push(el('p', { class: 'mw-note mw-mono', 'data-role': 'format-help', text: T('apps.composer.formatHelp') }))
        } else if (isDm && p.panel === 'snippets') {
          const items = snippetList().map((sn, i) => el('div', { class: 'mw-apps-snippet-row' }, [
            button(T('apps.composer.snippetUse', { text: shortPlain(sn.text, 60) }), () => insertAtCursor(sn.text), 'mw-small mw-apps-snippet', { 'data-role': 'snippet', 'data-fk': 'snippet:' + i }),
            button(T('apps.composer.snippetRemove'), () => removeSnippet(sn), 'mw-small mw-link', { 'aria-label': T('apps.composer.snippetRemoveLabel', { text: shortPlain(sn.text, 40) }), 'data-role': 'snippet-remove', 'data-fk': 'snippet-remove:' + i })
          ]))
          kids.push(el('div', { class: 'mw-apps-snippets', 'data-role': 'snippets-panel' }, items.length ? items : [el('p', { class: 'mw-note', text: T('apps.composer.snippetNone') })]))
          kids.push(button(T('apps.composer.snippetSave'), () => saveSnippet(), 'mw-small', { 'data-role': 'snippet-save', 'data-fk': 'snippet-save' }))
        } else if (isDm && p.panel === 'later') {
          laterInput.min = localMoment(nowMs())
          if (!laterInput.value) laterInput.value = localMoment(nowMs() + 600000)
          kids.push(el('div', { class: 'mw-apps-later', 'data-role': 'later-panel' }, [
            el('label', { class: 'mw-apps-label', for: 'mw-apps-later-input', text: T('apps.composer.laterAt') }),
            laterInput,
            button(T('apps.composer.laterSet'), () => scheduleLater(), 'mw-primary mw-small', { 'data-role': 'later-set', 'data-fk': 'later:set' })
          ]))
          laterInput.setAttribute('id', 'mw-apps-later-input')
        }
        fill(panel, kids)
      }
      updateCounter()
    }
    function cancelEdit () {
      if (!st.editing) return
      ta.value = st.editing.saved || ''
      st.editing = null
      render()
    }
    function reset () {
      stopTyping()
      p.panel = null; p.important = false; p.laterAt = null; p.error = ''
      ta.value = ''
    }
    return { node: formEl, ta, sendBtn, update, reset, stopTyping, submit, state: p }
  }
  const dm = makeComposer('dm')
  const rm = makeComposer('room')

  // ---- one conversation: status line, tools, search, messages, composer ----------------------------------------------------------------
  const currentConv = () => convById(snapshot(), st.convId)
  const convHead = el('div', { class: 'mw-apps-conv-head', 'data-role': 'conv-head' })
  const convNote = el('p', { class: 'mw-note', role: 'status', 'aria-live': 'polite', 'data-role': 'conv-note' })
  const msgListC = el('ul', { class: 'mw-apps-msgs', role: 'log', 'aria-live': 'polite', 'aria-relevant': 'additions', 'aria-label': T('apps.msg.list'), 'data-role': 'messages' })
  const jumpNewC = button(T('apps.tool.newMessages'), () => { scrollToBottom(); jumpNewC.hidden = true }, 'mw-primary mw-apps-jump', { hidden: true, 'data-role': 'jump-new', 'data-fk': 'jump-new' })

  // tools: toggles and actions are drawn again; the two selects and the nickname field live as long as the view
  const toolsToggles = el('div', { class: 'mw-apps-toolrow', 'data-role': 'tools-toggles' })
  const cfgToggles = el('span', { class: 'mw-apps-toolgroup' })
  const optionsOf = (choices, key) => choices.map(([value, k]) => el('option', { value: String(value), text: T(key + k) }))
  const expSel = el('select', { id: 'mw-apps-exp', class: 'mw-input', 'data-role': 'exp-select', 'data-fk': 'tool:exp' }, optionsOf(EXPIRY_CHOICES, 'apps.exp.'))
  const fontSel = el('select', { id: 'mw-apps-font', class: 'mw-input', 'data-role': 'font-select', 'data-fk': 'tool:font' }, optionsOf(FONT_SIZES.map((f) => [f, f]), 'apps.font.'))
  const nickInput = el('input', { type: 'text', id: 'mw-apps-nick', class: 'mw-input', maxlength: '32', autocomplete: 'off', spellcheck: 'false', 'data-role': 'nick-input', 'data-fk': 'tool:nick' })
  const toolsActions = el('div', { class: 'mw-apps-toolrow', 'data-role': 'tools-actions' })
  const noteInput = el('textarea', { id: 'mw-apps-note', class: 'mw-input', rows: '2', maxlength: '2000', spellcheck: 'true', 'data-role': 'note-input', 'data-fk': 'tool:note' })
  const notesMem = new Map() // the notes of this visit when the service keeps none (setNote)
  noteInput.addEventListener('input', () => {
    const c = currentConv()
    if (!c) return
    if (typeof service.setNote === 'function') { try { service.setNote(c.id, noteInput.value) } catch (_) { /* a courtesy */ } } else notesMem.set(c.id, noteInput.value)
  })
  const field = (id, label, control) => el('span', { class: 'mw-apps-field' }, [el('label', { class: 'mw-apps-label', for: id, text: label }), control])
  const nickForm = form('mw-apps-toolrow', [field('mw-apps-nick', T('apps.tool.nickname'), nickInput), button(T('apps.tool.nicknameSave'), () => saveNickname(), 'mw-small', { 'data-role': 'nick-save', 'data-fk': 'tool:nick-save' })])
  enterKey(nickInput, () => saveNickname())
  const toolsPanel = el('div', { class: 'mw-apps-tools', hidden: true, 'data-role': 'tools' }, [
    toolsToggles,
    el('div', { class: 'mw-apps-toolrow' }, [field('mw-apps-exp', T('apps.tool.expiry'), expSel), cfgToggles, field('mw-apps-font', T('apps.tool.fontSize'), fontSel)]),
    nickForm,
    field('mw-apps-note', T('apps.tool.note'), noteInput),
    toolsActions
  ])
  expSel.addEventListener('change', trustedOnly(guarded(async () => {
    const c = currentConv()
    if (!c) return
    const ms = Number(expSel.value) || 0
    await service.setCfg(c.id, { exp: ms > 0 ? ms : null })
    render()
  })))
  fontSel.addEventListener('change', trustedOnly(guarded(() => { st.font = FONT_SIZES.indexOf(fontSel.value) >= 0 ? fontSel.value : 'normal'; render() })))
  async function saveNickname () {
    const c = currentConv()
    if (!c) return
    await service.setNickname(c.id, cleanName(nickInput.value, 32))
    render()
  }
  async function setCfg (c, patch) { await service.setCfg(c.id, patch); render() }
  async function markUnread (c) {
    if (typeof service.markUnread !== 'function') { st.marked.add(c.id); back(); return }
    back() // leave first: the open conversation of a visible page would read itself again when the service answers
    await service.markUnread(c.id)
  }
  function toggleSelect () {
    st.select = !st.select
    st.selected = new Set()
    st.menuFor = null
    render()
  }
  function toggleSearch () {
    st.searchOpen = !st.searchOpen
    if (!st.searchOpen) st.search = { ids: null, i: 0, status: '' }
    render()
    if (st.searchOpen) { focusFk('search:text'); scrollToPanel(searchPanel) }
  }
  function toggleTools () {
    const open = !st.toolsOpen
    if (open) st.toolsReturn = atBottom()
    st.toolsOpen = open
    render()
    if (open) scrollToPanel(toolsPanel)
    else if (st.toolsReturn) { st.toolsReturn = false; scrollToBottom() }
  }
  function confirmClear (c) { openCard(confirmSpec('clear', T('apps.confirm.clear.title'), T('apps.confirm.clear.text'), T('apps.tool.clear'), () => service.clear(c.id))) }
  function confirmLeave (c) {
    openCard(confirmSpec('leave', T('apps.confirm.leave.title'), T('apps.confirm.leave.text'), T('apps.tool.leave'), async () => {
      await service.leave(c.id)
      if (st.convId === c.id) { st.view = 'messages'; st.convId = null }
    }))
  }
  function confirmBlock (c) { openCard(confirmSpec('block', T('apps.confirm.block.title'), T('apps.confirm.block.text'), T('apps.tool.block'), () => service.block(peerOf(c).pub))) }
  function confirmDeleteSelected (c) {
    const ids = Array.from(st.selected)
    if (!ids.length) return
    openCard(confirmSpec('delete-many', T('apps.confirm.deleteMany.title', { n: ids.length }), T('apps.confirm.deleteMany.text'), T('apps.msg.deleteMe'), async () => {
      for (const id of ids) await service.remove(c.id, id, { both: false })
      st.select = false; st.selected = new Set()
    }))
  }
  // The file name of an export: the person's short id and the UTC day (exported for the tests).
  async function doExport (c) {
    let file = null
    try {
      if (typeof service.exportData === 'function') {
        const r = await service.exportData(c.id)
        if (r && r.ok && typeof r.text === 'string') file = { name: r.fileName, text: r.text, mime: r.mime }
      }
      if (!file && typeof service.exportJson === 'function') {
        const data = await service.exportJson(c.id)
        const text = typeof data === 'string' ? data : (data && typeof data === 'object' && !data.error ? JSON.stringify(data, null, 2) : '')
        if (text) file = { name: null, text, mime: 'application/json' }
      }
    } catch (_) { file = null }
    const ok = !!file && ui && typeof ui.download === 'function' ? ui.download(file.name || modelFileName(c, nowMs()), file.text, file.mime || 'application/json') : false
    notes.conv = ok ? '' : T('apps.tool.exportFailed')
    render()
  }
  function verifyFor (c) {
    const direct = verifyText(c.compareText) || verifyText(c.compare) || verifyText(c.verify)
    if (direct) return direct
    if (st.verify.has(c.id)) return st.verify.get(c.id)
    if (typeof service.verifyCode === 'function' && (c.status === 'connected' || c.status === 'connecting') && peerOf(c).pub) {
      st.verify.set(c.id, '')
      Promise.resolve().then(() => service.verifyCode(c.id)).then((v) => { st.verify.set(c.id, verifyText(v)); if (!destroyed) render() }, () => { /* no code: the line stays out */ })
    }
    return ''
  }
  function renderConvHead (c) {
    statusLineEl.setAttribute('data-status', c.status || '')
    setLine(statusLineEl, statusLine(c))
    typingLineEl.hidden = c.typingPeer !== true
    setLine(typingLineEl, c.typingPeer === true ? T('apps.typing', { name: convLabel(c) }) : '')
    const row = []
    if (c.status === 'waiting') row.push(button(T('apps.conv.cancelRequest'), () => service.cancelKnock(c.knock !== undefined && c.knock !== null ? c.knock : c.id), 'mw-small', { 'data-role': 'cancel-knock', 'data-fk': 'cancel:' + c.id }))
    if (st.select) row.push(button(T('apps.tool.deleteSelected', { n: st.selected.size }), () => confirmDeleteSelected(c), 'mw-small mw-danger', { disabled: st.selected.size === 0, 'data-role': 'delete-selected', 'data-fk': 'delete-selected' }))
    row.push(button(T('apps.tools.toggle'), () => toggleTools(), 'mw-small', { 'aria-expanded': st.toolsOpen ? 'true' : 'false', 'data-role': 'tools-toggle', 'data-fk': 'tools-toggle' }))
    fill(subActions, row)
    const v = verifyFor(c)
    fill(convHead, v ? [el('p', { class: 'mw-apps-verify', 'data-role': 'verify' }, [el('span', { class: 'mw-mono', text: T('apps.verify', { code: v }) }), el('span', { class: 'mw-note', text: ' ' + T('apps.verify.help') })])] : [])
  }
  function ensureOption (sel, value, label) {
    for (const o of sel.children || []) if (o.value === String(value)) return
    sel.appendChild(el('option', { value: String(value), text: label }))
  }
  function renderTools (c, s) {
    toolsPanel.hidden = !st.toolsOpen
    if (!st.toolsOpen) return
    const cfg = c.cfg && typeof c.cfg === 'object' ? c.cfg : {}
    const pinned = flagOf(c, 'pinned'); const fav = flagOf(c, 'favorite'); const muted = flagOf(c, 'muted'); const arch = flagOf(c, 'archived'); const hid = flagOf(c, 'hidden')
    const small = (label, fn, role, on, extra) => button(label, fn, 'mw-small', Object.assign({ 'data-role': role, 'data-fk': 'tool:' + role }, on === undefined ? {} : { 'data-on': on ? '1' : '0' }, extra || {}))
    fill(toolsToggles, [
      small(T('apps.tool.search'), () => toggleSearch(), 'tool-search', undefined, { 'aria-expanded': st.searchOpen ? 'true' : 'false' }),
      small(pinned ? T('apps.tool.unpin') : T('apps.tool.pin'), () => setFlag(c, 'pinned', !pinned), 'tool-pin', pinned),
      small(fav ? T('apps.tool.unfavorite') : T('apps.tool.favorite'), () => setFlag(c, 'favorite', !fav), 'tool-favorite', fav),
      small(muted ? T('apps.tool.unmute') : T('apps.tool.mute'), () => setFlag(c, 'muted', !muted), 'tool-mute', muted),
      small(arch ? T('apps.tool.unarchive') : T('apps.tool.archive'), () => setFlag(c, 'archived', !arch), 'tool-archive', arch),
      small(hid ? T('apps.tool.unhide') : T('apps.tool.hide'), () => setFlag(c, 'hidden', !hid), 'tool-hide', hid),
      small(T('apps.tool.markUnread'), () => markUnread(c), 'tool-unread'),
      small(st.select ? T('apps.tool.selectDone') : T('apps.tool.select'), () => toggleSelect(), 'tool-select', st.select),
      small(T('apps.tool.jumpOldest'), () => scrollToTop(), 'tool-oldest'),
      small(T('apps.tool.jumpLatest'), () => scrollToBottom(), 'tool-latest')
    ])
    const exp = Number(cfg.exp) > 0 ? Number(cfg.exp) : 0
    ensureOption(expSel, exp, Math.round(exp / 1000) + ' s')
    expSel.value = String(exp)
    fontSel.value = st.font
    fill(cfgToggles, [
      small(T('apps.tool.receipts'), () => setCfg(c, { receipts: cfg.receipts === false }), 'tool-receipts', undefined, { 'aria-pressed': cfg.receipts === false ? 'false' : 'true' }),
      small(T('apps.tool.typing'), () => setCfg(c, { typing: cfg.typing === false }), 'tool-typing', undefined, { 'aria-pressed': cfg.typing === false ? 'false' : 'true' })
    ])
    if (nickInput.__conv !== c.id) { nickInput.__conv = c.id; nickInput.value = peerOf(c).nick || ''; noteInput.value = typeof c.note === 'string' ? c.note : (notesMem.get(c.id) || '') }
    const blocked = isBlocked(s, c)
    fill(toolsActions, [
      small(T('apps.tool.export'), () => doExport(c), 'tool-export'),
      small(T('apps.tool.clear'), () => confirmClear(c), 'tool-clear', undefined, { class: 'mw-btn mw-small mw-danger' }),
      small(T('apps.tool.leave'), () => confirmLeave(c), 'tool-leave', undefined, { class: 'mw-btn mw-small mw-danger' }),
      blocked ? small(T('apps.tool.unblock'), async () => { await service.unblock(peerOf(c).pub); render() }, 'tool-unblock') : small(T('apps.tool.block'), () => confirmBlock(c), 'tool-block', undefined, { class: 'mw-btn mw-small mw-danger' })
    ])
  }

  // search: the fields live as long as the view; the result line is drawn again
  const checkbox = (label, role) => {
    const input = el('input', { type: 'checkbox', 'data-role': role, 'data-fk': role })
    return { input, node: el('label', { class: 'mw-apps-check' }, [input, el('span', { text: label })]) }
  }
  const sText = el('input', { type: 'search', class: 'mw-input', autocomplete: 'off', spellcheck: 'false', 'aria-label': T('apps.search.text'), placeholder: T('apps.search.text'), 'data-role': 'search-text', 'data-fk': 'search:text' })
  const sFrom = el('input', { type: 'date', id: 'mw-apps-sfrom', class: 'mw-input', 'data-role': 'search-from', 'data-fk': 'search:from' })
  const sTo = el('input', { type: 'date', id: 'mw-apps-sto', class: 'mw-input', 'data-role': 'search-to', 'data-fk': 'search:to' })
  const sDir = el('select', { id: 'mw-apps-sdir', class: 'mw-input', 'data-role': 'search-direction', 'data-fk': 'search:dir' }, ['all', 'sent', 'received'].map((v) => el('option', { value: v, text: T('apps.search.dir.' + v) })))
  const sBoxes = {
    exact: checkbox(T('apps.search.exact'), 'search-exact'), links: checkbox(T('apps.search.links'), 'search-links'), saved: checkbox(T('apps.search.saved'), 'search-saved'),
    pinned: checkbox(T('apps.search.pinned'), 'search-pinned'), edited: checkbox(T('apps.search.edited'), 'search-edited'), reactions: checkbox(T('apps.search.reactions'), 'search-reactions'),
    deleted: checkbox(T('apps.search.deleted'), 'search-deleted'), important: checkbox(T('apps.search.important'), 'search-important')
  }
  const searchNav = el('div', { class: 'mw-apps-searchnav', role: 'status', 'aria-live': 'polite', 'data-role': 'search-nav' })
  const searchPanel = form('mw-apps-search', [
    el('h2', { class: 'mw-apps-h2', text: T('apps.search.title') }),
    el('div', { class: 'mw-row' }, [sText, button(T('apps.search.go'), () => doSearch(), 'mw-primary mw-small', { 'data-role': 'search-go', 'data-fk': 'search:go' })]),
    el('div', { class: 'mw-row' }, Object.keys(sBoxes).map((k) => sBoxes[k].node)),
    el('div', { class: 'mw-row' }, [field('mw-apps-sfrom', T('apps.search.from'), sFrom), field('mw-apps-sto', T('apps.search.to'), sTo), field('mw-apps-sdir', T('apps.search.direction'), sDir)]),
    searchNav
  ])
  searchPanel.hidden = true
  searchPanel.setAttribute('data-role', 'search')
  enterKey(sText, () => doSearch())
  const idsOf = (r) => (Array.isArray(r) ? r.map((x) => (x !== null && typeof x === 'object' ? x.id : x)).filter((x) => x !== undefined && x !== null) : (r && Array.isArray(r.results) ? idsOf(r.results) : null))
  async function doSearch () {
    const c = currentConv()
    if (!c) return
    const msgs = messagesOf(c)
    const q = {}
    const text = sText.value.trim()
    if (text) { q.text = text; if (sBoxes.exact.input.checked) q.exact = true }
    const from = parseDay(sFrom.value, false)
    const to = parseDay(sTo.value, true)
    if (from !== null) q.from = from
    if (to !== null) q.to = to
    if (sDir.value === 'sent' || sDir.value === 'received') q.direction = sDir.value
    for (const k of ['links', 'saved', 'pinned', 'important', 'edited', 'reactions']) if (sBoxes[k].input.checked) q[k] = true
    const wantDeleted = sBoxes.deleted.input.checked
    if (!Object.keys(q).length && !wantDeleted) { st.search = { ids: null, i: 0, status: '' }; render(); return }
    // The fields of the plan's search call go to the service (src/loader/apps.js search); without one, apps-format.js searchMessages reads the model.
    let found = null
    try { found = typeof service.search === 'function' ? idsOf(await service.search(c.id, q)) : null } catch (_) { found = null }
    if (found === null) found = idsOf(searchModel(msgs, q)) || []
    const wanted = new Set(found)
    const ids = msgs.filter((m) => m && wanted.has(m.id) && (wantDeleted ? m.deleted === true : m.deleted !== true) &&
      (!q.saved || msgFlagOf(c.id, m, 'saved')) && (!q.pinned || msgFlagOf(c.id, m, 'pinned')) && (!q.important || m.prio === true || msgFlagOf(c.id, m, 'important'))).map((m) => m.id)
    st.search = { ids, i: 0, status: ids.length ? '' : T('apps.search.none') }
    render()
    if (ids.length) jumpToMessage(ids[0])
  }
  function searchStep (d) {
    const ids = st.search.ids
    if (!ids || !ids.length) return
    st.search.i = (st.search.i + d + ids.length) % ids.length
    render()
    jumpToMessage(ids[st.search.i])
  }
  function renderSearch () {
    searchPanel.hidden = !(st.toolsOpen && st.searchOpen)
    if (searchPanel.hidden) return
    const ids = st.search.ids
    const kids = []
    if (ids && ids.length) {
      kids.push(el('span', { class: 'mw-apps-result', 'data-role': 'search-result', text: T('apps.search.result', { i: st.search.i + 1, n: ids.length }) }))
      kids.push(button(T('apps.search.prev'), () => searchStep(-1), 'mw-small', { 'data-role': 'search-prev', 'data-fk': 'search:prev' }))
      kids.push(button(T('apps.search.next'), () => searchStep(1), 'mw-small', { 'data-role': 'search-next', 'data-fk': 'search:next' }))
    } else if (ids) kids.push(el('span', { class: 'mw-apps-result', 'data-role': 'search-result', text: st.search.status || T('apps.search.none') }))
    if (ids) kids.push(button(T('apps.search.clear'), () => { st.search = { ids: null, i: 0, status: '' }; render() }, 'mw-small mw-link', { 'data-role': 'search-clear', 'data-fk': 'search:clear' }))
    fill(searchNav, kids)
  }

  function afterDraw (drawn, wasBottom, prevCount, count, jump) {
    if (memo.stick) { scrollToBottom(); memo.stick = false; jump.hidden = true } else if (drawn && wasBottom) { scrollToBottom(); jump.hidden = true } else if (drawn && prevCount !== undefined && count > prevCount) jump.hidden = false
    else if (atBottom()) jump.hidden = true
  }
  // Reading is told to the service once per unread count: the open conversation of a visible page is read (a conversation marked unread counts as one).
  function maybeMarkRead (id, unread, { marked = false, room = false } = {}) {
    const n = (Number(unread) || 0) + (marked ? 1 : 0)
    const call = room ? (service.markRoomRead || service.markRead) : service.markRead
    if (n > 0 && D.visibilityState !== 'hidden') {
      if (memo.lastRead.get(id) !== n && typeof call === 'function') {
        memo.lastRead.set(id, n)
        try { Promise.resolve(call.call(service, id)).catch(() => {}) } catch (_) { /* a courtesy */ }
      }
    } else if (n === 0) memo.lastRead.delete(id)
  }
  const convView = el('section', { class: 'mw-apps-conv', 'data-view': 'conversation', hidden: true }, [cardHosts.conversation, convHead, toolsPanel, searchPanel, convNote, msgListC, jumpNewC, dm.node])
  function renderConversation (s) {
    const c = convById(s, st.convId)
    if (!c) return
    convView.className = 'mw-apps-conv mw-apps-fs-' + st.font
    renderConvHead(c)
    renderTools(c, s)
    renderSearch()
    convNote.textContent = notes.conv
    const list = messagesOf(c)
    const ids = st.search.ids
    const ctx = {
      kind: 'dm', convId: c.id, list, byId: new Map(list.map((m) => [m.id, m])), mePub: s.me ? s.me.pub : '',
      sender: (m) => (m.mine ? T('apps.you') : convLabel(c)), hits: ids ? new Set(ids) : null, current: ids && ids.length ? ids[st.search.i] : null
    }
    const was = atBottom()
    const prev = memo.counts.get('c:' + c.id)
    const drawn = drawMessages(msgListC, ctx)
    memo.counts.set('c:' + c.id, list.length)
    afterDraw(drawn, was, prev, list.length, jumpNewC)
    const status = c.status
    const enabled = status === 'connected' || status === 'connecting'
    const note = enabled ? (status === 'connected' ? '' : (Number(c.lastSeenAt || c.connectedAt) > 0 ? T('apps.offline') : T('apps.composer.waitingFirst'))) : (status === 'waiting' ? '' : T('apps.composer.closed'))
    dm.node.hidden = status === 'waiting'
    dm.update({ enabled, closedNote: note, c })
    maybeMarkRead(c.id, c.unread, { marked: c.markedUnread === true })
  }

  // ---- Rooms: create (a code, requests, a roster), join (a code), the room's messages ----------------------------------------------
  function roomLabel (s, r) {
    if (r.name) return cleanName(r.name, 40)
    const code = r.code ? groupCode(r.code) : ''
    const owner = (Array.isArray(r.members) ? r.members : []).find((m) => m && m.owner)
    if (r.status === 'waiting' && !ownsRoom(r)) return T('apps.rooms.pending')
    if (ownsRoom(r)) return code ? T('apps.rooms.nameOwn', { code }) : T('apps.rooms.title')
    if (owner && (owner.name || owner.short)) return T('apps.rooms.nameJoined', { name: personLabel(owner) })
    return code ? T('apps.rooms.name', { code }) : T('apps.rooms.title')
  }
  const roomStatusText = (r) => T('apps.rooms.status.' + (['waiting', 'open', 'connecting', 'connected', 'rejected', 'left', 'closed'].indexOf(r.status) >= 0 ? r.status : 'connecting'))
  const roomsLinkNote = el('p', { class: 'mw-note mw-apps-linknote', role: 'status', 'aria-live': 'polite', hidden: true, 'data-role': 'link-note' })
  const roomNote = el('p', { class: 'mw-note', role: 'status', 'aria-live': 'polite', 'data-role': 'room-note' })
  const joinInput = el('input', {
    type: 'text', id: 'mw-apps-join-input', class: 'mw-input mw-mono mw-apps-codeinput', autocomplete: 'off', autocapitalize: 'none', autocorrect: 'off', spellcheck: 'false',
    enterkeyhint: 'go', maxlength: '20', placeholder: 'abcd-efgh-2345', 'data-role': 'join-input', 'data-fk': 'join:input'
  })
  const joinNote = el('p', { class: 'mw-note', role: 'status', 'aria-live': 'polite', 'data-role': 'join-note' })
  const createBox = el('section', { class: 'mw-apps-panel' }, [
    el('h2', { class: 'mw-apps-h2', text: T('apps.rooms.create') }),
    el('p', { class: 'mw-note', text: T('apps.rooms.createHelp') }),
    button(T('apps.rooms.create'), () => createRoomFlow(), 'mw-primary', { 'data-role': 'room-create', 'data-fk': 'room:create' }),
    roomNote
  ])
  const joinForm = form('mw-apps-panel mw-apps-knock', [
    el('h2', { class: 'mw-apps-h2', text: T('apps.rooms.join') }),
    el('label', { class: 'mw-apps-label', for: 'mw-apps-join-input', text: T('apps.rooms.joinLabel') }),
    el('div', { class: 'mw-row' }, [joinInput, button(T('apps.rooms.joinButton'), () => joinRoomFlow(), 'mw-primary', { 'data-role': 'join-button', 'data-fk': 'join:go' })]),
    joinNote
  ])
  enterKey(joinInput, () => joinRoomFlow())
  const roomsEmpty = el('p', { class: 'mw-note', text: T('apps.rooms.none') })
  const roomsList = el('ul', { class: 'mw-apps-list', 'data-role': 'room-list' })
  const roomsView = el('section', { class: 'mw-apps-rooms', 'data-view': 'rooms', hidden: true }, [
    roomsLinkNote, cardHosts.rooms, createBox, joinForm,
    el('section', { class: 'mw-apps-panel', 'data-role': 'rooms' }, [el('h2', { class: 'mw-apps-h2', text: T('apps.rooms.list') }), roomsEmpty, roomsList])
  ])
  async function doCreateRoom () {
    notes.room = ''
    let r
    try { r = await service.createRoom() } catch (err) { r = { error: err } }
    if (r && r.error) { notes.room = errText(r.error); render(); return }
    const id = r && (r.roomId !== undefined ? r.roomId : r.id)
    if (id !== undefined && id !== null) openRoom(id)
    else render()
  }
  function createRoomFlow () {
    if (!st.priceOk) { openCard(priceSpec('room-create', { room: true, run: () => { st.priceOk = true; return doCreateRoom() } })); return }
    return doCreateRoom()
  }
  async function doJoinRoom () {
    const text = joinInput.value
    if (!codeLooksValid(text)) { notes.join = T('apps.err.invalid'); render(); return }
    notes.join = ''
    let r
    try { r = await service.joinRoom(text) } catch (err) { r = { error: err } }
    if (r && r.error) notes.join = errText(r.error)
    else { joinInput.value = ''; notes.join = T('apps.rooms.joinSent') }
    render()
  }
  function joinRoomFlow () {
    if (!codeLooksValid(joinInput.value)) { notes.join = T('apps.err.invalid'); render(); return }
    if (!st.priceOk) { openCard(priceSpec('room-join', { room: true, run: () => { st.priceOk = true; return doJoinRoom() } })); return }
    return doJoinRoom()
  }
  function roomRow (s, r) {
    const unread = Number(r.unread) || 0
    const members = Array.isArray(r.members) ? r.members.length : 0
    const side = []
    if (unread > 0) side.push(el('span', { class: 'mw-apps-badge', 'data-role': 'unread', 'aria-label': T('apps.conv.unread', { n: unread }), text: unread > 99 ? '99+' : String(unread) }))
    const li = el('li', { class: 'mw-apps-row' + (unread > 0 ? ' mw-apps-unread' : '') }, [
      el('button', { type: 'button', class: 'mw-apps-rowbtn', 'data-room': r.id, 'data-status': r.status || '', 'data-fk': 'room:' + r.id, onclick: trustedOnly(guarded(() => openRoom(r.id))) }, [
        el('span', { class: 'mw-apps-row-main' }, [
          el('span', { class: 'mw-apps-row-name', dir: 'auto', text: roomLabel(s, r) }),
          el('span', { class: 'mw-apps-row-prev', text: roomStatusText(r) + (members ? ' \u00b7 ' + T('apps.rooms.members', { n: members }) : '') })
        ]),
        el('span', { class: 'mw-apps-row-side' }, side)
      ])
    ])
    if (r.status === 'waiting' && !ownsRoom(r)) li.appendChild(button(T('apps.conv.cancelRequest'), () => service.cancelKnock(r.knock !== undefined && r.knock !== null ? r.knock : r.id), 'mw-small', { 'data-role': 'cancel-knock', 'data-fk': 'cancel-room:' + r.id }))
    return li
  }
  function renderRoomsView (s) {
    const linkText = linkNoteText(s)
    roomsLinkNote.hidden = !linkText
    roomsLinkNote.textContent = linkText
    roomNote.textContent = notes.room
    joinNote.textContent = notes.join
    roomsEmpty.hidden = s.rooms.length > 0
    fill(roomsList, s.rooms.map((r) => roomRow(s, r)))
  }

  // one room
  const roomOwnerBox = el('section', { class: 'mw-apps-panel', hidden: true, 'data-role': 'room-owner' })
  const roomMembersBox = el('section', { class: 'mw-apps-panel', 'data-role': 'room-members' })
  const msgListR = el('ul', { class: 'mw-apps-msgs', role: 'log', 'aria-live': 'polite', 'aria-relevant': 'additions', 'aria-label': T('apps.msg.list'), 'data-role': 'room-messages' })
  const jumpNewR = button(T('apps.tool.newMessages'), () => { scrollToBottom(); jumpNewR.hidden = true }, 'mw-primary mw-apps-jump', { hidden: true, 'data-role': 'jump-new', 'data-fk': 'jump-new-room' })
  const roomView = el('section', { class: 'mw-apps-conv mw-apps-room', 'data-view': 'room', hidden: true }, [cardHosts.room, roomOwnerBox, roomMembersBox, msgListR, jumpNewR, rm.node])
  function senderLabel (r, m) {
    let from = m.from || m.sender || null
    if (typeof from === 'string') from = (Array.isArray(r.members) ? r.members : []).find((x) => x && x.pub === from) || { pub: from }
    return from && (from.name || from.short) ? named(from.name, from.short) : T('apps.someone')
  }
  function acceptMember (r, req) { openCard(priceSpec('room-accept', { room: true, accept: true, run: () => service.acceptMember(req.knock) })) }
  async function rejectMember (req) { await service.rejectMember(req.knock); render() }
  function confirmLeaveRoom (r) {
    openCard(confirmSpec('leave-room', T('apps.rooms.confirmLeave.title'), T('apps.rooms.confirmLeave.text'), T('apps.rooms.leave'), async () => {
      await service.leaveRoom(r.id)
      if (st.roomId === r.id) { st.view = 'rooms'; st.roomId = null }
    }))
  }
  function renderRoom (s) {
    const r = roomById(s, st.roomId)
    if (!r) return
    const owner = ownsRoom(r)
    statusLineEl.setAttribute('data-status', r.status || '')
    setLine(statusLineEl, roomStatusText(r))
    typingLineEl.hidden = true
    setLine(typingLineEl, '')
    fill(subActions, [button(T('apps.rooms.leave'), () => confirmLeaveRoom(r), 'mw-small mw-danger', { 'data-role': 'room-leave', 'data-fk': 'room:leave' })])
    roomOwnerBox.hidden = !owner
    if (owner) {
      const reqs = roomRequestsOf(s, r)
      const kids = [el('h2', { class: 'mw-apps-h2', text: T('apps.rooms.codeTitle') })]
      if (r.code) {
        const shown = groupCode(r.code)
        kids.push(el('p', { class: 'mw-apps-code', 'data-role': 'room-code', text: shown }))
        kids.push(el('div', { class: 'mw-actions' }, [button(T('apps.code.copy'), async () => { notes.roomCode = (await copyText(shown)) ? T('apps.code.copied') : T('apps.code.copyFailed'); render() }, '', { 'data-role': 'room-code-copy', 'data-fk': 'room:code-copy' })]))
        kids.push(el('p', { class: 'mw-note', text: T('apps.rooms.codeHelp') }))
        if (notes.roomCode) kids.push(el('p', { class: 'mw-note', role: 'status', 'aria-live': 'polite', text: notes.roomCode }))
      } else if (r.codeClosed) kids.push(el('p', { class: 'mw-note', role: 'status', 'data-role': 'room-code-closed', text: T('apps.rooms.codeClosed') }))
      else kids.push(el('p', { class: 'mw-note', role: 'status', text: T('apps.code.waiting') }))
      if (reqs.length) {
        kids.push(el('h2', { class: 'mw-apps-h2', text: T('apps.rooms.requests') }))
        kids.push(el('ul', { class: 'mw-apps-list', 'data-role': 'room-requests' }, reqs.map((req) => {
          const p = reqPeer(req)
          return el('li', { class: 'mw-apps-request', 'data-knock': req.knock }, [
            el('span', { class: 'mw-apps-request-text', dir: 'auto', text: T('apps.request.room', { name: p.name ? cleanName(p.name) : T('apps.someone'), short: groupCode(p.short || '') }) }),
            el('span', { class: 'mw-apps-request-actions' }, [
              button(T('apps.request.accept'), () => acceptMember(r, req), 'mw-primary', { 'data-role': 'accept', 'data-fk': 'accept:' + req.knock }),
              button(T('apps.request.reject'), () => rejectMember(req), '', { 'data-role': 'reject', 'data-fk': 'reject:' + req.knock })
            ])
          ])
        })))
      }
      fill(roomOwnerBox, kids)
    }
    const members = Array.isArray(r.members) ? r.members : []
    const mePub = s.me ? s.me.pub : ''
    fill(roomMembersBox, [
      el('h2', { class: 'mw-apps-h2', text: T('apps.rooms.members', { n: members.length }) }),
      el('ul', { class: 'mw-apps-list mw-apps-members', 'data-role': 'roster' }, members.map((m) => el('li', { class: 'mw-apps-member', dir: 'auto', 'data-pub': m.pub || '' }, [
        el('span', { text: m.name || m.short ? named(m.name, m.short) : T('apps.someone') }),
        m.owner ? el('span', { class: 'mw-apps-mark', text: T('apps.rooms.owner') }) : null,
        m.you === true || (mePub && m.pub === mePub) ? el('span', { class: 'mw-apps-mark', text: T('apps.rooms.you') }) : null
      ])))
    ])
    const list = messagesOf(r)
    const ctx = { kind: 'room', convId: r.id, list, byId: new Map(list.map((m) => [m.id, m])), mePub, sender: (m) => senderLabel(r, m), hits: null, current: null }
    const was = atBottom()
    const prev = memo.counts.get('r:' + r.id)
    const drawn = drawMessages(msgListR, ctx)
    memo.counts.set('r:' + r.id, list.length)
    afterDraw(drawn, was, prev, list.length, jumpNewR)
    const enabled = r.status === 'connected' || r.status === 'connecting' || r.status === 'open'
    rm.update({ enabled, closedNote: enabled ? '' : T('apps.composer.closed'), c: null })
    maybeMarkRead(r.id, r.unread, { room: true })
  }

  // ---- toasts and the tab title: a counter and a line, never a preview of a message ---------------------------------------------------
  function showToast (text) {
    toastEl.textContent = text
    toastEl.hidden = false
    clearT(memo.toastTimer)
    memo.toastTimer = setT(() => { toastEl.hidden = true; toastEl.textContent = '' }, TOAST_MS)
  }
  function lastIncoming (list) {
    for (let i = list.length - 1; i >= 0; i--) { const m = list[i]; if (m && m.mine !== true && m.deleted !== true) return m.id }
    return null
  }
  function noteIncoming (s) {
    const primed = memo.toastKeys !== null
    if (!primed) memo.toastKeys = new Set()
    const open = D.visibilityState !== 'hidden'
    let text = ''
    const consider = (key, id, muted, here, mk) => {
      if (id === null) { if (!memo.seen.has(key)) memo.seen.set(key, null); return }
      const before = memo.seen.has(key) ? memo.seen.get(key) : undefined
      memo.seen.set(key, id)
      if (!primed || before === id) return
      if (muted || (here && open)) return
      text = mk()
    }
    for (const c of s.conversations) consider('c:' + c.id, lastIncoming(messagesOf(c)), flagOf(c, 'muted'), st.view === 'conversation' && st.convId === c.id, () => T('apps.toast.message', { name: convLabel(c) }))
    for (const r of s.rooms) consider('r:' + r.id, lastIncoming(messagesOf(r)), false, st.view === 'room' && st.roomId === r.id, () => T('apps.toast.room', { room: roomLabel(s, r) }))
    for (const r of pairRequests(s).concat(allRoomRequests(s))) {
      const key = 'q:' + r.knock
      if (memo.toastKeys.has(key)) continue
      memo.toastKeys.add(key)
      if (primed) { const p = reqPeer(r); text = T(r.kind === 'room' ? 'apps.request.room' : 'apps.request.wants', { name: p.name ? cleanName(p.name) : T('apps.someone'), short: groupCode(p.short || '') }) }
    }
    if (text) showToast(text)
  }
  function updateTitle (s) {
    const n = s.conversations.reduce((a, c) => a + (flagOf(c, 'muted') ? 0 : (Number(c.unread) || 0)), 0) + s.rooms.reduce((a, r) => a + (Number(r.unread) || 0), 0) + pairRequests(s).length + allRoomRequests(s).length
    try { D.title = (n > 0 ? '(' + (n > 99 ? '99+' : n) + ') ' : '') + memo.baseTitle } catch (_) { /* no title in this document */ }
  }

  // ---- the whole view -------------------------------------------------------------------------------------------------------------------
  const views = { home: homeView, messages: messagesView, conversation: convView, rooms: roomsView, room: roomView }
  node.appendChild(headEl)
  node.appendChild(toastEl)
  for (const k of Object.keys(views)) node.appendChild(views[k])

  // A sign-out, by any path, ends this visit's state: drafts, snippets, the price answer, every field.
  function resetSession () {
    Object.assign(st, freshState())
    for (const k of Object.keys(notes)) notes[k] = ''
    local.conv.clear(); local.msg.clear()
    memo.lastRead.clear(); memo.seen.clear(); memo.counts.clear(); memo.toastKeys = null; memo.stick = false; memo.linkWasOpen = false
    dm.reset(); rm.reset()
    for (const i of [knockInput, joinInput, filterInput, sText, sFrom, sTo, nickInput, noteInput]) i.value = ''
    notesMem.clear()
    for (const k of Object.keys(sBoxes)) sBoxes[k].input.checked = false
    sDir.value = 'all'
    msgListC.__sig = null; msgListR.__sig = null; nickInput.__conv = null
  }
  function render () {
    if (destroyed) return
    memo.pendingRender = false
    const s = snapshot()
    if (memo.signedIn && !s.signedIn) resetSession()
    memo.signedIn = s.signedIn
    if (s.link === 'open') memo.linkWasOpen = true
    if (!s.signedIn && st.view !== 'home') { st.view = 'home'; st.card = null }
    if (st.view === 'conversation' && !convById(s, st.convId)) { st.view = 'messages'; st.convId = null }
    if (st.view === 'room' && !roomById(s, st.roomId)) { st.view = 'rooms'; st.roomId = null }
    keepFocus(() => {
      renderHead(s)
      for (const k of Object.keys(views)) views[k].hidden = k !== st.view
      if (st.view === 'home') renderHome(s)
      else if (st.view === 'messages') renderMessagesView(s)
      else if (st.view === 'conversation') renderConversation(s)
      else if (st.view === 'rooms') renderRoomsView(s)
      else if (st.view === 'room') renderRoom(s)
      renderCard()
      noteIncoming(s)
      updateTitle(s)
    })
  }
  // A service change draws the view once, in a microtask, however many changes came in a row.
  function scheduleRender () {
    if (destroyed || memo.pendingRender) return
    memo.pendingRender = true
    Promise.resolve().then(() => { if (memo.pendingRender) render() })
  }
  /** inspect() -> plain data for window.__mwShell.inspect().apps (tests and support): counts and states, never a message text. */
  function inspect () {
    const s = snapshot()
    const lastOwn = (c) => { const own = messagesOf(c).filter((m) => m && m.mine === true && m.deleted !== true); return own.length ? String(own[own.length - 1].status || 'sent') : null }
    return {
      view: st.view,
      signedIn: s.signedIn,
      ready: s.ready,
      tm: s.tm,
      link: s.link,
      // the channel only (the first four characters, which the rendezvous sees anyway): the secret half of a code is never shown here
      code: s.code ? groupCode(s.code).slice(0, 4) : null,
      current: st.view === 'conversation' ? st.convId : (st.view === 'room' ? st.roomId : null),
      card: st.card ? st.card.kind : null,
      requests: pairRequests(s).length + allRoomRequests(s).length,
      conversations: s.conversations.map((c) => ({
        id: c.id, short: groupCode(peerOf(c).short || ''), status: c.status || null, unread: Number(c.unread) || 0, messages: messagesOf(c).filter((m) => m && m.deleted !== true).length,
        lastStatus: lastOwn(c), pinned: flagOf(c, 'pinned'), muted: flagOf(c, 'muted'), archived: flagOf(c, 'archived'), favorite: flagOf(c, 'favorite')
      })),
      rooms: s.rooms.map((r) => ({ id: r.id, role: ownsRoom(r) ? 'owner' : 'member', status: r.status || null, members: Array.isArray(r.members) ? r.members.length : 0, messages: messagesOf(r).filter((m) => m && m.deleted !== true).length, unread: Number(r.unread) || 0 }))
    }
  }
  const onVisible = () => { if (!destroyed) render() }
  function destroy () {
    if (destroyed) return
    destroyed = true
    try { if (typeof offChange === 'function') offChange() } catch (_) { /* gone */ }
    try { D.removeEventListener('visibilitychange', onVisible) } catch (_) { /* gone */ }
    clearT(memo.toastTimer); clearT(memo.copiedTimer)
    dm.stopTyping(); rm.stopTyping()
    try {
      if (ui && typeof ui.hideApps === 'function') ui.hideApps()
      else if (node.parentNode) node.parentNode.removeChild(node)
    } catch (_) { /* gone */ }
  }

  memo.baseTitle = T('apps.docTitle')
  try { D.title = memo.baseTitle } catch (_) { /* no title in this document */ }
  if (ui && typeof ui.showApps === 'function') ui.showApps(node)
  else if (root && typeof root.appendChild === 'function') root.appendChild(node)
  let offChange = null
  try { offChange = typeof service.onChange === 'function' ? service.onChange(scheduleRender) : null } catch (err) { log('onChange: ' + ((err && err.message) || err)) }
  D.addEventListener('visibilitychange', onVisible)
  render()

  return {
    node,
    render,
    inspect,
    destroy,
    back,
    show (view, id) {
      if (view === 'messages') enterMessages()
      else if (view === 'rooms') enterRooms()
      else if (view === 'conversation') openConv(id)
      else if (view === 'room') openRoom(id)
      else { st.view = 'home'; st.card = null; render() }
    },
    nodes: { head: headEl, title: titleEl, toast: toastEl, tiles: tiles.map((t) => t.node), composer: dm.ta, send: dm.sendBtn, roomComposer: rm.ta, roomSend: rm.sendBtn, knockInput, joinInput, filterInput, messageList: msgListC, roomMessageList: msgListR }
  }
}
