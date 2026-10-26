// src/loader/personal-site.js: personal sites in hub mode (R 3.1, 3.3, 3.5; MF-64, MF-65; N-3) and the followed
// ledgers of the hub amendment (docs/SDK.md "Amendment to R 2.11.2: followed ledgers").
//
//   createPersonalSite({ keys, templateBtih, hub, confirm, genesis, now, random })
//     -> { ledgerId, label, origin, url, record, text, blocks, gen }
//   createHubService({ openLedger, multi, prefs, deviceClass, parsePointer, verifyPointer, ledgerIdFor, hubLabelFor,
//                      createPage, now }) -> { methods, on, read(ledger, method, args), follows(), destroy() }
//
// "Create my page" (R 3.3): after the identity origin's card ("Create your page on <hub>. Its address is public."),
// the person's hub-scoped working key mints the genesis of their own ledger in the browser: a policy block
// (writers 'owner', bits 16, maxChainBytes 8 MiB) and a keyinfo block (the recovery commitment rc from the key
// bundle), then signs the pointer
//   v=mw1; btih=<template>; owner=<key>; chain=<random>; gen=<h>; nx=<nextPubHash from the bundle>; seq; exp
// over the hub scope 'btih:<template>'. The ledger id is ledgerIdFor(pointer) and the address is
// <hubLabelFor(pointer, ledgerId)>.<hub>. Each label is its own origin with its own storage, so the genesis travels
// to the new address in the URL fragment after the pointer: '#<pointer>#mwgen=<b64url of the JSON blocks>'. The
// loader there checks every block (signature, genesis owner = pointer owner, gen = the genesis hash) before it
// keeps them (src/loader/app.js). Owner actions open the identity origin card (confirm); without one they refuse
// (E_UNSUPPORTED), never fall back to an in-page card.
//
// The keys are never raw: signing goes through keys.sign(bytes) (WorkingKeys, lane idp). ChainNode.genesis from
// lane chain-net mints the blocks (the only minting path since the v0.3 reconciliation: the copy this file kept
// for a build without it is gone, so the two cannot drift).

import { utf8, b64url } from '../chain/canonical.js'
import { isPublicKeyString } from '../chain/crypto.js'
import { validateBlock, DEFAULT_POLICY } from '../chain/block.js'
import { signingInput, formatPointer, parsePointer as parsePointerText, ledgerIdFor as ledgerIdOf, hubLabelFor as hubLabelOf, DEFAULT_EXP_DAYS } from '../common/pointer.js'
import { listOfNode, plainOf, kvEntryValue } from './api.js'
import { listScoped } from './mod.js'

export const PERSONAL_POLICY = Object.freeze({ writers: 'owner', bits: 16, maxChainBytes: 8 * 1024 * 1024 })
/** Follow caps per device class (R 3.2.3, chosen; gate rows G-SC-1 and G-SC-9 confirm or lower them). */
export const FOLLOW_CAPS = Object.freeze({ phone: 250, desktop: 1000 })
export const GENESIS_FRAGMENT = 'mwgen='
export const MAX_GENESIS_BLOCKS = 4
export const MAX_GENESIS_FRAGMENT = 8192
export const CHAIN_BYTES = 16
export const HUB_EVENTS = Object.freeze(['change', 'follow', 'unfollow', 'state'])
export const CHANGE_THROTTLE_MS = 250
/**
 * Code review v0.3 (correctness): a personal pointer expires 90 days after it was signed. The owner's own page signs a new
 * one (new seq and exp, the same ledger, nx=) once fewer than REFRESH_BEFORE_MS remain and writes it to POINTER_KEY in its
 * ledger, where the people who follow it pick it up (createHubService); a follow whose pointer only expired is kept and
 * flagged, never dropped.
 */
export const REFRESH_BEFORE_MS = 30 * 86400000
export const POINTER_KEY = '_mw.ptr'
/** Stored follows are opened this many at a time (code review v0.3, correctness: they were opened one after another). */
export const LOAD_BATCH = 32

