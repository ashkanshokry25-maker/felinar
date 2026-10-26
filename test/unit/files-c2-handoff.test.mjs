// Unit tests for the C2 parts of src/files/lane.js, src/files/service.js, src/media/lane.js and src/media/service.js
// (v0.3 C2, lane seed-engine; SZ 3.1.2, 3.1.5, SZ-6; R 2.8.4, 2.8.6, 2.9.11): own uploads seed in lane H (after the
// MF-45 card on phones), "Help share" and "Keep available" are K, a fetch is E; list() keeps 'available' and adds
// evidence, label and labelParams; own items move onlyHere -> handoff.waiting -> handoff.sending -> keptBySite, and a
// peer's full copy reads as sent; the site owner's own uploads go to the pin queue at once when _mw.cfg.pin is set;
// nothing joins a swarm for a label. The TorrentManager seam is a fake at the contract boundary (handles with lane,
// setLane and evidenceInputs). Run: node --test test/unit/files-c2-handoff.test.mjs
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'

import { createFilesService } from '../../src/files/service.js'
import { createMediaService, defaultStores } from '../../src/media/service.js'
import { MediaSessions } from '../../src/media/session.js'
import { memoryBackend } from '../../src/files/store-idb.js'
import { parseTorrentFile } from '../../src/common/torrent-file.js'

const ME = 'p256:me'
const BO = 'p256:bo'
const NOW = 1792500000000
const ACT = { activation: true }
const PIN = 'p256:pin-node-key'

function jpegBytes (n, seed = 1) {
  const u = new Uint8Array(n)
  for (let i = 0; i < n; i++) u[i] = (i * 31 + seed) & 255
  u.set([0xff, 0xd8, 0xff, 0xe0, 0, 16, 0x4a, 0x46, 0x49, 0x46, 0], 0)
  return u
}

function fakeNode (author, owner) {
  const lists = new Map()
  let n = 0
  return {
    owner,
    state: { lists, tombstoned: new Set() },
    async append (l, v) {
      const h = (++n).toString(16).padStart(64, '0')
      const list = lists.get(l) || []
      list.push({ h, author, ts: n, v })
      lists.set(l, list)
      return { h }
    },
    async tombstone () { return { h: 't' } }
  }
}

/** The TorrentManager seam: each handle reports what the test sets as its evidence inputs. */
function fakeTorrents () {
  const t = { adds: [], handles: new Map() }
  t.addFileTorrent = async (opts) => {
    t.adds.push(opts)
    const ih = opts.infoHash || (await parseTorrentFile(opts.torrentFile)).infoHash
    const listeners = new Map()
    const h = {
      infoHash: ih,
      lane: opts.lane || (opts.uploadException ? 'H' : 'E'),
      uploadException: !!opts.uploadException,
      lanes: [],
      inputs: { local: false, wires: [], webseed: null, pin: null, now: NOW, pinPct: null },
      numPeers: 0,
      on (e, fn) { if (!listeners.has(e)) listeners.set(e, []); listeners.get(e).push(fn) },
      once (e, fn) { h.on(e, fn) },
      fire (e, x) { for (const fn of listeners.get(e) || []) fn(x) },
      setLane (l) { h.lane = l; h.lanes.push(l); return l },
      evidenceInputs () { return h.inputs },
      prioritize () {},
      destroy () { h.destroyed = true },
      stopSeeding () { h.stopped = true },
      metadata: async () => opts.torrentFile
    }
    t.handles.set(ih, h)
    return h
  }
  return t
}

