// Unit tests for src/sdk/sdk.js (ARCHITECTURE section 9, INTERFACES "src/sdk/sdk.js"), v0.2 surface.
// Shell mode runs against the real Bridge (src/loader/bridge.js) over a real MessageChannel, so the
// wire shapes of both sides are checked together. Timers are injected (a fake clock, or real timers
// that are unref'd) and every port is closed, so this file exits on its own.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

import { createSdk, looksLikeApi, SDK_VERSION, ERROR_CODES } from '../../src/sdk/sdk.js'
import { Bridge } from '../../src/loader/bridge.js'

const ORIGIN = 'https://site.test'
// Algorithm-tagged key shapes (v0.2.1 A2): 'p256:' + 87 base64url characters of a 0x04 point.
const PUB = 'p256:B' + 'A'.repeat(86)
const OTHER = 'p256:B' + 'A'.repeat(85) + 'E'
const hex64 = (n) => n.toString(16).padStart(64, '0')

// ---- helpers ----------------------------------------------------------------------------------

/** Real timers that never keep the process alive. */
const unrefTimers = {
  setTimeout: (fn, ms) => { const t = setTimeout(fn, ms); if (t && t.unref) t.unref(); return t },
  clearTimeout: (t) => clearTimeout(t)
}

class FakeClock {
  constructor () { this.t = 0; this.timers = new Map(); this.id = 0 }
  setTimeout (fn, ms) { const id = ++this.id; this.timers.set(id, { fn, at: this.t + Math.max(0, ms || 0) }); return id }
  clearTimeout (id) { this.timers.delete(id) }
  get api () { return { setTimeout: (fn, ms) => this.setTimeout(fn, ms), clearTimeout: (id) => this.clearTimeout(id) } }
  async tick (ms) {
    const end = this.t + ms
    for (;;) {
      let next = null
      for (const [id, tm] of this.timers) if (tm.at <= end && (!next || tm.at < next[1].at)) next = [id, tm]
      if (!next) break
      this.timers.delete(next[0])
      this.t = next[1].at
      next[1].fn()
      await flush()
    }
    this.t = end
    await flush()
  }
}

function flush () { return new Promise((resolve) => setImmediate(resolve)) }

/** A ledger node with the parts the Bridge reads (state Maps, snapshot, subscribe, writes). */
function fakeNode ({ role = 'writer' } = {}) {
  const kv = new Map()
  const lists = new Map()
  const profiles = new Map()
  const subs = new Set()
  let height = 0
  const changed = () => { for (const fn of subs) fn() }
  const node = {
    role,
    identity: { pub: PUB },
    peers: 2,
    inSyncPeers: 1,
    get height () { return height },
    state: { kv, lists, policy: { maxValueBytes: 2048 } },
    snapshot () {
      const o = (m) => { const out = {}; for (const [k, v] of m) out[k] = v; return out }
      return { height, kv: o(kv), lists: o(lists), profiles: o(profiles), policy: { writers: 'open', bits: 0, moderators: [], banned: [] }, owner: OTHER, authors: 1 }
    },
    subscribe (fn) { subs.add(fn); return () => subs.delete(fn) },
    async put (k, v) { height++; const h = hex64(height); kv.set(k, { v, author: PUB, h, ts: height }); changed(); return { h } },
    async del (k) { return node.put(k, null) },
    async append (l, v) {
      height++
      const h = hex64(height)
      if (!lists.has(l)) lists.set(l, [])
      lists.get(l).push({ h, author: PUB, ts: height, v })
      changed()
      return { h }
    },
    async tombstone (h) { height++; for (const items of lists.values()) { const i = items.findIndex((x) => x.h === h); if (i >= 0) items.splice(i, 1) } changed(); return { h: hex64(height) } },
    async profile (name) { height++; profiles.set(PUB, name); changed(); return { h: hex64(height) } },
    async ban () { height++; return { h: hex64(height) } }
  }
  return node
}

/**
 * A shell page with the real Bridge and a site frame window for the SDK. ignoreHellos: the first n
 * hellos are dropped (the shell is not listening yet).
 */
