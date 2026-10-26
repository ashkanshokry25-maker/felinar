// src/loader/api.js: the site SDK method table (ARCHITECTURE 9 and 15.9; R 2.11), shared by the shell Bridge
// (src/loader/bridge.js, requests arrive over a MessagePort) and the drop-in binding (src/dropin/binding.js,
// window.mw calls it directly). One table means a site that moves between drop-in and shell sees the same
// validation, limits, gating, results and error codes.
//
//   const api = new MwApi({ node, torrentManager, consent, ui, info, identity, limits, activation, tab, hostOnly })
//   api.mount('chat', createChatService(deps))           // the SVC contract: { methods, on(event, fn), destroy() }
//   await api.request('db.set', { key: 'k', value: 1 })  -> { ok: true, result: { h } }
//                                                        | { ok: false, error: { code, message }, reason }
//
// request() never throws. Params are validated (plain JSON only, except the Blob a few methods take, sizes per
// the live ledger policy); ledger writes are limited to `writesPerMinute` per page; anything thrown below is
// mapped to the documented codes. Nothing touches the DOM; the clock, the timers and the activation tracker are
// injectable for Node tests.
//
// The A4 rule, v0.3 (R 2.11.1). Site code can never export or read a key, a seed, the root, the phrase, a file or
// playback key or the vault; grant consent; accept a "same identity" link; choose the domain, origin, ledger or
// key mode of a sign-in proof; open a high-risk card without transient activation. LOADER_ONLY_METHODS do not
// exist here: over the Bridge or the binding they are unknown methods (E_BAD_REQUEST). UI methods need a click
// in the site frame, which only the loader's own ActivationTracker can report (trusted input events, or the
// browser's own transient activation); a flag the site puts in its params (activation, isTrusted, gesture,
// trusted, userActivation) is removed before any service sees the params and proves nothing. The loader's own
// prompt (ui.prompt) or the identity origin window then takes the person's input.
//
// The SDK boundary checks, in this order: unknown or loader-only method (E_BAD_REQUEST); v0.3 C2: a calls.* method on a
// drop-in page (E_UNSUPPORTED); parameter shape and size (E_LIMIT, E_BAD_REQUEST); host-only mode for methods that would
// reach peers (E_HOST_ONLY, before any prompt or request); a UI method without activation (E_NEEDS_GESTURE); the ledger
// write rate (E_RATE). Services then apply their own rules (E_POLICY, E_NOT_SIGNED_IN, ...). A call that fails both the
// gesture and a service policy therefore reports E_NEEDS_GESTURE (docs/SDK.md "Gating"). Results and events of calls.*
// are plain data only (plainOnly): no MediaStream ever reaches the site (C2 wire-ui, SZ 3.5 "SDK").

import { canonicalize, byteLength } from '../chain/canonical.js'
import { isPublicKeyString, shortKey } from '../chain/crypto.js'
import { createModService, MOD_METHODS, listingVisible } from './mod.js'
// C2 wire-ui: the six call error codes and the call and seeding texts of lane docs-strings (SZ 3.5, 3.1.5).
import { C2_ERROR_CODES, callText, seedText } from './strings.js'
import { storageLines } from './policy.js'

export const SDK_VERSION = '0.3.0'

// ---------------------------------------------------------------------------------------------
// v0.3 C2 (lane wire-ui; research/v03/SEEDING-AND-ZERO-SETUP-DESIGN.md "SZ" 3.5 "SDK" and 3.1.3 to 3.1.4): mw.calls and
// the seeding reads and controls of mw.net. Listed apart so the tables below show what C2 added; docs/SDK.md, "Calls:
// mw.calls" and "Seeding: mw.net.seeding, dock and keep". Deviations in docs/deviations/wire-ui.md.
// ---------------------------------------------------------------------------------------------

/** Every call method of SZ 3.5, in its order. */
export const C2_CALL_METHODS = Object.freeze(['calls.start', 'calls.accept', 'calls.decline', 'calls.hangup', 'calls.mute', 'calls.camera', 'calls.screen', 'calls.state', 'calls.list'])
/** The seeding methods of mw.net (SZ 3.1.3, 3.1.4): a read and two UI methods. */
export const C2_NET_METHODS = Object.freeze(['net.seeding', 'net.dock', 'net.keep'])
/** The events of mw.calls.on (pushed as 'calls' { type, data }). */
export const CALL_EVENTS = Object.freeze(['ring', 'state', 'peer', 'ended'])

// ---------------------------------------------------------------------------------------------
// Method tables (INTERFACES "v0.3 (proposed)" src/loader/api.js; R 2.11.2, 2.9.11). Every name is the SDK path.
// Entries marked "amendment" are R 2.11.2 methods the INTERFACES lists do not classify, or the hub amendment
// (docs/SDK.md, "Amendment to R 2.11.2: followed ledgers").
// ---------------------------------------------------------------------------------------------

export const READ_METHODS = Object.freeze([
  'ready', 'db.get', 'db.list', 'net.peers', 'site.info', 'consent.state',
  // INTERFACES v0.3
  'auth.state', 'auth.verify', 'identity.current', 'identity.backupStatus', 'chat.state', 'chat.presence.list', 'files.list',
  'files.received', 'media.list', 'mod.queue',
  // amendment: reads R 2.11.2 names without a class, and the followed-ledger reads
  'db.getMine', 'db.listBy', 'db.snapshot', 'hub.list', 'chat.requests.list', 'chat.contacts.verify', 'files.preview',
  // v0.3 C2 (lane wire-ui)
  'calls.state', 'calls.list', 'net.seeding'
])

export const WRITE_METHODS = Object.freeze([
  // v0.2.1 (mod.ban moved to UI_METHODS: MF-27)
  'db.set', 'db.del', 'db.append', 'db.tombstone', 'identity.setName', 'owner.policy',
  // INTERFACES v0.3 ('chat.group.*' expanded)
  'auth.prove', 'me.set', 'me.del', 'db.setMine', 'chat.dm.send', 'chat.room.send',
  'chat.group.create', 'chat.group.invite', 'chat.group.remove', 'chat.group.leave', 'chat.group.send',
  'media.open', 'media.close',
  // amendment: state changes R 2.11.2 names without a class
  'chat.disable', 'chat.contacts.add', 'chat.contacts.remove', 'chat.contacts.block', 'chat.contacts.unblock',
  'chat.requests.accept', 'chat.requests.decline', 'chat.dm.keepHistory', 'chat.room.join', 'chat.room.leave',
  'files.fetch', 'files.stopSharing', 'files.pinRequest', 'media.pinRequest',
  'hub.follow', 'hub.unfollow',
  // v0.3 C2 (lane wire-ui): SZ 3.5 marks start, accept and screen as UI; the others change a call's state
  'calls.decline', 'calls.hangup', 'calls.mute', 'calls.camera'
])

/** Methods that need a click in the site frame and are completed by the loader's own prompt or the IdO window. */
export const UI_METHODS = Object.freeze([
  'consent.request',
  // INTERFACES v0.3 ('me.get(first per session)' and 'chat.presence.set(public)' are conditional: CONDITIONAL_UI)
  'auth.signIn', 'auth.signInServer', 'identity.openIdentity', 'me.get', 'me.sync', 'me.erase',
  'mod.ban', 'mod.unban', 'mod.tombstoneMany', 'mod.decide', 'chat.enable', 'chat.presence.set', 'chat.requests.setOpen',
  'chat.holder.set', 'chat.direct.connect', 'files.share', 'files.save', 'files.keepSharing', 'media.upload', 'media.share',
  'media.revoke', 'media.delete', 'media.keepAvailable', 'report.send',
  // amendment: R 2.11.2 marks these UI (signOut with forget; contacts and history per session) and the files service
  // treats enable and remove as UI (docs/deviations/media.md item 18); hub.createPage is an owner action (R 3.3)
  'auth.signOut', 'chat.contacts.list', 'chat.dm.history', 'files.enable', 'files.remove', 'hub.createPage',
  // v0.3 C2 (lane wire-ui): a call starts, is answered or shares a screen only from a click; dock mode and the keeper tab
  // start from a click and the loader's own card (net.keep needs it only to turn keeping on: CONDITIONAL_UI)
  'calls.start', 'calls.accept', 'calls.screen', 'net.dock', 'net.keep'
])

/**
 * UI methods that do not need the click at the SDK boundary: consent.request keeps its v0.2.1 behaviour (the
 * consent card itself takes the visitor's click, and a card closed without a choice cannot be reopened for 10 s).
 */
export const GESTURE_EXEMPT = Object.freeze(['consent.request'])

/**
 * UI methods that need the click only under a condition: 'session' (the first successful call per sign-in
 * session; read afterwards), or the name of a boolean parameter that must be true (R 2.11.2).
 */
export const CONDITIONAL_UI = Object.freeze({
  'me.get': 'session',
  'chat.contacts.list': 'session',
  'chat.dm.history': 'session',
  'chat.presence.set': 'public',
  'auth.signOut': 'forget',
  // C2 wire-ui: turning keeping off never needs a click (it only lowers what this tab shares)
  'net.keep': 'on'
})

/** Manages another request (cancel a write in progress); not a write, not rate limited. Bridge only. */
export const CONTROL_METHODS = Object.freeze(['write.cancel'])

/** Never site-callable (R 2.11.1): over the Bridge and the binding they are unknown methods (E_BAD_REQUEST). */
export const LOADER_ONLY_METHODS = Object.freeze(['identity.export', 'identity.import', 'identity.root', 'consent.accept', 'link.accept', 'keys.export', 'media.key'])

export const API_METHODS = Object.freeze(READ_METHODS.concat(WRITE_METHODS, UI_METHODS))

/** Pushes host -> site: v0.2.1 events plus the v0.3 ones; 'hub' is the followed-ledger amendment; 'calls' is C2 (lane wire-ui). */
export const PUSH_EVENTS = Object.freeze(['state', 'peers', 'progress', 'status', 'sync', 'pow', 'auth', 'chat', 'files', 'media', 'mod', 'keychange', 'hub', 'calls'])

/** The service that answers each namespace (R 2.11.2); 'core' is this module. */
export const NAMESPACE_SERVICE = Object.freeze({
  auth: 'identity', identity: 'identity', me: 'identity', chat: 'chat', files: 'files', media: 'media', mod: 'mod', report: 'mod', hub: 'hub',
  calls: 'calls' // C2 wire-ui: src/calls/service.js (lane calls), mounted after chat
})

/** Events each service emits, pushed to the site as { event: push, data: { type, data } }. */
export const SERVICE_EVENTS = Object.freeze({
  // 'kit' (R 2.2.6, code review v0.3 conformance): the identity service asks for the recovery kit after the first
  // meaningful action; the loader shows its own card (never pushed to the site).
  identity: { push: 'auth', events: ['change', 'auth', 'state', 'keychange', 'kit'] },
  chat: { push: 'chat', events: ['message', 'delivery', 'request', 'presence', 'room', 'group', 'state', 'keychange'] },
  files: { push: 'files', events: ['progress', 'shared', 'received', 'removed'] },
  media: { push: 'media', events: ['progress', 'received', 'shared', 'revoked', 'unavailable'] },
  mod: { push: 'mod', events: ['queue', 'report', 'decided'] },
  hub: { push: 'hub', events: ['change', 'follow', 'unfollow', 'state'] },
  calls: { push: 'calls', events: CALL_EVENTS } // C2 wire-ui
})

/** In host-only mode these answer E_HOST_ONLY before any prompt, card or network request (R 2.11.2, E-CH-6). */
export const HOST_ONLY_METHODS = Object.freeze([
  'chat.enable', 'chat.disable', 'chat.presence.set', 'chat.presence.list', 'chat.contacts.list', 'chat.contacts.add',
  'chat.contacts.remove', 'chat.contacts.block', 'chat.contacts.unblock', 'chat.contacts.verify', 'chat.requests.list',
  'chat.requests.accept', 'chat.requests.decline', 'chat.requests.setOpen', 'chat.dm.send', 'chat.dm.history',
  'chat.dm.keepHistory', 'chat.room.join', 'chat.room.leave', 'chat.room.send', 'chat.group.create', 'chat.group.invite',
  'chat.group.remove', 'chat.group.leave', 'chat.group.send', 'chat.holder.set', 'chat.direct.connect',
  'files.enable', 'files.share', 'files.fetch', 'files.keepSharing', 'files.pinRequest',
  'media.upload', 'media.share', 'media.revoke', 'media.keepAvailable', 'media.pinRequest',
  'report.send',
  // v0.3 C2 (lane wire-ui): what rings, answers or sends to the people of a call, and the seeding controls. Hanging up
  // and muting are left out (as in src/calls/service.js, they keep working so a call can always end), and so are the
  // reads (calls.state, calls.list, net.seeding answer from this device).
  'calls.start', 'calls.accept', 'calls.decline', 'calls.camera', 'calls.screen', 'net.dock', 'net.keep'
])

/** Params that may carry a Blob or File (structured clone over the port); everything else is plain JSON. */
export const BLOB_PARAMS = Object.freeze({ 'files.share': ['file'], 'media.upload': ['file'] })

/** Writes that create ledger blocks on this page: counted against writesPerMinute (ARCHITECTURE 9). */
export const LEDGER_WRITES = Object.freeze(['db.set', 'db.del', 'db.append', 'db.tombstone', 'db.setMine', 'identity.setName', 'owner.policy', 'mod.ban', 'mod.unban', 'mod.tombstoneMany', 'mod.decide'])

/**
 * The first meaningful actions of R 2.2.6 (ledger write, message, upload, me.set, the keep-history choice): after the
 * first one succeeds, the identity service offers the recovery kit (code review v0.3, conformance).
 */
export const MEANINGFUL_METHODS = Object.freeze(['db.set', 'db.del', 'db.append', 'db.setMine', 'identity.setName', 'me.set', 'chat.dm.send',
  'chat.room.send', 'chat.group.send', 'chat.dm.keepHistory', 'files.share', 'media.upload'])

/** Writes that open the sign-in prompt for a guest (R 2.4.1: implicit sign-in on the first write). */
export const IMPLICIT_SIGNIN_METHODS = Object.freeze(['db.set', 'db.del', 'db.append', 'db.tombstone', 'db.setMine', 'identity.setName'])

/** Param names a site may try to use to claim a gesture: removed before services see the params (A4). */
export const ACTIVATION_FLAGS = Object.freeze(['activation', 'isTrusted', 'trusted', 'gesture', 'userActivation', 'userGesture'])

