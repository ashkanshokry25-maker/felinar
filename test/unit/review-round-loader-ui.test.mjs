// Regression tests of the loader-ui fixer, review round R 5.3 (2026-10-24): one block per finding id, each failing on the
// code before the fix. The record is docs/deviations/review-round-loader-ui.md.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { createModService, listingVisible, listedKeysOf, pendingListings, idKey, listedId, LISTED_PREFIX } from '../../src/loader/mod.js';
import { keygen } from '../../tools/keygen.mjs';
import { createGenesis, appendControl, loadLedger, ledgerIdForOwner, acceptListing } from '../../tools/ledger-admin.mjs';
import { loadOwnerKey } from '../../tools/lib.mjs';
import { generateKeyPair, exportPublicKey } from '../../src/chain/crypto.js';
import { createBlock } from '../../src/chain/block.js';

const H = (c) => String(c).repeat(64).slice(0, 64);

// ------------------------------------------------------------------------------------------- MAL53-1 (premoderation)

function modNode ({ lists = new Map(), kv = new Map(), modPub = 'p256:mod', owner = 'p256:owner', allow = [], moderators = [] } = {}) {
  const puts = []
  const ops = []
  let n = 0
  const node = {
    role: 'moderator',
    identity: { pub: modPub },
    state: { lists, kv, owner, policy: { moderators: new Set(moderators), allow: new Set(allow) } },
    async put (k, v) { puts.push([k, v]); kv.set(k, { v, h: H(String((++n) % 10)), author: modPub, ts: 1000 }); return { h: 'p'.repeat(63) + n } },
    async writeControl (op) { ops.push(op); return { h: 'c'.repeat(63) + (++n) } },
  }
  return { node, puts, ops }
}
const modApi = (node) => ({ node, identity: { keys: () => null, info: () => ({ pub: node.identity.pub }) }, prompt: async () => true, infoNow: () => ({}), service: () => null })
const listing = (h, author, ih, ts = 1) => ({ h, author, ts, v: { ih, len: 5, name: 'f.txt', mime: 'text/plain', t: ts } })

test('MAL53-1: an accepted infohash credits only its own author; a stranger who re-lists it stays premoderated', async () => {
  const X = 'a'.repeat(40)
  const Y = 'b'.repeat(40)
  const Z = 'c'.repeat(40)
  const items = [listing(H('1'), 'p256:alice', X, 1)]
  const lists = new Map([['mw.files', items]])
  const { node, puts } = modNode({ lists })
  const mod = createModService({ api: modApi(node) })
  const q = await mod.methods['mod.queue']({}, {})
  await mod.methods['mod.decide']({ id: q[0].id, decision: 'accept' }, { activation: true })
  assert.deepEqual(puts.map((p) => p[0]), [await idKey(LISTED_PREFIX, listedId(X, 'p256:alice'))], 'the key binds the infohash and the author')
  assert.deepEqual(puts[0][1].author, 'p256:alice')
  assert.equal(puts[0][1].ih, X)
  assert.equal(listingVisible(node.state, items[0]), true, 'the accepted listing is shown')
  // The attack: C lists the accepted infohash X, then an unvetted file Y.
  const cx = listing(H('2'), 'p256:mallory', X, 2)
  const cy = listing(H('3'), 'p256:mallory', Y, 3)
  items.push(cx, cy)
  assert.equal(listingVisible(node.state, cx), false, 're-listing an accepted infohash is not an acceptance')
  assert.equal(listingVisible(node.state, cy), false, 'and gives the re-lister no standing')
  assert.ok(!listedKeysOf(node.state).authors.has('p256:mallory'))
  assert.deepEqual(pendingListings(node.state).map((x) => x.h).sort(), [H('2'), H('3')], 'both wait in the moderators\' queue')
  // Alice stays past premoderation: her later listing Z is shown.
  const az = listing(H('4'), 'p256:alice', Z, 4)
  items.push(az)
  assert.equal(listingVisible(node.state, az), true)
  mod.destroy()
})

test('MAL53-1: a legacy _listed/<hash(ih)> key credits only a sole lister whose listing predates the acceptance', async () => {
  const X = 'd'.repeat(40)
  const legacyKey = await idKey(LISTED_PREFIX, X)
  const kv = new Map([[legacyKey, { v: { by: 'p256:owner', t: 50 }, h: H('9'), author: 'p256:owner', ts: 50 }]])
  const alice = listing(H('1'), 'p256:alice', X, 10)
  const lists = new Map([['mw.files', [alice]]])
  const st = { lists, kv, owner: 'p256:owner', policy: { moderators: new Set(), allow: new Set() } }
  assert.equal(listingVisible(st, alice), true, 'the ledger-admin acceptance of a sole lister keeps working')
  const late = { lists: new Map([['mw.files', [listing(H('2'), 'p256:late', X, 60)]]]), kv, owner: 'p256:owner', policy: st.policy }
  assert.equal(listingVisible(late, late.lists.get('mw.files')[0]), false, 'a listing written after the acceptance was never seen by a moderator')
  lists.get('mw.files').push(listing(H('3'), 'p256:mallory', X, 20), listing(H('4'), 'p256:mallory', 'e'.repeat(40), 21))
  assert.equal(listingVisible(st, lists.get('mw.files')[2]), false, 'two listers of one infohash: the legacy key credits nobody')
  assert.equal(listingVisible(st, lists.get('mw.files')[1]), false)
  // A legacy value that names its author credits exactly that author.
  kv.set(legacyKey, { v: { by: 'p256:owner', t: 50, author: 'p256:alice' }, h: H('9'), author: 'p256:owner', ts: 50 })
  assert.equal(listingVisible(st, alice), true)
  assert.equal(listingVisible(st, lists.get('mw.files')[2]), false)
})