function shell ({ node = fakeNode(), ignoreHellos = 0, consentState = 'pending', srcdoc = false, ui = undefined, activation = null, identity = null } = {}) {
  const listeners = new Set()
  const parentWin = {
    location: { origin: ORIGIN },
    addEventListener (type, fn) { if (type === 'message') listeners.add(fn) },
    removeEventListener (type, fn) { listeners.delete(fn) },
    hellos: [],
    postMessage (data, targetOrigin, transfer) {
      parentWin.hellos.push({ data, targetOrigin })
      if (parentWin.hellos.length <= ignoreHellos) {
        for (const p of transfer || []) { try { p.close() } catch (_) { /* ignore */ } }
        return
      }
      const ev = { source: frameWin, origin: ORIGIN, data, ports: transfer || [] }
      for (const fn of listeners) fn(ev)
    }
  }
  // srcdoc: limited mode (ARCHITECTURE 7.4) renders the site as an about:srcdoc document, which
  // inherits the shell's origin (window.origin) while its location.origin is "null".
  const frameWin = srcdoc ? { origin: ORIGIN, location: { origin: 'null', href: 'about:srcdoc' }, parent: parentWin } : { location: { origin: ORIGIN }, parent: parentWin }
  if (srcdoc) parentWin.origin = ORIGIN
  let consent = consentState
  // The loader-owned consent card (v0.2.1 A4): the visitor clicks OK there; the site only asks.
  const card = { opened: 0 }
  const loaderUi = ui !== undefined ? ui : { openConsent: async () => { card.opened++; consent = 'accepted'; return consent } }
  const bridge = new Bridge({
    iframe: { contentWindow: frameWin },
    node,
    torrentManager: null,
    consent: { state: () => consent },
    ui: loaderUi,
    info: () => ({ siteId: 'mw1:test', btih: 'f'.repeat(40), mode: 'shell', name: 'demo', files: [{ path: 'index.html', length: 10, type: 'text/html' }], owner: OTHER, unmoderated: false, source: 'webseed' }),
    identity: identity || { current: () => ({ pub: PUB, short: 'abcd1234', name: null }) },
    win: parentWin,
    origin: ORIGIN,
    // v0.3: what the loader's ActivationTracker reports for the site frame (a trusted click there); null: none.
    activation
  })
  bridge.attach()
  return { parentWin, frameWin, bridge, node, card, close: () => bridge.destroy() }
}

test('v0.3 final integration: ready() follows the sign-in; calls made while the first is pending share it', async () => {
  let who = null
  const s = shell({ identity: { current: () => who } })
  try {
    const mw = createSdk({ win: s.frameWin, doc: null, global: {}, ...unrefTimers })
    const first = mw.ready()
    assert.equal(mw.ready(), first, 'a call made before the loader answered shares the pending one')
    const guest = await first
    assert.equal(guest.auth, 'guest')
    assert.equal(guest.identity, null)
    who = { pub: PUB, short: 'abcd1234', name: null }
    const signedIn = await mw.ready()
    assert.equal(signedIn.auth, 'signed-in', 'the second answer is fresh: the page sees the sign-in')
    assert.equal(signedIn.identity.pub, PUB)
    who = null
    assert.equal((await mw.ready()).auth, 'guest', 'and the sign-out')
  } finally {
    s.close()
  }
})

// ---- standalone -------------------------------------------------------------------------------

test('standalone (not inside felinar): calls reject with E_NO_HOST, owner.policy with E_NOT_OWNER', async () => {
  const win = { location: { origin: ORIGIN } }
  win.parent = win
  const mw = createSdk({ win, doc: null, global: {} })
  assert.equal(looksLikeApi(mw), true)
  await assert.rejects(mw.ready(), (e) => e instanceof Error && e.code === 'E_NO_HOST')
  await assert.rejects(mw.db.get('k'), { code: 'E_NO_HOST' })
  await assert.rejects(mw.db.set('k', 1), { code: 'E_NO_HOST' })
  await assert.rejects(mw.db.list('g'), { code: 'E_NO_HOST' })
  await assert.rejects(mw.db.append('g', { a: 1 }), { code: 'E_NO_HOST' })
  await assert.rejects(mw.site.info(), { code: 'E_NO_HOST' })
  await assert.rejects(mw.identity.setName('x'), { code: 'E_NO_HOST' })
  await assert.rejects(mw.consent.request(), { code: 'E_NO_HOST' })
  await assert.rejects(mw.owner.policy({ writers: 'owner' }), { code: 'E_NOT_OWNER' })
  assert.equal(mw.net.peers(), 0)
  const off = mw.db.subscribe(() => {})
  assert.equal(typeof off, 'function')
  off()
})