function device ({ pub = ME, owner = ME, cfg = {}, deviceClass = 'desktop', answers = {}, pin = null, pinEvidence = undefined, evidenceInputs = undefined, extra = {} } = {}) {
  const prompts = []
  const pinRequests = []
  const stores = defaultStores(memoryBackend())
  let seed = 7
  const random = (n) => { const u = new Uint8Array(n); for (let i = 0; i < n; i++) u[i] = (seed = (seed * 1103515245 + 12345) >>> 0) >>> 24; return u }
  const torrents = fakeTorrents()
  const node = fakeNode(pub, owner)
  const cfgValue = Object.assign({ media: 'members', files: 'members' }, cfg)
  const deps = {
    keys: { pub, own: { k: 'own' } },
    ledgerId: 'mw1:test',
    node,
    cfg: () => cfgValue,
    deviceClass,
    hostOnly: () => false,
    ownTracker: 'ws://127.0.0.1:8000',
    torrents,
    chat: { dm: { async send () { return { state: 'delivered' } } } },
    sealed: { async seal ({ data, kind, authorPub }) { return { k: kind, a: authorPub, d: Array.from(data).length } } },
    isDenied: async () => false,
    prompt: async (card) => { prompts.push(card); const a = answers[card.kind]; return a === undefined ? true : a },
    sessions: new MediaSessions({ sw: null, random, capBytes: 25 * 1024 * 1024 }),
    makeStore: stores.makeStore,
    storeClass: stores.storeClass,
    random,
    now: () => NOW,
    strip: {
      async stripImage (blob) { return { blob: new Blob([await blob.arrayBuffer()], { type: 'image/jpeg' }), removed: ['exif'], mime: 'image/jpeg', w: 8, h: 8 } },
      async stripMp4 (blob) { return { blob, removed: [] } },
      async stripWebm (blob) { return { blob, removed: [] } }
    },
    faststart: async (blob) => ({ blob, moved: false }),
    makePoster: async () => ({ blob: new Blob([jpegBytes(500, 5)], { type: 'image/jpeg' }), mime: 'image/jpeg', w: 8, h: 8 }),
    canPlay: () => true,
    pin: pin === false ? null : (pin || { async request (item) { pinRequests.push(item); return { queued: true } } }),
    doneWaitMs: 500,
    pollMs: 5
  }
  if (pinEvidence) deps.pinEvidence = pinEvidence
  if (evidenceInputs) deps.evidenceInputs = evidenceInputs
  Object.assign(deps, extra)
  const files = createFilesService(deps)
  const media = createMediaService(deps)
  return { files, media, torrents, prompts, pinRequests, node, cfg: cfgValue }
}

const file = (n = 4000, seed = 1) => new Blob([jpegBytes(n, seed)], { type: 'image/jpeg' })