/** Argument names of every SDK call, in order ('...' merges an options object): the SDK, the binding and docs/SDK.md use these. */
export const METHOD_ARGS = Object.freeze({
  ready: [],
  'auth.signIn': ['...'], 'auth.signOut': ['...'], 'auth.state': [], 'auth.prove': ['...'], 'auth.verify': ['proof'], 'auth.signInServer': ['...'],
  'identity.current': [], 'identity.setName': ['name'], 'identity.backupStatus': [], 'identity.openIdentity': [],
  'me.get': ['field'], 'me.set': ['field', 'value'], 'me.del': ['field'], 'me.sync': ['...'], 'me.erase': [],
  'db.get': ['key', '...'], 'db.set': ['key', 'value'], 'db.del': ['key'], 'db.list': ['name', '...'], 'db.append': ['name', 'value'],
  'db.tombstone': ['h'], 'db.setMine': ['name', 'value'], 'db.getMine': ['name', '...'], 'db.listBy': ['name', 'author', '...'], 'db.snapshot': ['...'],
  'hub.follow': ['target', 'opts'], 'hub.unfollow': ['ledger'], 'hub.list': [], 'hub.createPage': ['...'],
  'mod.ban': ['pub', '...'], 'mod.unban': ['pub'], 'mod.tombstoneMany': ['authors', '...'], 'mod.queue': [], 'mod.decide': ['id', 'decision', '...'],
  'chat.enable': ['...'], 'chat.disable': [], 'chat.state': [],
  'chat.presence.set': ['...'], 'chat.presence.list': [],
  'chat.contacts.list': [], 'chat.contacts.add': ['pub', '...'], 'chat.contacts.remove': ['pub'], 'chat.contacts.block': ['pub'],
  'chat.contacts.unblock': ['pub'], 'chat.contacts.verify': ['pub'],
  'chat.requests.list': [], 'chat.requests.accept': ['id'], 'chat.requests.decline': ['id'], 'chat.requests.setOpen': ['open'],
  'chat.dm.send': ['pub', '...'], 'chat.dm.history': ['pub', '...'], 'chat.dm.keepHistory': ['pub', 'on'],
  'chat.room.join': ['name'], 'chat.room.leave': ['name'], 'chat.room.send': ['name', '...'],
  'chat.group.create': ['...'], 'chat.group.invite': ['groupId', 'pub'], 'chat.group.remove': ['groupId', 'pub'],
  'chat.group.leave': ['groupId'], 'chat.group.send': ['groupId', '...'],
  'chat.holder.set': ['on'], 'chat.direct.connect': ['pub'],
  'files.enable': [], 'files.list': [], 'files.received': [], 'files.share': ['file', '...'], 'files.fetch': ['ref', '...'],
  'files.preview': ['ref'], 'files.save': ['ref'], 'files.keepSharing': ['ref', 'on'], 'files.stopSharing': ['ref'],
  'files.remove': ['ref'], 'files.pinRequest': ['ref'],
  'media.upload': ['file', '...'], 'media.list': ['...'], 'media.open': ['id', '...'], 'media.close': ['id'],
  'media.share': ['id', '...'], 'media.revoke': ['id', '...'], 'media.delete': ['id'], 'media.keepAvailable': ['id', 'on'],
  'media.pinRequest': ['id'],
  'report.send': ['...'],
  // v0.3 C2 (lane wire-ui; SZ 3.5 "SDK", SZ 3.1.4)
  'calls.start': ['...'], 'calls.accept': ['id', '...'], 'calls.decline': ['id'], 'calls.hangup': ['id'], 'calls.mute': ['id', 'on'],
  'calls.camera': ['id', 'on'], 'calls.screen': ['id', 'on'], 'calls.state': ['id'], 'calls.list': [],
  'net.seeding': [], 'net.dock': ['...'], 'net.keep': ['on'],
  'net.peers': [], 'site.info': [], 'consent.request': [], 'consent.state': [], 'owner.policy': ['...']
})

/** The v0.2.1 codes, R 2.11.2 "Error codes added" in its order, E_TIMEOUT (the SDK's own), then the six call codes of C2. */
export const ERROR_CODES = Object.freeze([
  'E_POLICY', 'E_LIMIT', 'E_RATE', 'E_NOT_OWNER', 'E_NOT_MODERATOR', 'E_POW_ABORTED', 'E_IDENTITY', 'E_NO_HOST', 'E_CAP', 'E_BANNED',
  'E_BAD_REQUEST', 'E_INTERNAL', 'E_TIMEOUT',
  'E_NOT_SIGNED_IN', 'E_USER_CANCELLED', 'E_UNSUPPORTED', 'E_FIELD', 'E_DECRYPT', 'E_HOST_ONLY_IDENTITY', 'E_POPUP_BLOCKED',
  'E_IDP_UNREACHABLE', 'E_NEEDS_GESTURE', 'E_NONCE_REQUIRED', 'E_LEDGER_FULL', 'E_SYNCING', 'E_HOST_ONLY', 'E_NO_OWN_TRACKER',
  'E_NO_CHAT_KEY', 'E_BLOCKED', 'E_STAMP', 'E_NOT_MEMBER', 'E_NOT_ADMIN', 'E_NOT_CONTACT', 'E_PEER_UNREACHABLE',
  'E_FILE_UNAVAILABLE', 'E_FILE_TOMBSTONED', 'E_FILE_HASH', 'E_DENIED', 'E_MEDIA_TYPE', 'E_MEDIA_STRIP', 'E_MEDIA_UNPLAYABLE', 'E_REVOKED',
  // v0.3 C2 (SZ 3.5): the call codes, after the R 2.11.2 list (src/loader/strings.js has a sentence for each)
  ...C2_ERROR_CODES
])

/**
 * The key in ERROR_TEXT (src/loader/strings.js, English and French) that explains each code to a visitor. Since the review
 * round of R 5.3 (UX-11) every code has a sentence of its own, so every code maps to itself.
 */
export const ERROR_STRING_KEYS = Object.freeze(Object.assign({}, ...ERROR_CODES.map((c) => ({ [c]: c }))))

export const CONSENT_STATES = Object.freeze(['pending', 'accepted', 'host-only'])
/** After a consent card closes without a choice, site requests within this time do not reopen it. */
export const CONSENT_REQUEST_COOLDOWN_MS = 10000
/** After a sign-in prompt is cancelled, writes within this time answer E_NOT_SIGNED_IN without a new prompt (R 2.11.2 E_RATE 10 s). */
export const SIGNIN_COOLDOWN_MS = 10000
/** A trusted input event counts as activation for this long (Chromium's transient activation lifetime, chosen). */
export const ACTIVATION_WINDOW_MS = 5000

const WRITE_SET = new Set(WRITE_METHODS)
const READ_SET = new Set(READ_METHODS)
const UI_SET = new Set(UI_METHODS)
const METHOD_SET = new Set(API_METHODS)
const LOADER_ONLY_SET = new Set(LOADER_ONLY_METHODS)
const KNOWN_CODES = new Set(ERROR_CODES)
const HOST_ONLY_SET = new Set(HOST_ONLY_METHODS)
const LEDGER_WRITE_SET = new Set(LEDGER_WRITES)
const IMPLICIT_SET = new Set(IMPLICIT_SIGNIN_METHODS)
const MEANINGFUL_SET = new Set(MEANINGFUL_METHODS)
const CALL_SET = new Set(C2_CALL_METHODS) // C2 wire-ui
const HASH_RE = /^[0-9a-f]{64}$/
const LEDGER_ID_RE = /^(?:mw1:[A-Za-z0-9_-]{27}|btih:[0-9a-f]{40})$/

export const DEFAULT_LIMITS = Object.freeze({
  writesPerMinute: 20,
  maxRequestBytes: 65536,
  maxListLimit: 1000,
  maxValueBytes: 2048, // DEFAULT_POLICY.maxValueBytes; the live policy value wins when known
  maxKey: 256,
  maxListName: 64,
  maxName: 48,
  readyWaitMs: 15000,
  statePushMs: 250
})

/** { code, message }: the error shape every transport reports (thrown as is by dispatch). */
export function apiError (code, message) { return { code, message } }

export function isWriteMethod (method) { return WRITE_SET.has(method) }
export function isReadMethod (method) { return READ_SET.has(method) }
export function isUiMethod (method) { return UI_SET.has(method) }
export function isLoaderOnly (method) { return LOADER_ONLY_SET.has(method) }
export function isApiMethod (method) { return typeof method === 'string' && METHOD_SET.has(method) }

/** classOf(method) -> 'read' | 'write' | 'ui' | 'control' | null (null: unknown, loader-only included). */
export function classOf (method) {
  if (READ_SET.has(method)) return 'read'
  if (WRITE_SET.has(method)) return 'write'
  if (UI_SET.has(method)) return 'ui'
  if (CONTROL_METHODS.indexOf(method) >= 0) return 'control'
  return null
}

/** serviceOf(method) -> 'identity' | 'chat' | 'files' | 'media' | 'mod' | 'hub' | 'core'. */
export function serviceOf (method) {
  if (method === 'identity.setName') return 'identity'
  if (method === 'db.setMine' || method === 'db.getMine' || method === 'db.listBy') return 'mod'
  const ns = String(method).split('.')[0]
  return NAMESPACE_SERVICE[ns] || 'core'
}

/**
 * needsActivation(method, params, { unlocked }) -> true when the call must come from a click: every UI method, a
 * conditional one only under its condition (R 2.11.2). unlocked: the set of 'session' methods that already
 * passed their card in this sign-in session.
 */
export function needsActivation (method, params, { unlocked = null } = {}) {
  if (!UI_SET.has(method) || GESTURE_EXEMPT.indexOf(method) >= 0) return false
  const cond = CONDITIONAL_UI[method]
  if (!cond) return true
  if (cond === 'session') return !(unlocked && unlocked.has(method))
  return !!(params && params[cond] === true)
}

export function isPlainJson (value, depth = 0) {
  if (depth > 64) return false
  if (value === null) return true
  const t = typeof value
  if (t === 'string' || t === 'boolean') return true
  if (t === 'number') return Number.isFinite(value)
  if (t !== 'object') return false
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) if (!(i in value) || !isPlainJson(value[i], depth + 1)) return false
    return true
  }
  const proto = Object.getPrototypeOf(value)
  if (proto !== Object.prototype && proto !== null) return false
  for (const k of Object.keys(value)) if (!isPlainJson(value[k], depth + 1)) return false
  return true
}

/** True for a Blob or File (any realm: a structured clone arrives as the receiving realm's Blob). */
export function isBlobLike (v) {
  if (!v || typeof v !== 'object') return false
  if (typeof Blob === 'function' && v instanceof Blob) return true
  return typeof v.size === 'number' && typeof v.type === 'string' && typeof v.slice === 'function' && typeof v.arrayBuffer === 'function'
}

function jsonBytes (value) {
  try { return byteLength(canonicalize(value)) } catch (_) { return Infinity }
}

/** The params without the Blob fields of BLOB_PARAMS (those are checked as Blobs, sized by their service). */
function jsonPart (method, params) {
  const keys = BLOB_PARAMS[method]
  if (!keys || !params || typeof params !== 'object') return { json: params, blobError: null }
  const json = Object.assign({}, params)
  for (const k of keys) {
    if (json[k] === undefined) continue
    if (!isBlobLike(json[k])) return { json, blobError: apiError('E_BAD_REQUEST', k + ' must be a File or Blob') }
    delete json[k]
  }
  return { json, blobError: null }
}

/** stripActivationFlags(params) -> a copy without the A4 flags a site might send (they prove nothing). */
export function stripActivationFlags (params) {
  if (!params || typeof params !== 'object' || Array.isArray(params)) return params
  let out = null
  for (const k of ACTIVATION_FLAGS) {
    if (Object.prototype.hasOwnProperty.call(params, k)) {
      if (!out) out = Object.assign({}, params)
      delete out[k]
    }
  }
  return out || params
}

function idOk (id) {
  return (typeof id === 'string' && id.length > 0 && id.length <= 64) || (typeof id === 'number' && Number.isFinite(id))
}

/**
 * validateEnvelope(msg, { maxBytes, methods }) -> { ok: true, id, method, params } | { ok: false, id, error }
 * id: non-empty string of at most 64 characters or a finite number; method from API_METHODS (or `methods`);
 * params: a plain JSON object (or absent) of at most maxBytes once serialised (Blob params excepted).
 */
export function validateEnvelope (msg, { maxBytes = DEFAULT_LIMITS.maxRequestBytes, methods = METHOD_SET } = {}) {
  if (!msg || typeof msg !== 'object' || Array.isArray(msg)) return { ok: false, id: null, error: apiError('E_BAD_REQUEST', 'request must be an object') }
  const id = msg.id
  if (!idOk(id)) return { ok: false, id: null, error: apiError('E_BAD_REQUEST', 'request id must be a short string or a number') }
  if (typeof msg.method !== 'string' || !methods.has(msg.method)) return { ok: false, id, error: apiError('E_BAD_REQUEST', 'unknown method') }
  const params = msg.params === undefined || msg.params === null ? {} : msg.params
  const checked = validateParamsObject(msg.method, params, maxBytes)
  if (checked) return { ok: false, id, error: checked }
  return { ok: true, id, method: msg.method, params }
}

function validateParamsObject (method, params, maxBytes) {
  if (typeof params !== 'object' || Array.isArray(params) || params === null) return apiError('E_LIMIT', 'params must be a plain JSON object')
  const { json, blobError } = jsonPart(method, params)
  if (blobError) return blobError
  if (!isPlainJson(json)) return apiError('E_LIMIT', 'params must be a plain JSON object')
  if (jsonBytes(json) > maxBytes) return apiError('E_LIMIT', 'request larger than ' + maxBytes + ' bytes')
  return null
}

function stringParam (value, what, max) {
  if (typeof value !== 'string' || value.length === 0) return { error: apiError('E_LIMIT', what + ' must be a non-empty string') }
  if (value.length > max) return { error: apiError('E_LIMIT', what + ' longer than ' + max + ' characters') }
  return { value }
}

function valueParam (value, maxValueBytes) {
  if (value === undefined) return { error: apiError('E_LIMIT', 'value is required') }
  if (!isPlainJson(value)) return { error: apiError('E_LIMIT', 'values must be plain JSON') }
  const size = jsonBytes(value)
  if (size > maxValueBytes) return { error: apiError('E_LIMIT', 'value is ' + size + ' bytes; the limit is ' + maxValueBytes) }
  return { value }
}

function ledgerParam (p) {
  if (p.ledger === undefined || p.ledger === null) return { value: null }
  if (typeof p.ledger !== 'string' || !LEDGER_ID_RE.test(p.ledger)) return { error: apiError('E_BAD_REQUEST', 'ledger must be a ledger id (mw1:... or btih:...)') }
  return { value: p.ledger }
}

/**
 * validateParams(method, params, limits) -> { ok: true, args } | { ok: false, error }
 * Accepts the SDK's object form ({ key, value }, { name, limit, newestFirst }, ...). Methods answered by a
 * service are passed through as { params } (the service validates them).
 */
export function validateParams (method, params, limits = {}) {
  const L = Object.assign({}, DEFAULT_LIMITS, limits)
  const p = params || {}
  const fail = (r) => ({ ok: false, error: r.error })
  let a
  let b
  let led
  switch (method) {
    case 'db.get':
      a = stringParam(p.key, 'key', L.maxKey)
      if (a.error) return fail(a)
      led = ledgerParam(p)
      return led.error ? fail(led) : { ok: true, args: [a.value], ledger: led.value }
    case 'db.del':
      a = stringParam(p.key, 'key', L.maxKey)
      if (a.error) return fail(a)
      led = ledgerParam(p)
      return led.error ? fail(led) : { ok: true, args: [a.value], ledger: led.value }
    case 'db.set':
      a = stringParam(p.key, 'key', L.maxKey)
      if (a.error) return fail(a)
      b = valueParam(p.value, L.maxValueBytes)
      if (b.error) return fail(b)
      led = ledgerParam(p)
      return led.error ? fail(led) : { ok: true, args: [a.value, b.value], ledger: led.value }
    case 'db.append':
      a = stringParam(p.name, 'list name', L.maxListName)
      if (a.error) return fail(a)
      b = valueParam(p.value, L.maxValueBytes)
      if (b.error) return fail(b)
      led = ledgerParam(p)
      return led.error ? fail(led) : { ok: true, args: [a.value, b.value], ledger: led.value }
    case 'db.list': {
      a = stringParam(p.name, 'list name', L.maxListName)
      if (a.error) return fail(a)
      let limit = p.limit === undefined ? 100 : p.limit
      if (typeof limit !== 'number' || !Number.isFinite(limit)) return { ok: false, error: apiError('E_LIMIT', 'limit must be a number') }
      limit = Math.max(1, Math.min(L.maxListLimit, Math.floor(limit)))
      led = ledgerParam(p)
      return led.error ? fail(led) : { ok: true, args: [a.value, { limit, newestFirst: p.newestFirst !== false }], ledger: led.value }
    }
    case 'db.snapshot':
      led = ledgerParam(p)
      return led.error ? fail(led) : { ok: true, args: [], ledger: led.value }
    case 'db.tombstone':
      if (typeof p.h !== 'string' || !HASH_RE.test(p.h)) return { ok: false, error: apiError('E_LIMIT', 'h must be a 64-character lowercase hex hash') }
      led = ledgerParam(p)
      return led.error ? fail(led) : { ok: true, args: [p.h], ledger: led.value }
    case 'mod.ban':
    case 'mod.unban': {
      const pub = p.pub !== undefined ? p.pub : p.author
      if (!isPublicKeyString(pub)) return { ok: false, error: apiError('E_LIMIT', 'pub must be a P-256 public key (p256:<base64url>)') }
      return { ok: true, args: [pub], params: Object.assign({}, p, { pub }) }
    }
    case 'identity.setName':
      a = stringParam(typeof p.name === 'string' ? p.name.trim() : p.name, 'name', L.maxName)
      return a.error ? fail(a) : { ok: true, args: [a.value], params: Object.assign({}, p, { name: a.value }) }
    case 'write.cancel':
      return idOk(p.id) ? { ok: true, args: [p.id] } : { ok: false, error: apiError('E_LIMIT', 'id must be the id of a write request') }
    default:
      return { ok: true, args: [], params: p }
  }
}