test('client-side validation happens before any message is sent', async () => {
  const win = { location: { origin: ORIGIN } }
  win.parent = win
  const mw = createSdk({ win, doc: null, global: {} })
  await assert.rejects(mw.db.get(''), { code: 'E_LIMIT' })
  await assert.rejects(mw.db.get(5), { code: 'E_LIMIT' })
  await assert.rejects(mw.db.set('k', undefined), { code: 'E_LIMIT' })
  await assert.rejects(mw.db.set('k', { d: new Date(0) }), { code: 'E_LIMIT' })
  await assert.rejects(mw.db.append('g', NaN), { code: 'E_LIMIT' })
  await assert.rejects(mw.db.list('g', { limit: 0 }), { code: 'E_LIMIT' })
  await assert.rejects(mw.db.tombstone('xyz'), { code: 'E_LIMIT' })
  await assert.rejects(mw.mod.ban(''), { code: 'E_LIMIT' })
  // v0.2.1 A4: identity export/import and consent decisions are not site-callable at all.
  assert.equal(mw.identity.export, undefined)
  assert.equal(mw.identity.import, undefined)
  assert.equal(mw.consent.accept, undefined)
  // v0.3 (R 2.11.2): identity.current, backupStatus and openIdentity join setName.
  assert.deepEqual(Object.keys(mw.identity).sort(), ['backupStatus', 'current', 'openIdentity', 'setName'])
  assert.deepEqual(Object.keys(mw.consent).sort(), ['request', 'state'])
  assert.throws(() => mw.db.subscribe('nope'), { code: 'E_LIMIT' })
  assert.throws(() => mw.net.on('', () => {}), { code: 'E_LIMIT' })
  assert.throws(() => mw.net.on('peers', 'nope'), { code: 'E_LIMIT' })
})

// ---- shell mode against the real Bridge ----------------------------------------------------------