const RC_RE = /^[A-Za-z0-9_-]{43}$/
const NX_RE = /^[A-Za-z0-9_-]{43}$/
const BTIH_RE = /^[0-9a-f]{40}$/
const LEDGER_RE = /^mw1:[A-Za-z0-9_-]{27}$/

function fail (code, message) { return Object.assign(new Error(message), { code }) }

function signerOf (keys) {
  if (!keys || !isPublicKeyString(keys.pub) || typeof keys.sign !== 'function') return null
  return { pub: keys.pub, sign: (bytes) => keys.sign(bytes) }
}

/**
 * personalPolicyOp() -> the genesis policy op of a personal site: PERSONAL_POLICY over DEFAULT_POLICY, every field
 * present (the same op ChainNode.genesis writes).
 */
export function personalPolicyOp () {
  const op = { t: 'policy' }
  for (const f of ['writers', 'bits', 'maxValueBytes', 'maxChainBytes', 'moderators', 'allow']) {
    let v = PERSONAL_POLICY[f] === undefined ? DEFAULT_POLICY[f] : PERSONAL_POLICY[f]
    if (Array.isArray(v)) v = Array.from(new Set(v)).sort()
    op[f] = v
  }
  return op
}

/**
 * genesisBlocks({ signer, site, chain, rc, now, chainGenesis }) -> { blocks: [policy, keyinfo], gen }.
 * chainGenesis: ChainNode.genesis from lane chain-net ({ signer, policy, keyinfo, chain, ledgerId, now }), required
 * (E_UNSUPPORTED without it); blocks minted for another ledger are refused (E_INTERNAL).
 */
export async function genesisBlocks ({ signer, site, chain = null, rc, now = Date.now(), chainGenesis = null }) {
  if (typeof rc !== 'string' || !RC_RE.test(rc)) throw fail('E_UNSUPPORTED', 'the key bundle has no recovery commitment (rc), which a personal site needs for keyinfo')
  if (typeof chainGenesis !== 'function') throw fail('E_UNSUPPORTED', 'this loader cannot mint a ledger (ChainNode.genesis is missing)')
  const out = await chainGenesis({ signer, policy: Object.assign({}, PERSONAL_POLICY), keyinfo: { rc }, chain, ledgerId: site, now })
  if (!out || !Array.isArray(out.blocks) || !out.blocks.length) throw fail('E_INTERNAL', 'the genesis came back empty')
  if (out.ledgerId && out.ledgerId !== site) throw fail('E_INTERNAL', 'the genesis was minted for another ledger')
  for (const b of out.blocks) if (!b || !b.e || b.e.site !== site) throw fail('E_INTERNAL', 'the genesis was minted for another ledger')
  return { blocks: out.blocks, gen: out.gen || out.blocks[0].h }
}

/** randomChain(random) -> 22 b64url characters (16 random bytes): the pointer's chain= of a new personal site. */
export function randomChain (random = (n) => globalThis.crypto.getRandomValues(new Uint8Array(n))) {
  return b64url.encode(random(CHAIN_BYTES))
}

/** hubScope(templateBtih) -> 'btih:<btih>': the scope every hub pointer is signed and verified for. */
export function hubScope (templateBtih) {
  if (!BTIH_RE.test(String(templateBtih || ''))) throw new TypeError('the template infohash must be 40 lowercase hex characters')
  return 'btih:' + templateBtih
}

/**
 * transportOf(record) -> { tr?, ws?, xs?, idp? }: the template's transport hints a new personal pointer repeats (v0.3
 * final integration). A signed pointer is announced only on its own tr= (announceListFor never adds the public
 * defaults to a signed record) and fetched only from its own ws= and xs=, so a personal pointer without them could
 * never load the template on its new origin: no tracker, no web seed. The template's lists are copied as they are
 * (the same torrent), and so is idp= (the hub's identity origin, the owner's suggestion); nothing that names the
 * template's ledger (cs=, gen=, chain=, lo=, rot=, nx=, org=) is copied.
 */