describe('files: own uploads are the H lane and move through the hand-off states', () => {
  test('a public share seeds in lane H with the per-upload exception; list() shows onlyHere with E0 evidence', async () => {
    const d = device()
    const r = await d.files.methods['files.share']({ file: file(), public: true }, ACT)
    const add = d.torrents.adds[0]
    assert.equal(add.lane, 'H')
    assert.equal(add.uploadException, true)
    assert.deepEqual(add.announce, ['ws://127.0.0.1:8000'])
    const [e] = await d.files.methods['files.list']({}, {})
    assert.equal(e.ref, r.ref)
    assert.equal(e.label, 'avail.onlyHere')
    assert.deepEqual(e.handoff, { state: 'onlyHere' })
    assert.equal(e.available, 'online', 'the v0.3 value set is kept')
    assert.deepEqual(e.evidence, { tier: 'E0', count: 0, atLeast: false, reported: false, checkedAt: NOW })
    assert.equal(d.pinRequests.length, 0, 'no _mw.cfg.pin: nothing is requested')
    assert.ok(!d.prompts.some((p) => p.kind === 'phone-upload'), 'no MF-45 card on a desktop')
  })

  test('SZ-6: with _mw.cfg.pin and the owner key, the upload is queued at once (handoff.waiting); others stay UI-driven', async () => {
    const owner = device({ cfg: { pin: PIN } })
    await owner.files.methods['files.share']({ file: file(), public: true }, ACT)
    assert.equal(owner.pinRequests.length, 1)
    assert.equal(owner.pinRequests[0].author, ME)
    assert.equal(owner.pinRequests[0].auto, true)
    const [e] = await owner.files.methods['files.list']({}, {})
    assert.equal(e.label, 'handoff.waiting')
    assert.deepEqual(e.handoff, { state: 'waiting' })

    const member = device({ pub: BO, owner: ME, cfg: { pin: PIN } })
    const r = await member.files.methods['files.share']({ file: file(3000, 2), public: true }, ACT)
    assert.equal(member.pinRequests.length, 0, 'a member\'s item waits for the moderator queue, asked from the UI')
    assert.equal((await member.files.methods['files.list']({}, {}))[0].label, 'avail.onlyHere')
    await member.files.methods['files.pinRequest']({ ref: r.ref }, {})
    assert.equal(member.pinRequests.length, 1)
    assert.equal((await member.files.methods['files.list']({}, {}))[0].label, 'handoff.waiting')

    const noPinNode = device({ cfg: { pin: PIN }, pin: false })
    await noPinNode.files.methods['files.share']({ file: file(), public: true }, ACT)
    assert.equal((await noPinNode.files.methods['files.list']({}, {}))[0].label, 'avail.onlyHere', 'no pin seam: nothing queued')
  })

  test('the pin wire fetching: handoff.sending {pct}; its receipt: keptBySite, available kept', async () => {
    const d = device({ cfg: { pin: PIN } })
    const r = await d.files.methods['files.share']({ file: file(), public: true }, ACT)
    const h = d.torrents.handles.get(r.ih)
    h.inputs = Object.assign({}, h.inputs, { pinPct: 62 })
    let [e] = await d.files.methods['files.list']({}, {})
    assert.equal(e.label, 'handoff.sending')
    assert.deepEqual(e.labelParams, { pct: 62 })
    assert.deepEqual(e.handoff, { state: 'sending', pct: 62 })
    h.inputs = Object.assign({}, h.inputs, { pin: { configured: true, receipt: { at: NOW - 4 * 60000 }, heartbeat: null } })
    ;[e] = await d.files.methods['files.list']({}, {})
    assert.equal(e.label, 'avail.keptBySite')
    assert.deepEqual(e.labelParams, { age: 4 * 60000 })
    assert.equal(e.available, 'kept')
    assert.equal(e.evidence.tier, 'E4')
    assert.equal(e.handoff.state, 'kept')
  })

  test('no pin: a peer with every piece reads as sent (heldBy, reported); a stale bitfield does not', async () => {
    const d = device()
    const r = await d.files.methods['files.share']({ file: file(), public: true }, ACT)
    const h = d.torrents.handles.get(r.ih)
    h.inputs = Object.assign({}, h.inputs, { wires: [{ id: 'bo', complete: true, at: NOW }] })
    let [e] = await d.files.methods['files.list']({}, {})
    assert.equal(e.label, 'avail.heldBy')
    assert.deepEqual(e.labelParams, { n: 1 })
    assert.deepEqual(e.handoff, { state: 'sent', n: 1 })
    assert.equal(e.evidence.reported, true)
    h.inputs = Object.assign({}, h.inputs, { wires: [{ id: 'bo', complete: true, at: NOW - 61000 }] })
    ;[e] = await d.files.methods['files.list']({}, {})
    assert.equal(e.label, 'avail.onlyHere')
  })

  test('phones: the MF-45 card first; declined, the item stays here in lane K (no per-upload exception)', async () => {
    const yes = device({ deviceClass: 'phone' })
    await yes.files.methods['files.share']({ file: file(), public: true }, ACT)
    const card = yes.prompts.find((p) => p.kind === 'phone-upload')
    assert.ok(card, 'the per-upload card')
    assert.equal(yes.torrents.adds[0].lane, 'H')
    const no = device({ deviceClass: 'phone', answers: { 'phone-upload': false } })
    await no.files.methods['files.share']({ file: file(), public: true }, ACT)
    assert.equal(no.torrents.adds[0].lane, 'K')
    assert.equal(no.torrents.adds[0].uploadException, undefined)
  })

  test('a fetch is E; listings never join a swarm for a label', async () => {
    const owner = device()
    const r = await owner.files.methods['files.share']({ file: file(), public: true }, ACT)
    const reader = device({ pub: BO })
    reader.node.state.lists.set('mw.files', owner.node.state.lists.get('mw.files'))
    const list = await reader.files.methods['files.list']({}, {})
    assert.equal(list.length, 1)
    assert.equal(list[0].label, 'avail.nobody', 'never fetched, no pin: nobody known online')
    assert.equal(list[0].available, 'unknown')
    assert.equal(reader.torrents.adds.length, 0, 'the E lane never fetches what the person did not open')
    assert.equal(list[0].handoff, undefined, 'hand-off states are for the uploader only')
    // The reader fetches: E (the fake swarm has no bytes, so the fetch times out; the lane was E).
    await assert.rejects(reader.files.methods['files.fetch']({ ref: r.ref }, {}))
    assert.equal(reader.torrents.adds[0].lane, undefined, 'no lane given: E by default')
  })

  test('"Help share this file" is K: a live handle is re-laned, a fetched file without one joins lane K', async () => {
    const d = device({ pub: BO })
    const live = { infoHash: 'c'.repeat(40), lane: 'E', lanes: [], setLane (l) { this.lane = l; this.lanes.push(l); return l } }
    d.files.lane.files.set('c'.repeat(40), { ref: 'c'.repeat(40), ih: 'c'.repeat(40), kind: 'public', mine: false, name: 'a', size: 1, verified: true, complete: true, handle: live, store: {} })
    await d.files.methods['files.keepSharing']({ ref: 'c'.repeat(40), on: true }, ACT)
    assert.deepEqual(live.lanes, ['K'])
    d.files.lane.files.set('e'.repeat(40), { ref: 'e'.repeat(40), ih: 'e'.repeat(40), kind: 'public', mine: false, name: 'b', size: 1, verified: true, complete: true, handle: null, store: {}, storeName: 'f-e' })
    await d.files.methods['files.keepSharing']({ ref: 'e'.repeat(40), on: true }, ACT)
    assert.equal(d.torrents.adds.at(-1).lane, 'K')
    assert.equal(d.torrents.adds.at(-1).infoHash, 'e'.repeat(40))
    const [held] = (await d.files.methods['files.received']({}, {}))
    assert.equal(held, undefined, 'public files are not "received"')
  })

  test('a private share is H too; received() entries carry evidence and label', async () => {
    const d = device()
    await d.files.methods['files.share']({ file: file(), to: [BO] }, ACT)
    assert.equal(d.torrents.adds[0].lane, 'H')
    const bo = device({ pub: BO })
    const sent = d.torrents.adds[0]
    const parsed = await parseTorrentFile(sent.torrentFile)
    const rec = Array.from(d.files.lane.files.values())[0]
    const ref = await bo.files.onGrant(ME, { t: 'file', F: { ref: rec.ref, ih: parsed.infoHash, len: rec.cipherBytes, plen: rec.size, P: rec.P, name: 'x.jpg', mime: 'image/jpeg', fk: Buffer.from(rec.fk).toString('base64url'), from: ME, to: BO } })
    assert.ok(ref)
    const [got] = await bo.files.methods['files.received']({}, {})
    assert.equal(got.label, 'avail.nobody')
    assert.equal(got.available, 'unknown')
    assert.equal(got.evidence.tier, null)
  })

  test('a seam without handle evidence: the lane asks deps.evidenceInputs and deps.pinEvidence', async () => {
    const seen = []
    const d = device({
      cfg: { pin: PIN },
      evidenceInputs: (ih) => { seen.push(ih); return { local: false, wires: [], now: NOW } },
      pinEvidence: (ih) => ({ configured: true, receipt: null, heartbeat: { at: NOW - 60000, has: true } })
    })
    const owner = device()
    await owner.files.methods['files.share']({ file: file(), public: true }, ACT)
    d.node.state.lists.set('mw.files', owner.node.state.lists.get('mw.files'))
    const [e] = await d.files.methods['files.list']({}, {})
    assert.equal(seen.length, 1)
    assert.equal(e.label, 'avail.keptBySite', 'the pin heartbeat lists it')
    assert.equal(e.available, 'kept')
  })
})