test('shell: handshake with the Bridge, ready(), reads, writes, errors and pushes', async () => {
  const s = shell()
  try {
    const mw = createSdk({ win: s.frameWin, doc: null, global: {}, ...unrefTimers })
    const info = await mw.ready()
    assert.equal(s.parentWin.hellos.length, 1, 'one hello was enough')
    assert.equal(s.parentWin.hellos[0].data.mw, 'hello')
    assert.equal(s.parentWin.hellos[0].data.proto, 1)
    assert.equal(s.parentWin.hellos[0].data.sdk, SDK_VERSION)
    assert.equal(s.parentWin.hellos[0].targetOrigin, ORIGIN, 'targetOrigin is the page origin, never *')
    assert.equal(info.siteId, 'mw1:test')
    assert.equal(info.btih, 'f'.repeat(40))
    assert.equal(info.mode, 'shell')
    // v0.3: the identity carries its mode ('legacy': the 0.2.1 per-site key of this test's identity provider).
    assert.deepEqual(info.identity, { pub: PUB, short: 'abcd1234', name: null, mode: 'legacy' })
    assert.equal(info.role, 'writer')
    assert.equal(info.owner, OTHER)
    assert.equal(info.unmoderated, false)
    // v0.3 final integration: a later ready() asks the loader again (auth and identity follow the sign-in, docs/SDK.md).
    assert.deepEqual(await mw.ready(), info, 'a later ready() gets the same answer while nothing changed')

    // writes resolve to { h }; reads see them
    const a = await mw.db.append('guestbook', { msg: 'one' })
    const b = await mw.db.append('guestbook', { msg: 'two' })
    assert.match(a.h, /^[0-9a-f]{64}$/)
    assert.notEqual(a.h, b.h)
    const newest = await mw.db.list('guestbook')
    assert.deepEqual(newest.map((x) => x.v.msg), ['two', 'one'], 'newest first by default')
    const oldest = await mw.db.list('guestbook', { limit: 1, newestFirst: false })
    assert.deepEqual(oldest.map((x) => x.v.msg), ['one'])
    await mw.db.set('_notice', 'hello')
    assert.equal(await mw.db.get('_notice'), 'hello')
    assert.equal(await mw.db.get('missing'), undefined)
    await mw.db.del('_notice')
    assert.equal(await mw.db.get('_notice'), null)
    await mw.db.tombstone(a.h)
    assert.deepEqual((await mw.db.list('guestbook')).map((x) => x.v.msg), ['two'])
    await mw.identity.setName('Ash')

    // errors carry the documented codes; v0.3: mod.ban is a UI method, so without a click in the site frame the
    // boundary answers E_NEEDS_GESTURE before the moderator check (docs/SDK.md "Gating")
    await assert.rejects(mw.mod.ban(OTHER), (e) => e.code === 'E_NEEDS_GESTURE' && e instanceof Error)
    await assert.rejects(mw.owner.policy({ writers: 'owner' }), { code: 'E_NOT_OWNER' })
    await assert.rejects(mw.db.set('k', 'x'.repeat(3000)), { code: 'E_LIMIT' }, 'value above maxValueBytes is refused by the Bridge')

    // site info and consent
    const si = await mw.site.info()
    assert.deepEqual(si, { name: 'demo', files: [{ path: 'index.html', length: 10 }], btih: 'f'.repeat(40), source: 'webseed', mode: 'shell' })
    assert.equal(await mw.consent.state(), 'pending')
    assert.equal(await mw.consent.request(), 'accepted', 'the loader card opened and the visitor accepted there')
    assert.equal(s.card.opened, 1)
    assert.equal(await mw.consent.state(), 'accepted')
    assert.equal(await mw.consent.request(), 'accepted', 'decided: nothing opens')
    assert.equal(s.card.opened, 1)
  } finally {
    s.close()
  }
})

test('v0.3: after a click in the site frame, a non-moderator ban is E_NOT_MODERATOR and writes nothing', async () => {
  const node = fakeNode()
  let banned = 0
  node.ban = async () => { banned++; return { h: hex64(99) } }
  const s = shell({ node, activation: () => true })
  try {
    const mw = createSdk({ win: s.frameWin, doc: null, global: {}, ...unrefTimers })
    await mw.ready()
    await assert.rejects(mw.mod.ban(OTHER), (e) => e.code === 'E_NOT_MODERATOR' && e instanceof Error)
    assert.equal(banned, 0)
  } finally {
    s.close()
  }
})

test('limited mode: an about:srcdoc site frame (location.origin "null") reaches the Bridge with the shell origin', async () => {
  const s = shell({ srcdoc: true })
  try {
    const mw = createSdk({ win: s.frameWin, doc: null, global: {}, ...unrefTimers })
    const info = await mw.ready()
    assert.equal(info.siteId, 'mw1:test')
    assert.equal(s.parentWin.hellos.length, 1)
    assert.equal(s.parentWin.hellos[0].targetOrigin, ORIGIN, 'the hello targets the inherited origin, not "null"')
    assert.deepEqual((await mw.site.info()).btih, 'f'.repeat(40))
  } finally {
    s.close()
  }
})

