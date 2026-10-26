// src/loader/mod.js: the moderation, report and author-scoped key methods of the SDK (R 2.11.2, 2.10.1, 2.10.2,
// 2.17; MF-27), mounted by src/loader/api.js in the shell and in drop-in mode.
//
//   createModService({ api, now, random }) -> { methods, on(event, fn), receive(fromPub, grant), destroy() }
//
//   mod.ban(pub, { until? }) / mod.unban(pub) / mod.tombstoneMany(authors, { before })   UI: the moderator card
//   mod.queue() -> [{ id, kind: 'pin'|'report'|'join'|'listing', ... }]                 read, moderators
//   mod.decide(id, 'accept'|'decline'|'deny', { reason })                               UI
//   report.send({ target: { h } | { envelope } | { media } | { key }, reason, note? }) -> { sent }   UI, metadata only
//   db.setMine(name, value) -> { h }          write: the '@<16 chars of b64url(sha256(pub))>/' + name key
//   db.getMine(name, { ledger? }) -> value     read
//   db.listBy(name, author, { ledger? }) -> [{ key, v, h, ts }]   read: the author's '@' keys that start with name
//   owner.policy(fields)                      UI: personal sites only, the person is the owner (R 3.3)
//
// Moderation (MF-27): every action needs a click in the site frame AND the loader's moderator card, whose button
// takes the person's own (isTrusted) input; the moderator key stays non-extractable (src/loader/app.js). Role
// checks come first (E_NOT_MODERATOR), so a site learns nothing by calling these for a visitor who is not one.
// Ledger caps (modActionsPerHour, modAllowPerDay) are state rules of the freeze group. A join accept checks the
// moderator's room for the day and the 1,000-key allow cap first (allowRoomOf, SCALE-14) and refuses with E_LIMIT, so an
// approval the ledger would drop is never reported as a join.
//
// Reports (R 2.17.3): sealed to the moderators' chat keys and signed with "mw-report-v1\n"; they carry what this
// device saw (the reported key, item hash or envelope id, a digest and size of the value, the time) and the note,
// never a file, a file key or a file name. Delivery uses the chat service (mw.chat must be on); a moderator
// without a chat key on this site is skipped. A report of private media also names its infohash (from this device's
// own copy of the item), which is what every loader checks before it fetches or seeds (code review v0.3).
//
// Takedown (R 2.8.7, MF-52; code review v0.3 conformance): mod.decide 'deny' writes _deny/<b64url sha256(utf8(id))> for
// each identifier the files and media lanes check before a fetch or a seed (the listing's infohash and content sha256,
// a report's infohash), and tombstones the public listing in the same step. Before, the key was the hash of the
// listing's block hash or of the media id, which no lane ever checks: the item stayed visible and kept seeding.
//
// Premoderation (R 2.10.2, 2.17.1, MF-53): a public listing by a key that has no accepted listing yet (and is not the
// owner, a moderator or on the allow list) waits in the moderators' queue (kind 'listing'); 'accept' writes
// _listed/<b64url sha256(utf8(ih))> = { by, t }, 'decline' and 'deny' tombstone it. listingVisible(state, item) is the
// rule honest copies apply to show it (the files lane, src/files/lane.js, reads it through deps.listingVisible).

import { canonicalize, utf8, b64url, hex } from '../chain/canonical.js'
import { isPublicKeyString, sha256 } from '../chain/crypto.js'
import { sha256Sync } from '../chain/sha256-sync.js'
import { LIMITS } from '../chain/block.js'

export const MOD_METHODS = Object.freeze(['mod.ban', 'mod.unban', 'mod.tombstoneMany', 'mod.queue', 'mod.decide', 'report.send', 'db.setMine', 'db.getMine', 'db.listBy', 'owner.policy'])
export const MOD_EVENTS = Object.freeze(['queue', 'report', 'decided'])
export const REPORT_PREFIX = 'mw-report-v1\n'
export const REPORT_REASONS = Object.freeze(['spam', 'harassment', 'illegal', 'malware', 'P0', 'impersonation', 'other'])
export const DENY_REASONS = Object.freeze(['P0', 'illegal', 'malware', 'spam', 'other'])
export const QUEUE_KINDS = Object.freeze(['pin', 'report', 'join', 'listing'])
export const QUEUE_MAX = 500
/** Review round R 5.3 (SYB-11): the cap of each kind's queue (a full queue refuses new items, never evicts). */
export const QUEUE_CAPS = Object.freeze({ report: 500, join: 200, pin: 200, listing: 500 })
/** Open reports, joins and pins one sender may have in the queue at once. */
export const QUEUE_PER_SENDER = 3
/** Pending listings of one author that syncListings puts in the queue at once. */
export const QUEUE_LISTINGS_PER_AUTHOR = 100
/** The moderators' acceptance of a public listing (premoderation, MF-53): _listed/<b64url sha256(utf8(ih))> = { by, t }. */
export const LISTED_PREFIX = '_listed/'
export const DENY_PREFIX = '_deny/'
const IH_RE = /^[0-9a-f]{40}$/
export const BULK_MAX_AUTHORS = 64
export const NOTE_MAX = 500
/** Owner fields a personal site may change from the browser (R 3.3: the owner raises maxChainBytes). */
export const OWNER_POLICY_FIELDS = Object.freeze(['writers', 'bits', 'maxValueBytes', 'maxChainBytes', 'moderators', 'allow', 'modAllowPerDay', 'modActionsPerHour', 'reservedPool'])