describe('media: own uploads are H; Keep available is K; labels from evidence', () => {
  test('an upload seeds in lane H; list() shows onlyHere, E0, available online; SZ-6 queues the owner\'s item', async () => {
    const d = device({ cfg: { pin: PIN } })
    const r = await d.media.methods['media.upload']({ file: file(6000) }, ACT)
    const add = d.torrents.adds[0]
    assert.equal(add.lane, 'H')
    assert.equal(add.uploadException, true)
    assert.equal(d.pinRequests.length, 1)
    assert.equal(d.pinRequests[0].auto, true)
    const [e] = await d.media.methods['media.list']({ from: 'mine' }, {})
    assert.equal(e.id, r.id)
    assert.equal(e.available, 'online')
    assert.equal(e.label, 'handoff.waiting')
    assert.equal(e.evidence.tier, 'E0')
    const h = d.torrents.handles.get(add.torrentFile ? (await parseTorrentFile(add.torrentFile)).infoHash : add.infoHash)
    h.inputs = Object.assign({}, h.inputs, { pin: { configured: true, receipt: { at: NOW - 1000 } } })
    const [kept] = await d.media.methods['media.list']({ from: 'mine' }, {})
    assert.equal(kept.label, 'avail.keptBySite')
    assert.equal(kept.available, 'kept')
  })

  test('a manifest ws field alone is no longer "kept"; Keep available moves a received item to K', async () => {
    const d = device()
    const r = await d.media.methods['media.upload']({ file: file(6000) }, ACT)
    const rec = d.media.lane.items.get(r.id)
    rec.M = Object.assign({}, rec.M, { ws: 'https://cdn.example/x' })
    const [e] = await d.media.methods['media.list']({}, {})
    assert.equal(e.available, 'online', 'E0 (own copy), not kept: no probe or receipt says the host has it')
    // A received item that is opened is E; Keep available makes it K.
    const recv = { id: 'b'.repeat(32), from: BO, M: Object.assign({}, rec.M, { ih: 'c'.repeat(40) }), fk: rec.fk, store: rec.store, storeName: 'x', handle: null, state: 'ready', grants: new Map(), keep: false, ownH: null, t: NOW }
    d.media.lane.items.set(recv.id, recv)
    const [, got] = await d.media.methods['media.list']({}, {})
    assert.equal(got.available, 'unknown')
    assert.equal(got.label, 'avail.nobody')
    assert.equal(d.torrents.adds.length, 1, 'listing never joins a swarm')
    await d.media.methods['media.keepAvailable']({ id: recv.id, on: true }, ACT)
    assert.equal(d.torrents.adds[1].lane, 'K')
    const h = d.torrents.handles.get('c'.repeat(40))
    await d.media.methods['media.keepAvailable']({ id: recv.id, on: false }, ACT)
    assert.equal(h.stopped, true)
  })

  test('phones: the MF-45 card before an upload seeds; declined, lane K', async () => {
    const d = device({ deviceClass: 'phone', answers: { 'phone-upload': false } })
    await d.media.methods['media.upload']({ file: file(6000) }, ACT)
    assert.ok(d.prompts.some((p) => p.kind === 'phone-upload'))
    assert.equal(d.torrents.adds[0].lane, 'K')
  })
})

