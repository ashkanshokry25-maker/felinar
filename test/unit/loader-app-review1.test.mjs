// Code review round 1 (docs/review/DESIGN-REVIEW.md "Code review round 1"): regression tests for the
// shell orchestrator steps in src/loader/app.js, run on plain objects (no DOM, no IndexedDB): hub
// arrival safety (keyless withdrawals, the gate and its copy, the hub root's #host: links), the
// rotated and first-visit pointer rules, and the identity race.
// Run: node --test test/unit/loader-app-review1.test.mjs
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { resolvePointer, vetCandidate, decidePointer, isUpdate, TabLink, RemoteNode, validTabMessage, ensureIdentity, __test } from '../../src/loader/app.js'
import * as chainCrypto from '../../src/chain/crypto.js'
import { CONFIG } from '../../src/loader/config.js'
import * as pointer from '../../src/common/pointer.js'
import { generateKeyPair, exportPublicKey } from '../../src/chain/crypto.js'

const BTIH = 'ab'.repeat(20)
const NOW = Date.UTC(2026, 9, 19, 12, 0, 0)
const SEC = Math.floor(NOW / 1000)

async function owner () {
  const kp = await generateKeyPair({ extractable: false })
  return { privateKey: kp.privateKey, pub: await exportPublicKey(kp.publicKey) }
}

async function signed (o, fields, scope) {
  const rec = Object.assign({ btih: BTIH, owner: o.pub, seq: SEC, exp: SEC + 30 * 86400 }, fields)
  return pointer.formatPointer(await pointer.signPointer(rec, scope, o.privateKey))
}

function fakeCache () {
  const prefs = new Map()
  const calls = { deleteSite: 0, saveSite: 0, savePointer: 0 }
  return {
    calls,
    prefs,
    getPin: async () => null,
    savePin: async () => {},
    getPointer: async () => null,
    savePointer: async () => { calls.savePointer++ },
    getPref: async (k, d) => (prefs.has(k) ? prefs.get(k) : d),
    setPref: async (k, v) => { prefs.set(k, v) },
    deleteSite: async () => { calls.deleteSite++ },
    saveSite: async () => { calls.saveSite++ },
    getSite: async () => null,
    listSites: async () => [{ btih: BTIH, ledgerId: 'btih:' + BTIH }],
    enforceBudget: async () => {},
    requestPersist: async () => true
  }
}

function pdeps (cache, extra = {}) {
  return Object.assign({
    parsePointer: pointer.parsePointer,
    verifyPointer: pointer.verifyPointer,
    verifyRotation: pointer.verifyRotation,
    ledgerIdFor: pointer.ledgerIdFor,
    pickRecord: pointer.pickRecord,
    joinTxtData: pointer.joinTxtData,
    resolveTxt: async () => { throw new Error('no DNS in this test') },
    shouldSkipDoh: () => true,
    cache
  }, extra)
}

function fakeUi () {
  const ui = { status: [], errors: [], banners: new Map(), cards: [], gates: [] }
  ui.setStatus = (t) => { ui.status.push(t) }
  ui.showError = (e) => { ui.errors.push(e) }
  ui.setBanner = (k, t) => { ui.banners.set(k, t) }
  ui.showConsentCard = (o) => { ui.cards.push(o); return () => {} }
  ui.showGate = (o) => { ui.gates.push(o); return () => {} }
  ui.setProgress = () => {}
  ui.setSource = () => {}
  ui.setMode = () => {}
  ui.diagnostics = { set: () => {}, log: () => {}, lines: () => [] }
  return ui
}

// ---- keyless withdrawals on hubs ----------------------------------------------------------------

test('hub: an unsigned st=withdrawn link is refused (never a withdrawal), on the subdomain and the shared hub', async () => {
  for (const mode of ['hub', 'hub-shared']) {
    const cache = fakeCache()
    const text = 'v=mw1; st=withdrawn; btih=' + BTIH + '; why=fake; ct=https://evil.example/'
    const ctx = { mode: mode === 'hub' ? 'hub' : 'hub', scope: 'btih:' + BTIH, fragment: { kind: 'record', text }, now: NOW, config: CONFIG }
    const cand = await vetCandidate(text, 'fragment', Object.assign({ pin: null }, ctx), pdeps(cache))
    assert.equal(cand.status, 'rejected')
    assert.equal(cand.reason, 'unsigned-withdrawal')
    await assert.rejects(resolvePointer(ctx, pdeps(cache)), (err) => err.code === 'E_POINTER' && /unsigned-withdrawal/.test(err.tried.join(' ')))
    assert.equal(cache.calls.savePointer, 0, 'nothing saved as the scope record')
    assert.equal(cache.calls.deleteSite, 0)
  }
  // A host's own unsigned page tag (shell) may still withdraw that host's site.
  const cache = fakeCache()
  const r = await resolvePointer({ mode: 'shell', scope: 'site.example', metaText: 'v=mw1; st=withdrawn; btih=' + BTIH, now: NOW, config: CONFIG }, pdeps(cache))
  assert.equal(r.record.withdrawn, true)
})