const work = mkdtempSync(join(tmpdir(), 'mw-loader-ui-'))
after(() => rmSync(work, { recursive: true, force: true }))

test('MAL53-1 on a real open ledger: owner accepts (alice, X); mallory lists X then Y; Y stays pending', async () => {
  const T = 1790000000000
  const MIN = 60000
  const file = join(work, 'owner.jwk')
  await keygen({ out: file })
  const owner = await loadOwnerKey(file)
  const ledgerId = await ledgerIdForOwner(owner.pub, { scope: 'example.com' })
  let blocks = [await createGenesis({ identity: owner, ledgerId, policy: { writers: 'open', bits: 0 }, now: T })]
  const person = async () => { const { publicKey, privateKey } = await generateKeyPair({ extractable: false }); return { pub: await exportPublicKey(publicKey), privateKey } }
  const append = async (who, ih, ts) => {
    const led = await loadLedger(blocks)
    const prev = led.dag.heads({ limit: 8 }).slice().sort()
    const seq = led.dag.order().filter((b) => b.e.author === who.pub).length
    blocks = blocks.concat([await createBlock({ identity: who, site: ledgerId, seq, prev, op: { t: 'append', l: 'mw.files' }, value: { ih, len: 5, name: 'n.txt', mime: 'text/plain', t: ts }, ts, bits: 0 })])
  }
  const alice = await person()
  const mallory = await person()
  const X = '1'.repeat(40)
  const Y = '2'.repeat(40)
  await append(alice, X, T + MIN)
  // The loader's bound acceptance (what mod.decide writes now).
  const key = await idKey(LISTED_PREFIX, listedId(X, alice.pub))
  blocks = (await appendControl({ blocks, identity: owner, now: T + 2 * MIN, op: { t: 'put', k: key }, value: { by: owner.pub, t: T + 2 * MIN, ih: X, author: alice.pub } })).blocks
  await append(mallory, X, T + 3 * MIN)
  await append(mallory, Y, T + 4 * MIN)
  let st = (await loadLedger(blocks)).state
  const find = (who, ih) => st.lists.get('mw.files').find((it) => it.author === who.pub && it.v.ih === ih)
  assert.equal(listingVisible(st, find(alice, X)), true)
  assert.equal(listingVisible(st, find(mallory, X)), false)
  assert.equal(listingVisible(st, find(mallory, Y)), false)
  assert.ok(pendingListings(st).some((p) => p.author === mallory.pub && p.ih === Y), 'Y reaches the moderators')
  // Integrator (MAL53-1, request R9): the ledger-admin tool binds its acceptance to the author and refuses an infohash two keys
  // listed unless --author names one.
  await assert.rejects(acceptListing({ blocks, identity: owner, ih: X, now: T + 5 * MIN }), /--author/)
  const bound = await acceptListing({ blocks, identity: owner, ih: X, author: alice.pub, now: T + 5 * MIN })
  assert.equal(bound.key, key, 'the same bound key the loader writes')
  // A legacy key (ih only), as the tool wrote it before, on an infohash two keys listed credits neither.
  blocks = (await appendControl({ blocks, identity: owner, now: T + 5 * MIN, op: { t: 'put', k: await idKey(LISTED_PREFIX, X) }, value: { by: owner.pub, t: T + 5 * MIN } })).blocks
  st = (await loadLedger(blocks)).state
  assert.equal(listingVisible(st, find(mallory, Y)), false, 'the legacy key cannot be borrowed either')
  assert.equal(listingVisible(st, find(alice, X)), true, 'the bound key still credits alice')
})

// ------------------------------------------------------------------------------------------- SCALE-14 (allow caps)

test('SCALE-14 on a real node: a moderator\'s accept past modAllowPerDay is refused with E_LIMIT and writes no block', async () => {
  const { ChainNode } = await import('../../src/chain/node.js')
  const { MemoryBlockStore } = await import('../../src/chain/stores.js')
  const { sign } = await import('../../src/chain/crypto.js')
  const key = async () => { const kp = await generateKeyPair({ extractable: false }); const pub = await exportPublicKey(kp.publicKey); return { pub, privateKey: kp.privateKey, signer: { pub, sign: (b) => sign(kp.privateKey, b) } } }
  const owner = await key()
  const moder = await key()
  const g = await ChainNode.genesis({ signer: owner.signer, policy: { writers: 'allow', bits: 0, moderators: [moder.pub], modAllowPerDay: 2 } })
  const node = await ChainNode.open({ siteId: g.ledgerId, expectedOwner: owner.pub, ledgerOwner: owner.pub, genesisHash: g.gen, store: new MemoryBlockStore(), identity: { pub: moder.pub, privateKey: moder.privateKey }, config: { minBits: 0, tickMs: 0 } })
  await node.ingest(g.blocks, 'local')
  try {
    assert.equal(node.role, 'moderator')
    const api = { node, identity: { keys: () => null, info: () => ({ pub: moder.pub }) }, prompt: async () => true, infoNow: () => ({}), service: () => null }
    const mod = createModService({ api, now: () => node.now() })
    const joiners = []
    for (let i = 0; i < 3; i++) joiners.push((await key()).pub)
    const items = joiners.map((p) => mod.receive(p, { t: 'join', pub: p }))
    const height = () => node.height
    await mod.methods['mod.decide']({ id: items[0].id, decision: 'accept' }, { activation: true })
    await mod.methods['mod.decide']({ id: items[1].id, decision: 'accept' }, { activation: true })
    assert.ok(node.state.policy.allow.has(joiners[1]), 'the first two are in effect')
    const before = height()
    const err = await mod.methods['mod.decide']({ id: items[2].id, decision: 'accept' }, { activation: true }).catch((e) => e)
    assert.equal(err && err.code, 'E_LIMIT')
    assert.match(err.message, /daily limit of 2/)
    assert.equal(height(), before, 'no block that the ledger would drop')
    mod.destroy()
  } finally { await node.close() }
})