/** Maps anything thrown by the ledger, crypto, storage or a service to { code, message }. */
export function mapError (err) {
  if (err && typeof err === 'object' && typeof err.code === 'string' && KNOWN_CODES.has(err.code)) {
    return { code: err.code, message: typeof err.message === 'string' && err.message ? err.message : err.code }
  }
  const name = err && err.name
  const message = (err && err.message) || (typeof err === 'string' ? err : 'internal error')
  if (name === 'AbortError') return { code: 'E_POW_ABORTED', message }
  if (name === 'QuotaExceededError') return { code: 'E_CAP', message }
  if (name === 'DataCloneError' || name === 'OperationError' || name === 'InvalidAccessError') return { code: 'E_IDENTITY', message }
  if (err && typeof err.code === 'string' && /^E_[A-Z_]+$/.test(err.code)) return { code: 'E_POLICY', message: err.code + ': ' + message }
  return { code: 'E_INTERNAL', message }
}

export class RateLimiter {
  constructor (limit, windowMs, now = () => Date.now()) {
    this.limit = limit
    this.windowMs = windowMs
    this.now = now
    this.hits = []
  }

  take () {
    const t = this.now()
    while (this.hits.length && this.hits[0] <= t - this.windowMs) this.hits.shift()
    if (this.hits.length >= this.limit) return false
    this.hits.push(t)
    return true
  }
}

export function kvEntryValue (entry) {
  if (entry && typeof entry === 'object' && !Array.isArray(entry) && 'v' in entry && 'h' in entry) return entry.v
  return entry
}

export function plainOf (map) {
  if (map instanceof Map) { const o = {}; for (const [k, v] of map) o[k] = v; return o }
  return map && typeof map === 'object' ? map : {}
}

export function blockHash (block) {
  if (!block) return null
  if (typeof block === 'string') return block
  return block.h || null
}

/**
 * featuresOf(cfg) -> { chat, files, media, records, requests, calls } from the site's _mw.cfg (R 2.5.5): advisory owner
 * settings, every one off by default. calls (C2 wire-ui, SZ 3.5) is true only for _mw.cfg.calls = 'contacts', the one
 * value that turns calls on in src/calls/service.js.
 */
export function featuresOf (cfg) {
  const c = cfg && typeof cfg === 'object' ? cfg : {}
  const on = (v) => !(v === undefined || v === null || v === false || v === 'off')
  return {
    chat: on(c.chat),
    files: on(c.files),
    media: on(c.media),
    records: c.records === 'sealed' || Boolean(c.records && typeof c.records === 'object' && c.records.mode === 'sealed'),
    requests: on(c.requests),
    calls: c.calls === 'contacts' // C2 wire-ui
  }
}

/** cfgFromNode(node) -> the _mw.cfg value of the ledger (state or snapshot), or {}. */
/**
 * ownerCfgPin(node) -> _mw.cfg.pin when the _mw.cfg in effect was written with owner standing, else null (code review v0.3,
 * security 13). The pin key authenticates pin receipts, heartbeats and anchored pin wires ("Kept by the site"), so a
 * moderator, who may write _mw.cfg, must not be able to name their own node (R 2.5.5: nothing security-relevant comes
 * from a moderator's advisory settings).
 */
export function ownerCfgPin (node) {
  try {
    const st = node && node.state
    const e = st && st.kv instanceof Map ? st.kv.get('_mw.cfg') : null
    if (!e || typeof e !== 'object' || typeof e.h !== 'string') return null
    if (!(st.ownerWritten instanceof Set) || !st.ownerWritten.has(e.h)) return null
    const v = kvEntryValue(e)
    return v && typeof v === 'object' && typeof v.pin === 'string' && v.pin ? v.pin : null
  } catch (_) {
    return null
  }
}

/**
 * Review round R 5.3 (SYB-18): the _mw.cfg fields that open a site to more traffic or change who may reach people. From an
 * entry the owner did not write (a moderator's; the owner's own cannot be replaced by one since HUB-6) a reader keeps such a
 * field only when it turns the feature off; every other value falls back to the default.
 */
export const OWNER_ONLY_CFG = Object.freeze(['chatBits', 'requests', 'chat', 'files', 'media', 'calls', 'age', 'turn', 'blockTiers'])

export function narrowNonOwnerCfg (v) {
  const out = Object.assign({}, v)
  for (const k of OWNER_ONLY_CFG) if (k in out && out[k] !== 'off') delete out[k]
  return out
}

export function cfgFromNode (node) {
  if (!node) return {}
  try {
    const st = node.state
    if (st && st.kv instanceof Map) {
      const e = st.kv.get('_mw.cfg')
      const v = kvEntryValue(e)
      if (!(v && typeof v === 'object' && !Array.isArray(v))) return {}
      const owner = e && typeof e.h === 'string' && st.ownerWritten instanceof Set && st.ownerWritten.has(e.h)
      return owner || !(st.ownerWritten instanceof Set) ? v : narrowNonOwnerCfg(v)
    }
  } catch (_) { /* a follower node has no state */ }
  try {
    const snap = typeof node.snapshot === 'function' ? node.snapshot() : null
    const kv = snap ? plainOf(snap.kv) : {}
    const v = kvEntryValue(kv['_mw.cfg'])
    return v && typeof v === 'object' && !Array.isArray(v) ? v : {}
  } catch (_) { return {} }
}

// ---------------------------------------------------------------------------------------------
// Activation (R 2.11.1): only the loader can say a call came from a click in the site frame.
// ---------------------------------------------------------------------------------------------

const ACTIVATION_EVENTS = ['pointerdown', 'pointerup', 'mousedown', 'mouseup', 'click', 'keydown', 'keyup', 'touchend']

/**
 * new ActivationTracker({ now, windowMs, nav }): records the time of the last trusted input event (isTrusted ===
 * true: script-made events never count) on the targets it watches (the site frame's window in shell mode, the
 * page in drop-in mode), and reads the browser's own transient activation where the floor browsers have it.
 * isActive() -> true within windowMs of trusted input, or while navigator.userActivation.isActive.
 * A site cannot set either: a value it passes in its params is dropped (stripActivationFlags).
 */
export class ActivationTracker {
  constructor ({ now = () => Date.now(), windowMs = ACTIVATION_WINDOW_MS, nav = null } = {}) {
    this.now = now
    this.windowMs = windowMs
    this.nav = nav
    this.last = -Infinity
    this.count = 0
    this._targets = new Map()
    this._onEvent = (ev) => this.note(ev)
  }

  /** note(event): an input event the loader saw; counts only when the browser says the person made it. */
  note (ev) {
    if (!ev || ev.isTrusted !== true) return false
    this.last = this.now()
    this.count++
    return true
  }

  /** watch(target): listen in the capture phase (a site's stopPropagation cannot hide a click). Returns unwatch(). */
  watch (target) {
    // C2 integrator (doors request 5): a cross-origin window (the door view's opaque-origin frame) throws a SecurityError on the
    // property read itself, so the check sits in a try; such a target is not watched (navigator.userActivation still counts).
    let listens = false
    try { listens = !!target && typeof target.addEventListener === 'function' } catch (_) { listens = false }
    if (!listens || this._targets.has(target)) return () => {}
    for (const type of ACTIVATION_EVENTS) {
      try { target.addEventListener(type, this._onEvent, true) } catch (_) { /* a closed window */ }
    }
    this._targets.set(target, true)
    return () => this.unwatch(target)
  }

  unwatch (target) {
    if (!this._targets.has(target)) return
    for (const type of ACTIVATION_EVENTS) {
      try { target.removeEventListener(type, this._onEvent, true) } catch (_) { /* gone */ }
    }
    this._targets.delete(target)
  }

  browserActive () {
    try {
      const ua = this.nav && this.nav.userActivation // lint-floor-ignore: optional, read only when the browser has it
      return !!(ua && ua.isActive === true)
    } catch (_) { return false }
  }

  isActive () {
    if (this.browserActive()) return true
    return this.now() - this.last <= this.windowMs
  }

  destroy () {
    for (const t of Array.from(this._targets.keys())) this.unwatch(t)
  }
}

function activationOf (a) {
  if (!a) return () => false
  if (typeof a === 'function') return () => { try { return a() === true } catch (_) { return false } }
  if (typeof a.isActive === 'function') return () => { try { return a.isActive() === true } catch (_) { return false } }
  return () => false
}

// ---------------------------------------------------------------------------------------------
// The loader's prompt for services (the cards of src/loader/ui.js and src/dropin/panel.js, lane ui)
// ---------------------------------------------------------------------------------------------

/**
 * Card kinds ui.prompt() accepts (src/loader/ui.js CARD_KINDS, kept here so Node tests need no DOM module). 'dock' is C2
 * wire-ui; 'kit' and 'continue-here' are the loader's own (code review v0.3: the recovery kit, the redirect round trip).
 */
export const UI_CARD_KINDS = Object.freeze(['signin', 'tap', 'consent', 'confirm', 'upload', 'phone-upload', 'offer', 'owner-changed',
  'foreign-address', 'storage-evicted', 'error', 'mod.ban', 'mod.unban', 'mod.tombstoneMany', 'mod.decide', 'dock', 'kit', 'continue-here'])

/**
 * The card kinds src/calls/service.js asks for (deps.prompt, SZ 3.5 "UI"). The shell answers them with its call panel
 * (src/loader/call-ui.js); cardFor() below maps them to plain confirm cards for a loader without one (C2 wire-ui).
 */
export const CALL_CARD_KINDS = Object.freeze(['call.start', 'call.incoming', 'call.group', 'call.metered', 'call.screen'])

/** Short card texts for prompts lane ui has no sentence for yet (request in docs/deviations/sdk.md). */
export const PROMPT_TEXT = Object.freeze({
  en: Object.freeze({
    contactsTitle: 'Show your contacts to this site?',
    contactsText: 'Code on this site will see the names and keys of your contacts on this site while you are signed in.',
    historyTitle: 'Show your saved messages to this site?',
    historyText: 'Code on this site will see the messages you kept on this device while you are signed in.',
    shareTitle: 'Share with {count}?',
    shareText: 'Each person gets a key to open it. People you share with may keep a copy.',
    deleteTitle: 'Delete this?',
    deleteText: 'This stops sharing it from this device and deletes your copy. Copies other people kept stay with them.',
    reportTitle: 'Send this report?',
    reportText: 'The moderators get what this device saw about it (keys, ids, size, time) and your note. The file itself is never sent.',
    ownerTitle: 'Confirm this change to your page',
    ownerText: 'This changes the settings of the page you own on this site.',
    tombstoneTitle: 'Remove this entry for everyone?',
    tombstoneText: 'Copies that sync drop what it says. Its author, its time and where it was posted stay in the ledger.'
  }),
  fr: Object.freeze({
    contactsTitle: 'Montrer vos contacts à ce site ?',
    contactsText: 'Le code de ce site verra les noms et les clés de vos contacts sur ce site tant que vous êtes connecté.',
    historyTitle: 'Montrer vos messages enregistrés à ce site ?',
    historyText: 'Le code de ce site verra les messages gardés sur cet appareil tant que vous êtes connecté.',
    shareTitle: 'Partager avec {count} ?',
    shareText: 'Chaque personne reçoit une clé pour l\'ouvrir. Les personnes avec qui vous partagez peuvent garder une copie.',
    deleteTitle: 'Supprimer ceci ?',
    deleteText: 'Le partage depuis cet appareil s\'arrête et votre copie est supprimée. Les copies gardées par d\'autres restent chez eux.',
    reportTitle: 'Envoyer ce signalement ?',
    reportText: 'Les modérateurs reçoivent ce que cet appareil a vu (clés, identifiants, taille, heure) et votre note. Le fichier lui-même n\'est jamais envoyé.',
    ownerTitle: 'Confirmer ce changement de votre page',
    ownerText: 'Ceci change les réglages de la page que vous possédez sur ce site.',
    tombstoneTitle: 'Retirer cette entrée pour tout le monde ?',
    tombstoneText: 'Les copies qui se synchronisent effacent son contenu. Son auteur, son heure et l\'endroit où elle a été publiée restent dans le registre.'
  })
})

function promptText (lang, key, params) {
  const t = (PROMPT_TEXT[lang] || PROMPT_TEXT.en)[key] || PROMPT_TEXT.en[key] || ''
  return t.replace(/\{(\w+)\}/g, (m, k) => (params && params[k] !== undefined ? String(params[k]) : m))
}

/**
 * cardFor(kind, data, { lang }) -> { kind, data } | null: the loader card for a service's prompt. Services call
 * prompt(kind, data) (chat) or prompt({ kind, ... }) (files, media); identity and the SDK itself use the card
 * kinds of ui.prompt directly. null: no card exists for this kind (the prompt answers false).
 */
export function cardFor (kind, data, { lang = 'en', stun = null } = {}) {
  const d = data && typeof data === 'object' ? data : {}
  if (UI_CARD_KINDS.indexOf(kind) >= 0) return { kind, data: d }
  const consent = (card, params) => ({ kind: 'consent', data: { card, params: params || {} } })
  const confirm = (title, text, danger) => ({ kind: 'confirm', data: { title, text, danger: !!danger } })
  switch (kind) {
    // chat (src/chat/service.js prompt kinds). Code review v0.3 (conformance, MF-44): the card names the STUN servers
    // the chat lane really uses, the site's own (stun: the loader's list), never an empty name.
    case 'chat.enable': return consent('turnOnChat', { tracker: d.tracker || '', stun: d.stun || stunNames(stun, lang) })
    case 'chat.ck.ledger': return consent('chatKeyInLedger')
    case 'chat.presence.public': return consent('presencePublic')
    case 'chat.requests.open': return d.open === false ? { kind: null, data: d } : consent('messageRequests')
    case 'chat.holder': return consent('holdMessages')
    case 'chat.contacts.list': return confirm(promptText(lang, 'contactsTitle'), promptText(lang, 'contactsText'))
    case 'chat.dm.history': return confirm(promptText(lang, 'historyTitle'), promptText(lang, 'historyText'))
    // files (src/files/lane.js, src/files/service.js)
    case 'files-enable': return consent('fetchPublic')
    case 'file-share': return { kind: 'upload', data: { visibility: d.public ? 'public' : 'private', name: d.name || '', size: d.size || 0, type: d.mime || '', stripped: Array.isArray(d.removed) && d.removed.length > 0, unchecked: Boolean(d.unchecked) } }
    case 'file-send-original': return confirm('', d.text || '', true)
    case 'file-strip-failed': return confirm('', d.choice || d.text || '', true)
    case 'file-fetch': return { kind: 'offer', data: { kind: 'file', from: d.from || '', name: d.name || '', size: d.size || 0, type: d.mime || '' } }
    case 'file-risk': return confirm(d.name || '', d.warning || '', true)
    case 'file-help-share': return consent('helpShare')
    // media (src/media/lane.js, src/media/service.js)
    case 'media-upload': return { kind: 'upload', data: { visibility: 'private', name: d.name || '', size: d.size || 0, type: d.mime || '', stripped: Array.isArray(d.removed) && d.removed.length > 0 } }
    case 'media-keep-original': return confirm('', d.text || '', true)
    case 'media-strip-failed': return confirm('', d.choice || d.text || '', true)
    case 'media-share': return confirm(promptText(lang, 'shareTitle', { count: Array.isArray(d.recipients) ? d.recipients.length : 1 }), promptText(lang, 'shareText'))
    case 'media-revoke': return confirm('', d.text || '', true)
    case 'media-delete': return confirm(promptText(lang, 'deleteTitle'), promptText(lang, 'deleteText'), true)
    case 'media-keep-available': return consent('helpShare')
    case 'media-offer': return { kind: 'offer', data: { kind: 'media', from: d.from || '', name: d.name || '', size: d.size || 0, type: d.mediaKind || d.mime || '' } }
    // this module and mod.js
    case 'report.send': return confirm(promptText(lang, 'reportTitle'), promptText(lang, 'reportText'))
    case 'owner.action': return confirm(promptText(lang, 'ownerTitle'), d.text || promptText(lang, 'ownerText'))
    // MF-27: a moderator removing another author's entry (db.tombstone)
    case 'mod.tombstone': return confirm(promptText(lang, 'tombstoneTitle'), promptText(lang, 'tombstoneText'), true)
    // C2 wire-ui: the calls service's cards, as confirm cards with the CALL_TEXT sentences (SZ 3.5), for a loader that
    // has no call panel to answer them. Each one names who will see the IP address before any address leaves.
    case 'call.start': return confirm('', callText('call.start', lang, { name: callName(d.name, d.to) }) + (d.relay && d.relay.operator ? ' ' + callText('call.startRelay', lang, { operator: d.relay.operator }) : ''))
    case 'call.incoming': return confirm('', callText('call.incoming', lang, { name: callName(d.name, d.from), kind: callText(d.kind === 'video' ? 'call.kind.video' : 'call.kind.audio', lang) }))
    case 'call.group': return confirm('', callText('call.group', lang, { names: d.role === 'callee' ? callNames([d.name].concat(d.names || []), [d.from].concat(d.roster || [])) : callNames(d.names, d.to) }))
    case 'call.metered': return confirm('', callText('call.metered', lang))
    case 'call.screen': return confirm('', callText('call.screen', lang))
    default: return null
  }
}