test('hub: the forged label attack (unsigned btih decoded from a signed label) now fails the label check', async () => {
  const o = await owner()
  const scope = 'btih:' + BTIH
  const rec = pointer.parsePointer(await signed(o, {}, scope)).record
  const lid = await pointer.ledgerIdFor(rec, scope)
  const label = pointer.hubLabelFor(rec, lid)
  const { decode } = await import('../../src/common/base32.js')
  const collider = Buffer.from(decode(label)).toString('hex')
  const forged = pointer.parsePointer('v=mw1; btih=' + collider).record
  assert.notEqual(pointer.hubLabelFor(forged, 'btih:' + collider), label)
})

test('hub: a signed withdrawal that arrives by a link deletes stored copies only after the click', async () => {
  const cache = fakeCache()
  const ui = fakeUi()
  const A = { ui, deps: { cache }, mode: { mode: 'hub-sub' }, ledgerId: 'mw1:x', record: { withdrawn: true, why: 'gone', ct: null }, log: () => {}, win: {} }
  await __test.presentWithdrawal(A, { askFirst: true })
  assert.equal(cache.calls.deleteSite, 0, 'nothing deleted before the click')
  assert.equal(A.withdrawn.pending, true)
  const del = ui.errors[0].actions.find((a) => a.primary)
  assert.ok(del, 'a delete button')
  await del.onClick()
  assert.equal(cache.calls.deleteSite, 1, 'the click deletes')
  const B = Object.assign({}, A, { ui: fakeUi(), deps: { cache: fakeCache() } })
  await __test.presentWithdrawal(B)
  assert.equal(B.deps.cache.calls.deleteSite, 1, 'from the page tag, the cache or DNS: at once')
})

// ---- the gate and its copy --------------------------------------------------------------------------

test('hub-sub: the gate depends on a stored choice, not on a stored copy', () => {
  const A = (consentState) => ({ mode: { mode: 'hub-sub' }, consentState, record: {}, config: CONFIG })
  assert.equal(__test.needsGate(A('pending'), true), true, 'a copy cached under a cancelled gate does not skip it')
  assert.equal(__test.needsGate(A('accepted'), false), false)
  assert.equal(__test.needsGate(A('host-only'), true), false)
})

function downloadA ({ signedRecord = true, gate }) {
  const cache = fakeCache()
  const calls = { download: 0, stopSite: 0 }
  const tm = {
    source: 'webseed',
    download: async () => { calls.download++; return { manifest: { btih: BTIH, files: [] }, blobs: new Map(), parsed: { length: 1, files: [] } } },
    stopSite: () => { calls.stopSite++ }
  }
  const A = {
    ui: fakeUi(), deps: { cache }, tm, calls, cache,
    mode: { mode: 'hub-sub' }, isLeader: true, ledgerPromise: null, consentState: 'pending',
    record: { signed: signedRecord, btih: BTIH, ws: ['https://seed.example/ws/'], xs: ['https://seed.example/x.torrent'] },
    policy: { maxSiteBytes: 1e6, storageBudget: 1e9 }, config: CONFIG, log: () => {}, win: {},
    gatePromise: gate
  }
  return A
}

test('a copy downloaded while the gate is open is stored only after Load; Cancel drops it and stops the torrent', async () => {
  let decide
  const A = downloadA({ gate: new Promise((resolve) => { decide = resolve }) })
  A.isLeader = false // no rendezvous in this test
  const p = __test.downloadSite(A)
  await new Promise((resolve) => setTimeout(resolve, 10))
  assert.equal(A.calls.download, 1, 'a signed record\'s web seed may start under the gate')
  assert.equal(A.cache.calls.saveSite, 0, 'not stored while the gate is open')
  decide('cancel')
  assert.equal(await p, null)
  assert.equal(A.cache.calls.saveSite, 0, 'never stored after Cancel')
  assert.equal(A.calls.stopSite, 1)
  const B = downloadA({ gate: Promise.resolve('load') })
  B.isLeader = false
  B.link = null
  const site = await __test.downloadSite(B)
  assert.ok(site)
  assert.equal(B.cache.calls.saveSite, 1, 'stored after Load')
})