const HASH_RE = /^[0-9a-f]{64}$/
const NAME_MAX = 238 // 256-byte key minus the 18-character scope
const FORBIDDEN_REPORT_FIELDS = ['file', 'blob', 'bytes', 'fk', 'key64', 'name', 'data', 'content']

function fail (code, message) { return Object.assign(new Error(message), { code }) }

/** authorScopeOf(pub) -> Promise<'@' + 16 b64url characters + '/'>, the same as state.js authorScope (sync there). */
export async function authorScopeOf (pub) {
  return '@' + b64url.encode(await sha256(utf8.encode(pub))).slice(0, 16) + '/'
}

/** isScopedKey(k): the author-scoped form '@' + 16 base64url characters + '/'. */
export function isScopedKey (k) {
  return typeof k === 'string' && k.length >= 18 && k.charAt(0) === '@' && k.charAt(17) === '/' && /^[A-Za-z0-9_-]{16}$/.test(k.slice(1, 17))
}

/**
 * writeControl(node, op, opts) -> Promise<block>: a control block from the browser (unban, bulk tombstone, ban
 * until, allow, policy) through ChainNode.writeControl (lane chain-net, wired by the v0.3 reconciliation). A
 * follower tab's node (src/dropin/leader.js RemoteNode) forwards only ban and tombstone of one entry; any other
 * control op there is E_UNSUPPORTED (write it from the first tab).
 */
export function writeControl (node, op, opts) {
  if (!node) return Promise.reject(fail('E_IDENTITY', 'the site ledger is not available in this browser'))
  if (typeof node.writeControl === 'function') return node.writeControl(op, opts)
  if (op && op.t === 'ban' && op.until === undefined && typeof node.ban === 'function') return node.ban(op.author, opts)
  if (op && op.t === 'tombstone' && typeof op.h === 'string' && typeof node.tombstone === 'function') return node.tombstone(op.h, opts)
  return Promise.reject(fail('E_UNSUPPORTED', 'write ' + (op && op.t) + ' from the first tab you opened this site in'))
}

function blockHash (b) {
  if (!b) return null
  if (typeof b === 'string') return b
  return b.h || null
}

function role (api) {
  const node = api.node
  return node && typeof node.role === 'string' ? node.role : 'reader'
}

function isMod (api) {
  const r = role(api)
  return r === 'owner' || r === 'moderator'
}

function tsOf (node, h) {
  try {
    const b = node && node.dag && typeof node.dag.get === 'function' ? node.dag.get(h) : null
    return b && b.e && Number.isFinite(b.e.ts) ? b.e.ts : undefined
  } catch (_) { return undefined }
}

function profileName (node, pub) {
  try {
    const st = node && node.state
    const p = st && st.profiles
    if (p instanceof Map) { const v = p.get(pub); return typeof v === 'string' ? v : (v && v.name) || null }
  } catch (_) { /* follower */ }
  return null
}

function shortOf (pub) { return String(pub || '').slice(5, 13) }

function kvMap (node) {
  try {
    if (node && node.state && node.state.kv instanceof Map) return node.state.kv
  } catch (_) { /* follower */ }
  try {
    const snap = node && typeof node.snapshot === 'function' ? node.snapshot() : null
    const kv = snap && snap.kv
    if (kv instanceof Map) return kv
    if (kv && typeof kv === 'object') return new Map(Object.entries(kv))
  } catch (_) { /* no snapshot */ }
  return new Map()
}

function entryValue (e) {
  if (e && typeof e === 'object' && !Array.isArray(e) && 'v' in e && 'h' in e) return e.v
  return e
}

function moderatorsOf (node) {
  const out = new Set()
  try {
    const st = node && node.state
    const mods = st && st.policy && st.policy.moderators
    if (mods && typeof mods.forEach === 'function') mods.forEach((m) => out.add(m))
    if (st && typeof st.owner === 'string') out.add(st.owner)
  } catch (_) { /* follower */ }
  return Array.from(out).filter(isPublicKeyString)
}

/** idKey(prefix, id) -> prefix + b64url(sha256(utf8(id))): the _deny/ and _listed/ key of an identifier (R 2.8.7). */
export async function idKey (prefix, id) {
  return prefix + b64url.encode(await sha256(utf8.encode(String(id))))
}

/** listItemOf(state, h) -> { list, item } of the list item written by block h, or null. */
function listItemOf (st, h) {
  try {
    const lists = st && st.lists
    if (!(lists instanceof Map) || typeof h !== 'string') return null
    for (const [list, items] of lists) for (const it of items || []) if (it && it.h === h) return { list, item: it }
  } catch (_) { /* a follower */ }
  return null
}

