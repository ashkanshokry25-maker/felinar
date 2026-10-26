// Regression tests of the media fixer's review round (docs/deviations/review-round-media.md): the read-side listing caps
// (SCALE-1, MAL53-5, SYB-13), own public uploads after a reload and the files storage budget (SCALE-13, MAL53-11), the
// digest check and the takedown that reaches running handles (MAL53-4, MAL53-3, HUB-10), the GIF first-frame cap
// (MAL53-2), the risk tier gaps (MAL53-7), names (MAL53-12), TIFF, RAW, MP3, AVI and WAV metadata (PRIV-5) and the MP4 and
// WebM allow-lists (STALK-10, MAL53-9). Node only, fakes at the TorrentManager seam. Run:
// node --test test/unit/media-review-round.test.mjs
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { createFilesService } from '../../src/files/service.js'
import { listingOk, CAPS } from '../../src/files/lane.js'
import { defaultStores } from '../../src/media/service.js'
import { MediaLane } from '../../src/media/lane.js'
import { MediaSessions } from '../../src/media/session.js'
import { encryptChunk, REGION, PIECE_SMALL, TAG_BYTES } from '../../src/media/format.js'
import { memoryBackend } from '../../src/files/store-idb.js'
import { parseTorrentFile } from '../../src/common/torrent-file.js'
import { b64url } from '../../src/chain/canonical.js'
import { createSha256 } from '../../src/files/validate.js'
import { previewPlan, imageSize, riskTier, PIXEL_CAP } from '../../src/files/preview.js'
import { cleanName, splitName, downloadName } from '../../src/files/names.js'
import { sniff } from '../../src/media/sniff.js'
import { stripMp4, stripWebm, stripMp3, stripRiff, stripperFor } from '../../src/media/strip.js'
import { readTopBoxes } from '../../src/media/faststart.js'

const NOW = 1792500000000
const te = new TextEncoder()
const ascii = (s) => te.encode(s)
const has = (u8, s) => Buffer.from(u8).indexOf(Buffer.from(s, 'latin1')) >= 0
const code = (c) => (e) => e && e.code === c
const tick = () => new Promise((resolve) => setTimeout(resolve, 5))

function text (n, seed = 1) {
  const u = new Uint8Array(n)
  for (let i = 0; i < n; i++) u[i] = 97 + ((i * 7 + seed) % 26)
  return u
}

function sha256Hex (u8) {
  const h = createSha256()
  h.update(u8)
  return h.hex()
}

/** One ledger shared by every device: lists of { h, author, ts, v }, subscribers that hear a change. */
function makeLedger () {
  const lists = new Map()
  const subs = new Set()
  let n = 0
  return {
    lists,
    nodeFor (author) {
      return {
        owner: 'p256:owner',
        state: { lists, tombstoned: new Set() },
        async append (l, v) {
          const h = (++n).toString(16).padStart(64, '0')
          const list = lists.get(l) || []
          list.push({ h, author, ts: n, v })
          lists.set(l, list)
          return { h }
        },
        async tombstone (h) {
          for (const [k, list] of lists) lists.set(k, list.filter((it) => it.h !== h))
          return { h: 't' }
        },
        subscribe (fn) {
          subs.add(fn)
          return () => subs.delete(fn)
        }
      }
    },
    raw (author, v) {
      const list = lists.get('mw.files') || []
      list.push({ h: (++n).toString(16).padStart(64, '0'), author, ts: n, v })
      lists.set('mw.files', list)
    },
    fire () { for (const fn of subs) fn({}, { reason: 'remote' }) }
  }
}

/** The TorrentManager seam: a seed with a torrentFile is held; a fetch by infohash gets its pieces at once. */
function makeSwarm () {
  const held = new Map()
  const torrentsFor = () => {
    const t = { adds: [], handles: [] }
    t.addFileTorrent = async (opts) => {
      t.adds.push(opts)
      let ih = opts.infoHash
      if (opts.torrentFile) {
        const p = await parseTorrentFile(opts.torrentFile)
        ih = p.infoHash
        const s = new opts.store(p.pieceLength, { length: p.length })
        const pieces = []
        for (let i = 0; i < p.pieceCount; i++) pieces.push(await s.getAsync(i))
        if (pieces.every(Boolean)) held.set(ih, { torrentFile: opts.torrentFile, p, pieces })
      }
      const h = {
        infoHash: ih,
        lane: opts.lane || 'E',
        destroyed: false,
        on () {},
        once () {},
        setLane (l) { h.lane = l },
        destroy () { h.destroyed = true },
        evidenceInputs: () => ({ local: false, wires: [], webseed: null, pin: null, now: NOW })
      }
      if (!opts.torrentFile) {
        const src = held.get(ih)
        h.metadata = async () => {
          if (!src) throw Object.assign(new Error('nobody'), { code: 'E_FILE_UNAVAILABLE' })
          return src.torrentFile
        }
        if (src) {
          const s = new opts.store(src.p.pieceLength, { length: src.p.length })
          for (let i = 0; i < src.pieces.length; i++) await s.putAsync(i, src.pieces[i])
        }
      }
      t.handles.push(h)
      return h
    }
    return t
  }
  return { held, torrentsFor }
}