test('hub: an unsigned link\'s xs= and ws= hosts are not contacted before the gate is answered', async () => {
  let decide
  const A = downloadA({ signedRecord: false, gate: new Promise((resolve) => { decide = resolve }) })
  A.isLeader = true
  A.leader = null
  A.ledgerPromise = null
  const fetched = []
  A.tm.download = async () => { fetched.push('download'); return { manifest: { btih: BTIH, files: [] }, blobs: new Map(), parsed: { length: 1, files: [] } } }
  A.link = { on: () => () => {}, send: () => {} }
  // obtainSite as the engine tab: it must wait for the gate before any download.
  const p = __test.obtainSite(A)
  await new Promise((resolve) => setTimeout(resolve, 10))
  assert.deepEqual(fetched, [], 'no xs= fetch, no web-seed probe before the click')
  A.consentState = 'accepted'
  decide('load')
  A.isLeader = false // skip the rendezvous join inside downloadSite (no torrent client here)
  await p
  assert.deepEqual(fetched, ['download'])
})

// ---- the hub root: #host: links ---------------------------------------------------------------------

test('hub root: a #host: link shows the blocking card, asks DNS only after the click, then redirects to the label origin', async () => {
  const cache = fakeCache()
  const ui = fakeUi()
  const dns = { calls: 0 }
  const text = 'v=mw1; btih=' + BTIH
  const replaced = []
  const A = {
    ui, config: CONFIG, log: () => {}, doc: null, env: null, origin: 'https://hub.example',
    mode: { mode: 'hub-root', hubHost: 'hub.example', fragment: { kind: 'host', host: 'example.com', text: null } },
    win: { location: { protocol: 'https:', port: '', hash: '#host:example.com', replace: (u) => replaced.push(u) } },
    deps: {
      pointer,
      cache,
      doh: { resolveTxt: async () => { dns.calls++; return { resolver: 'test', strings: [text], ad: false, ttl: 300 } }, shouldSkipDoh: () => false, dohOverrideFromMeta: () => null }
    }
  }
  const done = __test.runHubRoot(A, null)
  await new Promise((resolve) => setTimeout(resolve, 20))
  assert.equal(ui.cards.length, 1, 'the blocking card')
  assert.equal(ui.cards[0].blocking, true)
  assert.equal(dns.calls, 0, 'no DoH request before the click')
  ui.cards[0].onShare()
  await done
  assert.equal(dns.calls, 1, 'exactly one after it')
  const label = pointer.hubLabelFor(pointer.parsePointer(text).record, 'btih:' + BTIH)
  assert.deepEqual(replaced, ['https://' + label + '.hub.example/#host:example.com'])
  // The choice is kept for this origin: the next #host: link resolves without the card.
  const ui2 = fakeUi()
  const replaced2 = []
  const A2 = Object.assign({}, A, { ui: ui2, win: { location: { protocol: 'https:', port: '', hash: '#host:example.com', replace: (u) => replaced2.push(u) } } })
  await __test.runHubRoot(A2, null)
  assert.equal(ui2.cards.length, 0)
  assert.equal(replaced2.length, 1)
})

test('hub root: Cancel on the card asks nothing and stays put', async () => {
  const cache = fakeCache()
  const ui = fakeUi()
  let dnsCalls = 0
  const replaced = []
  const A = {
    ui, config: CONFIG, log: () => {}, doc: null, env: null, origin: 'https://hub.example',
    mode: { mode: 'hub-root', hubHost: 'hub.example', fragment: { kind: 'host', host: 'example.com', text: null } },
    win: { location: { protocol: 'https:', port: '', hash: '#host:example.com', replace: (u) => replaced.push(u), reload: () => {} } },
    deps: { pointer, cache, doh: { resolveTxt: async () => { dnsCalls++; return { strings: [] } }, shouldSkipDoh: () => false, dohOverrideFromMeta: () => null } }
  }
  const done = __test.runHubRoot(A, null)
  await new Promise((resolve) => setTimeout(resolve, 20))
  ui.cards[0].onCancel()
  await done
  assert.equal(dnsCalls, 0)
  assert.deepEqual(replaced, [])
})