function isListingValue (v) {
  return Boolean(v && typeof v === 'object' && typeof v.ih === 'string' && IH_RE.test(v.ih))
}

/**
 * denyIdsOf(state, item) -> { ids, listingH }: the identifiers a 'deny' covers (what the lanes check: an infohash, a content
 * sha256) and the public listing to tombstone. A report of a listing ({ h }) is resolved to that listing on this device; a
 * report of private media carries the infohash its reporter's device knew ({ media, ih }).
 */
export function denyIdsOf (st, item) {
  const ids = []
  const add = (x) => { if (typeof x === 'string' && x && ids.indexOf(x) < 0) ids.push(x) }
  let listingH = null
  if (!item || typeof item !== 'object') return { ids, listingH }
  if (typeof item.ih === 'string' && IH_RE.test(item.ih)) add(item.ih)
  const h = item.kind === 'listing' ? item.h : (item.target && item.target.h)
  const hit = typeof h === 'string' ? listItemOf(st, h) : null
  if (hit && hit.list === 'mw.files' && isListingValue(hit.item.v)) {
    add(hit.item.v.ih)
    if (typeof hit.item.v.sha256 === 'string' && /^[0-9a-f]{64}$/.test(hit.item.v.sha256)) add(hit.item.v.sha256)
    listingH = hit.item.h
  } else if (item.kind === 'listing' && typeof item.h === 'string') {
    listingH = item.h
  }
  if (item.kind === 'listing' && typeof item.sha256 === 'string' && /^[0-9a-f]{64}$/.test(item.sha256)) add(item.sha256)
  const t = item.target
  if (t && typeof t.ih === 'string' && IH_RE.test(t.ih)) add(t.ih)
  return { ids, listingH }
}

/** vetted(state, pub) -> true for the owner, a moderator in effect or an allow-listed key (no premoderation for them). */
function vetted (st, pub) {
  try {
    if (!st || typeof pub !== 'string') return false
    if (st.owner === pub) return true
    const p = st.policy || {}
    const has = (set) => (set instanceof Set ? set.has(pub) : Array.isArray(set) ? set.indexOf(pub) >= 0 : false)
    return has(p.moderators) || has(p.allow)
  } catch (_) { return false }
}

const DAY_MS = 86400000

/**
 * allowRoomOf(node, pub, nowMs) -> { has(pub), size, max, full, perDay, used, left } (SCALE-14): what the ledger's state rules
 * will keep of a moderator's next allow add. The reducer (src/chain/state.js, pass 1b and the allow fold) drops adds past
 * modAllowPerDay per moderator per UTC day and past LIMITS.maxAllow keys; the owner has no day cap. used counts this key's
 * allow adds in blocks of today's UTC day (the block time; the reducer caps it by the parents' times, so this is an upper
 * bound of the room, never a looser one by more than a block written at a day boundary).
 */
export function allowRoomOf (node, pub, nowMs = Date.now()) {
  let st = null
  try { st = node && node.state } catch (_) { st = null }
  const p = (st && st.policy) || {}
  const allow = p.allow instanceof Set ? p.allow : new Set(Array.isArray(p.allow) ? p.allow : [])
  const max = LIMITS.maxAllow
  const perDay = Number.isSafeInteger(p.modAllowPerDay) ? p.modAllowPerDay : Infinity
  const owner = Boolean(st && st.owner && st.owner === pub)
  let used = 0
  if (!owner && Number.isFinite(perDay)) {
    const day = Math.floor(nowMs / DAY_MS)
    try {
      const blocks = node && node.dag && typeof node.dag.blocks === 'function' ? node.dag.blocks() : []
      for (const b of blocks) {
        const e = b && b.e
        if (!e || e.author !== pub || !e.op || e.op.t !== 'allow' || Math.floor(e.ts / DAY_MS) !== day) continue
        if (Array.isArray(e.op.remove) && e.op.remove.length > 0) continue // not a moderator's add (the reducer skips it)
        used += Array.isArray(e.op.add) ? e.op.add.length : 0
      }
    } catch (_) { /* a follower */ }
  }
  return { has: (k) => allow.has(k), size: allow.size, max, full: allow.size >= max, perDay, used, left: owner ? Infinity : perDay - used }
}

/**
 * listedId(ih, author) -> the string whose hash names the acceptance of ONE listing (review round R 5.3, MAL53-1):
 * ih + '\n' + author. The key is _listed/<b64url sha256(utf8(listedId))> and its value { by, t, ih, author }.
 */
export function listedId (ih, author) { return String(ih) + '\n' + String(author) }

/**
 * listingVisible(state, item, { listedKeys }) -> true when honest copies show this mw.files item (premoderation, MF-53):
 * its author is vetted (owner, moderator, allow list), or a moderator accepted this listing, or an earlier listing by the
 * same author. The acceptance is bound to the (infohash, author) pair (MAL53-1): another key that re-lists an accepted
 * infohash is NOT credited and its listings stay in the moderators' queue. listedKeys: listedKeysOf(state), once.
 */