function memVault () {
  const m = new Map()
  return {
    m,
    async put (k, v) { m.set(k, JSON.parse(JSON.stringify(v))); return true },
    async del (k) { return m.delete(k) },
    async entries () { return Array.from(m.entries()) }
  }
}

function device (L, S, pub, { backend = memoryBackend(), vault = memVault(), denied = new Set(), extra = {} } = {}) {
  const prompts = []
  const stores = defaultStores(backend)
  const torrents = S.torrentsFor()
  const deps = {
    keys: { pub },
    ledgerId: 'mw1:test',
    node: L.nodeFor(pub),
    cfg: () => ({ files: 'members', media: 'members' }),
    deviceClass: 'desktop',
    hostOnly: () => false,
    ownTracker: 'ws://127.0.0.1:8000',
    torrents,
    chat: { dm: { async send () { return { state: 'delivered' } } } },
    isDenied: async (id) => denied.has(id),
    prompt: async (card) => { prompts.push(card); return true },
    sessions: new MediaSessions({ sw: null, capBytes: 25 * 1024 * 1024 }),
    makeStore: stores.makeStore,
    storeClass: stores.storeClass,
    now: () => NOW,
    vault,
    doneWaitMs: 500,
    pollMs: 5,
    strip: {
      async stripImage () { throw Object.assign(new Error('no decoder'), { code: 'E_MEDIA_STRIP' }) },
      async stripMp4 (blob) { return { blob, removed: [] } },
      async stripWebm (blob) { return { blob, removed: [] } }
    }
  }
  Object.assign(deps, extra)
  const files = createFilesService(deps)
  const call = (m, params = {}) => files.methods[m](params, { activation: true })
  return { files, call, prompts, backend, vault, denied, torrents, lane: files.lane }
}

const share = (d, bytes, name) => d.call('files.share', { file: new Blob([bytes]), public: true, name })
const listing = (ih, len, name = 'x.txt') => ({ ih, len, name, mime: 'text/plain', t: 1 })
const hexIh = (k) => k.toString(16).padStart(40, '0')

// ------------------------------------------------------------------------------- SCALE-1, MAL53-5, SYB-13

test('SCALE-1 / MAL53-5: a forged listing above 25 MiB is not a listing; an honest share still fits the site', async () => {
  const L = makeLedger()
  const S = makeSwarm()
  assert.equal(listingOk(listing(hexIh(1), Number.MAX_SAFE_INTEGER)), false)
  assert.equal(listingOk(listing(hexIh(1), CAPS.publicPerFile + 1)), false)
  assert.equal(listingOk(listing(hexIh(1), CAPS.publicPerFile)), true)
  L.raw('p256:mallory', listing(hexIh(1), Number.MAX_SAFE_INTEGER))
  const a = device(L, S, 'p256:alice')
  assert.equal((await a.call('files.list')).length, 0, 'the forged listing is not shown')
  const r = await share(a, text(1000), 'notes.txt')
  assert.equal(r.listed, true, 'the honest share is not refused with E_LIMIT')
})

test('MAL53-5: another author\'s pending listings never use the uploader\'s room; only shown listings count', async () => {
  const L = makeLedger()
  const S = makeSwarm()
  for (let i = 0; i < 11; i++) L.raw('p256:pending', listing(hexIh(100 + i), CAPS.publicPerFile))
  const a = device(L, S, 'p256:alice', { extra: { listingVisible: (it) => it.author !== 'p256:pending' } })
  assert.equal((await a.call('files.list')).length, 0)
  assert.equal((await share(a, text(5000), 'a.txt')).listed, true)
  // Without premoderation, 11 x 25 MiB from 11 keys: the site shows 10 (250 MiB) and an upload that fits the rest passes.
  const L2 = makeLedger()
  for (let i = 0; i < 11; i++) L2.raw('p256:k' + i, listing(hexIh(200 + i), CAPS.publicPerFile))
  const b = device(L2, S, 'p256:bob')
  assert.equal((await b.call('files.list')).length, 10, 'the 256 MiB site total holds where honest copies read')
  assert.equal((await share(b, text(5000), 'b.txt')).listed, true)
  await assert.rejects(share(b, text(7 * 1024 * 1024), 'big.txt'), code('E_LIMIT'), 'the site total still holds')
})