test('shell: subscribe gets the pushed snapshot (also a late subscriber); net.on gets peers', async () => {
  const s = shell()
  try {
    const mw = createSdk({ win: s.frameWin, doc: null, global: {}, ...unrefTimers })
    const snaps = []
    const off = mw.db.subscribe((snap) => snaps.push(snap))
    const peers = []
    const offPeers = mw.net.on('peers', (d) => peers.push(d.count))
    await mw.ready()
    for (let i = 0; i < 50 && !snaps.length; i++) await new Promise((r) => setTimeout(r, 10))
    assert.ok(snaps.length >= 1, 'the Bridge pushes a snapshot after the handshake')
    assert.equal(snaps[snaps.length - 1].peers, 2)
    assert.equal(snaps[snaps.length - 1].inSync, 1)
    await mw.db.append('guestbook', { msg: 'hi' })
    for (let i = 0; i < 100 && !(snaps.length && snaps[snaps.length - 1].height === 1); i++) await new Promise((r) => setTimeout(r, 10))
    const last = snaps[snaps.length - 1]
    assert.equal(last.height, 1)
    assert.equal(last.lists.guestbook[0].v.msg, 'hi')
    const late = []
    mw.db.subscribe((snap) => late.push(snap))
    await flush()
    assert.equal(late.length, 1, 'a late subscriber first gets the latest snapshot')
    assert.ok(peers.length >= 1)
    s.bridge.push('peers', { count: 7 })
    for (let i = 0; i < 50 && peers[peers.length - 1] !== 7; i++) await new Promise((r) => setTimeout(r, 10))
    assert.equal(mw.net.peers(), 7)
    off()
    offPeers()
  } finally {
    s.close()
  }
})

test('shell: a shell that is not listening yet is reached by the 500 ms hello retry', async () => {
  const clock = new FakeClock()
  const s = shell({ ignoreHellos: 2 })
  try {
    const mw = createSdk({ win: s.frameWin, doc: null, global: {}, ...clock.api })
    const p = mw.ready()
    await flush()
    assert.equal(s.parentWin.hellos.length, 1)
    await clock.tick(500)
    assert.equal(s.parentWin.hellos.length, 2)
    await clock.tick(500)
    assert.equal(s.parentWin.hellos.length, 3, 'the third hello is the first one the shell sees')
    for (let i = 0; i < 20; i++) await flush()
    const info = await p
    assert.equal(info.siteId, 'mw1:test')
    await clock.tick(5000)
    assert.equal(s.parentWin.hellos.length, 3, 'no more hellos once connected')
    assert.equal(await mw.db.get('nothing'), undefined)
  } finally {
    s.close()
    await clock.tick(30000) // runs the SDK's deferred port cleanup
  }
})

test('shell: a silent parent gives E_NO_HOST after 20 s, and a later call starts a new handshake', async () => {
  const clock = new FakeClock()
  const parentWin = { location: { origin: ORIGIN }, hellos: 0, postMessage (data, o, transfer) { this.hellos++; for (const p of transfer || []) p.close() } }
  const frameWin = { location: { origin: ORIGIN }, parent: parentWin }
  const mw = createSdk({ win: frameWin, doc: null, global: {}, ...clock.api })
  const p = mw.ready()
  const rejected = assert.rejects(p, { code: 'E_NO_HOST' })
  await clock.tick(19999)
  assert.equal(parentWin.hellos, 40, 'a hello every 500 ms')
  await clock.tick(1)
  await rejected
  const sent = parentWin.hellos
  const p2 = mw.db.get('k')
  const rejected2 = assert.rejects(p2, { code: 'E_NO_HOST' })
  await flush()
  assert.equal(parentWin.hellos, sent + 1, 'a new call starts a new handshake')
  await clock.tick(20000)
  await rejected2
})

test('shell: an unanswered request gives E_TIMEOUT after 30 s; the connection survives', async () => {
  const clock = new FakeClock()
  const node = fakeNode()
  let hold = true
  const realPut = node.put
  node.put = (k, v) => (k === 'slow' && hold ? new Promise(() => {}) : realPut(k, v))
  const s = shell({ node })
  try {
    const mw = createSdk({ win: s.frameWin, doc: null, global: {}, ...clock.api })
    const ready = mw.ready()
    for (let i = 0; i < 20; i++) await flush()
    await ready
    const slow = mw.db.set('slow', 1)
    const timedOut = assert.rejects(slow, { code: 'E_TIMEOUT' })
    for (let i = 0; i < 10; i++) await flush()
    assert.equal(await mw.db.get('fast'), undefined)
    await clock.tick(29999)
    assert.equal(await mw.db.get('fast'), undefined, 'still connected')
    await clock.tick(1)
    await timedOut
    hold = false
    await mw.db.set('fast', 2)
    assert.equal(await mw.db.get('fast'), 2, 'the connection survives a timeout')
  } finally {
    s.close()
    await clock.tick(30000)
  }
})