describe('code review v0.3 round 2: premoderation in the files lane and the owner-written pin key', () => {
  test('a public listing that waits for a moderator: its author lists it as pending; nobody else lists or fetches it until it is accepted', async () => {
    const author = device({ pub: BO, owner: ME, extra: { listingVisible: () => false } })
    const r = await author.files.methods['files.share']({ file: file(3000, 4), public: true }, ACT)
    const [own] = await author.files.methods['files.list']({}, {})
    assert.equal(own.ref, r.ref)
    assert.equal(own.mine, true)
    assert.equal(own.pending, true, 'its author sees that it waits')
    const accepted = new Set()
    const other = device({ pub: 'p256:cy', owner: ME, extra: { listingVisible: (it) => accepted.has(it.v.ih) } })
    other.node.state.lists.set('mw.files', author.node.state.lists.get('mw.files'))
    assert.deepEqual(await other.files.methods['files.list']({}, {}), [], 'hidden from everyone else')
    await assert.rejects(other.files.methods['files.fetch']({ ref: r.ref }, {}), (e) => e.code === 'E_POLICY')
    assert.equal(other.torrents.adds.length, 0, 'no swarm joined for a pending listing')
    accepted.add(r.ref)
    const [shown] = await other.files.methods['files.list']({}, {})
    assert.equal(shown.ref, r.ref)
    assert.equal(shown.pending, undefined)
  })

  test('the pin key comes from deps.pinKey (an owner-written _mw.cfg), not from _mw.cfg.pin alone: files and media', async () => {
    const moderatorSet = device({ cfg: { pin: PIN }, extra: { pinKey: () => null } })
    await moderatorSet.files.methods['files.share']({ file: file(), public: true }, ACT)
    await moderatorSet.media.methods['media.upload']({ file: file(6000) }, ACT)
    assert.equal(moderatorSet.pinRequests.length, 0, 'a pin named by a moderator\'s _mw.cfg is not the site\'s: nothing is queued')
    const [f] = await moderatorSet.files.methods['files.list']({}, {})
    assert.equal(f.label, 'avail.onlyHere')
    const ownerSet = device({ cfg: {}, extra: { pinKey: () => PIN } })
    await ownerSet.files.methods['files.share']({ file: file(), public: true }, ACT)
    await ownerSet.media.methods['media.upload']({ file: file(6000) }, ACT)
    assert.equal(ownerSet.pinRequests.length, 2, 'the owner-written pin key: both own uploads are queued at once (SZ-6)')
  })
})