test('SYB-13: a hand-written flood shows the author\'s first 20; a relisting cannot rename an infohash', async () => {
  const L = makeLedger()
  const S = makeSwarm()
  for (let i = 0; i < 25; i++) L.raw('p256:mallory', listing(hexIh(300 + i), 10))
  L.raw('p256:jay', listing(hexIh(300), 10, 'URGENT-invoice.pdf.exe'))
  const a = device(L, S, 'p256:alice')
  const rows = await a.call('files.list')
  assert.equal(rows.filter((r) => r.author === 'p256:mallory').length, 20)
  assert.equal(rows.filter((r) => r.ref === hexIh(300)).length, 1, 'an infohash shows once')
  assert.equal(rows.find((r) => r.ref === hexIh(300)).name, 'x.txt', 'under its first visible name')
  assert.ok(!rows.some((r) => r.author === 'p256:jay'))
  await assert.rejects(a.call('files.fetch', { ref: hexIh(324) }), code('E_POLICY'), 'a listing past the cap cannot be fetched')
})

// ------------------------------------------------------------------------------- SCALE-13, MAL53-11

test('SCALE-13: an own public upload is stored as f-<infohash>, comes back after a reload, seeds again in lane K and can be removed', async () => {
  const L = makeLedger()
  const S = makeSwarm()
  const backend = memoryBackend()
  const vault = memVault()
  const a = device(L, S, 'p256:alice', { backend, vault })
  const r = await share(a, text(40000), 'a.txt')
  assert.ok((await backend.keys('f-' + r.ih)).length > 0, 'the store is named by the infohash')
  assert.ok(vault.m.has('pub:' + r.ih))
  a.files.destroy()
  const again = device(L, S, 'p256:alice', { backend, vault })
  const rows = await again.call('files.list')
  const row = rows.find((x) => x.ref === r.ih)
  assert.equal(row.mine, true)
  assert.equal(row.fetched, true, 'the own copy is found again')
  await tick()
  const add = again.torrents.adds.find((o) => o.torrentFile)
  assert.ok(add, 'it joins its swarm again')
  assert.equal(add.lane, 'K')
  assert.equal((await parseTorrentFile(add.torrentFile)).infoHash, r.ih)
  assert.deepEqual(await again.call('files.remove', { ref: r.ih }), { removed: true })
  await tick()
  assert.equal((await backend.keys('f-' + r.ih)).length, 0)
  assert.equal(vault.m.has('pub:' + r.ih), false)
})

test('SCALE-13 / MAL53-11: fetched files live under the storage budget, least recently used first; own uploads stay', async () => {
  const L = makeLedger()
  const S = makeSwarm()
  const a = device(L, S, 'p256:alice')
  const ihs = []
  for (let i = 0; i < 3; i++) ihs.push((await share(a, text(20000, i), 'f' + i + '.txt')).ih)
  const backend = memoryBackend()
  const b = device(L, S, 'p256:bob', { backend, extra: { filesBudget: 50000 } })
  const own = await share(b, text(9000, 9), 'mine.txt')
  await b.call('files.fetch', { ref: ihs[0] })
  await b.call('files.fetch', { ref: ihs[1] })
  await b.call('files.preview', { ref: ihs[0] }) // f0 is now used more recently than f1
  await b.call('files.fetch', { ref: ihs[2] })
  await tick()
  assert.equal((await backend.keys('f-' + ihs[1])).length, 0, 'the least recently used copy went')
  assert.ok((await backend.keys('f-' + ihs[0])).length > 0)
  assert.ok((await backend.keys('f-' + ihs[2])).length > 0)
  assert.ok((await backend.keys('f-' + own.ih)).length > 0, 'an own upload is never evicted')
  const rows = await b.call('files.list')
  assert.equal(rows.find((x) => x.ref === ihs[1]).fetched, false)
  await b.call('files.fetch', { ref: ihs[1] }) // fetched again on a click
  assert.equal((await b.call('files.list')).find((x) => x.ref === ihs[1]).fetched, true)
  const tiny = device(L, S, 'p256:carol', { extra: { filesBudget: 1000 } })
  await assert.rejects(tiny.call('files.fetch', { ref: ihs[0] }), code('E_LIMIT'), 'a file larger than the whole budget is refused')
})

// ------------------------------------------------------------------------------- MAL53-4, MAL53-3, HUB-10

test('MAL53-4: denied bytes relisted under a new name and without sha256 end E_DENIED after the download; the copy goes', async () => {
  const L = makeLedger()
  const S = makeSwarm()
  const bytes = text(30000, 4)
  const a = device(L, S, 'p256:alice')
  const m = device(L, S, 'p256:mallory')
  const r1 = await share(a, bytes, 'one.txt')
  const r2 = await share(m, bytes, 'two.txt')
  assert.notEqual(r1.ih, r2.ih, 'the display name is inside the infohash')
  const it = L.lists.get('mw.files').find((x) => x.v.ih === r2.ih)
  delete it.v.sha256 // a hand-written listing that leaves the digest out (MF-56 allows it)
  const backend = memoryBackend()
  const denied = new Set([sha256Hex(bytes)]) // the moderator denied the first listing's digest
  const b = device(L, S, 'p256:bob', { backend, denied })
  await assert.rejects(b.call('files.fetch', { ref: r1.ih }), code('E_DENIED'))
  await assert.rejects(b.call('files.fetch', { ref: r2.ih }), code('E_DENIED'), 'the computed digest is checked')
  await tick()
  assert.equal((await backend.keys('f-' + r2.ih)).length, 0, 'the downloaded copy is deleted')
  assert.ok(!(await b.call('files.list')).some((x) => x.ref === r2.ih))
})