/** callName(name, pub) -> the name a call card shows: the contact's name, else the short id of the key (C2 wire-ui). */
export function callName (name, pub) {
  if (typeof name === 'string' && name.trim()) return name.trim().slice(0, 48)
  return typeof pub === 'string' && pub ? shortKey(pub) : '?'
}

/** callNames(names, pubs) -> 'Ana, Bo, 3f9a2c1d': the people a group card names (C2 wire-ui). */
export function callNames (names, pubs) {
  const list = Array.isArray(pubs) ? pubs : (typeof pubs === 'string' ? [pubs] : [])
  const named = Array.isArray(names) ? names : []
  const out = []
  const n = Math.max(list.length, named.length)
  for (let i = 0; i < n && out.length < 6; i++) out.push(callName(named[i], list[i]))
  return out.join(', ')
}

/**
 * stunNames(list, lang) -> 'stun.example.org' or 'a.example and b.example' (the hosts of 'stun:' URLs), or the words
 * for "no STUN server" when the site names none (its chat, group, file and media swarms then use host candidates only).
 */
export function stunNames (list, lang = 'en') {
  const raw = typeof list === 'function' ? list() : list
  const hosts = []
  for (const x of Array.isArray(raw) ? raw : []) {
    const u = typeof x === 'string' ? x : (x && typeof x === 'object' ? (Array.isArray(x.urls) ? x.urls[0] : x.urls) : null)
    if (typeof u !== 'string') continue
    const m = /^stuns?:(\[[^\]]+\]|[^:?]+)/.exec(u.trim())
    if (m && hosts.indexOf(m[1]) < 0) hosts.push(m[1])
  }
  const and = lang === 'fr' ? ' et ' : ' and '
  if (!hosts.length) return lang === 'fr' ? 'aucun serveur STUN' : 'no STUN server'
  if (hosts.length === 1) return hosts[0]
  return hosts.slice(0, -1).join(', ') + and + hosts[hosts.length - 1]
}

/**
 * promptAdapter(ui, { lang, log }) -> prompt(kindOrObject, data) -> Promise<boolean | result>: the one function
 * every service gets as deps.prompt. It shows the loader's card (ui.prompt) and resolves true only on the
 * person's own input there; a kind with no card resolves false (nothing is granted by default). The answer of a
 * card the person accepted is passed through (a 'signin' card resolves with the sign-in result).
 */
export function promptAdapter (ui, { lang = 'en', log = null, stun = null } = {}) {
  return async function prompt (kindOrObject, data) {
    let kind = kindOrObject
    let d = data
    if (kindOrObject && typeof kindOrObject === 'object') {
      kind = kindOrObject.kind
      d = kindOrObject
    }
    if (!ui || typeof ui.prompt !== 'function') return false
    // stun may be a function, and its answer a promise (the drop-in reads the site's list only when a card needs it).
    let list = stun
    if (String(kind) === 'chat.enable' && typeof stun === 'function') {
      try { list = await stun() } catch (_) { list = [] }
    } else if (typeof stun === 'function') {
      list = null
    }
    const card = cardFor(String(kind), d, { lang, stun: list })
    if (!card) {
      if (typeof log === 'function') log('no loader card for prompt kind ' + String(kind) + ': answered no')
      return false
    }
    if (card.kind === null) return true // nothing to confirm (closing message requests)
    try {
      const res = await ui.prompt(card.kind, card.data)
      return res === undefined || res === null ? false : res
    } catch (_) {
      return false
    }
  }
}

/**
 * new ConsentRequests({ consent, ui, now, cooldownMs }): mw.consent.request() (v0.2.1 A4), shared by
 * the shell Bridge and the drop-in binding.
 *   consent: { state() -> 'pending'|'accepted'|'host-only', request?() -> Promise<state> }
 *   ui:      { openConsent() -> Promise<state> } (loader-owned UI hook; preferred over consent.request)
 * request() -> Promise<state>. A decided state ('accepted' or 'host-only') is returned as is and never
 * reopens a card. Otherwise the loader-owned consent card opens and the promise resolves with the
 * visitor's choice there; concurrent requests share one card; after a card closes undecided, requests
 * within cooldownMs return 'pending' without reopening it, so a site cannot nag. Without a UI hook it
 * resolves with the current state. It never grants consent by itself.
 */
export class ConsentRequests {
  constructor ({ consent = null, ui = null, now = () => Date.now(), cooldownMs = CONSENT_REQUEST_COOLDOWN_MS } = {}) {
    this.consent = consent
    this.ui = ui
    this.now = now
    this.cooldownMs = cooldownMs
    this.pending = null
    this.quietUntil = 0
    this.opened = 0
  }

  state () {
    try {
      const s = this.consent && typeof this.consent.state === 'function' ? this.consent.state() : 'pending'
      return CONSENT_STATES.indexOf(s) >= 0 ? s : 'pending'
    } catch (_) { return 'pending' }
  }

  opener () {
    if (this.ui && typeof this.ui.openConsent === 'function') return () => this.ui.openConsent()
    if (this.consent && typeof this.consent.request === 'function') return () => this.consent.request()
    return null
  }

  request () {
    const now = this.state()
    if (now !== 'pending') return Promise.resolve(now)
    if (this.pending) return this.pending
    if (this.now() < this.quietUntil) return Promise.resolve('pending')
    const open = this.opener()
    if (!open) return Promise.resolve(now)
    this.opened++
    const p = Promise.resolve()
      .then(open)
      .then((s) => (CONSENT_STATES.indexOf(s) >= 0 ? s : this.state()), (err) => {
        if (err && typeof err === 'object' && err.code === 'E_NO_HOST') throw err
        return this.state()
      })
      .then((s) => {
        this.pending = null
        if (s === 'pending') this.quietUntil = this.now() + this.cooldownMs
        return s
      }, (err) => {
        this.pending = null
        throw err
      })
    this.pending = p
    return p
  }
}

/**
 * new SignInRequests({ open, now, cooldownMs }): the implicit sign-in prompt of R 2.4.1, shared by every write a
 * guest makes. open() -> Promise<truthy when the person signed in>. Concurrent writes share one prompt; after
 * a prompt that did not end signed in, writes within cooldownMs get E_NOT_SIGNED_IN without a new prompt.
 */
export class SignInRequests {
  constructor ({ open = null, now = () => Date.now(), cooldownMs = SIGNIN_COOLDOWN_MS } = {}) {
    this.open = open
    this.now = now
    this.cooldownMs = cooldownMs
    this.pending = null
    this.quietUntil = 0
    this.opened = 0
  }

  request () {
    if (this.pending) return this.pending
    if (this.now() < this.quietUntil || typeof this.open !== 'function') return Promise.resolve(false)
    this.opened++
    const p = Promise.resolve().then(() => this.open()).then((r) => !!r, () => false).then((ok) => {
      this.pending = null
      if (!ok) this.quietUntil = this.now() + this.cooldownMs
      return ok
    })
    this.pending = p
    return p
  }
}

// ---------------------------------------------------------------------------------------------
// Identity binding: the auth state the SDK reports, from the identity service (lane idp) or the 0.2.1 key
// ---------------------------------------------------------------------------------------------

/**
 * workingKeysOf(service) -> the WorkingKeys of this tab, or null: the identity service's keys() (lane idp,
 * src/identity/service.js; null when signed out).
 */
export function workingKeysOf (service) {
  if (!service || typeof service.keys !== 'function') return null
  try { return service.keys() || null } catch (_) { return null }
}

/**
 * nodeIdentityOf(keys) -> { privateKey, pub, kind, rc? } | null: what ChainNode signs blocks with, from WorkingKeys
 * (src/identity/store.js keys.identity: the non-extractable private CryptoKey createBlock needs). null for a guest,
 * for keys already destroyed (sign-out) and for anything without that key. rc (the bundle's recovery commitment)
 * lets the node write { t: 'keyinfo', rc } before the key's first other write on the ledger (MF-20, chain node.js),
 * which a later recover rotation of "Replace my keys on all sites" needs.
 */
export function nodeIdentityOf (keys, kind = 'signed-in') {
  if (!keys || !isPublicKeyString(keys.pub)) return null
  let id = null
  try { id = keys.identity || null } catch (_) { id = null }
  if (id && id.privateKey && typeof id.privateKey === 'object' && id.privateKey.type === 'private' && id.pub === keys.pub) {
    const out = { privateKey: id.privateKey, pub: id.pub, kind }
    let rc = null
    try { rc = typeof keys.rc === 'string' ? keys.rc : (typeof id.rc === 'string' ? id.rc : null) } catch (_) { rc = null }
    if (rc && /^[A-Za-z0-9_-]{43}$/.test(rc)) out.rc = rc
    return out
  }
  return null
}

/**
 * writeRotation(node, keys, ledgerId) -> Promise<block | null>: "Replace my keys on all sites" reaches this ledger
 * (MF-20; code review v0.3, conformance: the rotate op was never written). The bundle's rotateNotice for this ledger,
 * signed by the identity origin's recover key (rsig over "mw-rotate-v1\n" + ledger + from + next), becomes
 * { t: 'rotate', from, next, by: 'recover', rp, rsig }, written by the new key before its other writes, so the old
 * key's bans and allow membership follow it (chain state.js; never moderator or owner standing). Nothing is written
 * when the notice is for another ledger or key, when the old key left this ledger no recovery commitment (keyinfo: the
 * rotation would be refused), or when the rotation is already there. Never throws.
 */
export async function writeRotation (node, keys, ledgerId) {
  try {
    const n = keys ? keys.rotateNotice : null
    if (!node || typeof node.writeControl !== 'function' || !n || typeof n.rsig !== 'string' || !n.rsig) return null
    if (n.ledger !== ledgerId || n.next !== keys.pub || !isPublicKeyString(n.from) || !isPublicKeyString(n.rp)) return null
    const st = node.state || null
    const rot = st && st.rotations instanceof Map ? st.rotations.get(n.from) : null
    if (rot && rot.next === n.next) return null
    if (st && st.keyinfo instanceof Map && !st.keyinfo.has(n.from)) return null
    return await node.writeControl({ t: 'rotate', from: n.from, next: n.next, by: 'recover', rp: n.rp, rsig: n.rsig })
  } catch (_) {
    return null
  }
}

/**
 * rotationBlocker(node, keys) -> Promise<'commitment-not-yours' | 'no-keyinfo' | null> (review round R 5.3, HUB-5): why the
 * recover rotation of keys.rotateNotice cannot be written on this ledger. The first keyinfo of a key is final (MF-20), so a
 * site that wrote another recovery commitment for the old key while it was signed in blocks the replacement here for good.
 */
export async function rotationBlocker (node, keys) {
  try {
    const n = keys ? keys.rotateNotice : null
    const st = node && node.state
    if (!n || typeof n.rp !== 'string' || !st || !(st.keyinfo instanceof Map)) return null
    const ki = st.keyinfo.get(n.from)
    if (!ki) return 'no-keyinfo'
    if (typeof ki.rc !== 'string') return null
    const digest = new Uint8Array(await globalThis.crypto.subtle.digest('SHA-256', new TextEncoder().encode(n.rp)))
    let s = ''
    for (let i = 0; i < digest.length; i++) s += String.fromCharCode(digest[i])
    const rc = btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
    return rc === ki.rc ? null : 'commitment-not-yours'
  } catch (_) {
    return null
  }
}

/**
 * siteModeOf(mode) -> what the site sees as identity.mode: 'private' (a key for this site only, the default), 'same'
 * (linked to another site), 'hub' (one identity on a hub), 'visit' (this visit only) or 'legacy' (the 0.2.1 key).
 * Takes either that form or a WorkingKeys keyMode ('linked', 'visit-only', ...), as lane idp's identity.current does.
 */
export function siteModeOf (mode) {
  if (mode === 'linked' || mode === 'same') return 'same'
  if (mode === 'hub') return 'hub'
  if (mode === 'visit-only' || mode === 'visit') return 'visit'
  if (mode === 'legacy') return 'legacy'
  return 'private'
}

/**
 * identityHeaderOf(info, keys) -> what ui.setIdentityHeader() draws (lane ui; MF-09): the unlock method and the backup
 * state come from the identity origin's bundle (keys.status), never assumed (code review v0.3, browser: the header
 * said "Unlocked with a passkey / No backup yet" whatever happened). unlock: 'visit' for "this visit only" or a
 * shared computer, 'passkey', else 'passphrase'; backup: the recovery kit or a backup file is saved.
 */
export function identityHeaderOf (info, keys) {
  if (!info) return null
  const m = siteModeOf((info && info.mode) || (keys && keys.keyMode))
  let st = null
  let shared = false
  let keyMode = null
  try {
    st = keys && keys.status && typeof keys.status === 'object' ? keys.status : null
    shared = Boolean(keys && keys.sharedComputer === true)
    keyMode = keys ? keys.keyMode : null
  } catch (_) { st = null }
  const visit = shared || keyMode === 'visit-only' || m === 'visit'
  const unlock = visit ? 'visit' : st && st.passkey === true ? 'passkey' : 'passphrase'
  const backup = Boolean(st && (st.kitSaved === true || st.fileSaved === true))
  return { name: info.name || null, short: info.short, pub: info.pub, mode: m === 'same' || m === 'hub' ? m : 'private', unlock, backup }
}

/**
 * restoreMedia(service) -> Promise<number>: the person's own private media and accepted grants back after a reload or a
 * sign-in (code review v0.3, correctness: MediaLane.restore had no caller, so a reload emptied the gallery). Uses the
 * lane's once-per-key ready() where it exists. Never throws.
 */
export function restoreMedia (service) {
  try {
    if (!service) return Promise.resolve(0)
    if (service.lane && typeof service.lane.ready === 'function') return Promise.resolve(service.lane.ready()).catch(() => 0)
    if (typeof service.restore === 'function') return Promise.resolve(service.restore()).catch(() => 0)
  } catch (_) { /* no keys yet */ }
  return Promise.resolve(0)
}

/** chatKeyOf(keys) -> { pub, ecdh } for the chat service (INTERFACES ChatKey), or null. */
export function chatKeyOf (keys) {
  if (!keys) return null
  if (keys.chat && typeof keys.chat.ecdh === 'function' && typeof keys.chat.pub === 'string') return keys.chat
  if (typeof keys.ecdh === 'function' && typeof keys.chatPub === 'string') return { pub: keys.chatPub, ecdh: (p) => keys.ecdh(p) }
  return null
}

/**
 * new IdentityBinding({ legacy, now }) holds what mw.ready(), mw.auth.state() and the services need:
 *   mode()   'v03' (the identity service is mounted), 'legacy' (the 0.2.1 per-ledger key provider), 'none'
 *   state()  'signed-in' | 'guest'
 *   info()   { pub, short, name, mode } | null
 *   keys()   WorkingKeys | null (v03 only; a follower tab never has any)
 * refresh() reads the service again (after every auth.* call and every identity event).
 */