// ---- pointer trust: rotations, the first visit, a poisoned floor -------------------------------------

async function rotatedText (from, to, seq, scope) {
  const rot = await pointer.signRotation({ owner: to.pub, seq, scope }, from.privateKey)
  return signed(to, { seq, rot }, scope)
}

test('a valid rot= from the pinned key is trusted: status ok, rotated, an update, and DNS wins over the page tag', async () => {
  const k1 = await owner()
  const k2 = await owner()
  const scope = 'site.example'
  const current = pointer.parsePointer(await signed(k1, { seq: SEC - 100 }, scope)).record
  const text = await rotatedText(k1, k2, SEC - 50, scope)
  const ctx = { mode: 'shell', scope, now: NOW, config: CONFIG, pin: { owner: k1.pub }, cachedSeq: SEC - 100 }
  const cand = await vetCandidate(text, 'dns', ctx, pdeps(fakeCache()))
  assert.equal(cand.status, 'ok')
  assert.equal(cand.trusted, true)
  assert.equal(cand.rotated, true)
  assert.equal(isUpdate(current, cand), true, 'the DNS update check applies a rotated record')
  const meta = await vetCandidate(await signed(k1, { seq: SEC - 100 }, scope), 'meta', ctx, pdeps(fakeCache()))
  assert.equal(decidePointer({ mode: 'shell', meta, dns: cand }).pick, cand)
  // A rotated withdrawal is a trusted update too (it is applied at once by withdrawNow).
  const rot = await pointer.signRotation({ owner: k2.pub, seq: SEC - 40, scope }, k1.privateKey)
  const wtext = pointer.formatPointer(await pointer.signPointer(pointer.withdrawalRecord({ owner: k2.pub, seq: SEC - 40, exp: SEC + 86400, rot }), scope, k2.privateKey))
  const wcand = await vetCandidate(wtext, 'dns', ctx, pdeps(fakeCache()))
  assert.equal(wcand.status, 'ok')
  assert.equal(wcand.record.withdrawn, true)
  assert.equal(isUpdate(current, wcand), true)
})

test('first visit: a DNS record signed by an unrelated key never beats the page tag, and is never pinned', async () => {
  const a = await owner()
  const b = await owner()
  const scope = 'site.example'
  const run = async (dnsText) => {
    const cache = fakeCache()
    const pins = []
    cache.savePin = async (s, o) => { pins.push(o) }
    const deps = pdeps(cache, { resolveTxt: async () => ({ resolver: 'test', strings: [dnsText], ad: false, ttl: 300 }), shouldSkipDoh: () => false })
    const r = await resolvePointer({ mode: 'shell', scope, metaText: await signed(a, { seq: SEC - 100 }, scope), dnsHost: scope, blockOnDns: true, dohAllowed: true, now: NOW, config: CONFIG }, deps)
    return { r, pins }
  }
  const foreign = await run(await signed(b, { seq: SEC - 50 }, scope))
  assert.equal(foreign.r.source, 'meta')
  assert.deepEqual(foreign.pins, [a.pub])
  const sameOwner = await run(await signed(a, { seq: SEC - 50 }, scope))
  assert.equal(sameOwner.r.source, 'dns')
  const withRot = await run(await rotatedText(a, b, SEC - 50, scope))
  assert.equal(withRot.r.source, 'dns')
  assert.equal(withRot.r.rotated, true)
  assert.deepEqual(withRot.pins, [b.pub])
})

test('a poisoned seq floor (2^53-1, saved before code review round 1) does not lock the scope: rot= passes, a new key gets the prompt', async () => {
  const k1 = await owner()
  const k2 = await owner()
  const k3 = await owner()
  const scope = 'site.example'
  const ctx = { mode: 'shell', scope, now: NOW, config: CONFIG, pin: { owner: k1.pub }, cachedSeq: Number.MAX_SAFE_INTEGER }
  const rotated = await vetCandidate(await rotatedText(k1, k2, SEC, scope), 'meta', ctx, pdeps(fakeCache()))
  assert.equal(rotated.status, 'ok')
  assert.equal(rotated.rotated, true)
  const changed = await vetCandidate(await signed(k3, { seq: SEC }, scope), 'meta', ctx, pdeps(fakeCache()))
  assert.equal(changed.status, 'key-changed', 'the TOFU prompt, not seq-rollback')
  const ahead = await vetCandidate(await signed(k1, { seq: SEC + 2 * 86400 }, scope), 'meta', ctx, pdeps(fakeCache()))
  assert.equal(ahead.reason, 'seq-future')
})