test('shell: the SDK follows the port the Bridge adopted last', async () => {
  // The Bridge replaces its port on every hello (closing the previous one). A slow shell sees the
  // first hello only after the SDK has sent its retry: it adopts port 1, then port 2, and answers
  // on both. The SDK must settle on the newest port, the one the Bridge kept.
  const clock = new FakeClock()
  const s = shell()
  const held = []
  const deliver = s.parentWin.postMessage.bind(s.parentWin)
  s.parentWin.postMessage = (data, o, transfer) => {
    held.push([data, o, transfer])
    if (held.length === 2) { deliver(...held[0]); deliver(...held[1]) }
  }
  try {
    const mw = createSdk({ win: s.frameWin, doc: null, global: {}, ...clock.api })
    const p = mw.ready()
    await clock.tick(500)
    for (let i = 0; i < 20; i++) await flush()
    await clock.tick(1000)
    for (let i = 0; i < 20; i++) await flush()
    const info = await p
    assert.equal(info.siteId, 'mw1:test')
    await mw.db.set('k', 'v')
    assert.equal(await mw.db.get('k'), 'v')
  } finally {
    s.close()
    await clock.tick(30000)
  }
})

// ---- drop-in mode ----------------------------------------------------------------------------------

test('drop-in: calls are handed to the window.mw binding that /_mw/mw.js assigns later', async () => {
  const clock = new FakeClock()
  const G = {}
  const doc = { getElementsByTagName: () => [{ src: 'https://site.test/_mw/mw.js' }] }
  const win = { location: { origin: ORIGIN } }
  win.parent = win
  const mw = createSdk({ win, doc, global: G, installGlobal: true, ...clock.api })
  assert.equal(G.mw, mw, 'window.mw is the facade until the binding arrives')
  const calls = []
  const pushed = []
  const binding = {
    ready: async () => { calls.push('ready'); return { siteId: 'mw1:dropin', mode: 'dropin' } },
    db: {
      get: async (k) => { calls.push('get:' + k); return 'v' },
      set: async () => ({ h: hex64(1) }),
      del: async () => ({ h: hex64(2) }),
      list: async () => [],
      append: async (n, v) => { calls.push('append:' + n); return { h: hex64(3) } },
      tombstone: async () => ({ h: hex64(4) }),
      subscribe: (fn) => { pushed.push(fn); return () => {} }
    },
    mod: { ban: async () => ({ h: hex64(5) }) },
    identity: { setName: async () => ({ h: hex64(6) }), export: async () => 'x', import: async () => true },
    net: { peers: () => 4, on: () => () => {} },
    site: { info: async () => ({ name: 'n' }) },
    consent: { accept: async () => 'accepted', state: () => 'accepted' },
    owner: { policy: async () => { throw new Error('no') } }
  }
  const early = []
  mw.db.subscribe((snap) => early.push(snap))
  const p = mw.ready()
  await clock.tick(300)
  G.mw = binding // what /_mw/mw.js does
  await clock.tick(100)
  for (let i = 0; i < 10; i++) await flush()
  assert.deepEqual(await p, { siteId: 'mw1:dropin', mode: 'dropin' })
  assert.equal(G.mw, binding, 'window.mw now returns the binding')
  assert.equal(await mw.db.get('k'), 'v')
  assert.deepEqual(await mw.db.append('g', { a: 1 }), { h: hex64(3) })
  assert.equal(mw.net.peers(), 4)
  assert.equal(mw.consent.state(), 'accepted')
  assert.deepEqual(calls, ['ready', 'get:k', 'append:g'])
  assert.equal(pushed.length, 1, 'a subscription made before the binding moved over to it')
})

test('drop-in: no binding within 20 s gives E_NO_HOST', async () => {
  const clock = new FakeClock()
  const doc = { getElementsByTagName: () => [{ getAttribute: () => '/_mw/mw.js' }] }
  const win = { location: { origin: ORIGIN } }
  win.parent = win
  const mw = createSdk({ win, doc, global: {}, ...clock.api })
  const rejected = assert.rejects(mw.ready(), { code: 'E_NO_HOST' })
  await clock.tick(20000)
  await rejected
})