export class IdentityBinding {
  constructor ({ legacy = null } = {}) {
    this.legacy = legacy && typeof legacy.current === 'function' ? legacy : null
    this.service = null
    this.remote = null // { state, info } from the leader tab (followers)
    this.loaderKey = null // { pub, short, name, mode: 'legacy' }: a key the loader signs with outside the service
    this._state = 'guest'
    this._info = null
    this._keys = null
    this._listeners = new Set()
  }

  attach (service) {
    this.service = service || null
    return this.refresh()
  }

  detach () {
    this.service = null
    this._keys = null
    this._state = 'guest'
    this._info = null
  }

  mode () {
    if (this.service) return 'v03'
    if (this.remote) return 'v03'
    return this.legacy ? 'legacy' : 'none'
  }

  /**
   * setLoaderKey(info | null) (v0.3 reconciliation): a key the loader itself signs this ledger with, outside the
   * identity service: an imported moderator key (MF-27, Settings). While it is set it is what signs every write of
   * this tab (app.js and engine.js bindKeys keep it), so the site sees it: state 'signed-in' and info { pub, short,
   * name, mode: 'legacy' } (a loader-held key, not one of the identity origin), and a write opens no sign-in. Without
   * this a tab holding the moderator key reported auth 'guest' with role 'moderator'.
   */
  setLoaderKey (info) {
    const before = this.snapshot()
    this.loaderKey = info && isPublicKeyString(info.pub) ? { pub: info.pub, short: info.short || shortKey(info.pub), name: info.name || null, mode: 'legacy' } : null
    this._notifyIfChanged(before)
  }

  /** setRemote({ state, info }) on a follower tab: what the leader tab broadcast (never keys). null clears it. */
  setRemote (r) {
    const before = this.snapshot()
    this.remote = r && typeof r === 'object' ? { state: r.state === 'signed-in' ? 'signed-in' : 'guest', info: r.info || null } : null
    this._notifyIfChanged(before)
  }

  state () {
    if (this.loaderKey) return 'signed-in'
    if (this.service) return this._state
    if (this.remote) return this.remote.state
    if (this.legacy) return this.info() ? 'signed-in' : 'guest'
    return 'guest'
  }

  info () {
    if (this.loaderKey) return Object.assign({}, this.loaderKey)
    if (this.service) return this._info
    if (this.remote) return this.remote.info
    if (this.legacy) {
      try {
        const cur = this.legacy.current()
        if (cur && cur.pub) return { pub: cur.pub, short: cur.short || shortKey(cur.pub), name: cur.name || null, mode: 'legacy' }
      } catch (_) { /* no key yet */ }
    }
    return null
  }

  keys () { return this.service ? this._keys : null }

  snapshot () { return { state: this.state(), info: this.info() } }

  onChange (fn) {
    this._listeners.add(fn)
    return () => this._listeners.delete(fn)
  }

  _notifyIfChanged (before) {
    const now = this.snapshot()
    const same = before.state === now.state && JSON.stringify(before.info) === JSON.stringify(now.info)
    if (same) return false
    for (const fn of Array.from(this._listeners)) { try { fn(now) } catch (_) { /* a listener's bug */ } }
    return true
  }

  async refresh () {
    const svc = this.service
    if (!svc) return this.snapshot()
    const before = this.snapshot()
    const ctx = { activation: false, tab: 'leader' }
    let state = 'guest'
    let cur = null
    try {
      if (svc.methods && typeof svc.methods['auth.state'] === 'function') state = await svc.methods['auth.state']({}, ctx)
    } catch (_) { state = 'guest' }
    if (state && typeof state === 'object') state = state.state
    try {
      if (svc.methods && typeof svc.methods['identity.current'] === 'function') cur = await svc.methods['identity.current']({}, ctx)
    } catch (_) { cur = null }
    this._keys = workingKeysOf(svc)
    const signedIn = state === 'signed-in'
    this._state = signedIn ? 'signed-in' : 'guest'
    const pub = cur && cur.pub ? cur.pub : (this._keys && this._keys.pub) || null
    this._info = signedIn && pub
      ? { pub, short: (cur && cur.short) || shortKey(pub), name: (cur && cur.name) || null, mode: siteModeOf((cur && cur.mode) || (this._keys && this._keys.keyMode)) }
      : null
    if (!signedIn) this._keys = null
    this._notifyIfChanged(before)
    return this.snapshot()
  }
}

// ---------------------------------------------------------------------------------------------
// The method table: MwApi
// ---------------------------------------------------------------------------------------------

/**
 * new MwApi({ node, torrentManager, consent, ui, info, identity, limits, now, setTimeoutFn, clearTimeoutFn,
 *             activation, tab, hostOnly, cfg, prompt, lang, log })
 *  node: ChainNode (or a follower-tab proxy) or null until it opens (setNode()).
 *  torrentManager: optional; peers and source come from it when present.
 *  consent: { state() -> 'pending'|'accepted'|'host-only', request?() -> Promise<state> } (no site-callable accept).
 *  ui: loader-owned UI hooks { openConsent(), prompt(kind, data), setWriteProgress(p) } (src/loader/ui.js, panel.js).
 *  info: object or () -> object with { siteId, btih, mode, name, files, owner, unmoderated, source, peers }.
 *  identity: the 0.2.1 per-ledger key provider { current() -> { pub, short, name } }; the v0.3 identity
 *    service is mounted with mount('identity', svc) and then wins.
 *  activation: an ActivationTracker (or () -> boolean): the only source of ctx.activation.
 *  tab: () -> 'leader' | 'follower'. hostOnly: () -> boolean. cfg: () -> _mw.cfg (default: the ledger's).
 *  prompt: the services' prompt (default: promptAdapter(ui)).
 */
export class MwApi {
  constructor ({
    node = null, torrentManager = null, consent = null, ui = null, info = {}, identity = null, limits = {}, now = () => Date.now(),
    setTimeoutFn = null, clearTimeoutFn = null, activation = null, tab = null, hostOnly = null, cfg = null, prompt = null,
    lang = 'en', log = null, mod = true, readOnly = null
  } = {}) {
    this.node = node
    this.tm = torrentManager
    this.consent = consent
    this.ui = ui
    this.consentRequests = new ConsentRequests({ consent, ui, now })
    this.info = info
    this.identity = new IdentityBinding({ legacy: identity })
    this.legacyIdentity = identity
    this.limits = Object.assign({}, DEFAULT_LIMITS, limits || {})
    this.now = now
    this._setTimeout = setTimeoutFn || ((fn, ms) => setTimeout(fn, ms))
    this._clearTimeout = clearTimeoutFn || ((t) => clearTimeout(t))
    this.writes = new RateLimiter(this.limits.writesPerMinute, 60000, now)
    this.stats = { requests: 0, rejected: 0, rateLimited: 0, gestureRefused: 0, hostOnlyRefused: 0 }
    this.nodeSettled = !!node
    this._nodeWaiters = []
    this.activation = activationOf(activation)
    this.tracker = activation && typeof activation === 'object' ? activation : null
    this._tab = typeof tab === 'function' ? tab : () => 'leader'
    this._hostOnly = typeof hostOnly === 'function' ? hostOnly : () => false
    this._readOnly = typeof readOnly === 'function' ? readOnly : () => false
    /** ownerConfirm(card) -> Promise<boolean>: the identity origin's owner-action card (set by the loader). */
    this.ownerConfirm = null
    /** C2 wire-ui: the seeding reads and controls of mw.net (createNetControl, set by the loader with setNet()). */
    this.net = null
    this._cfg = typeof cfg === 'function' ? cfg : () => cfgFromNode(this.node)
    this.lang = lang
    this.log = typeof log === 'function' ? log : () => {}
    /** The site's own STUN servers (setLaneStun): what the chat, group, file and media swarms use, and what cards name. */
    this._laneStun = []
    /** setLaneStunSource(fn): where the list comes from when it is read late (the drop-in: fn() -> Promise, then setLaneStun). */
    this._laneStunSource = null
    this.prompt = typeof prompt === 'function' ? prompt : promptAdapter(ui, {
      lang,
      log: this.log,
      stun: () => (typeof this._laneStunSource === 'function'
        ? Promise.resolve().then(this._laneStunSource).then(() => this._laneStun, () => this._laneStun)
        : this._laneStun)
    })
    this.services = {}
    this._serviceOff = {}
    this._pushListeners = new Set()
    this._unlocked = new Set()
    this.signInRequests = new SignInRequests({ open: () => this.openSignInCard(), now })
    this._kitOffered = false
    this.identity.onChange((snap) => {
      if (snap.state !== 'signed-in') this._unlocked.clear()
      // Working keys installed (sign-in, a restored "Stay signed in"): the person's own media come back (shell, hub
      // and drop-in all run this table).
      if (snap.state === 'signed-in') restoreMedia(this.services.media)
      this.emitPush('auth', { type: 'change', data: { state: snap.state, identity: snap.info, role: this.role() } })
    })
    if (mod) this.mount('mod', createModService({ api: this }))
  }

  // ----- late binding ---------------------------------------------------------------------------

  /** Late binding: the ledger opens after the page renders. node null + failed = no ledger here. */
  setNode (node, { failed = false } = {}) {
    this.node = node || null
    if (node || failed) {
      this.nodeSettled = true
      this._resolveNodeWaiters()
    }
  }

  setTorrentManager (tm) { this.tm = tm || null }

  /** setLaneStun(list): the site's own STUN servers ('stun:' URLs or { urls }), named on the chat card (MF-44). */
  setLaneStun (list) { this._laneStun = Array.isArray(list) ? list.slice(0, 4) : [] }

  /** setLaneStunSource(fn | null): fn() -> Promise, settled once setLaneStun() holds the site's list (read before the chat card). */
  setLaneStunSource (fn) { this._laneStunSource = typeof fn === 'function' ? fn : null }

  /** setNet(control) (C2 wire-ui): { seeding(), dock(params, ctx), keep(params, ctx) } for mw.net; null: E_UNSUPPORTED. */
  setNet (control) { this.net = control && typeof control === 'object' ? control : null }

  /** mount(name, service): a service of the SVC contract ({ methods, on, destroy }); its events are pushed. */
  mount (name, service) {
    this.unmount(name)
    if (!service || typeof service !== 'object' || !service.methods) return null
    this.services[name] = service
    const spec = SERVICE_EVENTS[name]
    const offs = []
    if (spec && typeof service.on === 'function') {
      for (const ev of spec.events) {
        try {
          const off = service.on(ev, (data) => this._serviceEvent(name, ev, data))
          if (typeof off === 'function') offs.push(off)
        } catch (_) { /* the service does not emit this event */ }
      }
    }
    this._serviceOff[name] = offs
    if (name === 'identity') this.identity.attach(service).catch(() => {})
    return service
  }

  unmount (name) {
    const svc = this.services[name]
    for (const off of this._serviceOff[name] || []) { try { off() } catch (_) { /* gone */ } }
    delete this._serviceOff[name]
    delete this.services[name]
    if (name === 'identity' && svc) this.identity.detach()
    return svc || null
  }

  service (name) { return this.services[name] || null }

  /** addPushListener(fn(event, data)) -> remove: the Bridge, the binding and the loader itself listen here. */
  addPushListener (fn) {
    this._pushListeners.add(fn)
    return () => this._pushListeners.delete(fn)
  }

  emitPush (event, data) {
    for (const fn of Array.from(this._pushListeners)) { try { fn(event, data) } catch (_) { /* a listener's bug */ } }
  }

  _serviceEvent (name, ev, data) {
    const spec = SERVICE_EVENTS[name]
    if (name === 'identity') {
      if (ev === 'kit') { this.offerKit(data); return }
      this.identity.refresh().catch(() => {})
      if (ev === 'keychange') this.emitPush('keychange', { source: 'identity', data })
      return
    }
    if (!spec) return
    // A chat message that carries a grant shows the site only its type: grants hold file keys (R 2.9.6).
    // C2 wire-ui: call events carry plain data only (no MediaStream or track ever reaches the site, SZ 3.5 "SDK").
    const safe = name === 'chat' && ev === 'message' ? redactGrant(data) : (name === 'calls' ? plainOnly(data) : data)
    this.emitPush(spec.push, { type: ev, data: safe })
    if (ev === 'keychange') this.emitPush('keychange', { source: name, data })
  }

  destroy () {
    for (const name of Object.keys(this.services)) {
      const svc = this.unmount(name)
      if (svc && typeof svc.destroy === 'function') { try { svc.destroy() } catch (_) { /* gone */ } }
    }
    this._pushListeners.clear()
    this._resolveNodeWaiters()
  }

  // ----- small reads ----------------------------------------------------------------------------

  infoNow () {
    const i = typeof this.info === 'function' ? this.info() : this.info
    return i || {}
  }

  /** dropin() (C2 wire-ui) -> true on a drop-in page (its site info says mode 'dropin'); never throws. */
  dropin () {
    try { return this.infoNow().mode === 'dropin' } catch (_) { return false }
  }

  tab () {
    try { return this._tab() === 'follower' ? 'follower' : 'leader' } catch (_) { return 'leader' }
  }

  hostOnly () {
    try { return this._hostOnly() === true } catch (_) { return false }
  }

  readOnly () {
    try { return this._readOnly() === true } catch (_) { return false }
  }

  cfg () {
    try { return this._cfg() || {} } catch (_) { return {} }
  }

  role () {
    const node = this.node
    return node && typeof node.role === 'string' ? node.role : 'reader'
  }

  peers () {
    if (this.tm && typeof this.tm.peers === 'number') return this.tm.peers
    const node = this.node
    if (node && typeof node.peers === 'number') return node.peers
    const i = this.infoNow()
    return typeof i.peers === 'number' ? i.peers : 0
  }

  maxValueBytes () {
    const node = this.node
    try {
      const v = node && node.state && node.state.policy && node.state.policy.maxValueBytes
      if (typeof v === 'number' && v > 0) return v
    } catch (_) { /* ignore */ }
    const snap = this.rawSnapshot()
    const v = snap && snap.policy && snap.policy.maxValueBytes
    return typeof v === 'number' && v > 0 ? v : this.limits.maxValueBytes
  }

  rawSnapshot () {
    const node = this.node
    if (!node || typeof node.snapshot !== 'function') return null
    try { return node.snapshot() } catch (_) { return null }
  }

  /** The snapshot handed to the site: the ledger snapshot plus peers, inSync and role. */
  snapshot () {
    const node = this.node
    const snap = this.rawSnapshot()
    if (!snap) return null
    const out = Object.assign({}, snap)
    out.peers = typeof node.peers === 'number' ? node.peers : this.peers()
    out.inSync = typeof node.inSyncPeers === 'number' ? node.inSyncPeers : 0
    if (typeof node.role === 'string') out.role = node.role
    if (typeof out.height !== 'number') out.height = typeof node.height === 'number' ? node.height : 0
    return out
  }

  waitForNode () {
    if (this.node || this.nodeSettled) return Promise.resolve(this.node)
    return new Promise((resolve) => {
      const timer = this._setTimeout(() => resolve(this.node), this.limits.readyWaitMs)
      this._nodeWaiters.push(() => { this._clearTimeout(timer); resolve(this.node) })
    })
  }

  _resolveNodeWaiters () {
    const waiters = this._nodeWaiters
    this._nodeWaiters = []
    for (const fn of waiters) { try { fn() } catch (_) { /* ignore */ } }
  }

  _requireNode () {
    if (!this.node) throw apiError('E_IDENTITY', 'the site ledger is not available in this browser')
    return this.node
  }

  /** The identity mw.ready() reports: { pub, short, name, mode } when signed in, else null (R 2.11.2). */
  identityInfo () {
    return this.identity.info()
  }

  // ----- the loader's own entry points (never site-callable) ------------------------------------

  /**
   * openSignInCard() -> Promise<boolean>: the in-page Sign in prompt (ui.prompt('signin')). Its button calls the
   * loader's actions.signIn, which ends in signInFromCard() inside the person's click.
   */
  async openSignInCard (options = {}) {
    const ui = this.ui
    if (!ui || typeof ui.prompt !== 'function') return false
    let res
    try { res = await ui.prompt('signin', { method: 'signIn', options }) } catch (_) { return false }
    if (res && typeof res === 'object' && res.fallback === 'redirect') {
      // The sign-in window could not open even inside the click (E_POPUP_BLOCKED), or it lost its link to this page and
      // never answered (E_IDP_UNREACHABLE: in-app browsers, iOS Home Screen apps; R 2.3.1, G-ID-7): the redirect round
      // trip, from the loader's own "Continue in this tab" card (code review v0.3, browser).
      try { res = await ui.prompt('continue-here', { options }) } catch (_) { res = false }
    }
    await this.identity.refresh().catch(() => {})
    return !!res && this.identity.state() === 'signed-in'
  }