test('SCALE-14: an accept when the allow list holds 1,000 keys is refused (E_LIMIT, "full"); the owner has no day cap', async () => {
  const { allowRoomOf } = await import('../../src/loader/mod.js')
  const allow = new Set()
  for (let i = 0; i < 1000; i++) allow.add('k' + i)
  const node = { state: { owner: 'p256:owner', policy: { allow, modAllowPerDay: 20, moderators: new Set(['p256:mod']) } }, dag: { blocks: () => [] } }
  assert.equal(allowRoomOf(node, 'p256:mod', 0).full, true)
  allow.delete('k0')
  const day = 5 * 86400000
  const blocks = []
  for (let i = 0; i < 20; i++) blocks.push({ e: { author: 'p256:mod', ts: day + i * 60000, op: { t: 'allow', add: ['x' + i], remove: [] } } })
  blocks.push({ e: { author: 'p256:mod', ts: day - 60000, op: { t: 'allow', add: ['y'], remove: [] } } }) // yesterday
  node.dag.blocks = () => blocks
  const room = allowRoomOf(node, 'p256:mod', day + 3600000)
  assert.deepEqual([room.full, room.used, room.left], [false, 20, 0])
  assert.equal(allowRoomOf(node, 'p256:owner', day + 3600000).left, Infinity, 'the owner has no day cap')
  // Through mod.decide with a mocked node: nothing is written.
  allow.add('k0')
  const ops = []
  const mnode = Object.assign(node, { role: 'moderator', identity: { pub: 'p256:mod' }, async writeControl (op) { ops.push(op); return { h: 'c'.repeat(64) } } })
  const mod = createModService({ api: { node: mnode, identity: { keys: () => null, info: () => ({ pub: 'p256:mod' }) }, prompt: async () => true, infoNow: () => ({}), service: () => null }, now: () => day })
  const pub = (await exportPublicKey((await generateKeyPair({ extractable: false })).publicKey))
  const it = mod.receive(pub, { t: 'join', pub })
  const err = await mod.methods['mod.decide']({ id: it.id, decision: 'accept' }, { activation: true }).catch((e) => e)
  assert.equal(err.code, 'E_LIMIT')
  assert.match(err.message, /full/)
  assert.deepEqual(ops, [])
  mod.destroy()
})

// ------------------------------------------------------------------------------------------- UX-1, UX-2, UX-3 (redress)

// A fake DOM with a layout that follows the cards: the host is anchored at the bottom, so a card in the prompt slot
// pushes the header's buttons up by 200 px, and a status line longer than 35 characters (as if it wrapped) pushes the card's buttons up by 18 px.
async function cardWorld (opts = {}) {
  const { FakeDocument, FakeNode } = await import('./dropin-fake-dom.mjs')
  const { createCards } = await import('../../src/loader/ui.js')
  const w = { overlay: null, clock: 1000, timers: [] }
  class MO { constructor (cb) { this.cb = cb } observe () {} disconnect () {} }
  const up = (n, pred) => { for (let x = n; x; x = x.parentNode) if (pred(x)) return x; return null }
  FakeNode.prototype.getBoundingClientRect = function () {
    if (this.tagName !== 'BUTTON') return { x: 0, y: 0, width: 300, height: 100 }
    const inHeader = up(this, (x) => x.getAttribute && x.getAttribute('data-mw-header') !== null)
    const card = up(this, (x) => x.getAttribute && x.getAttribute('data-mw-card') !== null)
    const idx = this.parentNode ? this.parentNode.children.indexOf(this) : 0
    if (inHeader) {
      const wrap = up(inHeader, (x) => x.children && x.children.length === 2 && x.children[0] === inHeader.parentNode)
      const prompt = wrap ? wrap.children[1] : null
      const shift = prompt && prompt.children.some((c) => c.getAttribute('data-mw-card') !== null) ? 200 : 0
      return { x: 20 + 140 * idx, y: 700 - shift, width: 120, height: 44 }
    }
    if (card) {
      const status = card.find((x) => x.getAttribute && x.getAttribute('role') === 'status')
      const shift = status && status.textContent.length > 35 ? 18 : 0
      return { x: 20 + 140 * idx, y: 900 - shift, width: 120, height: 44 }
    }
    return { x: 20 + 140 * idx, y: 950, width: 120, height: 44 }
  }
  FakeNode.prototype.getRootNode = function () { let n = this; while (n.parentNode) n = n.parentNode; return n }
  FakeNode.prototype.elementFromPoint = function (x, y) {
    if (w.overlay) return w.overlay
    return this.findAll((n) => {
      if (n.tagName !== 'BUTTON') return false
      const r = n.getBoundingClientRect()
      return x >= r.x && x <= r.x + r.width && y >= r.y && y <= r.y + r.height
    })[0] || null
  }
  const doc = new FakeDocument()
  doc.elementFromPoint = () => (w.overlay ? w.overlay : cards.host)
  const win = { document: doc, innerWidth: 1280, innerHeight: 1000, MutationObserver: MO, matchMedia: () => ({ matches: false }), navigator: { language: 'en-CA' }, getComputedStyle: () => ({ opacity: '1', visibility: 'visible', display: 'block', pointerEvents: 'auto' }), addEventListener () {}, removeEventListener () {} }
  const cards = createCards(Object.assign({
    win, doc, lang: 'en', now: () => w.clock, minVisibleMs: 250, headerFoldMs: 1e9,
    setTimeout: (fn, ms) => { const t = { fn, ms }; w.timers.push(t); return t },
    clearTimeout: (t) => { const i = w.timers.indexOf(t); if (i >= 0) w.timers.splice(i, 1) }
  }, opts))
  w.tick = (ms) => { w.clock += ms }
  w.btn = (label) => cards.host && cards.host.buttonByText(label)
  w.text = () => (cards.host ? cards.host.findAll((n) => n._text).map((n) => n._text).join(' | ') : '')
  return { w, cards, doc }
}
const flushUi = () => new Promise((r) => setTimeout(r, 0))