// ---- the module itself --------------------------------------------------------------------------------

test('default export: a facade on globalThis.mw, re-exported when a binding already exists', async () => {
  const before = Object.getOwnPropertyDescriptor(globalThis, 'mw')
  try {
    const mod = await import('../../src/sdk/sdk.js?default=1')
    assert.equal(looksLikeApi(mod.default), true)
    assert.equal(globalThis.mw, mod.default)
    const binding = createSdk({ win: null, doc: null, global: {} })
    delete globalThis.mw
    globalThis.mw = binding
    const again = await import('../../src/sdk/sdk.js?default=2')
    assert.equal(again.default, binding, 'an existing binding is re-exported, not wrapped')
  } finally {
    delete globalThis.mw
    if (before) Object.defineProperty(globalThis, 'mw', before)
  }
})

test('sdk.js source: no imports, no top-level await, the documented exports and error codes', () => {
  const src = readFileSync(new URL('../../src/sdk/sdk.js', import.meta.url), 'utf8')
  assert.ok(!/^\s*import\s/m.test(src), 'no static imports')
  assert.ok(!/^\s*await\s/m.test(src), 'no top-level await')
  const exported = (src.match(/^export\s+(?:default\s+)?(?:const|function|let|class)?\s*([A-Za-z_]\w*)/gm) || []).map((l) => l.replace(/^export\s+(default\s+)?(const|function|let|class)?\s*/, ''))
  assert.deepEqual(exported.sort(), ['ERROR_CODES', 'SDK_VERSION', 'createSdk', 'looksLikeApi', 'mw'].sort())
  for (const code of ['E_POLICY', 'E_LIMIT', 'E_RATE', 'E_NOT_OWNER', 'E_NOT_MODERATOR', 'E_POW_ABORTED', 'E_IDENTITY', 'E_NO_HOST', 'E_CAP', 'E_BANNED']) {
    assert.ok(ERROR_CODES.includes(code), code)
  }
})

test('v0.2.1 A4: the Bridge refuses identity export/import and consent.accept from the site frame; consent.request is deduplicated and cooled down', async () => {
  let opened = 0
  let release = null
  const ui = { openConsent: () => { opened++; return new Promise((resolve) => { release = resolve }) } }
  const s = shell({ ui })
  try {
    const mw = createSdk({ win: s.frameWin, doc: null, global: {}, ...unrefTimers })
    await mw.ready()
    // Raw requests over the port, as a hostile site would send them: unknown methods.
    const answers = []
    const respond = s.bridge._respond.bind(s.bridge)
    s.bridge._respond = (id, result, error) => { answers.push({ id, result, error }); return respond(id, result, error) }
    for (const method of ['identity.export', 'identity.import', 'consent.accept']) {
      const res = await s.bridge.dispatch(method, []).then(() => 'resolved', (e) => e.code)
      assert.equal(res, 'E_BAD_REQUEST', method + ' is not dispatched')
      await s.bridge.handleRequest({ id: 'x-' + method, method, params: { passphrase: 'long enough', blob: 'x' } })
      const env = answers.find((x) => x.id === 'x-' + method)
      assert.equal(env.error && env.error.code, 'E_BAD_REQUEST', method)
    }
    s.bridge._respond = respond
    // consent.request: one card for concurrent requests; closed without a choice -> 'pending'; cooldown.
    const a = s.bridge.dispatch('consent.request', [])
    const b = s.bridge.dispatch('consent.request', [])
    await flush()
    assert.equal(opened, 1)
    release('pending')
    assert.equal(await a, 'pending')
    assert.equal(await b, 'pending')
    assert.equal(await s.bridge.dispatch('consent.request', []), 'pending')
    assert.equal(opened, 1, 'a site cannot reopen a dismissed card within 10 s')
  } finally {
    s.close()
  }
})

// ---- code review round 1: the write fee (DESIGN-REVIEW item 4) ------------------------------