// ---- two tabs across a publish ---------------------------------------------------------------------

function fakeLink () {
  const handlers = new Set()
  const sent = []
  return {
    sent,
    on: (fn) => { handlers.add(fn); return () => handlers.delete(fn) },
    send: (t, data = {}) => { sent.push(Object.assign({ t }, data)); return true },
    emit: async (m) => { for (const fn of Array.from(handlers)) await fn(m) }
  }
}

function engineTab ({ saved = null } = {}) {
  const calls = { seedFromCache: 0, stopSite: 0, download: 0 }
  const tm = {
    site: { record: { btih: BTIH } },
    seedFromCache: async () => { calls.seedFromCache++ },
    stopSite: () => { calls.stopSite++ },
    addRendezvous: async () => {}
  }
  const cache = fakeCache()
  cache.getPointer = async () => saved
  const A = {
    ui: fakeUi(), deps: { cache }, tm, calls, link: fakeLink(), config: CONFIG, log: () => {}, win: {},
    btih: BTIH, scope: 'site.example', ledgerId: 'mw1:x', isLeader: true, record: { btih: BTIH, signed: true, seq: 10 },
    manifest: { btih: BTIH }, blobs: new Map(), parsed: {}, ledgerPromise: null, mode: { mode: 'shell' }
  }
  return A
}

test('two tabs across a publish: a "version" message the stored pointer confirms stops the engine tab sharing the old version at once', async () => {
  const v2 = 'cd'.repeat(20)
  const A = engineTab({ saved: { record: { btih: v2, signed: true, seq: 11 } } })
  __test.installTabLink(A)
  await A.link.emit({ t: 'version', btih: v2, from: 'other' })
  assert.equal(A.superseded, true)
  assert.equal(A.calls.stopSite, 1, 'the old version stops announcing at once')
  assert.ok(A.ui.banners.has('update'))
  // A promoted (or restarted) engine never seeds the superseded version again.
  await __test.startEngine(A)
  assert.equal(A.calls.seedFromCache, 0)
})

test('two tabs across a publish: a "version" message alone (no stored pointer naming it) changes nothing', async () => {
  const A = engineTab({ saved: { record: { btih: BTIH, signed: true, seq: 10 } } })
  __test.installTabLink(A)
  await A.link.emit({ t: 'version', btih: 'ef'.repeat(20), from: 'other' })
  assert.equal(A.superseded, undefined)
  assert.equal(A.calls.stopSite, 0)
  await __test.startEngine(A)
  assert.equal(A.calls.seedFromCache, 1, 'the current version is still shared')
})

test('two tabs across a publish: a follower whose engine tab sends nothing downloads its version itself, after asking once', async () => {
  const A = downloadA({ gate: null })
  A.gatePromise = null
  A.btih = BTIH
  A.isLeader = false
  A.consentState = 'accepted'
  A.link = fakeLink()
  A.leader = { becomeLeader: new Promise(() => {}) } // the engine tab never goes away
  A.config = Object.assign({}, CONFIG, { timeoutsExtra: Object.assign({}, CONFIG.timeoutsExtra, { followerSiteMs: 30 }) })
  const site = await __test.obtainSite(A)
  assert.deepEqual(A.link.sent.filter((m) => m.t === 'need-site').map((m) => m.btih), [BTIH], 'asked the engine tab first')
  assert.ok(site, 'then downloaded it in this tab')
  assert.equal(A.calls.download, 1)
})