test('MAL53-3 / HUB-10: a _deny/ entry that arrives while a file seeds stops the handle and deletes every copy', async () => {
  const L = makeLedger()
  const S = makeSwarm()
  const aBackend = memoryBackend()
  const a = device(L, S, 'p256:alice', { backend: aBackend })
  const r = await share(a, text(30000, 5), 'p0.txt')
  const backend = memoryBackend()
  const b = device(L, S, 'p256:bob', { backend })
  await b.call('files.fetch', { ref: r.ih })
  await b.call('files.keepSharing', { ref: r.ih, on: true })
  const handle = b.torrents.handles[b.torrents.handles.length - 1]
  assert.equal(handle.destroyed, false)
  const ownHandle = a.torrents.handles[0]
  a.denied.add(r.ih)
  b.denied.add(r.ih)
  L.fire()
  await b.lane.denySweep()
  await a.lane.denySweep()
  await tick()
  assert.equal(handle.destroyed, true, 'the helper\'s handle leaves the swarm')
  assert.equal(ownHandle.destroyed, true, 'the uploader\'s handle too')
  assert.equal((await backend.keys('f-' + r.ih)).length, 0)
  assert.equal((await aBackend.keys('f-' + r.ih)).length, 0)
  assert.ok(!(await b.call('files.list')).some((x) => x.ref === r.ih))
  await assert.rejects(b.call('files.fetch', { ref: r.ih }), code('E_DENIED'))
})

function mediaRec (id, from) {
  const h = { destroyed: false, destroy () { h.destroyed = true } }
  return { id, from, M: { ih: hexIh(900), kind: 'video', mime: 'video/mp4', total: 1, P: PIECE_SMALL, regions: { poster: [0, 0], media: [0, 1] } }, fk: new Uint8Array(32), store: { destroy (cb) { cb() } }, storeName: 'm-' + id, handle: h, state: 'ready', grants: new Map(), keep: false }
}

test('MAL53-3 (media): open, accept, Keep available and the re-seed never join a denied swarm; a later deny reaches a running handle', async () => {
  const subs = new Set()
  const adds = []
  let denied = true
  const lane = new MediaLane({
    keys: { pub: 'p256:me' },
    node: { subscribe (fn) { subs.add(fn); return () => subs.delete(fn) }, state: { lists: new Map() } },
    torrents: { async addFileTorrent (o) { adds.push(o); return { on () {}, destroy () {} } } },
    isDenied: async () => denied,
    prompt: async () => true,
    sessions: { close () {} },
    hostOnly: () => false
  })
  const got = mediaRec('a1', 'p256:bo')
  got.handle = null
  lane.items.set('a1', got)
  await assert.rejects(lane.open('a1'), code('E_DENIED'))
  assert.equal(lane.items.has('a1'), false, 'a received item is forgotten')
  const offer = mediaRec('a2', 'p256:bo')
  offer.handle = null
  offer.state = 'offer'
  lane.items.set('a2', offer)
  await assert.rejects(lane.accept('a2'), code('E_DENIED'))
  const own = mediaRec('a3', 'mine')
  own.handle = null
  lane.items.set('a3', own)
  await assert.rejects(lane.keepAvailable('a3', true), code('E_DENIED'))
  lane._reseed(['a3'])
  await tick()
  assert.equal(adds.length, 0, 'no denied infohash reached addFileTorrent')
  assert.ok(lane.items.has('a3'), 'the person\'s own item keeps its bytes')
  // A handle that runs before the deny: the subscription takes it down.
  denied = false
  const running = mediaRec('a4', 'p256:bo')
  lane.items.set('a4', running)
  lane._watch()
  denied = true
  for (const fn of subs) fn({}, { reason: 'remote' })
  await lane.denySweep()
  assert.equal(running.handle.destroyed, true)
  assert.equal(lane.items.has('a4'), false)
})

// ------------------------------------------------------------------------------- MAL53-2

function gif ({ sw, sh, fw, fh, gct = false, ext = false }) {
  const parts = [ascii('GIF89a'), new Uint8Array([sw & 255, sw >> 8, sh & 255, sh >> 8, gct ? 0x80 : 0, 0, 0])]
  if (gct) parts.push(new Uint8Array(6))
  if (ext) parts.push(new Uint8Array([0x21, 0xf9, 4, 0, 0, 0, 0, 0]), new Uint8Array([0x21, 0xfe, 3, 0x61, 0x62, 0x63, 0]))
  parts.push(new Uint8Array([0x2c, 0, 0, 0, 0, fw & 255, fw >> 8, fh & 255, fh >> 8, 0, 2, 2, 0x4c, 1, 0, 0x3b]))
  return new Uint8Array(Buffer.concat(parts.map((p) => Buffer.from(p))))
}