/** A miner the test drives: progress(n) reports hashes, finish() mines for real, abort rejects. */
function slowMiner () {
  const m = { jobs: [], aborted: 0 }
  m.mine = (entry, bits, { signal, onProgress } = {}) => new Promise((resolve, reject) => {
    const job = {
      progress: (n) => { if (onProgress) onProgress(n) },
      finish: async () => { const { mine } = await import('../../src/chain/pow.js'); resolve(await mine(entry, bits)) }
    }
    if (signal) signal.addEventListener('abort', () => { m.aborted++; reject(Object.assign(new Error('aborted'), { name: 'AbortError', code: 'E_POW_ABORTED' })) })
    m.jobs.push(job)
  })
  return m
}

async function feeLedger (miner) {
  const { ChainNode } = await import('../../src/chain/node.js')
  const { SITE, makeIdentity, policy, storeWith } = await import('./chain-net-helpers.mjs')
  const owner = await makeIdentity()
  const G = await policy(owner, { writers: 'open', bits: 4 }, [])
  const node = await ChainNode.open({ siteId: SITE, expectedOwner: owner.pub, store: await storeWith([G]), identity: await makeIdentity(), miner, config: { tickMs: 0 } })
  return node
}

test('code review round 1: write progress reaches the site and the status line, keeps the request alive, and an SDK timeout cancels the write (nothing ingested)', async () => {
  const clock = new FakeClock()
  const miner = slowMiner()
  const node = await feeLedger(miner)
  const status = []
  const s = shell({ node, ui: { openConsent: async () => 'accepted', setWriteProgress: (p) => status.push(p) } })
  try {
    const mw = createSdk({ win: s.frameWin, doc: null, global: {}, ...clock.api, now: () => clock.t })
    const ready = mw.ready()
    for (let i = 0; i < 20; i++) await flush()
    await ready
    const events = []
    mw.net.on('pow', (e) => events.push(e))
    // 1. Progress keeps a slow write alive past 30 s, and it is published when the fee is found.
    const seen = []
    const ok = mw.db.append('gb', 'slow but fine', { onProgress: (p) => seen.push(p) })
    while (miner.jobs.length < 1) await flush()
    for (let t = 0; t < 3; t++) {
      await clock.tick(25000)
      miner.jobs[0].progress((t + 1) * 1000)
      for (let i = 0; i < 5; i++) await flush()
    }
    assert.deepEqual(seen.map((p) => p.hashes), [1000, 2000, 3000])
    assert.deepEqual(seen[0], { hashes: 1000, bits: 4 })
    assert.equal(events.length, 3)
    assert.equal(typeof events[0].id, 'number', 'the push names the write request')
    assert.ok(status.some((p) => p && p.hashes === 3000), 'the loader status line shows the fee')
    await miner.jobs[0].finish()
    const res = await ok
    assert.match(res.h, /^[0-9a-f]{64}$/)
    assert.ok(node.dag.has(res.h))
    assert.equal(status[status.length - 1], null, 'the status line is cleared afterwards')
    const height = node.height
    // 2. No answer and no progress for 30 s: E_TIMEOUT, and the host cancels the write.
    const lost = mw.db.append('gb', 'given up')
    const timedOut = assert.rejects(lost, { code: 'E_TIMEOUT' })
    while (miner.jobs.length < 2) await flush()
    await clock.tick(30000)
    await timedOut
    for (let i = 0; i < 20 && miner.aborted < 1; i++) await flush()
    assert.equal(miner.aborted, 1, 'the SDK told the host to stop mining')
    await miner.jobs[1].finish().catch(() => {})
    for (let i = 0; i < 10; i++) await flush()
    assert.equal(node.height, height, 'a write the site saw fail is never ingested')
    // 3. The site's own AbortSignal cancels as well.
    const ac = new AbortController()
    const cancelled = mw.db.set('k', 1, { signal: ac.signal })
    while (miner.jobs.length < 3) await flush()
    ac.abort()
    await assert.rejects(cancelled, { code: 'E_POW_ABORTED' })
    for (let i = 0; i < 20 && miner.aborted < 2; i++) await flush()
    assert.equal(miner.aborted, 2)
    assert.equal(node.height, height)
    assert.equal(s.bridge._inflight.size, 0, 'nothing is left in flight')
  } finally {
    s.close()
    await node.close()
    await clock.tick(60000)
  }
})