export function listingVisible (st, item, { listedKeys = null } = {}) {
  if (!item || !isListingValue(item.v)) return false
  if (vetted(st, item.author)) return true
  if (typeof item.author !== 'string') return false
  const keys = listedKeys || listedKeysOf(st)
  return keys.pairs.has(listedId(item.v.ih, item.author)) || keys.authors.has(item.author)
}

/**
 * listedKeysOf(state) -> { pairs: Set<ih\nauthor>, ih: Set, authors: Set, keys: Set }: what the moderators accepted.
 * A bound key (_listed/<hash(ih \n author)>, written since MAL53-1) credits exactly that author for that infohash.
 * A legacy key (_listed/<hash(ih)>, written before; the ledger-admin tool until it binds too) credits an author only
 * when its value names that author, or, with no author in the value, when exactly ONE key has listed that infohash:
 * a second lister makes it ambiguous and nobody is credited by it (a re-listing can then only hide, never unlock).
 */
export function listedKeysOf (st) {
  const out = { pairs: new Set(), ih: new Set(), authors: new Set(), keys: new Set() }
  try {
    const kv = st && st.kv
    const vals = new Map()
    if (kv instanceof Map) {
      for (const [k, e] of kv) {
        if (typeof k !== 'string' || !k.startsWith(LISTED_PREFIX)) continue
        const v = entryValue(e)
        if (v === null || v === undefined) continue
        out.keys.add(k)
        vals.set(k, v)
      }
    }
    if (!out.keys.size) return out
    const lists = st.lists
    const items = lists instanceof Map ? (lists.get('mw.files') || []) : []
    const listers = new Map() // ih -> Map(author -> earliest listing ts)
    for (const it of items) {
      if (!it || !isListingValue(it.v) || typeof it.author !== 'string') continue
      let s = listers.get(it.v.ih)
      if (!s) listers.set(it.v.ih, (s = new Map()))
      const ts = Number.isFinite(it.ts) ? it.ts : Infinity
      if (!s.has(it.author) || ts < s.get(it.author)) s.set(it.author, ts)
    }
    const credit = (ih, author) => { out.pairs.add(listedId(ih, author)); out.ih.add(ih); out.authors.add(author) }
    for (const [ih, authors] of listers) {
      for (const author of authors.keys()) {
        const bound = LISTED_PREFIX + b64url.encode(sha256Sync(utf8.encode(listedId(ih, author))))
        const bv = vals.get(bound)
        if (bv !== undefined && (!bv || typeof bv !== 'object' || bv.author === undefined || bv.author === author)) credit(ih, author)
      }
      const legacyKey = LISTED_PREFIX + b64url.encode(sha256Sync(utf8.encode(ih)))
      const legacy = vals.get(legacyKey)
      if (legacy === undefined) continue
      const named = legacy && typeof legacy === 'object' && typeof legacy.author === 'string' ? legacy.author : null
      if (named !== null) { if (authors.has(named)) credit(ih, named); continue }
      if (authors.size !== 1) continue
      // The sole lister, and only a listing that existed when the acceptance was written.
      const [author, ts] = authors.entries().next().value
      const at = kv.get(legacyKey)
      const acceptedAt = at && typeof at === 'object' && Number.isFinite(at.ts) ? at.ts : Infinity
      if (ts <= acceptedAt) credit(ih, author)
    }
  } catch (_) { /* a follower */ }
  return out
}

/**
 * pendingListings(state) -> [{ kind: 'listing', id, ih, author, len, mime, h, sha256 }]: the public listings that wait for a
 * moderator (an author without an accepted listing, not vetted). The moderator's device builds its queue from the ledger.
 */
export function pendingListings (st) {
  const out = []
  try {
    const lists = st && st.lists
    const items = lists instanceof Map ? (lists.get('mw.files') || []) : []
    const keys = listedKeysOf(st)
    for (const it of items) {
      if (!it || !isListingValue(it.v) || listingVisible(st, it, { listedKeys: keys })) continue
      out.push({ kind: 'listing', id: 'listing-' + it.h, ih: it.v.ih, author: it.author || null, len: Number(it.v.len) || 0, mime: typeof it.v.mime === 'string' ? it.v.mime : null, h: it.h, sha256: typeof it.v.sha256 === 'string' ? it.v.sha256 : undefined })
    }
  } catch (_) { /* a follower */ }
  return out
}

/** report digest: sha256 hex of the canonical value of a ledger item (what this device saw), and its size. */
async function itemFacts (node, h) {
  try {
    const st = node && node.state
    const lists = st && st.lists
    if (lists instanceof Map) {
      for (const items of lists.values()) {
        for (const it of items || []) {
          if (it && it.h === h) {
            const text = canonicalize(it.v === undefined ? null : it.v)
            return { author: it.author || null, ts: it.ts || null, digest: hex.encode(await sha256(utf8.encode(text))), size: utf8.encode(text).length }
          }
        }
      }
    }
    if (st && st.kv instanceof Map) {
      for (const [k, it] of st.kv) {
        if (it && it.h === h) {
          const text = canonicalize(it.v === undefined ? null : it.v)
          return { key: k, author: it.author || null, ts: it.ts || null, digest: hex.encode(await sha256(utf8.encode(text))), size: utf8.encode(text).length }
        }
      }
    }
  } catch (_) { /* a follower or a closed node */ }
  return {}
}