test('MAL53-2: a GIF whose 1x1 screen hides an 8000x8000 first frame is refused from the header; no frame, no preview', () => {
  const bomb = gif({ sw: 1, sh: 1, fw: 8000, fh: 8000, gct: true, ext: true })
  assert.deepEqual(imageSize(bomb, 'image/gif'), { w: 8000, h: 8000 })
  const p = previewPlan(bomb)
  assert.deepEqual([p.kind, p.reason], ['none', 'too-large'])
  assert.equal(previewPlan(gif({ sw: 1, sh: 1, fw: 65535, fh: 65535 })).kind, 'none')
  assert.equal(previewPlan(gif({ sw: 100, sh: 80, fw: 50, fh: 40, ext: true })).kind, 'image')
  assert.equal(previewPlan(ascii('GIF89a\x01\x00\x01\x00\x00\x00\x00')).kind, 'none', 'a head without its first frame is not previewed')
})

test('MAL53-2 (private media): the first chunk of a received GIF is checked before a session hands it to a decoder', async () => {
  const lane = new MediaLane({ keys: { pub: 'p256:me' } })
  const C = PIECE_SMALL - TAG_BYTES
  const fk = new Uint8Array(32).fill(3)
  const base = new Uint8Array(8).fill(4)
  const fid = new Uint8Array(16).fill(5)
  const item = async (bytes) => {
    const pt = new Uint8Array(C)
    pt.set(bytes, 0)
    const ct = await encryptChunk(fk, base, fid, 0, 1, REGION.media, pt)
    return { id: 'g', from: 'p256:bo', fk, store: { getAsync: async () => ct }, M: { kind: 'image', mime: 'image/gif', len: bytes.length, plen: 0, P: PIECE_SMALL, total: 1, base: b64url.encode(base), fid: b64url.encode(fid), regions: { poster: [0, 0], media: [0, 1] } } }
  }
  await assert.rejects(lane._checkedChunk(await item(gif({ sw: 1, sh: 1, fw: 8000, fh: 8000 })), 0), code('E_MEDIA_TYPE'))
  const ok = await item(gif({ sw: 64, sh: 64, fw: 64, fh: 64 }))
  assert.equal((await lane._checkedChunk(ok, 0)).length, PIECE_SMALL)
  assert.ok(64 * 64 < PIXEL_CAP)
})

// ------------------------------------------------------------------------------- MAL53-7, PRIV-5, MAL53-12

test('MAL53-7: LNK, ISO, CAB, OneNote, CHM, compiled AppleScript, VHD and VHDX by magic; unknown, HTML, SVG and PDF ask too', () => {
  const iso = new Uint8Array(0x8800)
  iso.set(ascii('CD001'), 0x8001)
  const cases = [
    [new Uint8Array([0x4c, 0, 0, 0, 1, 0x14, 2, 0, 0, 0, 0, 0, 0xc0, 0, 0, 0, 0, 0, 0, 0x46, 0, 0]), 'lnk'],
    [iso, 'iso'],
    [ascii('MSCF\0\0\0\0\x10\0'), 'cab'],
    [new Uint8Array([0xe4, 0x52, 0x5c, 0x7b, 0x8c, 0xd8, 0xa7, 0x4d, 0xae, 0xb1, 0x53, 0x78, 0xd0, 0x29, 0x96, 0xd3, 0]), 'one'],
    [ascii('ITSF\x03\0\0\0'), 'chm'],
    [ascii('FasdUAS 1.101.10'), 'scpt'],
    [ascii('conectix\0\0'), 'vhd'],
    [ascii('vhdxfile\0\0'), 'vhdx']
  ]
  for (const [bytes, ext] of cases) {
    const s = sniff(bytes)
    assert.equal(s.ext, ext, ext)
    assert.equal(riskTier(s).tier, 'confirm', ext)
  }
  for (const s of ['<!doctype html><script>x</script>', '<svg xmlns="x"><script/></svg>', '%PDF-1.7\n']) assert.equal(riskTier(sniff(ascii(s))).tier, 'confirm', s)
  const unknown = sniff(new Uint8Array([0, 1, 2, 3, 250]))
  assert.equal(riskTier(unknown).tier, 'confirm')
  assert.equal(riskTier(unknown, ['unknown']).tier, 'blocked', 'an owner can block them')
  assert.equal(riskTier(sniff(ascii('hello\n'))).tier, 'plain')
  assert.equal(riskTier(sniff(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))).tier, 'plain')
})