test('UX-1: the header drawn while a card is open still signs out after the card closes and another opens', async () => {
  const { w, cards } = await cardWorld()
  let signedOut = 0
  const first = cards.prompt('confirm', { title: 'T', text: 'x', confirmLabel: 'Confirm' })
  cards.setIdentityHeader({ name: 'Ann', short: 'k3f9', pub: 'p256:ann', mode: 'pairwise', unlock: 'passkey', backup: true }, { onSignOut: () => { signedOut++ } })
  w.tick(500)
  w.btn('Confirm').click()
  assert.equal(await first, true)
  // The card went away: the header moved down by 200 px. Before the fix the guard cancelled here, for good.
  w.tick(500)
  w.btn('Sign out').click()
  assert.equal(signedOut, 1, 'Sign out works after the loader moved the header itself')
  assert.ok(!/Cancelled: something moved/.test(w.text()))
  // A second card opens below and pushes the header up; a click right after the move does not count, a later one does,
  // and the header's guard never closes the card in the other slot.
  const kit = cards.prompt('confirm', { title: 'Kit', text: 'y', confirmLabel: 'Confirm' })
  w.btn('Sign out').click()
  assert.equal(signedOut, 1, 'too soon after the move: ignored, not cancelled')
  w.tick(300)
  w.btn('Sign out').click()
  assert.equal(signedOut, 2)
  assert.equal(cards.open, 'confirm', 'the card below is still open')
  w.tick(300)
  w.btn('Cancel').click()
  assert.equal(await kit, false)
  cards.destroy()
})

test('UX-1: a real overlay on the header cancels only the header click, re-arms it, and leaves the open card alone', async () => {
  const { w, cards } = await cardWorld()
  let signedOut = 0
  cards.setIdentityHeader({ name: 'Ann', short: 'k3f9', pub: 'p256:ann', mode: 'pairwise', unlock: 'passkey', backup: true }, { onSignOut: () => { signedOut++ } })
  const p = cards.prompt('confirm', { title: 'T', text: 'x', confirmLabel: 'Confirm' })
  w.tick(500)
  w.overlay = { tagName: 'DIV' }
  w.btn('Sign out').click()
  assert.equal(signedOut, 0)
  assert.equal(cards.open, 'confirm', 'the card in the prompt slot is not finished by a header guard')
  w.overlay = null
  w.tick(300)
  w.btn('Sign out').click()
  assert.equal(signedOut, 1, 'the header works again once nothing covers it')
  w.tick(300)
  w.btn('Cancel').click()
  assert.equal(await p, false)
  cards.destroy()
})

test('UX-2: retrying the sign-in card after an error status is not cancelled as a redress attack', async () => {
  const calls = []
  const { w, cards } = await cardWorld({ actions: { signIn: async () => { calls.push(1); const e = new Error('slow down'); e.code = 'E_RATE'; throw e } } })
  const p = cards.prompt('signin', { options: { stay: false } })
  w.tick(500)
  w.btn('Sign in').click()
  await flushUi()
  assert.equal(calls.length, 1)
  w.tick(300)
  w.btn('Sign in').click()
  await flushUi()
  assert.equal(calls.length, 2, 'the second press reaches signIn')
  assert.ok(!/Cancelled: something moved/.test(w.text()))
  assert.equal(cards.open, 'signin')
  w.btn('Cancel') && (w.tick(300), w.btn('Cancel').click())
  assert.equal(await p, false)
  cards.destroy()
})

test('UX-3: the redress notice has OK, goes away by itself, and the host is unmounted when nothing else is shown', async () => {
  const { w, cards, doc } = await cardWorld()
  const p = cards.prompt('confirm', { title: 'T', text: 'x', confirmLabel: 'Confirm' })
  w.tick(500)
  w.overlay = { tagName: 'DIV' }
  w.btn('Confirm').click()
  assert.equal(await p, false, 'the covered card is cancelled')
  w.overlay = null
  assert.match(w.text(), /Cancelled: something moved/)
  assert.ok(cards.host.parentNode, 'the notice is shown')
  const t = w.timers.find((x) => x.ms === 6000)
  assert.ok(t, 'a 6 s timer')
  t.fn()
  assert.equal(cards.host.parentNode, null, 'unmounted: nothing left over the site')
  assert.ok(!doc.body.children.includes(cards.host))
  // OK dismisses at once.
  const p2 = cards.prompt('confirm', { title: 'T', text: 'x', confirmLabel: 'Confirm' })
  w.tick(500)
  w.overlay = { tagName: 'DIV' }
  w.btn('Confirm').click()
  await p2
  w.overlay = null
  w.btn('OK').click()
  assert.equal(cards.host.parentNode, null)
  assert.equal(w.timers.filter((x) => x.ms === 6000).length, 0, 'its timer is cleared')
  cards.destroy()
})