/** mediaIhOf(api, id) -> the infohash of a private media item this device holds (sender or recipient), or null. */
function mediaIhOf (api, id) {
  try {
    const m = api && typeof api.service === 'function' ? api.service('media') : null
    const items = m && m.lane && m.lane.items
    const rec = items && typeof items.get === 'function' ? items.get(id) : null
    const ih = rec && rec.M && rec.M.ih
    return typeof ih === 'string' && IH_RE.test(ih) ? ih : null
  } catch (_) { return null }
}

export function createModService ({ api, now = () => Date.now(), random = null } = {}) {
  if (!api) throw new TypeError('createModService needs the MwApi')
  const listeners = new Map()
  const queue = new Map() // id -> item
  const rnd = typeof random === 'function' ? random : (n) => globalThis.crypto.getRandomValues(new Uint8Array(n))
  let destroyed = false

  const emit = (event, data) => {
    const set = listeners.get(event)
    if (!set) return
    for (const fn of Array.from(set)) { try { fn(data) } catch (_) { /* a listener's bug */ } }
  }

  const live = () => { if (destroyed) throw fail('E_POLICY', 'the moderation service was stopped') }
  const needMod = () => { if (!isMod(api)) throw fail('E_NOT_MODERATOR', 'only moderators can do this') }
  const needGesture = (ctx) => { if (!ctx || ctx.activation !== true) throw fail('E_NEEDS_GESTURE', 'call this from a click') }
  const keysNow = () => api.identity && typeof api.identity.keys === 'function' ? api.identity.keys() : null
  const myPub = () => {
    const k = keysNow()
    if (k && isPublicKeyString(k.pub)) return k.pub
    const info = api.identity ? api.identity.info() : null
    if (info && isPublicKeyString(info.pub)) return info.pub
    const node = api.node
    const id = node && node.identity
    return id && isPublicKeyString(id.pub) ? id.pub : null
  }
  async function card (kind, data) {
    let ok = false
    try { ok = await api.prompt(kind, data) } catch (_) { ok = false }
    if (ok !== true) throw fail('E_USER_CANCELLED', 'cancelled')
  }
  const nodeNow = () => {
    if (!api.node) throw fail('E_IDENTITY', 'the site ledger is not available in this browser')
    return api.node
  }
  const ownLedger = (ledger) => !ledger || (typeof api._ownLedger === 'function' ? api._ownLedger(ledger) : true)

  // Review round R 5.3 (SYB-11, MF-54): one bounded queue per kind, and a full queue refuses the NEW item: nothing is
  // ever evicted, so joins, pins or ledger listings cannot push a report out. A sender has at most QUEUE_PER_SENDER
  // open items (reports, joins, pins), one open join, and one open report per target.
  function addToQueue (item) {
    if (!item || QUEUE_KINDS.indexOf(item.kind) < 0) return null
    let ofKind = 0
    let ofSender = 0
    for (const e of queue.values()) {
      if (e.kind === item.kind) ofKind++
      if (item.kind === 'listing' || !item.from || e.kind === 'listing' || e.from !== item.from) continue
      if (item.kind === 'join' && e.kind === 'join') return e
      if (item.kind === 'report' && e.kind === 'report' && e.target === item.target) return e
      ofSender++
    }
    if (ofKind >= (QUEUE_CAPS[item.kind] || QUEUE_MAX)) return null
    if (item.kind !== 'listing' && item.from && ofSender >= QUEUE_PER_SENDER) return null
    const id = item.id || b64url.encode(rnd(12))
    const entry = Object.assign({}, item, { id, at: now() })
    queue.set(id, entry)
    emit('queue', { id, kind: entry.kind })
    return entry
  }

  /**
   * receive(fromPub, grant): a moderation item that reached this browser over chat (a report, a join request,
   * a pin request). Only moderators keep them; the queue holds metadata only.
   */
  function receive (fromPub, grant) {
    if (destroyed || !grant || typeof grant !== 'object' || !isMod(api)) return null
    if (grant.t === 'report' && grant.report && typeof grant.report === 'object') {
      const r = grant.report
      const item = addToQueue({ kind: 'report', from: fromPub, target: r.target || null, reason: r.reason || 'other', note: typeof r.note === 'string' ? r.note.slice(0, NOTE_MAX) : '', facts: r.facts || {}, sig: grant.sig || null })
      if (item) emit('report', { id: item.id, from: fromPub })
      return item
    }
    if (grant.t === 'join') return addToQueue({ kind: 'join', from: fromPub, pub: isPublicKeyString(grant.pub) ? grant.pub : fromPub, note: typeof grant.note === 'string' ? grant.note.slice(0, NOTE_MAX) : '' })
    if (grant.t === 'pin') return addToQueue({ kind: 'pin', from: fromPub, ih: typeof grant.ih === 'string' ? grant.ih : null, size: Number(grant.size) || 0, name: null })
    return null
  }

  /** queueListing(item): a public file listing that waits for premoderation (MF-53; pendingListings feeds it from the ledger). */
  function queueListing (listing) {
    if (!listing || typeof listing !== 'object') return null
    const id = typeof listing.id === 'string' ? listing.id : (typeof listing.h === 'string' ? 'listing-' + listing.h : undefined)
    if (id && queue.has(id)) return queue.get(id)
    return addToQueue({ kind: 'listing', id, ih: listing.ih || null, author: listing.author || null, len: listing.len || 0, mime: listing.mime || null, h: listing.h || null, sha256: listing.sha256 })
  }

  /** syncListings(): the listings of the ledger that wait for a moderator join this device's queue (moderators only). */
  function syncListings () {
    if (destroyed || !isMod(api)) return 0
    let n = 0
    let st = null
    try { st = api.node && api.node.state } catch (_) { st = null }
    // SYB-11: at most QUEUE_LISTINGS_PER_AUTHOR listings of one author wait in the queue (the rest join as those are decided).
    const perAuthor = new Map()
    for (const e of queue.values()) if (e.kind === 'listing' && e.author) perAuthor.set(e.author, (perAuthor.get(e.author) || 0) + 1)
    for (const item of pendingListings(st)) {
      if (queue.has(item.id)) continue
      const a = item.author || ''
      if ((perAuthor.get(a) || 0) >= QUEUE_LISTINGS_PER_AUTHOR) continue
      if (queueListing(item)) { n++; perAuthor.set(a, (perAuthor.get(a) || 0) + 1) }
    }
    return n
  }

  const methods = {
    async 'mod.ban' (params = {}, ctx = {}) {
      live()
      needMod()
      needGesture(ctx)
      const pub = params.pub
      if (!isPublicKeyString(pub)) throw fail('E_LIMIT', 'pub must be a P-256 public key (p256:<base64url>)')
      const until = params.until === undefined || params.until === null ? undefined : Number(params.until)
      if (until !== undefined && (!Number.isSafeInteger(until) || until <= 0)) throw fail('E_LIMIT', 'until must be a time in milliseconds')
      const node = nodeNow()
      await card('mod.ban', { pub, name: profileName(node, pub), short: shortOf(pub), until })
      const op = until === undefined ? { t: 'ban', author: pub } : { t: 'ban', author: pub, until }
      return { h: blockHash(await writeControl(node, op, ctx.opts)) }
    },

    async 'mod.unban' (params = {}, ctx = {}) {
      live()
      needMod()
      needGesture(ctx)
      const pub = params.pub
      if (!isPublicKeyString(pub)) throw fail('E_LIMIT', 'pub must be a P-256 public key (p256:<base64url>)')
      const node = nodeNow()
      await card('mod.unban', { pub, name: profileName(node, pub), short: shortOf(pub) })
      return { h: blockHash(await writeControl(node, { t: 'unban', author: pub }, ctx.opts)) }
    },

    async 'mod.tombstoneMany' (params = {}, ctx = {}) {
      live()
      needMod()
      needGesture(ctx)
      const authors = Array.isArray(params.authors) ? params.authors : null
      if (!authors || authors.length === 0 || authors.length > BULK_MAX_AUTHORS || !authors.every(isPublicKeyString)) {
        throw fail('E_LIMIT', 'authors must be 1 to ' + BULK_MAX_AUTHORS + ' P-256 public keys')
      }
      const before = params.before
      if (typeof before !== 'string' || !HASH_RE.test(before)) throw fail('E_LIMIT', 'before must be the hash of a block (64 lowercase hex characters)')
      const node = nodeNow()
      const unique = Array.from(new Set(authors)).sort()
      await card('mod.tombstoneMany', { authors: unique, before: tsOf(node, before) })
      return { h: blockHash(await writeControl(node, { t: 'tombstone', authors: unique, before }, ctx.opts)) }
    },

    async 'mod.queue' () {
      live()
      needMod()
      syncListings()
      return Array.from(queue.values()).map((it) => Object.assign({}, it))
    },

    async 'mod.decide' (params = {}, ctx = {}) {
      live()
      needMod()
      needGesture(ctx)
      const item = queue.get(params.id)
      if (!item) throw fail('E_BAD_REQUEST', 'no such item in the moderation queue')
      const decision = params.decision
      if (decision !== 'accept' && decision !== 'decline' && decision !== 'deny') throw fail('E_BAD_REQUEST', "decision must be 'accept', 'decline' or 'deny'")
      const reason = typeof params.reason === 'string' ? params.reason.slice(0, 64) : undefined
      await card('mod.decide', { id: item.id, decision, kind: item.kind, reason })
      const node = nodeNow()
      let h = null
      const hs = []
      if (decision === 'accept' && item.kind === 'join' && isPublicKeyString(item.pub)) {
        // SCALE-14: an add the ledger would drop (the moderator's day is used up, the allow list is full) is refused here,
        // with the reason, instead of a block that is reported as a join and has no effect.
        const room = allowRoomOf(node, myPub(), now())
        if (!room.has(item.pub) && room.full) throw fail('E_LIMIT', 'this group is full: the allow list holds ' + room.max + ' members, the most a ledger keeps')
        if (!room.has(item.pub) && room.left <= 0) throw fail('E_LIMIT', 'daily limit of ' + room.perDay + ' approvals reached for this moderator (UTC day); try again tomorrow or ask the owner')
        h = blockHash(await writeControl(node, { t: 'allow', add: [item.pub], remove: [] }, ctx.opts))
      } else if (decision === 'accept' && item.kind === 'listing' && typeof item.ih === 'string' && IH_RE.test(item.ih)) {
        // Premoderation (MF-53): honest copies show the listing, and this author's later ones, from now on. The key binds
        // the infohash AND the author (MAL53-1): another key that re-lists the same infohash gains nothing.
        if (typeof item.author !== 'string' || !item.author) throw fail('E_BAD_REQUEST', 'this listing names no author to accept')
        h = blockHash(await node.put(await idKey(LISTED_PREFIX, listedId(item.ih, item.author)), { by: myPub(), t: now(), ih: item.ih, author: item.author }, ctx.opts))
      } else if (decision === 'decline' && item.kind === 'listing' && typeof item.h === 'string' && HASH_RE.test(item.h)) {
        h = blockHash(await writeControl(node, { t: 'tombstone', h: item.h }, ctx.opts))
      } else if (decision === 'deny') {
        // R 2.8.7: a deny entry for every identifier the lanes check, and the listing tombstoned in the same step.
        let st = null
        try { st = node.state } catch (_) { st = null }
        const { ids, listingH } = denyIdsOf(st, item)
        if (!ids.length) throw fail('E_BAD_REQUEST', 'this item names no infohash or file hash to deny')
        const value = { by: myPub(), t: now(), reason: DENY_REASONS.indexOf(reason) >= 0 ? reason : 'other' }
        if (listingH) value.ref = listingH
        for (const id of ids) hs.push(blockHash(await node.put(await idKey(DENY_PREFIX, id), value, ctx.opts)))
        if (listingH && HASH_RE.test(listingH)) {
          try { hs.push(blockHash(await writeControl(node, { t: 'tombstone', h: listingH }, ctx.opts))) } catch (_) { /* tombstoned already, or by the owner */ }
        }
        h = hs[0] || null
      }
      queue.delete(item.id)
      emit('decided', { id: item.id, decision, h })
      const out = { id: item.id, decision, h }
      if (hs.length > 1) out.blocks = hs.filter(Boolean)
      return out
    },

    async 'report.send' (params = {}, ctx = {}) {
      live()
      needGesture(ctx)
      const target = params.target
      if (!target || typeof target !== 'object' || Array.isArray(target)) throw fail('E_BAD_REQUEST', 'target must be { h } | { envelope } | { media } | { key }')
      for (const f of FORBIDDEN_REPORT_FIELDS) {
        if (Object.prototype.hasOwnProperty.call(target, f) || Object.prototype.hasOwnProperty.call(params, f)) throw fail('E_BAD_REQUEST', 'a report carries metadata only, never ' + f)
      }
      const t = {}
      if (typeof target.h === 'string' && HASH_RE.test(target.h)) t.h = target.h
      else if (typeof target.envelope === 'string' && target.envelope.length <= 64) t.envelope = target.envelope
      else if (typeof target.media === 'string' && target.media.length <= 64) {
        t.media = target.media
        // The infohash of the reported item, from this device's own copy (never from the site's params): what a
        // moderator's deny entry must name for every loader to refuse it (R 2.8.7, 2.9.10).
        const ih = mediaIhOf(api, target.media)
        if (ih) t.ih = ih
      } else if (isPublicKeyString(target.key)) t.key = target.key
      else throw fail('E_BAD_REQUEST', 'target must be { h } | { envelope } | { media } | { key }')
      const reason = typeof params.reason === 'string' && REPORT_REASONS.indexOf(params.reason) >= 0 ? params.reason : null
      if (!reason) throw fail('E_BAD_REQUEST', 'reason must be one of ' + REPORT_REASONS.join(', '))
      const note = typeof params.note === 'string' ? params.note.slice(0, NOTE_MAX) : ''
      const keys = keysNow()
      if (!keys || !isPublicKeyString(keys.pub) || typeof keys.sign !== 'function') throw fail('E_NOT_SIGNED_IN', 'sign in to send a report')
      const chat = api.service ? api.service('chat') : null
      if (!chat || !chat.methods || typeof chat.methods['chat.dm.send'] !== 'function') throw fail('E_POLICY', 'reports travel as messages: turn on messages first (mw.chat.enable)')
      const node = api.node
      await card('report.send', { reason })
      const facts = t.h ? await itemFacts(node, t.h) : {}
      const report = { v: 1, t: 'mw-report', ledger: (api.infoNow().siteId || null), target: t, reason, note, facts, at: now(), from: keys.pub }
      const sig = b64url.encode(await keys.sign(utf8.encode(REPORT_PREFIX + canonicalize(report))))
      let sent = 0
      for (const m of moderatorsOf(node)) {
        if (m === keys.pub) continue
        try {
          await chat.methods['chat.dm.send']({ pub: m, grant: { t: 'report', report, sig } }, { activation: false, tab: ctx.tab || 'leader' })
          sent++
        } catch (_) { /* that moderator has no chat key here, or is blocked */ }
      }
      return { sent }
    },

    async 'db.setMine' (params = {}, ctx = {}) {
      live()
      const name = params.name
      if (typeof name !== 'string' || name.length === 0 || name.length > NAME_MAX) throw fail('E_LIMIT', 'name must be 1 to ' + NAME_MAX + ' characters')
      if (params.ledger && !ownLedger(params.ledger)) throw fail('E_POLICY', 'writes go to your own ledger only')
      await api.ensureSignedIn(ctx)
      const pub = myPub()
      if (!pub) throw fail('E_NOT_SIGNED_IN', 'sign in first')
      const key = (await authorScopeOf(pub)) + name
      if (params.value === undefined) throw fail('E_LIMIT', 'value is required (use null to clear it)')
      return { h: blockHash(await nodeNow().put(key, params.value, ctx.opts)), key }
    },

    async 'db.getMine' (params = {}) {
      live()
      const name = params.name
      if (typeof name !== 'string' || name.length === 0 || name.length > NAME_MAX) throw fail('E_LIMIT', 'name must be 1 to ' + NAME_MAX + ' characters')
      const pub = myPub()
      if (!pub) return undefined
      const key = (await authorScopeOf(pub)) + name
      if (params.ledger && !ownLedger(params.ledger)) return api._followedRead(params.ledger, 'db.get', [key])
      const e = kvMap(api.node).get(key)
      return e === undefined ? undefined : entryValue(e)
    },

    async 'db.listBy' (params = {}) {
      live()
      const name = typeof params.name === 'string' ? params.name : ''
      if (name.length > NAME_MAX) throw fail('E_LIMIT', 'name longer than ' + NAME_MAX + ' characters')
      if (!isPublicKeyString(params.author)) throw fail('E_LIMIT', 'author must be a P-256 public key (p256:<base64url>)')
      const prefix = (await authorScopeOf(params.author)) + name
      if (params.ledger && !ownLedger(params.ledger)) return api._followedRead(params.ledger, 'db.listBy', [prefix])
      return listScoped(kvMap(api.node), prefix)
    },

    async 'owner.policy' (params = {}, ctx = {}) {
      live()
      if (role(api) !== 'owner' || !keysNow()) throw fail('E_NOT_OWNER', 'only the owner of a personal site changes its policy in the browser; other sites use tools/ledger-admin.mjs')
      needGesture(ctx)
      const fields = {}
      for (const k of Object.keys(params)) {
        if (OWNER_POLICY_FIELDS.indexOf(k) < 0) throw fail('E_BAD_REQUEST', 'unknown policy field ' + k)
        fields[k] = params[k]
      }
      if (Object.keys(fields).length === 0) throw fail('E_BAD_REQUEST', 'no policy field to change')
      const confirm = api.ownerConfirm
      if (typeof confirm !== 'function') throw fail('E_UNSUPPORTED', 'owner actions need the identity page, which this loader cannot open')
      const ok = await confirm({ kind: 'policy', fields })
      if (ok !== true) throw fail('E_USER_CANCELLED', 'cancelled')
      return { h: blockHash(await writeControl(nodeNow(), Object.assign({ t: 'policy' }, fields), ctx.opts)) }
    }
  }

  return {
    methods,
    on (event, fn) {
      if (MOD_EVENTS.indexOf(event) < 0) throw fail('E_BAD_REQUEST', 'unknown event ' + event)
      if (!listeners.has(event)) listeners.set(event, new Set())
      listeners.get(event).add(fn)
      return () => listeners.get(event).delete(fn)
    },
    receive,
    queueListing,
    syncListings,
    get size () { return queue.size },
    destroy () {
      destroyed = true
      queue.clear()
      listeners.clear()
    }
  }
}

/** listScoped(kv, prefix) -> [{ key, v, h, ts, author }] of the '@' keys under prefix (deleted keys left out). */
export function listScoped (kv, prefix) {
  const out = []
  if (!kv || typeof kv.forEach !== 'function') return out
  kv.forEach((e, k) => {
    if (typeof k !== 'string' || !k.startsWith(prefix)) return
    const v = entryValue(e)
    if (v === null || v === undefined) return
    out.push({ key: k.slice(18), v, h: e && e.h ? e.h : null, ts: e && e.ts ? e.ts : null, author: e && e.author ? e.author : null })
  })
  out.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0))
  return out
}