test('PRIV-5: TIFF and camera RAW are images (the stripper runs; a public upload is refused when it cannot); MP3 and RIFF have strippers', async () => {
  for (const [bytes, mime] of [
    [new Uint8Array([0x49, 0x49, 0x2a, 0, 8, 0, 0, 0]), 'image/tiff'], [new Uint8Array([0x4d, 0x4d, 0, 0x2a, 0, 0, 0, 8]), 'image/tiff'],
    [ascii('IIRO\0\0\0\0'), 'image/x-raw'], [new Uint8Array([0x49, 0x49, 0x55, 0, 0, 0]), 'image/x-raw'], [ascii('FUJIFILMCCD-RAW 0201'), 'image/x-raw'],
    [ascii('\0\0\0\x18ftypcrx \0\0\0\x01crx isom'), 'image/x-raw']
  ]) {
    const s = sniff(bytes)
    assert.deepEqual([s.mime, s.kind], [mime, 'image'])
    assert.equal(stripperFor(s.mime), 'image')
  }
  assert.equal(stripperFor('audio/mpeg'), 'mp3')
  assert.equal(stripperFor('video/x-msvideo'), 'riff')
  assert.equal(stripperFor('audio/wav'), 'riff')
  assert.equal(downloadName('photo.dng', sniff(new Uint8Array([0x49, 0x49, 0x2a, 0, 8, 0, 0, 0]))), 'photo.dng')
  const L = makeLedger()
  const S = makeSwarm()
  const a = device(L, S, 'p256:alice')
  const tiff = new Uint8Array(2000)
  tiff.set([0x49, 0x49, 0x2a, 0, 8, 0, 0, 0], 0)
  tiff.set(ascii('GPS 43.6532N 79.3832W'), 100)
  await assert.rejects(share(a, tiff, 'IMG.dng'), code('E_MEDIA_STRIP'), 'no decoder here: the public upload is refused')
  await share(a, ascii('%PDF-1.7\n' + 'x'.repeat(500)), 'doc.pdf')
  assert.equal(a.prompts.find((p) => p.kind === 'file-share').unchecked, true, 'the card knows the file was not checked')
})

test('PRIV-5: stripMp3 drops ID3v2, ID3v1 and APEv2 tags; stripRiff turns LIST INFO, IDIT and bext into JUNK of the same length', async () => {
  const frames = new Uint8Array(400).fill(0x55)
  frames.set([0xff, 0xfb, 0x90, 0x64], 0)
  const id3body = ascii('TXXX GPS 43.6532 -79.3832 owner')
  const sz = id3body.length
  const id3 = new Uint8Array([...ascii('ID3'), 4, 0, 0, (sz >> 21) & 127, (sz >> 14) & 127, (sz >> 7) & 127, sz & 127, ...id3body])
  const v1 = new Uint8Array(128)
  v1.set(ascii('TAGHome recording'), 0)
  const mp3 = await stripMp3(new Blob([id3, frames, v1]))
  const out = new Uint8Array(await mp3.blob.arrayBuffer())
  assert.deepEqual(mp3.removed, ['ID3v2', 'ID3v1'])
  assert.deepEqual(Array.from(out), Array.from(frames))
  // AVI: hdrl (with a strn stream name), LIST INFO, IDIT, movi, idx1
  const le = (n) => [n & 255, (n >> 8) & 255, (n >> 16) & 255, (n >>> 24) & 255]
  const chunk = (id, body) => new Uint8Array([...ascii(id), ...le(body.length), ...body, ...(body.length % 2 ? [0] : [])])
  const list = (type, ...kids) => chunk('LIST', [...ascii(type), ...kids.flatMap((k) => Array.from(k))])
  const avih = chunk('avih', new Array(56).fill(1))
  const strl = list('strl', chunk('strh', new Array(56).fill(2)), chunk('strf', new Array(40).fill(3)), chunk('strn', Array.from(ascii('Cam serial 0042'))))
  const body = [list('hdrl', avih, strl), list('INFO', chunk('ICRD', Array.from(ascii('2026-10-01 GPS home'))), chunk('ISFT', Array.from(ascii('PhoneCam')))),
    chunk('IDIT', Array.from(ascii('Thu Oct 01 08:00:00 2026'))), list('movi', chunk('00dc', new Array(100).fill(9))), chunk('idx1', new Array(16).fill(0))]
  const flat = body.flatMap((b) => Array.from(b))
  const avi = new Uint8Array([...ascii('RIFF'), ...le(4 + flat.length), ...ascii('AVI '), ...flat])
  const r = await stripRiff(new Blob([avi]))
  const a2 = new Uint8Array(await r.blob.arrayBuffer())
  assert.equal(a2.length, avi.length, 'nothing moves')
  for (const s of ['GPS home', 'PhoneCam', 'Thu Oct 01', 'Cam serial']) assert.ok(!has(a2, s), s)
  assert.ok(has(a2, 'movi') && has(a2, 'idx1') && has(a2, 'strh'))
  assert.ok(r.removed.includes('LIST:INFO') && r.removed.includes('IDIT') && r.removed.includes('hdrl/LIST:strl/strn'), JSON.stringify(r.removed))
  const wflat = [chunk('fmt ', new Array(16).fill(1)), chunk('bext', Array.from(ascii('Originator: field recorder at home'))), chunk('data', new Array(64).fill(7))].flatMap((b) => Array.from(b))
  const wav = new Uint8Array([...ascii('RIFF'), ...le(4 + wflat.length), ...ascii('WAVE'), ...wflat])
  const w = await stripRiff(new Blob([wav]))
  const w2 = new Uint8Array(await w.blob.arrayBuffer())
  assert.equal(w2.length, wav.length)
  assert.ok(!has(w2, 'field recorder'))
  await assert.rejects(stripRiff(new Blob([ascii('RIFF\x04\0\0\0XXXX')])), code('E_MEDIA_STRIP'))
})