  /**
   * signInFromCard(options) -> the identity service's auth.signIn result. Called from the loader's own card
   * button (createUI / createPanel actions.signIn), i.e. inside the person's trusted click: activation true.
   */
  async signInFromCard (options = {}) {
    const svc = this.services.identity
    if (!svc || !svc.methods || typeof svc.methods['auth.signIn'] !== 'function') throw Object.assign(new Error('sign-in is not available in this loader'), { code: 'E_UNSUPPORTED' })
    try {
      return await svc.methods['auth.signIn'](stripActivationFlags(options) || {}, { activation: true, tab: this.tab() })
    } finally {
      await this.identity.refresh().catch(() => {})
    }
  }

  async openIdentityFromCard (options = {}) {
    const svc = this.services.identity
    if (!svc || !svc.methods || typeof svc.methods['identity.openIdentity'] !== 'function') throw Object.assign(new Error('the identity page is not available in this loader'), { code: 'E_UNSUPPORTED' })
    const intent = options && typeof options.intent === 'string' ? options.intent : undefined
    return svc.methods['identity.openIdentity'](intent ? { intent } : {}, { activation: true, tab: this.tab() })
  }

  /**
   * offerKit(data): the loader's "Save your recovery kit" card (R 2.2.6, code review v0.3 conformance), at most once per
   * page; its button opens the identity page at its recovery kit inside the person's click (ui actions.openIdentity).
   */
  offerKit () {
    if (this._kitOffered || !this.ui || typeof this.ui.prompt !== 'function' || this.tab() === 'follower') return false
    this._kitOffered = true
    try { Promise.resolve(this.ui.prompt('kit', {})).catch(() => {}) } catch (_) { /* no card here */ }
    return true
  }

  /** _noteMeaningful(method): after the first meaningful action of R 2.2.6 succeeds, the identity service may ask for the kit. */
  _noteMeaningful (method) {
    if (!MEANINGFUL_SET.has(method)) return
    const svc = this.services.identity
    if (!svc || typeof svc.noteMeaningful !== 'function') return
    try { svc.noteMeaningful(method) } catch (_) { /* the kit waits */ }
  }

  // ----- requests -------------------------------------------------------------------------------

  /**
   * request(method, params, opts) -> { ok: true, result } | { ok: false, error, reason }
   * reason: 'invalid' (params), 'rate' (write limit), 'gesture', 'host-only', 'failed' (the call threw). Never throws.
   * opts (writes only, code review round 1): { signal, onProgress } as ChainNode's writes take them:
   * onProgress({ hashes, bits }) while the fee is computed; an aborted signal fails the write with
   * E_POW_ABORTED and nothing is published.
   */
  async request (method, params, opts) {
    this.stats.requests++
    if (typeof method !== 'string' || !METHOD_SET.has(method)) {
      this.stats.rejected++
      return { ok: false, error: apiError('E_BAD_REQUEST', 'unknown method'), reason: 'invalid' }
    }
    // C2 wire-ui (SZ 3.5 "Scope"): drop-in mode has no calls in C2, because the host's next page load would end the call.
    if (CALL_SET.has(method) && this.dropin()) {
      this.stats.rejected++
      return { ok: false, error: apiError('E_UNSUPPORTED', 'calls need the full loader on this site: in drop-in mode a page load would end the call'), reason: 'failed' }
    }
    const raw = params === undefined || params === null ? {} : params
    const shape = validateParamsObject(method, raw, this.limits.maxRequestBytes)
    if (shape) {
      this.stats.rejected++
      return { ok: false, error: shape, reason: 'invalid' }
    }
    const clean = stripActivationFlags(raw)
    const p = validateParams(method, clean, Object.assign({}, this.limits, { maxValueBytes: this.maxValueBytes() }))
    if (!p.ok) {
      this.stats.rejected++
      return { ok: false, error: p.error, reason: 'invalid' }
    }
    if (HOST_ONLY_SET.has(method) && this.hostOnly()) {
      this.stats.hostOnlyRefused++
      return { ok: false, error: apiError('E_HOST_ONLY', 'this needs peer connections, and this browser runs the site host-only'), reason: 'host-only' }
    }
    const activation = this.activation()
    // MF-27: removing another author's entry is a moderator action: a click here, then the loader's card.
    const othersEntry = method === 'db.tombstone' && (!p.ledger || this._ownLedger(p.ledger)) && this._othersEntry(p.args[0])
    if ((needsActivation(method, clean, { unlocked: this._unlocked }) || othersEntry) && !activation) {
      this.stats.gestureRefused++
      return { ok: false, error: apiError('E_NEEDS_GESTURE', 'call ' + method + ' from a click'), reason: 'gesture' }
    }
    if (LEDGER_WRITE_SET.has(method) && method !== 'owner.policy' && this.readOnly()) {
      this.stats.rejected++
      return { ok: false, error: apiError('E_POLICY', 'this ledger has no owner on this hub, so it is read only here'), reason: 'failed' }
    }
    if (LEDGER_WRITE_SET.has(method) && !this.writes.take()) {
      this.stats.rateLimited++
      return { ok: false, error: apiError('E_RATE', 'too many writes, try again in a minute'), reason: 'rate' }
    }
    const ctx = { activation, tab: this.tab(), signal: opts && opts.signal ? opts.signal : undefined }
    try {
      let result = await this.dispatch(method, p, WRITE_SET.has(method) || UI_SET.has(method) ? opts : undefined, ctx)
      if (CONDITIONAL_UI[method] === 'session' && activation) this._unlocked.add(method)
      // Stored messages may hold grants with file keys: the site sees their type only (R 2.9.6).
      if (method === 'chat.dm.history' && Array.isArray(result)) result = result.map(redactGrant)
      // C2 wire-ui: a call result is plain data; the SDK never returns a MediaStream (SZ 3.5 "SDK", R 2.1 rule 2).
      if (CALL_SET.has(method)) result = plainOnly(result)
      this._noteMeaningful(method)
      return { ok: true, result }
    } catch (err) {
      this.stats.rejected++
      return { ok: false, error: mapError(err), reason: 'failed' }
    }
  }

  /** callService(name, method, params, ctx): the service's method, or E_UNSUPPORTED when it is not mounted here. */
  async callService (name, method, params, ctx) {
    const svc = this.services[name]
    const fn = svc && svc.methods ? svc.methods[method] : null
    if (typeof fn !== 'function') {
      if (ctx && ctx.tab === 'follower') throw apiError('E_POLICY', 'this tab does not run the site: use the first tab you opened it in')
      throw apiError('E_UNSUPPORTED', method + ' is not available on this page')
    }
    const res = await fn(params, ctx)
    if (name === 'identity' && /^(auth|identity|me)\./.test(method)) await this.identity.refresh().catch(() => {})
    return res
  }

  /** The implicit sign-in of R 2.4.1: a guest's first write opens the sign-in prompt; nothing is written without it. */
  async ensureSignedIn (ctx) {
    if (this.identity.mode() !== 'v03' || this.identity.state() === 'signed-in') return
    if (ctx && ctx.tab === 'follower') throw apiError('E_NOT_SIGNED_IN', 'sign in in the first tab you opened this site in')
    const ok = await this.signInRequests.request()
    if (!ok || this.identity.state() !== 'signed-in') throw apiError('E_NOT_SIGNED_IN', 'sign in to write to this site')
  }

  /** _othersEntry(h) -> true unless the entry h is known to be by this browser's own key (MF-27 card for others). */
  _othersEntry (h) {
    const node = this.node
    if (!node || typeof h !== 'string') return false
    const author = authorOfEntry(node, h)
    if (!author) return false
    let mine = null
    try { mine = (this.identity.info() || {}).pub || (node.identity && node.identity.pub) || null } catch (_) { mine = null }
    return author !== mine
  }

  _ownLedger (ledger) {
    if (!ledger) return true
    const own = this.infoNow().siteId || (this.node && this.node.siteId) || null
    return ledger === own
  }

  async _followedRead (ledger, method, args) {
    const hub = this.services.hub
    if (!hub || typeof hub.read !== 'function') throw apiError('E_POLICY', 'follow this ledger first (mw.hub.follow)')
    return hub.read(ledger, method, args)
  }

  /** _netCall(name, params, ctx) (C2 wire-ui): the loader's seeding control, or E_UNSUPPORTED on a page without one. */
  async _netCall (name, params, ctx) {
    const net = this.net
    const fn = net && typeof net[name] === 'function' ? net[name] : null
    if (!fn) throw apiError('E_UNSUPPORTED', 'net.' + name + ' is not available on this page')
    return fn.call(net, params || {}, ctx || { activation: false, tab: 'leader' })
  }

  async dispatch (method, p, opts, ctx = { activation: false, tab: 'leader' }) {
    const args = p.args || []
    const params = p.params || {}
    const info = this.infoNow()
    // A read of a followed ledger (the hub amendment): answered by the hub service, read only.
    if (p.ledger && !this._ownLedger(p.ledger)) {
      if (WRITE_SET.has(method)) throw apiError('E_POLICY', 'writes go to your own ledger only')
      return this._followedRead(p.ledger, method, args)
    }
    switch (method) {
      case 'ready': {
        const node = await this.waitForNode()
        // Read the site info after the wait: in drop-in mode the page may still be resolving its pointer
        // when ready() is called, and the ledger opening is what completes it.
        const now = this.infoNow()
        const id = this.identityInfo()
        return {
          siteId: now.siteId || null,
          btih: now.btih || null,
          mode: now.mode || 'shell',
          auth: this.identity.state(),
          identity: id ? { pub: id.pub, short: id.short, name: id.name, mode: id.mode } : null,
          role: node && typeof node.role === 'string' ? node.role : 'reader',
          peers: this.peers(),
          height: node && typeof node.height === 'number' ? node.height : 0,
          owner: now.owner || null,
          unmoderated: !!now.unmoderated,
          features: featuresOf(this.cfg())
        }
      }
      case 'db.get': {
        const [key] = args
        const node = this.node
        if (node && node.state && node.state.kv instanceof Map) {
          const entry = node.state.kv.get(key)
          return entry === undefined ? undefined : kvEntryValue(entry)
        }
        const snap = this.rawSnapshot()
        const kv = snap ? plainOf(snap.kv) : {}
        return Object.prototype.hasOwnProperty.call(kv, key) ? kvEntryValue(kv[key]) : undefined
      }
      case 'db.list': {
        const [name, o] = args
        return listOfNode(this.node, name, o, () => this.rawSnapshot())
      }
      case 'db.snapshot': return this.snapshot()
      case 'db.set':
        await this.ensureSignedIn(ctx)
        return { h: blockHash(await this._requireNode().put(args[0], args[1], opts)) }
      case 'db.del':
        await this.ensureSignedIn(ctx)
        return { h: blockHash(await this._requireNode().del(args[0], opts)) }
      case 'db.append':
        await this.ensureSignedIn(ctx)
        return { h: blockHash(await this._requireNode().append(args[0], args[1], opts)) }
      case 'db.tombstone': {
        await this.ensureSignedIn(ctx)
        const node = this._requireNode()
        if (this._othersEntry(args[0])) {
          const author = authorOfEntry(node, args[0])
          let ok = false
          try { ok = await this.prompt('mod.tombstone', { h: args[0], author, short: author ? shortKey(author) : null }) } catch (_) { ok = false }
          if (ok !== true) throw apiError('E_USER_CANCELLED', 'cancelled')
        }
        return { h: blockHash(await node.tombstone(args[0], opts)) }
      }
      case 'identity.setName': {
        await this.ensureSignedIn(ctx)
        const svc = this.services.identity
        if (svc && svc.methods && typeof svc.methods['identity.setName'] === 'function') return this.callService('identity', method, params, Object.assign({}, ctx, { opts }))
        return { h: blockHash(await this._requireNode().profile(args[0], opts)) }
      }
      case 'net.peers': return this.peers()
      // C2 wire-ui (SZ 3.1.3, 3.1.4): the seeding counters and the two controls, answered by the loader's net control.
      case 'net.seeding': return this._netCall('seeding', params, ctx)
      case 'net.dock': return this._netCall('dock', params, ctx)
      case 'net.keep': return this._netCall('keep', params, ctx)
      case 'site.info': {
        const files = Array.isArray(info.files) ? info.files.map((f) => ({ path: f.path, length: f.length })) : []
        const source = info.source || (this.tm ? this.tm.source : null) || null
        return { name: info.name || null, files, btih: info.btih || null, source, mode: info.mode || 'shell' }
      }
      case 'consent.state': return this.consent && typeof this.consent.state === 'function' ? this.consent.state() : 'pending'
      case 'consent.request': return await this.consentRequests.request()
      case 'auth.state':
        if (!this.services.identity) return this.identity.state()
        return this.callService('identity', method, params, ctx)
      case 'identity.current':
        if (!this.services.identity) return this.identityInfo()
        return this.callService('identity', method, params, ctx)
      case 'owner.policy': {
        const mod = this.services.mod
        if (mod && mod.methods && typeof mod.methods['owner.policy'] === 'function') return mod.methods['owner.policy'](params, Object.assign({}, ctx, { opts }))
        throw apiError('E_NOT_OWNER', 'the owner key never enters a browser; use tools/ledger-admin.mjs')
      }
      default: {
        const name = serviceOf(method)
        if (name === 'core') throw apiError('E_BAD_REQUEST', 'unknown method')
        if (name === 'identity' && method === 'auth.signIn' && this.services.identity) return this._signIn(params, ctx)
        if (name === 'mod' && MOD_METHODS.indexOf(method) >= 0) return this.callService('mod', method, params, Object.assign({}, ctx, { opts }))
        return this.callService(name, method, params, ctx)
      }
    }
  }

  /**
   * auth.signIn from the site: the identity service opens the IdO popup inside the site's click. When the
   * browser blocked the popup (the activation did not survive the hop to the loader), the loader's own Sign in
   * card takes over: its button opens the popup inside the person's click there (R 2.11.1).
   */
  async _signIn (params, ctx) {
    try {
      return await this.callService('identity', 'auth.signIn', params, ctx)
    } catch (err) {
      if (!(err && err.code === 'E_POPUP_BLOCKED') || !this.ui || typeof this.ui.prompt !== 'function') throw err
      const ok = await this.openSignInCard(params)
      if (!ok) throw Object.assign(new Error('sign-in was cancelled'), { code: 'E_USER_CANCELLED' })
      const id = this.identityInfo()
      return { state: 'signed-in', identity: id, role: this.role() }
    }
  }
}

/** authorOfEntry(node, h) -> the author key of entry h as this browser holds it, or null (unknown to it). */
export function authorOfEntry (node, h) {
  try {
    const b = node && node.dag && typeof node.dag.get === 'function' ? node.dag.get(h) : null
    if (b && b.e && typeof b.e.author === 'string') return b.e.author
  } catch (_) { /* a follower node has no DAG */ }
  try {
    const st = node && node.state
    if (st && st.lists instanceof Map) for (const items of st.lists.values()) for (const it of items || []) if (it && it.h === h) return it.author || null
    if (st && st.kv instanceof Map) for (const e of st.kv.values()) if (e && e.h === h) return e.author || null
  } catch (_) { /* no state */ }
  // A follower tab's node is the engine tab's snapshot: list items carry h and author there too.
  try {
    const snap = node && typeof node.snapshot === 'function' ? node.snapshot() : null
    const lists = snap ? plainOf(snap.lists) : {}
    for (const name of Object.keys(lists)) for (const it of lists[name] || []) if (it && it.h === h) return it.author || null
  } catch (_) { /* no snapshot */ }
  return null
}