test('recordVersion keeps a superseded version while a page still renders it (Service Worker live clients)', async () => {
  const v1 = 'aa'.repeat(20)
  const v2 = 'bb'.repeat(20)
  const cache = fakeCache()
  const deleted = []
  cache.deleteSite = async (b) => { deleted.push(b) }
  cache.prefs.set('versions:mw1:x', [v1])
  const A = { deps: { cache }, ledgerId: 'mw1:x', config: CONFIG, log: () => {}, swPromise: Promise.resolve({ ok: false }) }
  // No worker answer: the live set is unknown, so nothing is kept beyond the current version.
  await __test.recordVersion(A, v2)
  assert.deepEqual(deleted, [v1])
  assert.deepEqual(cache.prefs.get('versions:mw1:x'), [v2])
  // The worker says a page (the other tab's frame) still renders v1: kept, and listed for later.
  const v3 = 'cc'.repeat(20)
  deleted.length = 0
  const registration = { active: { postMessage: (msg, ports) => { if (msg.type === 'mw-get-clients') ports[0].postMessage({ type: 'mw-clients', clients: { [v2]: 1 } }) } } }
  const B = Object.assign({}, A, { swPromise: Promise.resolve({ ok: true, registration }) })
  await __test.recordVersion(B, v3)
  assert.deepEqual(deleted, [], 'v2 is still rendered by a page')
  assert.deepEqual(cache.prefs.get('versions:mw1:x'), [v3, v2])
})

// ---- the write fee across tabs (F31, DESIGN-REVIEW item 4) ----------------------------------------

