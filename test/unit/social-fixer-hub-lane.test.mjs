// Social fixer after verifier round 1 (E-SO-2, E-SO-3, E-SO-4): pins what the loader ships for the hub follow lane.
// Root cause of the intermittent E-SO-2 / E-SO-3 miss (measured: inspect().hubLane on the tab that missed showed joined true,
// torrent false, wires 0; the lane had joined while consent was pending and consent changed once): a new page's hub lane joins
// while the consent card is still open, so TorrentManager._startLane finds no peers allowed. The loader's setConsent sets the
// state, awaits the stored record and only then calls the listeners; a client built in that window already has peers
// (_clientPeers true), so _onConsentChange saw nothing to rebuild and the lane never started. _onConsentChange now starts
// lanes and file torrents that are still waiting. Also pinned: ensureTorrentManager is single-flight (a latent race: several
// callers before A.tm was set each built a manager), and the lane's kind is 'hub' (SCALE-6).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { EventEmitter } from 'node:events'
import { TorrentManager } from '../../src/loader/torrent.js'
import { CONFIG } from '../../src/loader/config.js'

const src = readFileSync(new URL('../../src/loader/app.js', import.meta.url), 'utf8')

function body (name) {
  const at = src.search(new RegExp('\\n(async )?function ' + name + ' \\('))
  assert.ok(at >= 0, name + ' is in src/loader/app.js')
  const end = src.indexOf('\n}\n', at)
  return src.slice(at, end + 2)
}

test('ensureTorrentManager is single-flight: concurrent callers share one pending manager', () => {
  const f = body('ensureTorrentManager')
  assert.match(f, /if \(A\.tm\) return Promise\.resolve\(A\.tm\)/)
  assert.match(f, /if \(!A\.tmPending\)/, 'a second caller waits on the first one\'s promise')
  assert.match(f, /A\.tmPending = createTorrentManager\(A\)/)
  assert.equal((src.match(/new TorrentManager\(/g) || []).length, 1, 'one place builds the manager')
  assert.match(body('createTorrentManager'), /new TorrentManager\(/)
})

test('the hub follow lane joins as kind "hub" (SCALE-6) and its mw_chain2 wires carry the same kind', () => {
  const f = body('joinHubLane')
  assert.match(f, /tm\.joinLane\(\{ kind: 'hub', infoHash: ih, announce: \[own\], ledgerSync: true, wanted: \(\) => A\.multi\.wantedWires, syncing: \(\) => A\.multi\.syncing === true \}\)/)
  assert.match(f, /kind: lane\.kind \}\)/, 'attachToTorrent gets the lane\'s kind, not a fixed \'group\'')
  assert.doesNotMatch(f, /kind: 'group'/)
})

class FakeTorrent extends EventEmitter {
  constructor (infoHash) { super(); this.infoHash = infoHash; this.discovery = null; this.destroyed = false }
  destroy (cb) { this.destroyed = true; if (cb) cb() }
}
class FakeWebTorrent {
  constructor () { this.torrents = [] }
  on () {}
  add (source) { const t = new FakeTorrent(source); this.torrents.push(t); return t }
  throttleUpload () {}
  destroy (cb) { if (cb) cb() }
}

function manager (consent) {
  return new TorrentManager({
    WebTorrent: FakeWebTorrent,
    config: CONFIG,
    policy: { maxConns: 8, uploadsEnabled: true, uploadLimit: 1048576, hostOnly: false },
    consent,
    deps: { MemoryChunkStore: class {}, BlobChunkStore: class {}, parseTorrentFile: async () => null },
    fetch: async () => { throw new TypeError('no network') },
    baseUrl: 'https://hub.example/',
    lifecycle: false
  })
}

test('a lane that joined while consent was pending starts when consent comes, even if a client with peers exists by then', async () => {
  let allowed = false
  const listeners = []
  const tm = manager({ peersAllowed: () => allowed, onChange: (fn) => { listeners.push(fn); return () => {} } })
  try {
    const lane = tm.joinLane({ kind: 'hub', infoHash: 'b'.repeat(40), announce: ['wss://own.example'], ledgerSync: true, wanted: () => 40, syncing: () => true })
    assert.equal(lane.torrent, null, 'consent pending: no swarm yet')
    // The window in the loader's setConsent: the state is 'accepted' and the site's start builds a client with peers before
    // the listeners run.
    allowed = true
    tm._ensureClient()
    assert.equal(tm._clientPeers, true)
    for (const fn of listeners) fn('accepted')
    assert.ok(lane.torrent, 'the lane started on the consent change')
    assert.equal(tm.client.torrents.filter((t) => t.infoHash === 'b'.repeat(40)).length, 1, 'one lane torrent, not two')
    for (const fn of listeners) fn('accepted')
    assert.equal(tm.client.torrents.length, 1, 'a second consent event adds nothing')
  } finally { await tm.destroy() }
})

test('without peers allowed the consent change starts nothing', async () => {
  const listeners = []
  const tm = manager({ peersAllowed: () => false, onChange: (fn) => { listeners.push(fn); return () => {} } })
  try {
    const lane = tm.joinLane({ kind: 'hub', infoHash: 'c'.repeat(40), announce: ['wss://own.example'], ledgerSync: true })
    for (const fn of listeners) fn('host-only')
    assert.equal(lane.torrent, null)
  } finally { await tm.destroy() }
})