export function transportOf (record) {
  const out = {}
  if (!record || typeof record !== 'object') return out
  for (const key of ['tr', 'ws', 'xs']) {
    const list = Array.isArray(record[key]) ? record[key].filter((u) => typeof u === 'string' && u) : []
    if (list.length) out[key] = list.slice(0, 8)
  }
  if (typeof record.idp === 'string' && record.idp) out.idp = record.idp
  return out
}

/**
 * personalPointer({ signer, templateBtih, chain, gen, nx, transport, now, expDays }) -> Promise<{ record, text }>: the
 * signed pointer of a personal site. seq is the Unix time, exp seq + expDays (90 by default). transport: the
 * template's tr=, ws=, xs= and idp= (transportOf), signed here by the person's own key.
 */
export async function personalPointer ({ signer, templateBtih, chain, gen, nx, transport = {}, now = Date.now(), expDays = DEFAULT_EXP_DAYS }) {
  if (!signer) throw fail('E_NOT_SIGNED_IN', 'sign in first')
  if (typeof nx !== 'string' || !NX_RE.test(nx)) throw fail('E_UNSUPPORTED', 'the key bundle has no next-key commitment (nextPubHash), which a personal site needs for nx=')
  const seq = Math.floor(now / 1000)
  const draft = Object.assign(transportOf(transport), { v: 'mw1', btih: templateBtih, owner: signer.pub, chain, gen, nx, seq, exp: seq + Math.floor(expDays * 86400) })
  const scope = hubScope(templateBtih)
  const parsedDraft = parsePointerText(formatPointer(draft))
  if (!parsedDraft.ok) throw fail('E_INTERNAL', 'the pointer draft does not parse (' + (parsedDraft.detail || parsedDraft.error) + ')')
  const input = signingInput(parsedDraft.record, scope)
  const sig = b64url.encode(await signer.sign(utf8.encode(input)))
  const text = formatPointer(Object.assign({}, parsedDraft.record, { sig }))
  const parsed = parsePointerText(text)
  if (!parsed.ok) throw fail('E_INTERNAL', 'the signed pointer does not parse (' + (parsed.detail || parsed.error) + ')')
  return { record: parsed.record, text }
}

/**
 * refreshPersonalPointer({ keys, record, now, before }) -> Promise<{ record, text } | null>: a fresh pointer for the owner's
 * own page when its current one has fewer than `before` ms left (or has expired): the same btih, owner, chain, gen, nx and
 * transport, a new seq (now) and exp (90 days), signed by the owner's working key for the hub scope. null when keys is
 * not the pointer's owner or there is time left.
 */
export async function refreshPersonalPointer ({ keys, record, now = Date.now(), before = REFRESH_BEFORE_MS } = {}) {
  const signer = signerOf(keys)
  if (!signer || !record || typeof record !== 'object' || !record.signed || record.owner !== signer.pub) return null
  if (typeof record.chain !== 'string' || !record.chain || typeof record.nx !== 'string' || !NX_RE.test(record.nx)) return null
  const expMs = Number(record.exp) * 1000
  if (Number.isFinite(expMs) && expMs - now >= before) return null
  if (Math.floor(now / 1000) <= Number(record.seq)) return null // never a seq that does not move forward
  return personalPointer({ signer, templateBtih: record.btih, chain: record.chain, gen: record.gen || undefined, nx: record.nx, transport: record, now })
}

/** encodeGenesis(blocks) -> 'mwgen=' + b64url(JSON); decodeGenesis(fragmentPart) -> blocks | null (bounded). */
export function encodeGenesis (blocks) {
  return GENESIS_FRAGMENT + b64url.encode(utf8.encode(JSON.stringify(blocks)))
}