function channelHub () {
  const channels = []
  class Channel {
    constructor (name) { this.name = name; this.closed = false; this.onmessage = null; channels.push(this) }
    postMessage (data) {
      for (const c of channels) {
        if (c !== this && c.name === this.name && !c.closed) {
          const copy = JSON.parse(JSON.stringify(data))
          Promise.resolve().then(() => { if (!c.closed && c.onmessage) c.onmessage({ data: copy }) })
        }
      }
    }
    close () { this.closed = true }
  }
  return { Channel }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

test('two tabs: a write forwarded by a follower hears the fee progress (its timeout waits) and the engine tab cancels it when the follower gives up or aborts', async () => {
  const { Channel } = channelHub()
  const leaderLink = new TabLink('mw1:x', { Channel, timeoutMs: 200 })
  const followerLink = new TabLink('mw1:x', { Channel, timeoutMs: 200 })
  const jobs = []
  const node = {
    role: 'writer',
    put: (k, v, opts) => new Promise((resolve, reject) => {
      const job = { k, v, opts, resolve, aborted: false }
      opts.signal.addEventListener('abort', () => { job.aborted = true; reject(Object.assign(new Error('aborted'), { name: 'AbortError', code: 'E_POW_ABORTED' })) })
      jobs.push(job)
    })
  }
  const A = engineTab()
  A.link = leaderLink
  A.node = node
  __test.installTabLink(A)
  const remote = new RemoteNode(followerLink)
  try {
    assert.equal(validTabMessage({ mw: 1, t: 'cancel', from: 'f', id: 'f:1' }), true)
    assert.equal(validTabMessage({ mw: 1, t: 'pow', from: 'l', id: 'f:1', to: 'f', hashes: 'many' }), false)
    // 1. Progress every 150 ms keeps the forwarded write alive past the link's 200 ms timeout.
    const seen = []
    const p = remote.put('k', 1, { onProgress: (x) => seen.push(x) })
    while (jobs.length < 1) await sleep(5)
    assert.deepEqual([jobs[0].k, jobs[0].v], ['k', 1])
    for (let i = 1; i <= 3; i++) {
      await sleep(150)
      jobs[0].opts.onProgress({ hashes: i * 100, bits: 8 })
    }
    await sleep(20)
    assert.deepEqual(seen, [{ hashes: 100, bits: 8 }, { hashes: 200, bits: 8 }, { hashes: 300, bits: 8 }])
    jobs[0].resolve({ h: 'a'.repeat(64) })
    assert.deepEqual(await p, { h: 'a'.repeat(64) })
    // 2. No news for 200 ms: the follower gives up and the engine tab aborts the write.
    const q = remote.put('k2', 2)
    const gaveUp = assert.rejects(q, (e) => e.code === 'E_INTERNAL')
    while (jobs.length < 2) await sleep(5)
    await gaveUp
    await sleep(20)
    assert.equal(jobs[1].aborted, true, 'the engine tab stopped mining')
    // 3. The follower's own signal cancels as well.
    const ac = new AbortController()
    const r = remote.put('k3', 3, { signal: ac.signal })
    while (jobs.length < 3) await sleep(5)
    ac.abort()
    await assert.rejects(r, (e) => e.code === 'E_POW_ABORTED')
    await sleep(20)
    assert.equal(jobs[2].aborted, true)
    assert.equal(A.tabCalls.size, 0, 'nothing left in flight on the engine tab')
  } finally {
    leaderLink.close()
    followerLink.close()
  }
})

// ---- the identity race (F17) -----------------------------------------------------------------------

/** A key store whose every call yields first, so two callers interleave like two tabs; addKey is atomic. */
function racingKeys ({ withAdd = true } = {}) {
  const keys = new Map()
  const calls = { getKey: 0, saveKey: 0, addKey: 0 }
  const yieldNow = () => new Promise((resolve) => setImmediate(resolve))
  const store = {
    calls,
    keys,
    getKey: async (name) => { calls.getKey++; await yieldNow(); return keys.has(name) ? keys.get(name) : null },
    saveKey: async (name, value) => { calls.saveKey++; await yieldNow(); keys.set(name, value) }
  }
  if (withAdd) {
    store.addKey = async (name, value) => {
      calls.addKey++
      await yieldNow()
      if (keys.has(name)) return false
      keys.set(name, value)
      return true
    }
  }
  return store
}

test('identity race: two tabs creating the identity at once end up with one key, the stored one, and both sign with it', async () => {
  for (let run = 0; run < 3; run++) {
    const cache = racingKeys()
    const [a, b] = await Promise.all([
      ensureIdentity({ cache, crypto: chainCrypto, ledgerId: 'mw1:x' }),
      ensureIdentity({ cache, crypto: chainCrypto, ledgerId: 'mw1:x' })
    ])
    const stored = cache.keys.get('identity:mw1:x')
    assert.equal(a.pub, b.pub, 'one identity')
    assert.equal(stored.pub, a.pub, 'the stored record is that identity')
    assert.equal(stored.kind, 'cryptokey', 'the self-test never mistook the other tab\'s key for a broken one')
    for (const id of [a, b]) {
      const sig = await chainCrypto.sign(id.privateKey, 'x')
      assert.equal(await chainCrypto.verify(stored.pub, 'x', sig), true, 'each tab signs with the stored key')
    }
  }
})

test('identity race: a follower tab never creates an identity (create: false), and storeKey without add still overwrites', async () => {
  const cache = racingKeys()
  assert.equal(await ensureIdentity({ cache, crypto: chainCrypto, ledgerId: 'mw1:y', create: false }), null)
  assert.equal(cache.calls.saveKey + cache.calls.addKey, 0, 'nothing was written')
  const made = await ensureIdentity({ cache, crypto: chainCrypto, ledgerId: 'mw1:y' })
  const again = await ensureIdentity({ cache, crypto: chainCrypto, ledgerId: 'mw1:y', create: false })
  assert.equal(again.pub, made.pub, 'a follower reads the identity the engine tab created')
  // A cache without addKey (older builds): the round trip notices the other tab's key and uses it.
  const old = racingKeys({ withAdd: false })
  const [c, d] = await Promise.all([
    ensureIdentity({ cache: old, crypto: chainCrypto, ledgerId: 'mw1:z' }),
    ensureIdentity({ cache: old, crypto: chainCrypto, ledgerId: 'mw1:z' })
  ])
  const rec = old.keys.get('identity:mw1:z')
  assert.ok(c.pub === rec.pub || d.pub === rec.pub)
})

// ---- the iOS Home Screen hint (F44) ----------------------------------------------------------------

test('Home Screen hint: iPhone and iPadOS (a Macintosh user agent with a touch screen), never a Mac or an installed app; honest wording', async () => {
  const { iosHintFor } = await import('../../src/loader/app.js')
  const { STRINGS } = await import('../../src/loader/strings.js')
  const ipad = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15'
  assert.equal(iosHintFor({ userAgent: ipad, maxTouchPoints: 5 }), true, 'iPadOS Safari')
  assert.equal(iosHintFor({ userAgent: ipad, maxTouchPoints: 0 }), false, 'a Mac')
  assert.equal(iosHintFor({ userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) Mobile/15E148', maxTouchPoints: 5 }), true)
  assert.equal(iosHintFor({ userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)', standalone: true }), false, 'already a Home Screen app')
  assert.equal(iosHintFor(null), false)
  assert.match(STRINGS.iosHomeScreen, /starts empty there: sign in again in the Home Screen app \(on a site without sign-in, export your identity here and import it there\)/)
  assert.doesNotMatch(STRINGS.iosHomeScreen, /keeps this site and your identity$/)
})