/** listOfNode(node, name, { limit, newestFirst }, snapshotFn) -> items (shared by the API and the hub service). */
export function listOfNode (node, name, o = { limit: 100, newestFirst: true }, snapshotFn = null) {
  let items = null
  if (node && node.state && node.state.lists instanceof Map) items = node.state.lists.get(name)
  if (!items) {
    let snap = null
    try { snap = snapshotFn ? snapshotFn() : (node && typeof node.snapshot === 'function' ? node.snapshot() : null) } catch (_) { snap = null }
    const lists = snap ? plainOf(snap.lists) : {}
    items = lists[name]
  }
  const list = Array.isArray(items) ? items.slice() : []
  if (o.newestFirst) list.reverse()
  return list.slice(0, o.limit)
}

// ---------------------------------------------------------------------------------------------
// v0.3 wiring, shared by the shell (src/loader/app.js) and drop-in mode (src/dropin/engine.js): the deps the
// services of lanes idp, chat and media get (the SVC contract), built once per page in the tab that runs the site.
// ---------------------------------------------------------------------------------------------

/**
 * liveObject(get) -> an object whose properties are read from get() at each access (methods bound to it): what a
 * service gets as `node` or `keys` when the ledger opens, or the person signs in, after the service was made.
 * get() returning null makes every property undefined (a guest has no keys; a page before its ledger has no node).
 */
export function liveObject (get) {
  return new Proxy({}, {
    get (_, k) {
      let o = null
      try { o = get() } catch (_) { o = null }
      if (!o) return undefined
      const v = o[k]
      return typeof v === 'function' ? v.bind(o) : v
    },
    has (_, k) {
      let o = null
      try { o = get() } catch (_) { o = null }
      return !!o && k in o
    }
  })
}

/**
 * createTorrentSeam({ get, ensure, beforeSwarm }) -> the TorrentManager seams the services use (lane harden-loader):
 * registerWireExtension (chat), joinLane (chat), addFileTorrent and budget (files, media). get() is the current
 * manager or null; ensure() makes one (it respects the sharing choice: no socket before consent); beforeSwarm(), when
 * given, settles before a lane or a file swarm starts (the drop-in reads the site's STUN list then). Extensions
 * registered before a manager exists, or on a manager that was rebuilt (back/forward cache, a phone's hidden
 * page), are registered again on the next one: attach(tm) does that.
 */
export function createTorrentSeam ({ get, ensure, beforeSwarm = null }) {
  const regs = new Set()
  const apply = (reg, tm) => {
    if (!tm || reg.tm === tm || typeof tm.registerWireExtension !== 'function') return
    if (reg.off) { try { reg.off() } catch (_) { /* the old manager is gone */ } }
    reg.off = tm.registerWireExtension(reg.name, reg.handler, reg.opts)
    reg.tm = tm
  }
  const current = () => { try { return get() || null } catch (_) { return null } }
  const need = async () => current() || (typeof ensure === 'function' ? await ensure() : null)
  // beforeSwarm(): settled before a lane or a file swarm starts (the drop-in reads the site's STUN list then, MF-44).
  const ready = async () => { if (typeof beforeSwarm === 'function') { try { await beforeSwarm() } catch (_) { /* the swarm still starts */ } } }
  return {
    attach (tm) {
      for (const reg of Array.from(regs)) { try { apply(reg, tm) } catch (_) { /* taken on this manager */ } }
    },
    registerWireExtension (name, handler, opts) {
      const reg = { name, handler, opts, off: null, tm: null }
      const tm = current()
      if (tm) apply(reg, tm)
      regs.add(reg)
      if (!tm && typeof ensure === 'function') Promise.resolve().then(ensure).then((t) => { if (regs.has(reg)) apply(reg, t) }).catch(() => {})
      return () => {
        regs.delete(reg)
        if (reg.off) { try { reg.off() } catch (_) { /* gone */ } }
      }
    },
    async joinLane (o) {
      const tm = await need()
      if (!tm || typeof tm.joinLane !== 'function') throw apiError('E_UNSUPPORTED', 'this loader cannot join a lane')
      await ready()
      return tm.joinLane(o)
    },
    async addFileTorrent (o) {
      const tm = await need()
      if (!tm || typeof tm.addFileTorrent !== 'function') throw apiError('E_FILE_UNAVAILABLE', 'this loader cannot fetch files')
      await ready()
      return tm.addFileTorrent(o)
    },
    get budget () { const tm = current(); return tm ? tm.budget : null },
    get peers () { const tm = current(); return tm ? tm.peers : 0 },
    get registered () { return regs.size }
  }
}

/** ownTrackerOf(record, defaults) -> the site's own tracker (the first tr= entry that is not a public default), or null. */
export function ownTrackerOf (record, defaults = []) {
  const list = record && Array.isArray(record.tr) ? record.tr : []
  const pub = new Set((Array.isArray(defaults) ? defaults : []).map((u) => String(u).toLowerCase()))
  for (const u of list) {
    if (typeof u !== 'string' || !/^wss?:\/\//i.test(u)) continue
    if (!pub.has(u.toLowerCase())) return u
  }
  return null
}

/** chatDeviceClass(env, nav) -> 'desktop' | 'android' | 'ios' (src/chat/limits.js DEVICE). */
export function chatDeviceClass (env, nav = null) {
  if (!env || !env.isMobile) return 'desktop'
  const ua = nav && typeof nav.userAgent === 'string' ? nav.userAgent : ''
  if (/iPhone|iPad|iPod/.test(ua) || (/Macintosh/.test(ua) && nav && Number(nav.maxTouchPoints) > 1)) return 'ios'
  return 'android'
}

/** randomBytes(n): the CSPRNG (the files and media services take this form; chat takes Math.random). */
export function randomBytes (n) {
  return globalThis.crypto.getRandomValues(new Uint8Array(n))
}

/**
 * denyChecker(getNode) -> async (identifier) -> true when the ledger holds _deny/<b64url sha256(utf8(id))> (R 2.8.7):
 * checked before any fetch or seed of a file or media item.
 */
export function denyChecker (getNode) {
  return async function isDenied (id) {
    if (typeof id !== 'string' || !id) return false
    const node = getNode()
    if (!node) return false
    let kv = null
    try { kv = node.state && node.state.kv instanceof Map ? node.state.kv : null } catch (_) { kv = null }
    if (!kv) return false
    const digest = await globalThis.crypto.subtle.digest('SHA-256', new TextEncoder().encode(id))
    const bytes = new Uint8Array(digest)
    let s = ''
    for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i])
    const key = '_deny/' + btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
    const e = kv.get(key)
    return !!(e && kvEntryValue(e) !== null && kvEntryValue(e) !== undefined)
  }
}

/**
 * plainOnly(value) -> a copy that holds plain JSON only (C2 wire-ui): null, booleans, finite numbers (others become
 * null), strings, arrays and plain objects, at most 32 levels deep. A function, a MediaStream, a MediaStreamTrack or any
 * other object with a prototype of its own is left out, so a call result or event can never hand the site a stream
 * (SZ 3.5 "SDK": "no method returns a MediaStream").
 */
export function plainOnly (value, depth = 0) {
  if (depth > 32) return undefined
  if (value === null) return null
  const t = typeof value
  if (t === 'string' || t === 'boolean') return value
  if (t === 'number') return Number.isFinite(value) ? value : null
  if (t !== 'object') return undefined
  if (Array.isArray(value)) {
    const out = []
    for (const v of value) {
      const c = plainOnly(v, depth + 1)
      if (c !== undefined) out.push(c)
    }
    return out
  }
  const proto = Object.getPrototypeOf(value)
  if (proto !== Object.prototype && proto !== null) return undefined
  const out = {}
  for (const k of Object.keys(value)) {
    const c = plainOnly(value[k], depth + 1)
    if (c !== undefined) out[k] = c
  }
  return out
}

/** redactGrant(message) -> the message a site may see: a grant shows only its type (never a file key, R 2.9.6). */
export function redactGrant (m) {
  if (!m || typeof m !== 'object' || !m.grant || typeof m.grant !== 'object') return m
  return Object.assign({}, m, { grant: { t: typeof m.grant.t === 'string' ? m.grant.t : 'unknown' } })
}

/**
 * createSealedStore({ prefs, key, prefix }) -> { get(k), set(k, v), del(k) }: the chat service's store (contacts,
 * counters, group secrets, the replay filter), sealed with AES-GCM under K_local from the key bundle before it
 * reaches IndexedDB. key() -> CryptoKey | 32 bytes | null; without a key nothing is written (memory only).
 */
export function createSealedStore ({ prefs, key, prefix = 'sealed:' }) {
  const memory = new Map()
  const aes = async () => {
    const k = typeof key === 'function' ? key() : key
    if (!k) return null
    if (typeof k === 'object' && k.algorithm && typeof k.type === 'string') return k
    const raw = typeof k === 'string' ? Uint8Array.from(atob(k.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((k.length + 3) % 4)), (c) => c.charCodeAt(0)) : k
    if (!(raw instanceof Uint8Array) || raw.length !== 32) return null
    return globalThis.crypto.subtle.importKey('raw', raw, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt'])
  }
  const aad = (k) => new TextEncoder().encode('mw-local-v1\n' + prefix + k)
  return {
    async get (k) {
      if (memory.has(k)) return memory.get(k)
      const ck = await aes()
      if (!ck || !prefs || typeof prefs.get !== 'function') return undefined
      const rec = await prefs.get(prefix + k, null)
      if (!rec || !rec.iv || !rec.ct) return undefined
      try {
        const plain = await globalThis.crypto.subtle.decrypt({ name: 'AES-GCM', iv: new Uint8Array(rec.iv), additionalData: aad(k) }, ck, new Uint8Array(rec.ct))
        const v = JSON.parse(new TextDecoder().decode(plain))
        memory.set(k, v)
        return v
      } catch (_) { return undefined }
    },
    async set (k, v) {
      memory.set(k, v)
      const ck = await aes()
      if (!ck || !prefs || typeof prefs.set !== 'function') return false
      const iv = globalThis.crypto.getRandomValues(new Uint8Array(12))
      const ct = new Uint8Array(await globalThis.crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: aad(k) }, ck, new TextEncoder().encode(JSON.stringify(v))))
      await prefs.set(prefix + k, { v: 1, iv: Array.from(iv), ct: Array.from(ct) })
      return true
    },
    async del (k) {
      memory.delete(k)
      if (prefs && typeof prefs.set === 'function') { try { await prefs.set(prefix + k, null) } catch (_) { /* gone */ } }
    },
    clear () { memory.clear() }
  }
}

/**
 * chatStore(getKeys, prefs) -> { get, set }: the chat service's store, sealed under K_local. WorkingKeys has its own
 * sealed cache (saveLocal / loadLocal, src/identity/store.js) and is used when present; otherwise createSealedStore.
 */
export function chatStore (getKeys, prefs) {
  const fallback = prefs ? createSealedStore({ prefs, key: () => { const k = getKeys(); try { return k ? k.local || null : null } catch (_) { return null } }, prefix: 'chat:' }) : null
  const memory = new Map()
  return {
    async get (k) {
      const keys = getKeys()
      if (keys && typeof keys.loadLocal === 'function') {
        try { const v = await keys.loadLocal('chat:' + k); return v === null ? undefined : v } catch (_) { return memory.get(k) }
      }
      return fallback ? fallback.get(k) : memory.get(k)
    },
    async set (k, v) {
      memory.set(k, v)
      const keys = getKeys()
      if (keys && typeof keys.saveLocal === 'function') {
        try { await keys.saveLocal('chat:' + k, v); return true } catch (_) { return false }
      }
      return fallback ? fallback.set(k, v) : false
    }
  }
}

/**
 * sealedAdapter(sealedModule) -> { seal, open } in the shape the media lane calls (docs/deviations/media.md):
 * seal({ kind, data, key, ledgerId, authorPub }), open(value, { key, ledgerId, authorPub }) over src/identity/
 * sealed.js seal() and open({ value, ... }). No sealTo: durable grants (kind 4 in mw.s) have no reader in this build
 * (no lane scans mw.s by hint for its grants), so the media lane's durable: true sends the grant over chat only
 * (its sealTo check skips the ledger copy) instead of failing after the message went out (v0.3 reconciliation;
 * the 1,040-byte box adapter of integration I-4 is ready when a reader lands).
 */
export function sealedAdapter (mod) {
  if (!mod || typeof mod.seal !== 'function' || typeof mod.open !== 'function') return null
  return {
    seal: (o) => mod.seal(Object.assign({}, o, { data: typeof o.data === 'string' ? new TextEncoder().encode(o.data) : o.data })),
    open: (value, o) => mod.open(Object.assign({}, o, { value }))
  }
}

/** swPortFor(nav) -> the media sessions' worker port: { ready(), post(msg, transfer), onMessage(fn) } (lane media). */
export function swPortFor (nav) {
  const sw = nav && nav.serviceWorker ? nav.serviceWorker : null
  return {
    ready: () => !!(sw && sw.controller),
    post: (msg, transfer) => {
      if (!sw || !sw.controller) throw apiError('E_UNSUPPORTED', 'no Service Worker controls this page')
      sw.controller.postMessage(msg, transfer || [])
    },
    onMessage: (fn) => {
      if (!sw || typeof sw.addEventListener !== 'function') return () => {}
      const h = (e) => { try { fn(e && e.data) } catch (_) { /* a handler's bug */ } }
      sw.addEventListener('message', h)
      return () => sw.removeEventListener('message', h)
    }
  }
}

/**
 * countPostsBy(node, pub) -> how many entries of pub the ledger holds ("Found 14 posts by this identity", R 2.2.6), or null
 * when the answer would mean nothing (review round R 5.3, UX-5): no node, a follower node without state, or a ledger that holds
 * nothing past its genesis yet (not synced), where "No posts found" would wrongly tell a person their words are wrong.
 */
export function countPostsBy (node, pub) {
  let n = 0
  const st = node && node.state
  if (!st || typeof pub !== 'string') return null
  try {
    if (st.lists instanceof Map) for (const items of st.lists.values()) for (const it of items || []) if (it && it.author === pub) n++
    if (st.kv instanceof Map) for (const it of st.kv.values()) if (it && it.author === pub) n++
  } catch (_) { return null }
  if (n === 0 && !(Number(node.height) > 1)) return null // the genesis alone: not synced yet
  return n
}

/**
 * mountV03Services(api, { modules, deps }) -> Promise<{ mounted, errors }>: makes and mounts the services of the
 * page in the tab that runs the site (never in a follower tab: no keys there). modules (missing ones are skipped):
 *   { identity: { createIdentityService }, chat: { createChatService }, files: { createFilesService },
 *     media: { createMediaService }, sealed: src/identity/sealed.js }
 * deps: { ledgerId, pointer, node: () => ChainNode | null, cfg, deviceClass ('desktop'|'phone'), chatDevice,
 *   hostOnly: () => boolean, ownTracker, torrents (createTorrentSeam), swPort, prefs (cache prefs), now, download,
 *   identityExtra (more deps for the identity service), skip: [names] }
 * Chat grants (media, revoke, file, report, join, pin) are routed to the media, files and moderation services;
 * the site sees only their type (redactGrant).
 * C2 wire-ui: modules.calls ({ createCallService }, src/calls/service.js) is mounted as 'calls' right after 'chat', with
 *   the chat service's `sig` seam (send, onReceive, listen, contact, groupMembers, state, ckOf, learn), and never in
 *   drop-in mode (deps.mode 'dropin'). Its deps here: mode ('shell' | 'hub' | 'hub-shared'), policy () -> { class,
 *   metered }, stun () -> the site's own STUN URLs (MF-44), turn () -> _mw.cfg.turn resolved (R 2.7.8 option a) or null,
 *   callPrefs () -> { sameLan, hideIp }, RTCPeerConnection, mediaDevices, wakeLock, mediaSession, callPrompt (the call
 *   panel's cards; default: this page's prompt), onSeedYield (state | null), each optional.
 */