test('MAL53-12: invisible fillers, trailing dots and Windows device names cannot hide or change an extension', () => {
  assert.equal(cleanName('Statement.pdf' + '⠀'.repeat(12) + '.lnk'), 'Statement.pdf.lnk')
  assert.equal(cleanName('Photo.jpg' + 'ㅤ'.repeat(4) + '.exe'), 'Photo.jpg.exe')
  assert.equal(cleanName('a­bᅟᅠﾠ᠎️.txt'), 'ab.txt')
  assert.equal(cleanName('setup.exe.'), 'setup.exe')
  assert.equal(splitName(cleanName('setup.exe. . ')).ext, 'exe')
  assert.equal(cleanName('CON.txt'), '_CON.txt')
  assert.equal(cleanName('nul'), '_nul')
})

// ------------------------------------------------------------------------------- STALK-10, MAL53-9

const u32s = (...ns) => {
  const b = Buffer.alloc(4 * ns.length)
  ns.forEach((n, i) => b.writeUInt32BE(n, 4 * i))
  return b
}
function box (type, ...parts) {
  const body = Buffer.concat(parts)
  const h = Buffer.alloc(8)
  h.writeUInt32BE(8 + body.length, 0)
  h.write(type, 4, 'latin1')
  return Buffer.concat([h, body])
}
const full = (type, ...parts) => box(type, Buffer.alloc(4), ...parts)

test('STALK-10 / MAL53-9: MP4 metadata removal is an allow-list: uuid, skip, free, vendor boxes and the recording times go', async () => {
  const GPS = 'GPS +43.6532-079.3832/'
  const T = 0xe7000000
  const ftyp = box('ftyp', Buffer.from('isom\0\0\0\0isomavc1', 'latin1'))
  const vendorTop = box('uuid', Buffer.alloc(16, 0x42), Buffer.from(GPS + 'top', 'latin1'))
  const skip = box('skip', Buffer.from(GPS + 'skip', 'latin1'))
  const free = box('free', Buffer.from('SERIAL-123456', 'latin1'))
  const mdat = box('mdat', Buffer.alloc(200, 0x11))
  const at = ftyp.length + vendorTop.length + skip.length + free.length + 8
  const stbl = box('stbl', full('stsd', u32s(1), box('avc1', Buffer.alloc(8))), full('stts', u32s(1, 1, 1)), full('stsc', u32s(1, 1, 1, 1)), full('stsz', u32s(0, 1, 200)), full('stco', u32s(1, at)))
  const trak = box('trak', full('tkhd', u32s(T, T + 1), Buffer.alloc(72)), box('mdia', full('mdhd', u32s(T, T + 1), Buffer.alloc(12)),
    full('hdlr', u32s(0), Buffer.from('vide', 'latin1'), Buffer.alloc(12), Buffer.from('v\0', 'latin1')), box('minf', box('dinf'), stbl)), box('gps ', Buffer.from(GPS + 'trak', 'latin1')))
  const moov = box('moov', full('mvhd', u32s(T, T + 1, 1000, 1000), Buffer.alloc(80)), trak, box('uuid', Buffer.alloc(16, 0x43), Buffer.from(GPS + 'moov', 'latin1')), box('udta', Buffer.from('\xa9xyz+43.65-079.38/', 'latin1')))
  const input = Buffer.concat([ftyp, vendorTop, skip, free, mdat, moov])
  const { blob, removed } = await stripMp4(new Blob([input], { type: 'video/mp4' }))
  const out = new Uint8Array(await blob.arrayBuffer())
  assert.equal(out.length, input.length, 'nothing moves')
  assert.ok(!has(out, 'GPS +43') && !has(out, 'SERIAL-123456') && !has(out, '+43.65'), 'no vendor payload survives')
  assert.ok(!Buffer.from(out).includes(Buffer.from(u32s(T, T + 1))), 'creation and modification times are 0')
  assert.ok(out.subarray(at, at + 200).every((x) => x === 0x11), 'the samples stay')
  for (const p of ['uuid', 'skip', 'free', 'moov/uuid', 'moov/udta', 'moov/trak/gps ', 'moov/times']) assert.ok(removed.includes(p), p + ' in ' + JSON.stringify(removed))
  const top = await readTopBoxes(new Blob([out]))
  assert.deepEqual(top.map((b) => b.type), ['ftyp', 'free', 'free', 'free', 'mdat', 'moov'])
})