export function decodeGenesis (part) {
  if (typeof part !== 'string' || !part.startsWith(GENESIS_FRAGMENT) || part.length > MAX_GENESIS_FRAGMENT) return null
  try {
    const blocks = JSON.parse(utf8.decode(b64url.decode(part.slice(GENESIS_FRAGMENT.length))))
    if (!Array.isArray(blocks) || blocks.length === 0 || blocks.length > MAX_GENESIS_BLOCKS) return null
    for (const b of blocks) if (!b || typeof b !== 'object' || !b.e || typeof b.h !== 'string') return null
    return blocks
  } catch (_) { return null }
}

/**
 * checkGenesis(blocks, record, ledgerId) -> Promise<boolean>: every block valid for the ledger, the first one the
 * genesis by the pointer's owner whose hash is the pointer's gen=, the rest controls by the owner. What a loader
 * runs before it keeps blocks that came in a link.
 */
export async function checkGenesis (blocks, record, ledgerId) {
  if (!Array.isArray(blocks) || !blocks.length || !record || !record.owner || !record.gen) return false
  const owner = record.lo || record.owner
  if (blocks[0].h !== record.gen || !blocks[0].e || blocks[0].e.prev.length !== 0) return false
  for (const b of blocks) {
    if (!b.e || b.e.author !== owner || b.e.site !== ledgerId) return false
    const v = await validateBlock(b, { site: ledgerId, genesisOwner: owner })
    if (!v.ok) return false
  }
  return true
}

/**
 * createPersonalSite({ keys, templateBtih, hub: { host, scheme, port }, confirm, genesis, transport, now, random,
 *   ledgerIdFor, hubLabelFor }) -> the new site. keys: WorkingKeys of the hub label (pub, sign, rc, nextPubHash).
 * confirm(card) -> Promise<boolean>: the identity origin card (owner action). genesis: ChainNode.genesis.
 * transport: the record of the page the person is on (the template's tr=, ws=, xs= and idp= are repeated; transportOf).
 */
export async function createPersonalSite ({ keys, templateBtih, hub = {}, confirm, genesis = null, transport = null, now = Date.now(), random, ledgerIdFor = ledgerIdOf, hubLabelFor = hubLabelOf } = {}) {
  const signer = signerOf(keys)
  if (!signer) throw fail('E_NOT_SIGNED_IN', 'sign in first')
  if (typeof confirm !== 'function') throw fail('E_UNSUPPORTED', 'creating a page needs the identity page, which this loader cannot open')
  const host = typeof hub.host === 'string' ? hub.host : ''
  if (!host) throw fail('E_POLICY', 'personal pages exist only on a hub')
  const ok = await confirm({ kind: 'create-page', hub: host })
  if (ok !== true) throw fail('E_USER_CANCELLED', 'cancelled')
  // Read after the card: the identity page's answer to "Create your page" carries rc and nextPubHash (WorkingKeys).
  const rc = keys.rc || null
  const nx = keys.nextPubHash || null
  const chain = randomChain(random)
  // The ledger id depends only on owner and chain (pointer.js ledgerIdFor): compute it from a draft, mint, then sign.
  const scope = hubScope(templateBtih)
  const draft = parsePointerText(formatPointer({ v: 'mw1', btih: templateBtih, owner: signer.pub, chain, seq: 1, exp: 2, sig: 'A'.repeat(86) }))
  const ledgerId = await ledgerIdFor(draft.ok ? draft.record : { btih: templateBtih, owner: signer.pub, chain, sig: 'x', signed: true }, scope)
  const { blocks, gen } = await genesisBlocks({ signer, site: ledgerId, chain, rc, now, chainGenesis: genesis })
  const { record, text } = await personalPointer({ signer, templateBtih, chain, gen, nx, transport: transport || {}, now })
  const realId = await ledgerIdFor(record, scope)
  if (realId !== ledgerId) throw fail('E_INTERNAL', 'the ledger id changed between the draft and the signed pointer')
  const label = hubLabelFor(record, ledgerId)
  const scheme = hub.scheme || 'https:'
  const port = hub.port ? ':' + hub.port : ''
  const origin = scheme + '//' + label + '.' + host + port
  const url = origin + '/#' + text + '#' + encodeGenesis(blocks)
  return { ledgerId, label, origin, url, record, text, blocks, gen, chain }
}