export async function mountV03Services (api, { modules = {}, deps = {} } = {}) {
  const mounted = []
  const errors = {}
  const skip = new Set(deps.skip || [])
  const now = deps.now || (() => Date.now())
  const getNode = typeof deps.node === 'function' ? deps.node : () => api.node
  const node = liveObject(getNode)
  const keysNow = () => api.identity.keys()
  const keys = liveObject(keysNow)
  const cfg = () => api.cfg()
  const hostOnly = typeof deps.hostOnly === 'function' ? deps.hostOnly : () => api.hostOnly()
  const prompt = api.prompt
  const tryMount = (name, make) => {
    if (skip.has(name) || api.service(name)) return null
    try {
      const svc = make()
      if (svc) { api.mount(name, svc); mounted.push(name) }
      return svc
    } catch (err) {
      errors[name] = (err && err.message) || String(err)
      return null
    }
  }
  if (modules.identity && typeof modules.identity.createIdentityService === 'function') {
    tryMount('identity', () => modules.identity.createIdentityService(Object.assign({
      node, ledgerId: deps.ledgerId, pointer: deps.pointer || null, cfg, prompt, now, random: Math.random,
      countPosts: (pub) => countPostsBy(getNode(), pub)
    }, deps.identityExtra || {})))
  }
  let chat = null
  if (modules.chat && typeof modules.chat.createChatService === 'function') {
    chat = tryMount('chat', () => modules.chat.createChatService({
      keys, ledgerId: deps.ledgerId, node, cfg, deviceClass: deps.chatDevice || 'desktop', hostOnly, ownTracker: deps.ownTracker || null,
      wires: deps.torrents || null, store: chatStore(keysNow, deps.prefs),
      // Review round R 5.3 (PRIV-2, STALK-2): the own CK goes to a neighbour only with a reason (src/chat/service.js ckReason).
      prompt, now, shareOnNetwork: deps.shareOnNetwork === true, ckShare: 'reason'
    }))
  }
  // UX-14: chat comes back on after a reload once the working keys exist (the sealed store says the person turned it on).
  if (chat && typeof chat.resume === 'function') {
    const tryResume = () => { if (keysNow()) Promise.resolve().then(() => chat.resume()).catch(() => {}) }
    const ids = api.service('identity')
    if (ids && typeof ids.on === 'function') { try { ids.on('auth', (e) => { if (e && e.state === 'signed-in') tryResume() }) } catch (_) { /* no events */ } }
    tryResume()
  }
  // C2 wire-ui (SZ 3.5): calls after chat, on the chat service's SIG seam. Shell and hub modes only: drop-in mode answers
  // every mw.calls method E_UNSUPPORTED (MwApi.request), because the host's next page load would end the call.
  if (modules.calls && typeof modules.calls.createCallService === 'function' && chat && chat.sig && deps.mode !== 'dropin' && !api.dropin()) {
    const fn = (v, fallback) => (typeof v === 'function' ? v : () => (v === undefined ? fallback : v))
    tryMount('calls', () => modules.calls.createCallService({
      chat: chat.sig, keys: keysNow, cfg, hostOnly,
      policy: fn(deps.policy, { class: 'desktop', metered: false }),
      stun: fn(deps.stun, []),
      turn: fn(deps.turn, null),
      prefs: fn(deps.callPrefs, {}),
      RTCPeerConnection: deps.RTCPeerConnection || null,
      mediaDevices: deps.mediaDevices || null,
      wakeLock: deps.wakeLock || null,
      mediaSession: deps.mediaSession || null,
      prompt: typeof deps.callPrompt === 'function' ? deps.callPrompt : prompt,
      deviceClass: deps.chatDevice || 'desktop',
      mode: deps.mode || 'shell',
      now,
      random: Math.random,
      onSeedYield: typeof deps.onSeedYield === 'function' ? deps.onSeedYield : () => {}
    }))
  }
  // The chat seam the media and files lanes share: grants go out as DMs (never with a click of their own), and a
  // share to a group id reads its members from the chat service (R 2.9.7).
  const chatSeam = chat ? {
    dm: { send: (pub, payload) => chat.methods['chat.dm.send'](Object.assign({ pub }, payload || {}), { activation: false, tab: 'leader' }) },
    groupMembers: typeof chat.groupMembers === 'function' ? (groupId) => chat.groupMembers(groupId) : undefined
  } : null
  const common = {
    keys: keysNow, ledgerId: deps.ledgerId, node, cfg, deviceClass: deps.deviceClass || 'desktop', hostOnly, ownTracker: () => deps.ownTracker || null,
    torrents: deps.torrents || null, chat: chatSeam, sealed: sealedAdapter(modules.sealed), isDenied: denyChecker(getNode), prompt,
    swPort: deps.swPort || null, now, random: randomBytes, download: deps.download,
    // v0.3 C2 (integrator; lane seed-engine's request O2, INTERFACES C2 src/files/*, src/media/*): the site owner's key (SZ-6),
    // the pin evidence of src/loader/pinwire.js (receipts and the heartbeat, E4) and the manager's evidence for items without
    // a handle. pin (the R 2.8.6 request seam) stays unset in C2: no page-to-pin request path is built, so files.pinRequest
    // and media.pinRequest answer E_POLICY and SZ-6 requests nothing (docs/deviations/integration-c2.md).
    owner: deps.owner, pinEvidence: deps.pinEvidence, evidenceInputs: deps.evidenceInputs, pin: deps.pin,
    // Premoderation (R 2.10.2, MF-53; code review v0.3): whether honest copies show an mw.files item (mod.js listingVisible).
    listingVisible: (item) => { let st = null; try { const n = getNode(); st = n ? n.state : null } catch (_) { st = null } return listingVisible(st, item) },
    // The pin key only from an owner-written _mw.cfg (security 13; ownerCfgPin).
    pinKey: () => ownerCfgPin(getNode())
  }
  let files = null
  let media = null
  if (modules.files && typeof modules.files.createFilesService === 'function') {
    // Review round R 5.3 (SCALE-13, MAL53-11): the files budget counts this ledger's bytes (and the site copy's, when the loader
    // passes deps.siteBytes), not the device's whole default line.
    const filesBudget = () => {
      const n = getNode()
      const siteBytes = typeof deps.siteBytes === 'function' ? Number(deps.siteBytes()) || 0 : 0
      return storageLines({ deviceClass: deps.deviceClass === 'desktop' || !deps.deviceClass ? 'desktop' : 'phone', siteBytes, ledgerBytes: (n && Number(n.bytes)) || 0 }).filesMax
    }
    files = tryMount('files', () => modules.files.createFilesService(Object.assign({ filesBudget }, common, { ownTracker: deps.ownTracker || null })))
  }
  if (modules.media && typeof modules.media.createMediaService === 'function') {
    media = tryMount('media', () => modules.media.createMediaService(Object.assign({}, common, { canWrite: () => { const n = getNode(); return !!n && n.role !== 'reader' } })))
  }
  if (chat && typeof chat.on === 'function') {
    chat.on('message', (m) => {
      const g = m && m.grant
      if (!g || typeof g !== 'object' || m.dir === 'out') return
      try {
        if ((g.t === 'media' || g.t === 'revoke') && media && typeof media.onGrant === 'function') media.onGrant(m.from, g)
        else if (g.t === 'file' && files && typeof files.onGrant === 'function') files.onGrant(m.from, g)
        else if (g.t === 'report' || g.t === 'join' || g.t === 'pin') {
          const mod = api.service('mod')
          if (mod && typeof mod.receive === 'function') mod.receive(m.from, g)
        }
      } catch (_) { /* a grant that does not parse is dropped */ }
    })
  }
  return { mounted, errors }
}

// ---------------------------------------------------------------------------------------------
// v0.3 C2 (lane wire-ui): mw.net.seeding(), mw.net.dock({ hours }) and mw.net.keep(on) (SZ 3.1.3, 3.1.4)
// ---------------------------------------------------------------------------------------------

const SEED_LANE_IDS = ['H', 'K', 'E']
const HOUR_MS = 3600000

function finiteOrNull (v) {
  const n = Number(v)
  return Number.isFinite(n) ? n : null
}

function bytesOf (v) {
  const n = Math.floor(Number(v))
  return Number.isFinite(n) && n > 0 ? n : 0
}

/**
 * seedingSnapshot({ budget, seeding, meters, dock, keeper }) -> { lanes: { H, K, E: { rate, used } }, month: { used, cap },
 *   dock: { on, until }, keeper } (pure). budget: a seedBudget() result (src/loader/seed-budget.js) or null; seeding: the
 *   TorrentManager's read-only `seeding` (lane seed-engine) or null; meters: createSeedMeters() or null (used when the
 *   manager has none); dock: dock.state() or null; keeper: boolean.
 * rate is bytes per second (0: the lane is off); used is the bytes this page sent in that lane on wires that count toward
 * the caps (a local wire's bytes do not); month.used is K plus E this UTC month; month.cap is bytes, or null for "no cap"
 * (Infinity becomes null, so the value is the same over the Bridge, in drop-in mode and in JSON). Counters are local:
 * nothing here is sent anywhere (ARCHITECTURE 8).
 */
export function seedingSnapshot ({ budget = null, seeding = null, meters = null, dock = null, keeper = false } = {}) {
  const b = budget && typeof budget === 'object' && budget.lanes ? budget : null
  const s = seeding && typeof seeding === 'object' && seeding.lanes ? seeding : null
  const lanes = {}
  for (const l of SEED_LANE_IDS) {
    const rate = b && b.lanes[l] ? bytesOf(b.lanes[l].rate) : 0
    let used = 0
    if (s && s.lanes[l]) used = bytesOf(s.lanes[l].used)
    else if (meters && typeof meters.sessionUsed === 'function') { try { used = bytesOf(meters.sessionUsed(l)) } catch (_) { used = 0 } }
    lanes[l] = { rate, used }
  }
  let monthUsed = 0
  if (s && s.month) monthUsed = bytesOf(s.month.used)
  else if (meters && typeof meters.monthUsed === 'function') { try { monthUsed = bytesOf(meters.monthUsed()) } catch (_) { monthUsed = 0 } }
  const cap = b && b.month ? b.month.cap : 0
  const d = dock && typeof dock === 'object' ? dock : null
  return {
    lanes,
    month: { used: monthUsed, cap: cap === Infinity || cap === null || cap === undefined ? null : bytesOf(cap) },
    dock: { on: !!(d && d.on), until: d && d.on ? finiteOrNull(d.until) : null },
    keeper: keeper === true
  }
}

/**
 * ipSentence(lang) -> the sentence that names what others see when this device shares ("Others can see your IP address
 * and which files you share."): the last sentence of SEED_TEXT 'seed.ask', for the keeper card until lane docs-strings
 * gives it a key of its own (request in docs/deviations/wire-ui.md).
 */
export function ipSentence (lang = 'en') {
  const text = seedText('seed.ask', lang, { cap: '' })
  const m = /[.?!]\s+([^.?!]+[.?!])\s*$/.exec(text)
  return m ? m[1] : ''
}

/**
 * createNetControl(deps) -> { seeding(), dock(params, ctx), keep(params, ctx) }: what MwApi.setNet() takes (C2 wire-ui).
 * deps (functions read the live state):
 *   budget() -> the current seedBudget() result; seeding() -> TorrentManager.seeding or null; meters() -> the seed
 *   meters or null; dock: the dock controller (src/loader/dock.js) or null; keeper() -> boolean; setKeeper(on) ->
 *   Promise; canKeep() -> null | a code ('E_POLICY' when sharing is off); isMobile() -> boolean; follower() -> boolean;
 *   declareNeeded() -> true when this browser cannot read the battery (iOS, Firefox: the person declares "plugged in,
 *   on Wi-Fi"); prompt(kind, data) -> the loader card; lang; now; dockDefaultMs (2 hours); dockCapMs (8 hours).
 * dock: phones only (a computer keeps a site with keep()); { hours } from 0 (stop) to 8, default 2; opens the 'dock' card,
 *   whose button starts dock mode inside the person's click; resolves { on, until, reason, declared } (a refused start
 *   is on: false with dock.js's reason, not an error). keep: computers only; keep(true) opens the keeper card, keep(false)
 *   needs no card; resolves { on }. A follower tab answers E_POLICY, as the services do.
 */
export function createNetControl (deps = {}) {
  const d = deps || {}
  const call = (fn, fallback) => { try { return typeof fn === 'function' ? fn() : fallback } catch (_) { return fallback } }
  const now = typeof d.now === 'function' ? d.now : () => Date.now()
  const lang = typeof d.lang === 'string' ? d.lang : 'en'
  const defaultMs = Number(d.dockDefaultMs) > 0 ? Number(d.dockDefaultMs) : 2 * HOUR_MS
  const capMs = Number(d.dockCapMs) > 0 ? Number(d.dockCapMs) : 8 * HOUR_MS
  const dockCtl = d.dock || null
  const fail = (code, message) => apiError(code, message)
  const notFollower = () => { if (call(d.follower, false) === true) throw fail('E_POLICY', 'this tab does not run the site: use the first tab you opened it in') }
  const prompt = async (kind, data) => {
    if (typeof d.prompt !== 'function') return false
    try { return await d.prompt(kind, data) } catch (_) { return false }
  }
  const dockState = () => (dockCtl && typeof dockCtl.state === 'function' ? dockCtl.state() : { on: false, until: null, reason: null, declared: false })
  const stateOut = (st) => ({ on: !!(st && st.on), until: st && st.on ? finiteOrNull(st.until) : null, reason: st && st.reason ? String(st.reason) : null, declared: !!(st && st.declared) })

  return {
    seeding () {
      notFollower()
      return seedingSnapshot({ budget: call(d.budget, null), seeding: call(d.seeding, null), meters: call(d.meters, null), dock: dockState(), keeper: call(d.keeper, false) === true })
    },
    async dock (params = {}) {
      notFollower()
      if (call(d.isMobile, false) !== true) throw fail('E_UNSUPPORTED', 'keeping the screen on is for phones; on a computer use mw.net.keep(true)')
      const p = params || {}
      let ms = defaultMs
      if (p.hours !== undefined) {
        const h = Number(p.hours)
        if (typeof p.hours !== 'number' || !Number.isFinite(h) || h < 0 || h * HOUR_MS > capMs) throw fail('E_LIMIT', 'hours must be a number from 0 to ' + (capMs / HOUR_MS))
        if (h === 0) return stateOut(dockCtl && typeof dockCtl.stop === 'function' ? dockCtl.stop('user') : dockState())
        ms = Math.max(60000, Math.round(h * HOUR_MS))
      }
      if (!dockCtl || typeof dockCtl.supported !== 'function' || !dockCtl.supported()) throw fail('E_UNSUPPORTED', 'this browser cannot keep the screen on')
      const answer = await prompt('dock', {
        ms,
        until: now() + ms,
        declare: call(d.declareNeeded, false) === true,
        // Called by the card's button inside the person's click: the Wake Lock request goes out before any await.
        start: (declared) => dockCtl.start({ ms, declared: declared === true })
      })
      if (!answer || typeof answer !== 'object') throw fail('E_USER_CANCELLED', 'the person did not start it')
      return stateOut(answer)
    },
    async keep (params = {}) {
      notFollower()
      if (call(d.isMobile, false) === true) throw fail('E_UNSUPPORTED', 'Keep this site is for computers; on a phone use mw.net.dock()')
      const p = params || {}
      if (typeof p.on !== 'boolean') throw fail('E_LIMIT', 'on must be true or false')
      if (p.on && call(d.keeper, false) !== true) {
        const why = call(d.canKeep, null)
        if (why) throw fail(why, 'sharing is off in this browser: turn on "Share with other visitors" first')
        const ok = await prompt('confirm', { title: seedText('keeper.toggle', lang), text: (seedText('keeper.on', lang) + ' ' + ipSentence(lang)).trim(), confirmLabel: seedText('keeper.toggle', lang) })
        if (ok !== true) throw fail('E_USER_CANCELLED', 'the person did not turn it on')
      }
      if (typeof d.setKeeper === 'function') await d.setKeeper(p.on)
      return { on: call(d.keeper, false) === true }
    }
  }
}

/**
 * setNodeIdentity(node, identity) -> boolean: the identity a ChainNode signs with, changed after it opened (sign in,
 * sign out), without reopening the ledger (its wire extension stays on every torrent): ChainNode.setIdentity (lane
 * chain-net, wired by the v0.3 reconciliation), which also recomputes the own-chain hints for the new key. false
 * for anything that is not an open ChainNode (a follower tab's RemoteNode never signs).
 */
export function setNodeIdentity (node, identity) {
  if (!node || typeof node !== 'object' || typeof node.setIdentity !== 'function') return false
  const id = identity && typeof identity.pub === 'string' ? identity : null
  node.setIdentity(id)
  return true
}