// ------------------------------------------------------------------------------------------- UX-11 (error sentences)

test('UX-11: every SDK error code has its own English and French sentence; E_BANNED names no room', async () => {
  const { ERROR_CODES } = await import('../../src/loader/api.js')
  const { ERROR_TEXT, errorText } = await import('../../src/loader/strings.js')
  for (const c of ERROR_CODES) {
    assert.ok(ERROR_TEXT.en[c], c + ' has an English sentence')
    assert.ok(ERROR_TEXT.fr[c], c + ' has a French sentence')
    assert.ok(!/Something went wrong \(/.test(errorText(c, 'en')), c)
    assert.ok(!/Une erreur est survenue \(/.test(errorText(c, 'fr')), c)
  }
  assert.match(errorText('E_CAP', 'en'), /out of storage/)
  assert.ok(!/room|salon/.test(errorText('E_BANNED', 'en') + errorText('E_BANNED', 'fr')))
})

// ------------------------------------------------------------------------------------------- UX-13 (French consent)

test('UX-13: with a French browser the consent card, the notice and the settings are French, with no English sentence', async () => {
  const { FakeDocument, FakeNode } = await import('./dropin-fake-dom.mjs')
  const { createUI } = await import('../../src/loader/ui.js')
  const { STRINGS, STRINGS_FR, stringsFor } = await import('../../src/loader/strings.js')
  class DomNode extends FakeNode {
    get classList () {
      const node = this
      const list = () => String(node.className || '').split(/\s+/).filter(Boolean)
      const add = (...c) => { node.className = Array.from(new Set(list().concat(c))).join(' ') }
      const remove = (...c) => { node.className = list().filter((x) => c.indexOf(x) < 0).join(' ') }
      return { add, remove, toggle: (c, on) => { const has = list().indexOf(c) >= 0; const want = on === undefined ? !has : !!on; if (want !== has) { if (want) add(c); else remove(c) } return want }, contains: (c) => list().indexOf(c) >= 0 }
    }
    get dataset () { if (!this._data) this._data = {}; return this._data }
    querySelector (sel) {
      if (sel.startsWith('#')) return this.find((n) => n.getAttribute && n.getAttribute('id') === sel.slice(1)) || null
      return this.find((n) => String(n.className || '').split(/\s+/).some((c) => sel.split(',').some((s) => s.trim() === '.' + c))) || null
    }
  }
  class DomDocument extends FakeDocument { createElement (tag, attrs = null) { const el = new DomNode(tag, this); if (attrs) for (const k of Object.keys(attrs)) el.setAttribute(k, attrs[k]); return el } }
  const build = (language) => {
    const doc = new DomDocument()
    const win = { document: doc, navigator: { language }, matchMedia: () => ({ matches: false }), localStorage: { getItem: () => null, setItem () {} }, setTimeout: (fn, ms) => setTimeout(fn, ms), clearTimeout: (h) => clearTimeout(h), console }
    doc.defaultView = win
    const root = doc.createElement('div')
    root.setAttribute('id', 'mw-root')
    doc.body.appendChild(root)
    const ui = createUI(root, STRINGS, { lang: language })
    const text = () => root.findAll((n) => n._text).map((n) => n._text).join(' | ')
    return { ui, root, text }
  }
  const fr = build('fr-CA')
  fr.ui.showConsentCard({ dns: true, mobile: true })
  const t = fr.text()
  assert.ok(t.includes(STRINGS_FR.consentTitle) && t.includes(STRINGS_FR.consentText), 'the French title and text')
  assert.ok(t.includes(STRINGS_FR.consentShare))
  for (const k of ['consentTitle', 'consentText', 'consentChoice', 'consentMobile', 'consentDns', 'consentShare', 'consentHostOnly']) assert.ok(!t.includes(STRINGS[k]), 'no English ' + k)
  assert.equal(fr.root.getAttribute('lang'), 'fr')
  const en = build('en-CA')
  en.ui.showConsentCard({ dns: true })
  assert.ok(en.text().includes(STRINGS.consentTitle))
  // Every French key exists in English, and the French table names the same resolvers (dohNamed still swaps them).
  for (const k of Object.keys(STRINGS_FR)) assert.ok(k in STRINGS, k)
  const F = stringsFor('fr')
  assert.equal(F.dohNamed(F.consentDns, 'dns.example').includes('dns.example'), true)
  assert.ok(!/Cloudflare/.test(F.dohNamed(F.consentDns, 'dns.example')))
  assert.equal(stringsFor('en'), STRINGS)
})

// ------------------------------------------------------------------------------------------- MAL53-6 (metadata bomb)

test('MAL53-6: a file wire announcing 10 MB of metadata for a 1,000-byte listing gets no request and is destroyed', async () => {
  const { guardMetadataSize, fileMetadataBound } = await import('../../src/loader/torrent.js')
  const { default: utMetadata } = await import('ut_metadata')
  const Ext = utMetadata()
  assert.equal(fileMetadataBound(1000, 262144), 20 + 1024, 'one piece of a 1,000-byte file')
  assert.equal(fileMetadataBound(8.2e9, 262144), 262144, 'never above the .torrent limit')
  assert.equal(fileMetadataBound(null, 262144), 262144)
  const wireWith = () => {
    const sent = []
    const wire = { destroyed: false, peerExtendedMapping: { ut_metadata: 3 }, extendedHandshake: {}, extended: (id, buf) => sent.push([id, buf]), destroy () { this.destroyed = true } }
    wire.ut_metadata = new Ext(wire)
    wire.ut_metadata.fetch()
    return { wire, sent }
  }
  // Without the guard ut_metadata asks for all 611 pieces of the announced 10 MB.
  const bare = wireWith()
  bare.wire.ut_metadata.onExtendedHandshake({ m: { ut_metadata: 3 }, metadata_size: 10000000 })
  assert.ok(bare.sent.length > 600, 'the library alone requests ' + bare.sent.length + ' pieces')
  // With it: no request, the wire is gone, the refusal is counted.
  const g = wireWith()
  let refused = null
  assert.equal(guardMetadataSize(g.wire, { maxBytes: fileMetadataBound(1000), onRefuse: (s) => { refused = s } }), true)
  assert.equal(guardMetadataSize(g.wire, { maxBytes: 1 }), false, 'installed once')
  g.wire.ut_metadata.onExtendedHandshake({ m: { ut_metadata: 3 }, metadata_size: 10000000 })
  assert.equal(g.sent.length, 0)
  assert.equal(g.wire.destroyed, true)
  assert.equal(refused, 10000000)
  // An honest size passes through to the library.
  const ok = wireWith()
  guardMetadataSize(ok.wire, { maxBytes: fileMetadataBound(1000) })
  ok.wire.ut_metadata.onExtendedHandshake({ m: { ut_metadata: 3 }, metadata_size: 300 })
  assert.equal(ok.sent.length, 1)
  assert.equal(ok.wire.destroyed, false)
})

test('MAL53-6: the vendored WebTorrent bundle calls onExtendedHandshake through the same extension object (the patch point)', async () => {
  const { readFileSync } = await import('node:fs')
  const dist = readFileSync(new URL('../../node_modules/webtorrent/dist/webtorrent.min.js', import.meta.url), 'utf8')
  assert.match(dist, /this\._ext\[t\]=i,this\[t\]=i/)
  assert.match(dist, /this\._ext\[e\]\.onExtendedHandshake\(this\.peerExtendedHandshake\)/)
})

// ------------------------------------------------------------------------------------------- SCALE-6 (hub lane wires)

test('SCALE-6: the hub follow lane is its own swarm kind, capped by wantedWires and first in the budget while syncing', async () => {
  const { TorrentManager } = await import('../../src/loader/torrent.js')
  const { computePolicy, allocateWireBudget, budgetVictim } = await import('../../src/loader/policy.js')
  const { CONFIG } = await import('../../src/loader/config.js')
  const tm = new TorrentManager({
    WebTorrent: class { constructor () { this.torrents = [] } on () {} destroy (cb) { if (cb) cb() } },
    config: CONFIG,
    policy: Object.assign({ maxConns: 8, uploadsEnabled: true, uploadLimit: 1048576, hostOnly: false }, computePolicy({ isMobile: true, networkType: 'wifi' })),
    consent: { peersAllowed: () => false, onChange () {} },
    deps: { MemoryChunkStore: class {}, BlobChunkStore: class {}, parseTorrentFile: async () => null },
    fetch: async () => { throw new TypeError('no network') },
    baseUrl: 'https://hub.example/',
    lifecycle: false
  })
  try {
    assert.equal(tm._budgetTotal(), 8, 'a phone')
    let syncing = true
    let wanted = 8
    tm.joinLane({ kind: 'hub', infoHash: 'b'.repeat(40), announce: ['wss://own.example'], ledgerSync: true, wanted: () => wanted, syncing: () => syncing })
    tm.joinLane({ kind: 'group', infoHash: 'c'.repeat(40), announce: ['wss://own.example'] })
    assert.deepEqual(tm._caps('hub'), { soft: 8, hard: 8 }, 'wantedWires, not the 4 wires of the group kind')
    assert.deepEqual(tm._caps('group'), { soft: 3, hard: 4 }, 'groups keep their own cap')
    // Site and rendezvous at demand on a phone: while syncing the lane gets the remainder, the others keep their floors.
    const demands = { site: 12, rendezvous: 5, hub: 8 }
    const now = allocateWireBudget(8, demands, tm._budgetConfig())
    assert.ok(now.hub >= 4, 'hub gets ' + now.hub + ' of 8 while syncing (1 before)')
    assert.deepEqual([now.site, now.rendezvous], [2, 2])
    assert.equal(budgetVictim({ site: 4, rendezvous: 2, hub: 3 }, 8, tm._budgetConfig()), 'site', 'over budget the site gives way, not the syncing lane')
    // Once current: phones keep 2 lane wires and the lane is back below the site.
    syncing = false
    wanted = 2
    assert.deepEqual(tm._caps('hub'), { soft: 2, hard: 2 })
    assert.equal(budgetVictim({ site: 4, rendezvous: 2, hub: 3 }, 8, tm._budgetConfig()), 'hub')
    assert.ok(tm.budget.bySwarm.hub, 'the budget reports the hub swarm')
    assert.ok(tm.budget.priority.indexOf('hub') > tm.budget.priority.indexOf('rendezvous'))
  } finally { await tm.destroy() }
})

// ------------------------------------------------------------------------------------------- MP-10 (holder recount flood)

test('MP-10: a flood of have-none, have-all and bitfield messages does not recount 16,384 pieces each time', async () => {
  const { TorrentManager } = await import('../../src/loader/torrent.js')
  const { CONFIG } = await import('../../src/loader/config.js')
  const tm = new TorrentManager({
    WebTorrent: class { constructor () { this.torrents = [] } on () {} destroy (cb) { if (cb) cb() } },
    config: CONFIG, policy: { maxConns: 8, uploadsEnabled: true, uploadLimit: 1048576, hostOnly: false },
    consent: { peersAllowed: () => false, onChange () {} },
    deps: { MemoryChunkStore: class {}, BlobChunkStore: class {}, parseTorrentFile: async () => null },
    fetch: async () => { throw new TypeError('no network') }, baseUrl: 'https://site.example/', lifecycle: false
  })
  try {
    tm.localState = () => ({ pieces: 16384 })
    const handlers = new Map()
    let gets = 0
    const wire = {
      peerId: 'p', peerPieces: { get: (i) => { gets++; return i < 100 } },
      on (t, fn) { if (!handlers.has(t)) handlers.set(t, []); handlers.get(t).push(fn) },
      once (t, fn) { this.on(t, fn) },
      emit (t, ...a) { for (const fn of handlers.get(t) || []) fn(...a) }
    }
    tm._watchHolder(wire, { torrent: { infoHash: 'd'.repeat(40) } })
    const rec = () => tm._holders.get('d'.repeat(40)).get(wire)
    const t0 = performance.now()
    for (let i = 0; i < 100000; i++) wire.emit(i % 2 ? 'have-none' : 'have-all')
    assert.equal(gets, 0, 'have-all and have-none never walk the bitfield')
    for (let i = 0; i < 10000; i++) wire.emit('bitfield')
    const ms = performance.now() - t0
    assert.ok(gets <= 16384, 'one full count for 10,000 bitfields in 250 ms, not ' + gets / 16384)
    assert.equal(rec().held, 100)
    assert.ok(ms < 1000, 'handled in ' + Math.round(ms) + ' ms')
    wire.emit('have-all')
    assert.equal(rec().held, 16384)
    wire.emit('close')
  } finally { await tm.destroy() }
})

// ------------------------------------------------------------------------------------------- MP-14 (unchecked copies)

test('MP-14: unchecked complete bitfields count as one copy at most; a pinned (checked) copy counts in full', async () => {
  const { planSeeding } = await import('../../src/loader/seed-planner.js')
  const WIDE = { lanes: { H: { rate: Infinity }, K: { rate: Infinity }, E: { rate: Infinity } } }
  const items = [
    { ih: 'a-lied', lane: 'K', complete: true, copies: { complete: 50 }, openedAt: 900 },
    { ih: 'b-one', lane: 'K', complete: true, copies: { complete: 1 }, openedAt: 100 },
    { ih: 'c-checked', lane: 'K', complete: true, copies: { complete: 3, checked: 3 }, openedAt: 950 }
  ]
  const plan = planSeeding({ items, budget: WIDE, now: 2000 })
  assert.deepEqual(plan.order, ['a-lied', 'b-one', 'c-checked'], '50 lying peers rank like one; three checked copies do push an item back')
})

// ------------------------------------------------------------------------------------------- MP-15 (pin-first deadline)

test('MP-15: a pin wire that never reports a revealed piece stops blocking the other wires after the deadline', async () => {
  const { SuperSeed, PIN_WAIT_MS } = await import('../../src/loader/superseed.js')
  let clock = 0
  const timers = []
  const wireOf = (pieces) => {
    const l = new Map()
    const w = {
      type: 'webrtc', destroyed: false, hasFast: false, sent: [], bits: new Uint8Array(pieces),
      on (t, fn) { if (!l.has(t)) l.set(t, []); l.get(t).push(fn) },
      removeListener (t, fn) { const a = l.get(t) || []; const i = a.indexOf(fn); if (i >= 0) a.splice(i, 1) },
      emit (t, ...a) { for (const fn of (l.get(t) || []).slice()) fn(...a) }
    }
    w.peerPieces = { get: (i) => w.bits[i] === 1 }
    w.bitfield = function (bf) { w.sent.push(['bitfield']) }
    w.have = function (i) { w.sent.push(['have', i]) }
    w.haveAll = function () { w.sent.push(['haveAll']) }
    return w
  }
  const pin = wireOf(4)
  const other = wireOf(4)
  const ss = new SuperSeed({ pieces: 4, isPin: (w) => w === pin, now: () => clock, setTimeout: (fn, ms) => { const t = { fn, at: clock + ms }; timers.push(t); return t }, clearTimeout: () => {} })
  ss.addWire(pin)
  ss.addWire(other)
  pin.bitfield(new Uint8Array(1).fill(255))
  other.bitfield(new Uint8Array(1).fill(255))
  const haves = (w) => w.sent.filter((m) => m[0] === 'have').length
  assert.equal(haves(pin), 1, 'the pin wire gets the first reveal')
  assert.equal(haves(other), 0, 'the other wire waits while the pin is served')
  // The pin never reports the piece. After the deadline the timer gives the other wire its turn.
  clock += PIN_WAIT_MS + 1
  for (const t of timers.splice(0)) if (t.at <= clock) t.fn()
  assert.equal(haves(other), 1, 'served after ' + PIN_WAIT_MS + ' ms of silence from the pin')
  ss.stop('test')
})

// ------------------------------------------------------------------------------------------- SCALE-12 (cap scope in the texts)

test('SCALE-12: the seeding cap texts say the month cap is per site, in both languages', async () => {
  const { seedText } = await import('../../src/loader/strings.js')
  assert.match(seedText('seed.ask', 'en', { cap: '1 GiB' }), /up to 1 GiB a month on this site\./)
  assert.match(seedText('seed.ask', 'fr', { cap: '1 Gio' }), /par mois sur ce site\./)
  assert.match(seedText('seed.monthUsed', 'en', { cap: '20 GB' }), /this site's limit of 20 GB for this month/)
  assert.match(seedText('seed.monthUsed', 'fr', { cap: '20 Go' }), /la limite de ce site pour ce mois/)
})

// ------------------------------------------------------------------------------------------- UX-17, MAL53-10 (card queue)

test('UX-17: focus goes back to the page element after a card closes (and after a queued card that followed it)', async () => {
  const { w, cards, doc } = await cardWorld()
  const pageBtn = doc.createElement('button')
  pageBtn.textContent = 'Post'
  doc.body.appendChild(pageBtn)
  pageBtn.focus()
  const p1 = cards.prompt('confirm', { title: 'A', text: 'x', confirmLabel: 'Confirm' })
  const p2 = cards.prompt('confirm', { title: 'B', text: 'y', confirmLabel: 'Go on' })
  assert.notEqual(doc.activeElement, pageBtn, 'the card took the focus')
  w.tick(500)
  w.btn('Cancel').click()
  assert.equal(await p1, false)
  assert.notEqual(doc.activeElement, pageBtn, 'the queued card has it now')
  w.tick(500)
  w.btn('Cancel').click()
  assert.equal(await p2, false)
  assert.equal(doc.activeElement, pageBtn, 'back on the page button')
  cards.destroy()
})

test('MAL53-10: a flood of offers does not auto-decline the next consent card; the newest offer gives way', async () => {
  const { w, cards } = await cardWorld()
  const first = cards.prompt('confirm', { title: 'A', text: 'x', confirmLabel: 'Confirm' })
  const offers = []
  for (let i = 0; i < 8; i++) offers.push(cards.prompt('offer', { kind: 'media', from: 'Mallory', name: 'n' + i, size: 10, type: 'image' }))
  const extra = await cards.prompt('offer', { kind: 'media', from: 'Mallory', name: 'n9', size: 10, type: 'image' })
  assert.equal(extra, false, 'a ninth offer is declined as before')
  const consent = cards.prompt('consent', { card: 'turnOnChat', params: { tracker: 't.example', stun: 's.example' } })
  assert.equal(await offers[7], false, 'the newest offer made room')
  let settled = false
  consent.then(() => { settled = true })
  await flushUi()
  assert.equal(settled, false, 'the consent card waits its turn instead of answering false')
  w.tick(500)
  w.btn('Cancel').click()
  await first
  cards.destroy()
})

// ------------------------------------------------------------------------------------------- UX-18 (iOS hint)

test('UX-18: with a v0.3 identity the iOS hint points at the recovery kit, never at an export that is not there', async () => {
  const { FakeDocument, FakeNode } = await import('./dropin-fake-dom.mjs')
  const { createUI } = await import('../../src/loader/ui.js')
  const { STRINGS } = await import('../../src/loader/strings.js')
  class DomNode extends FakeNode {
    get classList () {
      const node = this
      const list = () => String(node.className || '').split(/\s+/).filter(Boolean)
      const add = (...c) => { node.className = Array.from(new Set(list().concat(c))).join(' ') }
      const remove = (...c) => { node.className = list().filter((x) => c.indexOf(x) < 0).join(' ') }
      return { add, remove, toggle: (c, on) => { const has = list().indexOf(c) >= 0; const want = on === undefined ? !has : !!on; if (want !== has) { if (want) add(c); else remove(c) } return want }, contains: (c) => list().indexOf(c) >= 0 }
    }
    get dataset () { if (!this._data) this._data = {}; return this._data }
    querySelector (sel) {
      if (sel.startsWith('#')) return this.find((n) => n.getAttribute && n.getAttribute('id') === sel.slice(1)) || null
      return this.find((n) => String(n.className || '').split(/\s+/).some((c) => sel.split(',').some((s) => s.trim() === '.' + c))) || null
    }
  }
  class DomDocument extends FakeDocument { createElement (tag, attrs = null) { const el = new DomNode(tag, this); if (attrs) for (const k of Object.keys(attrs)) el.setAttribute(k, attrs[k]); return el } }
  const doc = new DomDocument()
  doc.defaultView = { document: doc, navigator: { language: 'en-CA' }, matchMedia: () => ({ matches: false }), localStorage: { getItem: () => null, setItem () {} }, setTimeout: (fn, ms) => setTimeout(fn, ms), clearTimeout: (h) => clearTimeout(h), console }
  const root = doc.createElement('div')
  doc.body.appendChild(root)
  const ui = createUI(root, STRINGS, { lang: 'en' })
  const hint = () => root.find((n) => n.tagName === 'P' && (n.textContent === STRINGS.iosHomeScreen || n.textContent === STRINGS.iosHomeScreenV03))
  const model = (v03) => ({ share: true, isMobile: true, shareOnNetwork: false, storage: {}, ledger: null, version: '0.3.0', iosHint: true, identity: { short: 'k3f9', v03, canExport: !v03, canImport: !v03 } })
  ui.settings.setModel(model(true))
  assert.equal(hint().textContent, STRINGS.iosHomeScreenV03)
  assert.ok(!/export your identity here/.test(hint().textContent))
  assert.equal(hint().hidden, false)
  ui.settings.setModel(model(false))
  assert.equal(hint().textContent, STRINGS.iosHomeScreen, 'a v0.2 identity keeps the export sentence (its rows are shown)')
})