// ---------------------------------------------------------------------------------------------
// Followed ledgers (the hub amendment)
// ---------------------------------------------------------------------------------------------

function deviceCap (deviceClass) {
  return deviceClass === 'desktop' ? FOLLOW_CAPS.desktop : FOLLOW_CAPS.phone
}

/**
 * createHubService(deps) -> { methods: { 'hub.follow', 'hub.unfollow', 'hub.list', 'hub.createPage' }, on, read, follows, destroy }
 * deps:
 *   openLedger({ ledgerId, record }) -> Promise<ChainNode>   a read-only node with its own store (the loader's)
 *   closeLedger(ledgerId, node)                               optional: the loader forgets the node (hub lane map)
 *   multi                                                     MultiGossip (lane chain-net) or null: follow(id), unfollow(id)
 *   prefs: { get(key, dflt), set(key, value) }                where the follow list is kept (this origin)
 *   deviceClass: 'desktop' | 'android' | 'ios' | ...          follow caps: phones 250, desktop 1000
 *   verifyPointer(record) -> Promise<boolean>                 the record's signature for the hub scope
 *   createPage(params, ctx) -> Promise<result>                hub.createPage (createPersonalSite with the loader's deps)
 *   stateOf(node) -> state                                    optional: the display state of a followed ledger (the
 *                                                             recent window's view, lane chain-net recent.js viewOf);
 *                                                             default node.state
 *   snapshotOf(node) -> snapshot                              optional: its snapshot (db.snapshot); default node.snapshot()
 * viewAdapters(recentModule) gives both from recent.js.
 */

/**
 * viewAdapters(recent) -> { stateOf, snapshotOf } | null: the reduced state and the snapshot of a followed ledger as
 * the hub lane keeps it (src/chain/recent.js viewOf(node).state() -> { state, snapshot, unchecked, ... }), the node's
 * own when its view is empty. v0.3 reconciliation: the hub wiring passed the whole view result as the state, so
 * every followed read missed the recent window (its kv and lists are under .state).
 */
export function viewAdapters (recent) {
  if (!recent || typeof recent.viewOf !== 'function') return null
  const viewState = (node) => {
    try {
      const v = recent.viewOf(node)
      return v && v.size > 0 ? v.state() : null
    } catch (_) { return null }
  }
  return {
    stateOf: (node) => { const s = viewState(node); return s && s.state ? s.state : node.state },
    snapshotOf: (node) => { const s = viewState(node); return s && s.snapshot ? s.snapshot : (typeof node.snapshot === 'function' ? node.snapshot() : null) }
  }
}