function vint8 (n) {
  const b = Buffer.alloc(8)
  b[0] = 0x01
  let v = n
  for (let k = 7; k >= 1; k--) { b[k] = v & 255; v = Math.floor(v / 256) }
  return b
}
const el = (id, ...parts) => {
  const body = Buffer.concat(parts.map((p) => (typeof p === 'string' ? Buffer.from(p, 'latin1') : Buffer.from(p))))
  return Buffer.concat([Buffer.from(id), vint8(body.length), body])
}

test('STALK-10: WebM loses Info DateUTC, MuxingApp and WritingApp, and its Attachments and Chapters, besides Tags and Title', async () => {
  const info = el([0x15, 0x49, 0xa9, 0x66], el([0x2a, 0xd7, 0xb1], [0x0f, 0x42, 0x40]), el([0x7b, 0xa9], 'Home video'),
    el([0x44, 0x61], [0, 1, 2, 3, 4, 5, 6, 7]), el([0x4d, 0x80], 'PhoneMux 9.1'), el([0x57, 0x41], 'SerialXYZ-77'))
  const segment = el([0x18, 0x53, 0x80, 0x67], info, el([0x16, 0x54, 0xae, 0x6b], el([0xae], [0x83, 0x81, 1])),
    el([0x19, 0x41, 0xa4, 0x69], 'cover-at-home.jpg'), el([0x10, 0x43, 0xa7, 0x70], 'Chapter: our street'), el([0x1f, 0x43, 0xb6, 0x75], [0xe7, 0x81, 0]))
  const input = Buffer.concat([el([0x1a, 0x45, 0xdf, 0xa3], el([0x42, 0x82], 'webm')), segment])
  const { blob, removed } = await stripWebm(new Blob([input], { type: 'video/webm' }))
  const out = new Uint8Array(await blob.arrayBuffer())
  assert.equal(out.length, input.length)
  for (const s of ['Home video', 'PhoneMux', 'SerialXYZ', 'cover-at-home', 'our street']) assert.ok(!has(out, s), s)
  assert.ok(!Buffer.from(out).includes(Buffer.from([0, 1, 2, 3, 4, 5, 6, 7])), 'DateUTC is gone')
  for (const p of ['Info/Title', 'Info/DateUTC', 'Info/MuxingApp', 'Info/WritingApp', 'Attachments', 'Chapters']) assert.ok(removed.includes(p), p)
})

test('integrator (STALK-12): a public listing carries the minute it was made, not the millisecond', async () => {
  const L = makeLedger()
  const S = makeSwarm()
  const a = device(L, S, 'p256:alice', { extra: { now: () => NOW + 12345 } })
  const r = await share(a, text(1000), 'minute.txt')
  const it = L.lists.get('mw.files').find((x) => x.v.ih === r.ih)
  assert.ok(Number.isSafeInteger(it.v.t) && it.v.t > 0)
  assert.equal(it.v.t % 60000, 0, 'rounded down to the minute')
  await tick()
  const add = a.torrents.adds.find((o) => o.torrentFile)
  assert.equal(add.expectedLength, 1000, 'MAL53-6: the listing length bounds the metadata of the file wire')
})

test('integrator (MAL53-10): private file grants not yet fetched are capped per sender (20) and the rest dropped and counted', async () => {
  const { streamPlan } = await import('../../src/files/encrypt.js')
  const { FK_BYTES } = await import('../../src/media/format.js')
  const L = makeLedger()
  const S = makeSwarm()
  const a = device(L, S, 'p256:alice')
  const grant = (k, from) => ({ t: 'file', F: { ref: k.toString(16).padStart(32, '0'), ih: hexIh(k + 1), from, to: 'p256:alice', fk: b64url.encode(new Uint8Array(FK_BYTES).fill(1)), plen: 100, len: streamPlan(100).bytes, P: 65536, name: 'f' + k } })
  let kept = 0
  for (let k = 0; k < 30; k++) if (await a.lane.onGrant('p256:mallory', grant(k, 'p256:mallory'))) kept++
  assert.equal(kept, CAPS.grantsPerSender)
  assert.equal(a.lane.grantsDropped, 30 - CAPS.grantsPerSender)
  assert.ok(await a.lane.onGrant('p256:bob', grant(100, 'p256:bob')), 'another sender still gets through')
})