export function createHubService (deps = {}) {
  const now = typeof deps.now === 'function' ? deps.now : () => Date.now()
  const setT = deps.setTimeout || ((fn, ms) => setTimeout(fn, ms))
  const clearT = deps.clearTimeout || ((t) => clearTimeout(t))
  const parsePointer = deps.parsePointer || parsePointerText
  const ledgerIdFor = deps.ledgerIdFor || ledgerIdOf
  const listeners = new Map()
  const followed = new Map() // ledgerId -> { ledger, record, text, node, since, off, timer }
  let destroyed = false
  let loaded = null

  const emit = (event, data) => {
    const set = listeners.get(event)
    if (!set) return
    for (const fn of Array.from(set)) { try { fn(data) } catch (_) { /* a listener's bug */ } }
  }
  const live = () => { if (destroyed) throw fail('E_POLICY', 'the hub service was stopped') }

  async function persist () {
    if (!deps.prefs || typeof deps.prefs.set !== 'function') return
    const list = Array.from(followed.values()).map((f) => Object.assign({ ledger: f.ledger, text: f.text || null, since: f.since }, f.private ? { private: true } : {}))
    try { await deps.prefs.set('hub:follows', list) } catch (_) { /* storage full: follows last for this page */ }
  }

  function watch (f) {
    if (!f.node || typeof f.node.subscribe !== 'function') return
    f.off = f.node.subscribe(() => {
      if (f.timer !== null && f.timer !== undefined) return
      f.timer = setT(() => {
        f.timer = null
        let height = 0
        try { height = f.node.height || 0 } catch (_) { height = 0 }
        emit('change', { ledger: f.ledger, height })
        refreshFrom(f).catch(() => {})
      }, CHANGE_THROTTLE_MS)
    })
  }

  const expiredRecord = (record) => {
    const e = Number(record && record.exp) * 1000
    return Number.isFinite(e) && e <= now()
  }

  /**
   * refreshFrom(f) -> true when the followed ledger holds a newer pointer of the same page (POINTER_KEY, written by its
   * owner when the old one neared its expiry): it verifies, names the same ledger and has a higher seq. The follow then
   * keeps that pointer (its link and its owner pin).
   */
  async function refreshFrom (f) {
    if (!f || !f.node) return false
    let text = null
    try {
      const st = stateOf(f.node)
      const e = st && st.kv instanceof Map ? st.kv.get(POINTER_KEY) : null
      const v = e === undefined || e === null ? null : kvEntryValue(e)
      text = typeof v === 'string' ? v : null
    } catch (_) { text = null }
    if (!text || text === f.text || text.length > 2048) return false
    let r = null
    try { r = await resolveTarget(text) } catch (_) { r = null }
    if (!r || r.ledger !== f.ledger || !r.record || Number(r.record.seq) <= Number(f.record && f.record.seq)) return false
    f.record = r.record
    f.text = r.text
    f.refreshedAt = now()
    await persist()
    emit('state', { ledger: f.ledger, refreshed: true })
    return true
  }

  async function open (ledger, record, text, since, { private: isPrivate = false } = {}) {
    // Review round R 5.3 (STALK-3): a private follow is pulled but never named in this tab's HAVE (multi.js follow private).
    const f = { ledger, record, text, node: null, since: since || now(), off: null, timer: null, private: isPrivate === true }
    if (typeof deps.openLedger === 'function') {
      f.node = await deps.openLedger({ ledgerId: ledger, record })
      watch(f)
    }
    followed.set(ledger, f)
    if (deps.multi && typeof deps.multi.follow === 'function') {
      try { deps.multi.follow(ledger, { private: f.private }) } catch (err) {
        if (err && err.code) throw err
      }
    }
    return f
  }

  async function close (f) {
    if (f.off) { try { f.off() } catch (_) { /* gone */ } }
    if (f.timer !== null && f.timer !== undefined) clearT(f.timer)
    if (deps.multi && typeof deps.multi.unfollow === 'function') { try { deps.multi.unfollow(f.ledger) } catch (_) { /* not followed there */ } }
    if (typeof deps.closeLedger === 'function') { try { deps.closeLedger(f.ledger, f.node) } catch (_) { /* the loader's map */ } }
    if (f.node && typeof f.node.close === 'function') { try { await f.node.close() } catch (_) { /* closing */ } }
  }

  /** load(): the follows this origin kept, opened again (called once, on the first method or by the loader). */
  function load () {
    if (loaded) return loaded
    loaded = (async () => {
      if (!deps.prefs || typeof deps.prefs.get !== 'function') return 0
      let list = []
      try { list = (await deps.prefs.get('hub:follows', [])) || [] } catch (_) { list = [] }
      let n = 0
      const one = async (it) => {
        if (!it || typeof it.ledger !== 'string' || followed.has(it.ledger)) return
        try {
          // A pointer that only expired still names its owner (the signature holds): the follow stays, flagged as not
          // refreshed since (hub.list expired), until the page's owner publishes a new one (refreshFrom).
          const r = it.text ? await resolveTarget(it.text, { allowExpired: true }) : null
          if (!r || r.ledger !== it.ledger || followed.has(r.ledger)) return
          const f = await open(r.ledger, r.record, r.text, it.since, { private: it.private === true })
          await refreshFrom(f)
          n++
        } catch (_) { /* a follow whose signature no longer verifies is dropped */ }
      }
      // In batches, not one after another: 250 follows on a phone are known within the first-screen budget (R 3.2.3).
      const seen = new Set()
      const all = (Array.isArray(list) ? list : []).filter((it) => it && typeof it.ledger === 'string' && !seen.has(it.ledger) && seen.add(it.ledger))
      for (let i = 0; i < all.length; i += LOAD_BATCH) await Promise.all(all.slice(i, i + LOAD_BATCH).map(one))
      return n
    })()
    return loaded
  }

  async function resolveTarget (target, { allowExpired = true } = {}) {
    if (typeof target !== 'string' || !target) throw fail('E_BAD_REQUEST', 'follow takes a pointer (v=mw1; ...) or the ledger id of a ledger you follow')
    let text = target.trim()
    const hash = text.indexOf('#')
    if (/^https?:\/\//i.test(text) && hash >= 0) text = text.slice(hash + 1)
    const second = text.indexOf('#')
    if (second >= 0) text = text.slice(0, second)
    if (LEDGER_RE.test(text)) {
      const known = followed.get(text)
      if (known) return { ledger: text, record: known.record, text: known.text }
      throw fail('E_BAD_REQUEST', 'follow a page by its link or pointer the first time (the pointer pins its owner)')
    }
    try { text = decodeURIComponent(text) } catch (_) { /* already decoded */ }
    const parsed = parsePointer(text)
    if (!parsed || !parsed.ok || !parsed.record || !parsed.record.signed) throw fail('E_BAD_REQUEST', 'not a signed pointer')
    const record = parsed.record
    if (typeof deps.verifyPointer === 'function' && !(await deps.verifyPointer(record, { allowExpired }))) throw fail('E_BAD_REQUEST', 'the pointer signature does not verify')
    const ledger = await ledgerIdFor(record, hubScope(record.btih))
    return { ledger, record, text }
  }

  const methods = {
    async 'hub.follow' (params = {}) {
      live()
      await load()
      const r = await resolveTarget(params.target !== undefined ? params.target : (params.pointer || params.ledger))
      const isPrivate = !!(params.opts && typeof params.opts === 'object' && params.opts.private === true)
      if (followed.has(r.ledger)) {
        const known = followed.get(r.ledger)
        if (isPrivate && !known.private) {
          known.private = true
          if (deps.multi && typeof deps.multi.follow === 'function') { try { deps.multi.follow(r.ledger, { private: true }) } catch (_) { /* followed there */ } }
          await persist()
        }
        return { ledger: r.ledger, following: followed.size, already: true }
      }
      const cap = deviceCap(deps.deviceClass)
      if (followed.size >= cap) throw fail('E_LIMIT', 'You follow ' + followed.size + ' of ' + cap + ' on this ' + (cap === FOLLOW_CAPS.desktop ? 'computer' : 'phone'))
      await open(r.ledger, r.record, r.text, undefined, { private: isPrivate })
      await persist()
      emit('follow', { ledger: r.ledger })
      return { ledger: r.ledger, following: followed.size, cap }
    },
    async 'hub.unfollow' (params = {}) {
      live()
      await load()
      const ledger = params.ledger !== undefined ? params.ledger : params.target
      const f = followed.get(ledger)
      if (!f) return { ledger, following: followed.size, removed: false }
      followed.delete(ledger)
      await close(f)
      await persist()
      emit('unfollow', { ledger })
      return { ledger, following: followed.size, removed: true }
    },
    async 'hub.list' () {
      live()
      await load()
      return Array.from(followed.values()).map((f) => {
        let height = 0
        try { height = f.node ? f.node.height || 0 : 0 } catch (_) { height = 0 }
        const out = { ledger: f.ledger, owner: f.record ? f.record.owner : null, since: f.since, height, pointer: f.text || null }
        // The page's pointer expired and its owner has not published a new one since (code review v0.3, correctness).
        if (expiredRecord(f.record)) out.expired = true
        if (f.refreshedAt) out.refreshedAt = f.refreshedAt
        return out
      })
    },
    async 'hub.createPage' (params = {}, ctx = {}) {
      live()
      if (!ctx || ctx.activation !== true) throw fail('E_NEEDS_GESTURE', 'call this from a click')
      if (typeof deps.createPage !== 'function') throw fail('E_POLICY', 'personal pages exist only on a hub')
      return deps.createPage(params, ctx)
    }
  }

  // The state a followed ledger is read from: the recent window's view when the hub lane keeps one (lane chain-net).
  function stateOf (node) {
    try {
      if (typeof deps.stateOf === 'function') {
        const st = deps.stateOf(node)
        if (st) return st
      }
      return node.state || null
    } catch (_) { return null }
  }

  /** read(ledger, method, args): db.get, db.list, db.snapshot, db.listBy on a followed ledger (read only). */
  async function read (ledger, method, args = []) {
    live()
    await load()
    const f = followed.get(ledger)
    if (!f || !f.node) throw fail('E_POLICY', 'follow this ledger first (mw.hub.follow)')
    const node = f.node
    const st = stateOf(node)
    const snapshotOf = () => (typeof deps.snapshotOf === 'function' ? deps.snapshotOf(node) : node.snapshot())
    const viewNode = st ? { state: st, snapshot: snapshotOf } : node
    switch (method) {
      case 'db.get': {
        let kv = null
        try { kv = st && st.kv instanceof Map ? st.kv : null } catch (_) { kv = null }
        if (kv) { const e = kv.get(args[0]); return e === undefined ? undefined : kvEntryValue(e) }
        const snap = typeof node.snapshot === 'function' ? node.snapshot() : null
        const o = snap ? plainOf(snap.kv) : {}
        return Object.prototype.hasOwnProperty.call(o, args[0]) ? kvEntryValue(o[args[0]]) : undefined
      }
      case 'db.list': return listOfNode(viewNode, args[0], args[1] || { limit: 100, newestFirst: true })
      case 'db.snapshot': {
        let snap = null
        try { snap = typeof deps.snapshotOf === 'function' ? deps.snapshotOf(node) : (typeof node.snapshot === 'function' ? node.snapshot() : null) } catch (_) { snap = null }
        return snap ? Object.assign({ ledger }, snap) : null
      }
      case 'db.listBy': {
        let kv = null
        try { kv = st && st.kv instanceof Map ? st.kv : null } catch (_) { kv = null }
        return listScoped(kv || new Map(), args[0])
      }
      default: throw fail('E_BAD_REQUEST', method + ' cannot read a followed ledger')
    }
  }

  return {
    methods,
    read,
    load,
    /** refresh(ledger) -> Promise<boolean>: look for a newer pointer of that followed page now (tests, the loader). */
    refresh: (ledger) => refreshFrom(followed.get(ledger)),
    follows: () => Array.from(followed.keys()),
    node: (ledger) => { const f = followed.get(ledger); return f ? f.node : null },
    on (event, fn) {
      if (HUB_EVENTS.indexOf(event) < 0) throw fail('E_BAD_REQUEST', 'unknown event ' + event)
      if (!listeners.has(event)) listeners.set(event, new Set())
      listeners.get(event).add(fn)
      return () => listeners.get(event).delete(fn)
    },
    async destroy () {
      destroyed = true
      const all = Array.from(followed.values())
      followed.clear()
      for (const f of all) await close(f)
      listeners.clear()
    }
  }
}

export { DEFAULT_POLICY }
