// Review round R 5.3, fixer loader-pointer (docs/deviations/review-round-loader-pointer.md): regression tests for
// PTR-1, PTR-2, PTR-3, PTR-4, PTR-5, PTR-8, PTR-9, PTR-11, PTR-12, PTR-13, PTR-14, GATE-1, PHISH-7, SYB-11, CONF-1.
// Run: node --test test/unit/review-round-loader-pointer.test.mjs
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

import {
  parsePointer, formatPointer, signPointer, verifyPointer, verifyRotation, signRotation, pointerLineage, lineageProven,
  ledgerIdFor, hubLabelFor, pickRecord, joinTxtData, nextKeyCommitment
} from '../../src/common/pointer.js'
import { generateKeyPair, exportPublicKey } from '../../src/chain/crypto.js'
import {
  resolvePointer, vetCandidate, updateContext, guardUpdate, lineageAction, gateHoldsDownload, forgetKeyRefusals, refusedKeyFor,
  noteLedger, LEDGER_PREF_PREFIX, retryRotation, notAnsweringModel, contactLabel, __c2WireUi, loopbackPair
} from '../../src/loader/app.js'
import { CONFIG } from '../../src/loader/config.js'
import { ownerFingerprint } from '../../src/loader/harden.js'
import { hintAllowed } from '../../src/loader/doors.js'
import { isPublicWebHost, isPublicHttpsUrl, filterWebseeds } from '../../src/common/magnet.js'
import { createModService, QUEUE_CAPS, QUEUE_PER_SENDER, QUEUE_LISTINGS_PER_AUTHOR } from '../../src/loader/mod.js'
import { STRINGS } from '../../src/loader/strings.js'

const NOW = Date.now()
const SEC = Math.floor(NOW / 1000)
const BT = (c) => c.repeat(40)
const CHAIN = 'club'

async function key () {
  const kp = await generateKeyPair({ extractable: false })
  return { privateKey: kp.privateKey, pub: await exportPublicKey(kp.publicKey) }
}

async function rec (signer, scope, fields) {
  const r = await signPointer(Object.assign({ seq: SEC - 60, exp: SEC + 30 * 86400 }, fields, { owner: signer.pub }), scope, signer.privateKey)
  return { record: r, text: formatPointer(r) }
}

function memCache () {
  const pins = new Map()
  const ptrs = new Map()
  const prefs = new Map()
  return {
    pins,
    ptrs,
    prefs,
    getPin: async (s) => pins.get(s) || null,
    savePin: async (s, owner, extra = {}) => { pins.set(s, Object.assign({}, extra, { owner })) },
    getPointer: async (s) => ptrs.get(s) || null,
    savePointer: async (s, v) => { ptrs.set(s, v) },
    getPref: async (k, d) => (prefs.has(k) ? prefs.get(k) : d),
    setPref: async (k, v) => { prefs.set(k, v) }
  }
}

function deps (cache, extra = {}) {
  return Object.assign({ parsePointer, verifyPointer, verifyRotation, pointerLineage, ledgerIdFor, pickRecord, joinTxtData, cache }, extra)
}

const hubCtx = (text, more = {}) => {
  const p = parsePointer(text)
  return Object.assign({ mode: 'hub', scope: 'btih:' + p.record.btih, fragment: { text }, now: NOW, config: CONFIG }, more)
}

// ------------------------------------------------------------------------------------------------ PTR-1 / PTR-2

test('PTR-1: pointerLineage: owner, rot, carried (previous record, ledger memory, nx), unproven', async () => {
  const V = await key()
  const V2 = await key()
  const V3 = await key()
  const X = await key()
  const s = 'btih:' + BT('a')
  const own = (await rec(V, s, { btih: BT('a'), chain: CHAIN })).record
  assert.equal(await pointerLineage(own, s), 'owner')
  const rot = (await rec(V2, s, { btih: BT('a'), chain: CHAIN, lo: V.pub, rot: await signRotation({ owner: V2.pub, seq: SEC - 60, scope: s, chain: CHAIN }, V.privateKey) })).record
  assert.equal(await pointerLineage(rot, s), 'rot')
  const squat = (await rec(X, s, { btih: BT('a'), chain: CHAIN, lo: V.pub })).record
  assert.equal(await pointerLineage(squat, s), 'unproven')
  assert.equal(lineageProven('unproven'), false)
  // A second rotation V2 -> V3 (rot signed by V2): unproven on a cold device, carried after the first one was seen.
  const second = (await rec(V3, s, { btih: BT('a'), chain: CHAIN, lo: V.pub, rot: await signRotation({ owner: V3.pub, seq: SEC - 60, scope: s, chain: CHAIN }, V2.privateKey) })).record
  assert.equal(await pointerLineage(second, s), 'unproven')
  assert.equal(await pointerLineage(second, s, { previousRecord: rot }), 'carried')
  assert.equal(await pointerLineage(second, s, { knownOwner: V2.pub }), 'carried', 'the per-ledger memory of this device')
  assert.equal(await pointerLineage(squat, s, { knownOwner: V2.pub }), 'unproven', 'the memory names the real owner: no help to a squat')
  // nx= pre-rotation: V committed to V3; V3 signs with lo=V and no rot=.
  const nxRec = (await rec(V3, s, { btih: BT('a'), chain: CHAIN, lo: V.pub })).record
  assert.equal(await pointerLineage(nxRec, s, { previousRecord: Object.assign({}, own, { nx: await nextKeyCommitment(V3.pub) }) }), 'carried')
  assert.equal(await pointerLineage(nxRec, s, { knownOwner: V.pub, knownNx: await nextKeyCommitment(V3.pub) }), 'carried')
  assert.equal(await pointerLineage(nxRec, s, { previousRecord: own }), 'unproven', 'no commitment, no rot: unproven')
})

test('PTR-1: a stranger\'s record lo=<victim>; chain=<victim\'s> gets the victim\'s ledger id and label but lineage "unproven": hub-sub refuses it', async () => {
  const V = await key()
  const X = await key()
  const victim = await rec(V, 'btih:' + BT('7'), { btih: BT('7'), chain: CHAIN })
  const squat = await rec(X, 'btih:' + BT('a'), { btih: BT('a'), chain: CHAIN, lo: V.pub, seq: SEC - 1 })
  const cache = memCache()
  const r = await resolvePointer(hubCtx(squat.text), deps(cache))
  const victimId = await ledgerIdFor(victim.record, 'btih:' + BT('7'))
  assert.equal(r.ledgerId, victimId, 'the squat names the victim ledger (format unchanged)')
  assert.equal(hubLabelFor(r.record, r.ledgerId), hubLabelFor(victim.record, victimId), 'and its hub label')
  assert.equal(r.lineage, 'unproven')
  assert.equal(lineageAction('hub-sub', r), 'refuse', 'the victim\'s own hub address is not mounted')
  assert.equal(lineageAction('hub-shared', r), 'read-only')
  assert.equal(lineageAction('door', r), 'read-only')
  assert.equal(lineageAction('shell', r), 'flag')
  assert.equal(cache.prefs.has(LEDGER_PREF_PREFIX + victimId), false, 'an unproven record neither raises the floor nor names the owner')
  // An honest one-step rotation (rot= from lo=) mounts.
  const V2 = await key()
  const scopeB = 'btih:' + BT('b')
  const honest = await rec(V2, scopeB, { btih: BT('b'), chain: CHAIN, lo: V.pub, rot: await signRotation({ owner: V2.pub, seq: SEC - 3 * 86400, scope: scopeB, chain: CHAIN }, V.privateKey), seq: SEC - 3 * 86400 })
  const r2 = await resolvePointer(hubCtx(honest.text), deps(memCache()))
  assert.equal(r2.lineage, 'rot')
  assert.equal(lineageAction('hub-sub', r2), 'ok')
  // The run() wiring: the refusal, the read-only mount and the withheld keys are in place.
  const src = readFileSync(new URL('../../src/loader/app.js', import.meta.url), 'utf8')
  assert.match(src, /const lineageAct = lineageAction\(A\.mode\.mode, r\)/)
  assert.match(src, /if \(A\.lineageUnproven\) return \/\/ Review round R 5\.3 \(PTR-1\): never the origin's current site/)
  assert.match(src, /!A\.pendingSignIn && !A\.lineageUnproven\)/)
  assert.match(src, /const moderator = A\.lineageUnproven \? null :/)
})

test('PTR-2: "#host:name@<fp of V>" refuses owner=X; lo=V, accepts owner=V and an honest rotation whose rot= verifies from V', async () => {
  const V = await key()
  const X = await key()
  const V2 = await key()
  const scope = 'blog.example'
  const fp = (await ownerFingerprint(V.pub)).slice(0, 22)
  const run = async (text) => resolvePointer({ mode: 'hub', scope, hostFp: fp, dnsHost: scope, blockOnDns: true, dohAllowed: true, now: NOW, config: CONFIG },
    deps(memCache(), { resolveTxt: async () => ({ resolver: 'test', strings: [text], ad: false, ttl: 300 }), shouldSkipDoh: () => false }))
  const lie = await rec(X, scope, { btih: BT('1'), lo: V.pub })
  await assert.rejects(run(lie.text), (e) => e.code === 'E_POINTER' && /not signed by the key the link names/.test(e.tried.join(' ')))
  const plain = await rec(V, scope, { btih: BT('2') })
  assert.equal((await run(plain.text)).record.owner, V.pub)
  const rotated = await rec(V2, scope, { btih: BT('3'), lo: V.pub, rot: await signRotation({ owner: V2.pub, seq: SEC - 3 * 86400, scope }, V.privateKey), seq: SEC - 3 * 86400 })
  const ok = await run(rotated.text)
  assert.equal(ok.record.owner, V2.pub)
  assert.equal(ok.lineage, 'rot')
})

// ------------------------------------------------------------------------------------------------ PTR-3

test('PTR-3: the update paths vet with the rendered record as previousRecord, so a stolen key\'s rot= is refused (nx-mismatch)', async () => {
  const K1 = await key()
  const K2 = await key()
  const K3 = await key()
  const scope = 'site.example'
  const current = (await rec(K1, scope, { btih: BT('1'), nx: await nextKeyCommitment(K2.pub), seq: SEC - 3600 })).record
  const thief = await rec(K3, scope, { btih: BT('2'), lo: K1.pub, rot: await signRotation({ owner: K3.pub, seq: SEC - 60, scope }, K1.privateKey) })
  const A = { record: current, pointerCtx: { mode: 'shell', scope, now: NOW, config: CONFIG } }
  const ctx = updateContext(A, { now: NOW })
  assert.equal(ctx.previousRecord, current)
  assert.equal(ctx.cachedSeq, current.seq)
  ctx.pin = { owner: K1.pub }
  const cand = await vetCandidate(thief.text, 'meta', ctx, deps(memCache()))
  await guardUpdate(cand, current, NOW)
  assert.equal(cand.status, 'rejected')
  assert.equal(cand.reason, 'nx-mismatch')
  // Without previousRecord (the code before) the same record passed as a trusted rotation.
  const old = await vetCandidate(thief.text, 'meta', Object.assign({}, A.pointerCtx, { now: NOW, pin: { owner: K1.pub }, cachedSeq: current.seq }), deps(memCache()))
  assert.equal(old.status, 'ok')
  assert.equal(old.rotated, true)
  // The committed key K2 is accepted as an update and carries the owner-change notice.
  const committed = await rec(K2, scope, { btih: BT('3'), lo: K1.pub, seq: SEC - 30 })
  const ok = await vetCandidate(committed.text, 'meta', Object.assign(updateContext(A, { now: NOW }), { pin: { owner: K1.pub } }), deps(memCache()))
  await guardUpdate(ok, current, NOW)
  assert.equal(ok.status, 'ok')
  assert.equal(ok.ownerChange.reason, 'nx-match')
  // Every vetCandidate call of an update path builds its context with updateContext (no copy of A.pointerCtx alone).
  const src = readFileSync(new URL('../../src/loader/app.js', import.meta.url), 'utf8')
  for (const fn of ['checkPageTagUpdate', 'checkForUpdate']) {
    const start = src.indexOf('async function ' + fn + ' (A')
    const body = src.slice(start, src.indexOf('\n}\n', start))
    assert.ok(body.includes('updateContext(A'), fn + ' uses updateContext')
    assert.ok(body.includes('guardUpdate('), fn + ' runs guardUpdate')
    assert.ok(!/Object\.assign\(\{\}, A\.pointerCtx/.test(body), fn + ' does not copy A.pointerCtx without previousRecord')
  }
})

// ------------------------------------------------------------------------------------------------ PTR-4

test('PTR-4: a link to an older version of the same ledger (another btih, lower seq) is refused once a newer one was accepted', async () => {
  const Z = await key()
  const v2 = await rec(Z, 'btih:' + BT('b'), { btih: BT('b'), chain: CHAIN, seq: SEC - 100 })
  const v1 = await rec(Z, 'btih:' + BT('a'), { btih: BT('a'), chain: CHAIN, seq: SEC - 300 })
  const cache = memCache()
  const r2 = await resolvePointer(hubCtx(v2.text), deps(cache))
  assert.equal(cache.prefs.get(LEDGER_PREF_PREFIX + r2.ledgerId).seq, SEC - 100, 'the ledger floor is remembered')
  await assert.rejects(resolvePointer(hubCtx(v1.text), deps(cache)), (e) => e.code === 'E_POINTER' && /seq-rollback/.test(e.tried.join(' ')))
  // A cold device still opens it (nothing to compare with), and a poisoned floor far in the future is ignored.
  assert.equal((await resolvePointer(hubCtx(v1.text), deps(memCache()))).record.btih, BT('a'))
  const poisoned = memCache()
  poisoned.prefs.set(LEDGER_PREF_PREFIX + r2.ledgerId, { seq: SEC + 10 * 86400, owner: Z.pub })
  assert.equal((await resolvePointer(hubCtx(v1.text), deps(poisoned))).record.btih, BT('a'))
  assert.equal(await noteLedger(memCache(), r2.ledgerId, Object.assign({}, v1.record, { seq: SEC + 5 * 86400 }), 'owner', NOW), false, 'no floor from the future')
})

test('PTR-4: dnsCandidate asks the next resolver when the first answer holds no acceptable record', async () => {
  const Z = await key()
  const scope = 'site.example'
  const old = await rec(Z, scope, { btih: BT('1'), seq: SEC - 500 })
  const cur = await rec(Z, scope, { btih: BT('2'), seq: SEC - 100 })
  const cache = memCache()
  cache.ptrs.set(scope, { record: cur.record, raw: cur.text })
  cache.pins.set(scope, { owner: Z.pub })
  const answers = [[old.text], [cur.text]]
  const resolveTxt = async (name, opts) => {
    for (const strings of answers) {
      const res = { resolver: 'r', strings, ad: false, ttl: 300 }
      if (await opts.accept(res)) return res
    }
    return { resolver: 'r', strings: answers[0], ad: false, ttl: 300 }
  }
  const r = await resolvePointer({ mode: 'shell', scope, dnsHost: scope, blockOnDns: true, dohAllowed: true, now: NOW, config: CONFIG }, deps(cache, { resolveTxt, shouldSkipDoh: () => false }))
  assert.equal(r.record.btih, BT('2'))
  assert.equal(r.source, 'dns')
})

// ------------------------------------------------------------------------------------------------ PTR-5

test('PTR-5: a first visit that meets a 5-minute-old rotation is held (24 h), nothing is pinned; an aged one is accepted', async () => {
  const K1 = await key()
  const K3 = await key()
  const s = 'btih:' + BT('c')
  const fresh = await rec(K3, s, { btih: BT('c'), lo: K1.pub, seq: SEC - 300, rot: await signRotation({ owner: K3.pub, seq: SEC - 300, scope: s }, K1.privateKey) })
  const cache = memCache()
  const r = await resolvePointer(hubCtx(fresh.text), deps(cache))
  assert.equal(r.rotationHold.decision, 'delay')
  assert.equal(r.rotationHold.reason, 'recent-rotation')
  assert.equal(cache.pins.size, 0, 'no pin: a reload is still a first visit')
  assert.equal(cache.ptrs.size, 0)
  assert.equal(r.firstTime, true)
  const aged = await rec(K3, 'btih:' + BT('d'), { btih: BT('d'), lo: K1.pub, seq: SEC - 2 * 86400, rot: await signRotation({ owner: K3.pub, seq: SEC - 2 * 86400, scope: 'btih:' + BT('d') }, K1.privateKey) })
  const cache2 = memCache()
  const r2 = await resolvePointer(hubCtx(aged.text), deps(cache2))
  assert.equal(r2.rotationHold, null)
  assert.equal(cache2.pins.get('btih:' + BT('d')).owner, K3.pub)
  // A returning visitor of the ledger (memory of the owner) is not held.
  const cache3 = memCache()
  cache3.prefs.set(LEDGER_PREF_PREFIX + await ledgerIdFor(fresh.record, s), { seq: SEC - 400, owner: K3.pub })
  assert.equal((await resolvePointer(hubCtx(fresh.text), deps(cache3))).rotationHold, null)
  const src = readFileSync(new URL('../../src/loader/app.js', import.meta.url), 'utf8')
  assert.match(src, /if \(r\.signed && \(r\.rotated \|\| r\.keyChanged \|\| r\.rotationHold\)\)/)
})

// ------------------------------------------------------------------------------------------------ PTR-8, PTR-9

test('PTR-8: wildcard-DNS names are not public hosts; signed records get the host rule; cs= and the pin web seed are filtered', () => {
  for (const h of ['127.0.0.1.nip.io', '192-168-1-1.sslip.io', '169.254.169.254.nip.io', 'localtest.me', 'x.lvh.me', 'vcap.me', 'a.traefik.me', 'x.local.gd', '10.0.0.5.example.net', 'h-10-0-0-5.example.org']) {
    assert.equal(isPublicWebHost(h), false, h)
    assert.equal(hintAllowed(h), false, 'door hint ' + h)
  }
  assert.equal(isPublicWebHost('cdn.example.com'), true)
  const hostile = ['https://127.0.0.1.nip.io:8443/x', 'https://192-168-1-1.sslip.io/x', 'https://169.254.169.254.nip.io/', 'https://localtest.me/', 'http://cdn.example.com/', 'https://10.0.0.1/']
  const f = filterWebseeds({ ws: hostile.concat(['https://cdn.example.com/ws/']), xs: hostile }, { origin: 'https://hub.example', signed: true })
  assert.deepEqual(f.ws, ['https://cdn.example.com/ws/'])
  assert.deepEqual(f.xs, [])
  assert.equal(isPublicHttpsUrl('/snap.json.gz', { base: 'http://127.0.0.1:8080/', origin: 'http://127.0.0.1:8080' }), true, 'the page\'s own origin')
  assert.equal(isPublicHttpsUrl('https://127.0.0.1.nip.io/snap', { origin: 'https://hub.example' }), false)
  const src = readFileSync(new URL('../../src/loader/app.js', import.meta.url), 'utf8')
  assert.match(src, /if \(!isPublicHttpsUrl\(cs, /)
  assert.match(src, /isPublicHttpsUrl\(w, \{ origin \}\)\) return w/)
})

test('PTR-9: on a hub or a door the gate holds every byte request, signed or not; shell keeps its web-seed fast path', () => {
  const gate = Promise.resolve('load')
  const signed = { signed: true, ws: ['https://collect.example/ws/'], xs: ['https://collect.example/t.torrent'] }
  assert.equal(gateHoldsDownload({ gatePromise: gate, record: signed, mode: { mode: 'hub-sub' } }), true)
  assert.equal(gateHoldsDownload({ gatePromise: gate, record: signed, mode: { mode: 'hub-shared' } }), true)
  assert.equal(gateHoldsDownload({ gatePromise: gate, record: signed, mode: { mode: 'door' } }), true)
  assert.equal(gateHoldsDownload({ gatePromise: gate, record: signed, mode: { mode: 'shell' } }), false)
  assert.equal(gateHoldsDownload({ gatePromise: gate, record: { signed: true }, mode: { mode: 'shell' } }), true, 'no web source: waits')
  assert.equal(gateHoldsDownload({ gatePromise: null, record: signed, mode: { mode: 'hub-sub' } }), false, 'no gate')
})

// ------------------------------------------------------------------------------------------------ PTR-11, PTR-13

test('PTR-11: the previous record and the seq floor come from the saved raw text and its signature, not the stored fields', async () => {
  const K1 = await key()
  const K2 = await key()
  const K3 = await key()
  const scope = 'site.example'
  const saved = await rec(K1, scope, { btih: BT('1'), nx: await nextKeyCommitment(K2.pub), seq: SEC - 3600 })
  const thief = await rec(K3, scope, { btih: BT('2'), lo: K1.pub, rot: await signRotation({ owner: K3.pub, seq: SEC - 60, scope }, K1.privateKey) })
  const cache = memCache()
  cache.pins.set(scope, { owner: K1.pub })
  // A same-origin script rewrote the stored fields (no nx=, a low seq) but cannot re-sign the raw text.
  cache.ptrs.set(scope, { record: Object.assign({}, saved.record, { nx: null, seq: 1 }), raw: saved.text })
  const r = await resolvePointer({ mode: 'shell', scope, metaText: thief.text, now: NOW, config: CONFIG }, deps(cache))
  assert.equal(r.record.btih, BT('1'), 'the thief\'s page tag is refused (nx-mismatch); the saved copy is used')
  assert.ok(r.tried.some((t) => /nx-mismatch/.test(t)), r.tried.join('; '))
  // A raw text that does not verify gives no previous record at all.
  const forged = memCache()
  forged.ptrs.set(scope, { record: saved.record, raw: saved.text.replace(/sig=[A-Za-z0-9_-]+/, 'sig=' + 'A'.repeat(86)) })
  forged.pins.set(scope, { owner: K1.pub })
  const r2 = await resolvePointer({ mode: 'shell', scope, metaText: (await rec(K1, scope, { btih: BT('3') })).text, now: NOW, config: CONFIG }, deps(forged))
  assert.equal(r2.previousRecord, null)
})

test('PTR-13: the page\'s mw-doh override is not used for a device\'s first lookup of a scope', async () => {
  const Z = await key()
  const scope = 'site.example'
  const r = await rec(Z, scope, { btih: BT('1') })
  const seen = []
  const resolveTxt = async (name, opts) => { seen.push(opts.override); return { resolver: 'r', strings: [r.text], ad: false, ttl: 300 } }
  const ctx = { mode: 'shell', scope, dnsHost: scope, blockOnDns: true, dohAllowed: true, dohOverride: 'https://evil.example/q', now: NOW, config: CONFIG }
  const cache = memCache()
  await resolvePointer(ctx, deps(cache, { resolveTxt, shouldSkipDoh: () => false }))
  assert.equal(seen[0], null, 'first lookup: the public resolvers')
  cache.prefs.clear()
  await resolvePointer(Object.assign({}, ctx, { now: NOW + 1 }), deps(cache, { resolveTxt, shouldSkipDoh: () => false }))
  assert.equal(seen[1], 'https://evil.example/q', 'a pinned scope may use the operator\'s resolver')
})

// ------------------------------------------------------------------------------------------------ GATE-1

test('GATE-1: a refused key change is returned and can be revisited: forgetKeyRefusals makes the card come back', async () => {
  const K1 = await key()
  const K2 = await key()
  const scope = 'site.example'
  const cur = await rec(K1, scope, { btih: BT('1'), seq: SEC - 600 })
  const next = await rec(K2, scope, { btih: BT('2') })
  const cache = memCache()
  cache.pins.set(scope, { owner: K1.pub })
  cache.ptrs.set(scope, { record: cur.record, raw: cur.text })
  let asked = 0
  const ctx = (answer) => ({ mode: 'shell', scope, metaText: next.text, now: NOW, config: CONFIG, confirmKeyChange: async () => { asked++; return answer } })
  const r1 = await resolvePointer(ctx(false), deps(cache))
  assert.equal(asked, 1)
  assert.deepEqual(r1.refusedOwners, [K2.pub])
  assert.ok(r1.warnings.includes('key-refused'))
  assert.equal(cache.prefs.get(refusedKeyFor(scope, K2.pub)), true)
  await resolvePointer(ctx(false), deps(cache))
  assert.equal(asked, 1, 'a remembered refusal does not ask again')
  assert.equal(await forgetKeyRefusals(cache, scope, r1.refusedOwners), 1)
  const r3 = await resolvePointer(ctx(true), deps(cache))
  assert.equal(asked, 2, 'after "Review the key change" the card asks again')
  assert.equal(r3.record.owner, K2.pub)
  assert.equal(r3.keyChanged, true)
  const src = readFileSync(new URL('../../src/loader/app.js', import.meta.url), 'utf8')
  assert.match(src, /label: STRINGS\.keyChangedReview \|\| 'Review the key change', onClick: \(\) => reviewKeyChange\(A, r\)/)
})

// ------------------------------------------------------------------------------------------------ PHISH-7

test('PHISH-7: a rotation that cannot be written on a cold node is retried on each ledger change until it is in the ledger', async () => {
  const subs = new Set()
  const node = { state: { rotations: new Map() }, subscribe (fn) { subs.add(fn); return () => subs.delete(fn) } }
  const banners = []
  const A = { node, ledgerId: 'mw1:x', ui: { setBanner: (id, text) => banners.push([id, text]) }, log: () => {} }
  const keys = { pub: 'p256:new', rotateNotice: { from: 'p256:old', next: 'p256:new' } }
  let ready = false
  let writes = 0
  const write = async () => { writes++; if (!ready) return null; node.state.rotations.set('p256:old', { next: 'p256:new' }); return { h: 'x' } }
  retryRotation(A, keys, { write })
  await new Promise((r) => setTimeout(r, 0))
  assert.equal(writes, 1)
  assert.equal(subs.size, 1, 'waiting for the ledger')
  assert.equal(banners.at(-1)[0], 'rotation')
  assert.ok(banners.at(-1)[1], 'the page says the replacement is not here yet')
  for (const fn of Array.from(subs)) fn()
  await new Promise((r) => setTimeout(r, 0))
  assert.equal(writes, 2, 'retried on the change')
  ready = true
  for (const fn of Array.from(subs)) fn()
  await new Promise((r) => setTimeout(r, 0))
  assert.equal(writes, 3)
  assert.equal(subs.size, 0, 'written: no more retries')
  assert.deepEqual(banners.at(-1), ['rotation', null])
  assert.equal(A.rotationRetry, null)
})

// ------------------------------------------------------------------------------------------------ PTR-12, PTR-14

test('PTR-12: the withdrawal contact button names where it goes', () => {
  assert.equal(contactLabel('https://evil.example/login'), STRINGS.withdrawnContact + ' (evil.example)')
  assert.equal(contactLabel('mailto:abuse@example.com'), STRINGS.withdrawnContact + ' (abuse@example.com)')
  assert.equal(contactLabel('not a url'), STRINGS.withdrawnContact)
})

test('PTR-14: "The owner lists" names only owner doors; hints are named apart and opening one asks first', () => {
  const offer = [
    { c: { host: 'mirror.example', kind: 'owner' }, url: 'https://mirror.example/_mw/open.html' },
    { c: { host: 'evil.example', kind: 'hint' }, url: 'https://evil.example/_mw/open.html' }
  ]
  let confirmed = null
  const assigned = []
  const win = { confirm: (q) => { confirmed = q; return false }, location: { assign: (u) => assigned.push(u) } }
  const m = notAnsweringModel(offer, 'en', win)
  assert.equal(/The owner lists: (.*?)\.( |$)/.exec(m.text)[1], 'mirror.example', m.text)
  assert.match(m.text, /Not from the owner: evil\.example\./)
  m.actions[1].onClick()
  assert.match(confirmed, /evil\.example/)
  assert.deepEqual(assigned, [], 'declined: no navigation')
  m.actions[0].onClick()
  assert.deepEqual(assigned, ['https://mirror.example/_mw/open.html'])
  const src = readFileSync(new URL('../../src/loader/app.js', import.meta.url), 'utf8')
  assert.match(src, /filter\(\(c\) => c\.kind === 'ledger' \|\| c\.kind === 'last-good'\)\.map/, 'doorShareLink drops link hints')
})

// ------------------------------------------------------------------------------------------------ SYB-11

function modApi (lists) {
  const node = { role: 'moderator', identity: { pub: 'p256:mod' }, state: { lists, kv: new Map(), owner: 'p256:owner', policy: { moderators: new Set(), allow: new Set() } } }
  return { node, identity: { keys: () => null, info: () => ({ pub: 'p256:mod' }) }, prompt: async () => true, infoNow: () => ({}), service: () => null }
}

test('SYB-11: a report survives 500 joins and 600 pending listings; each kind stays under its cap; per-sender limits', async () => {
  const lists = new Map([['mw.files', []]])
  let n = 0
  const mod = createModService({ api: modApi(lists), random: (k) => { const b = new Uint8Array(k); new DataView(b.buffer).setUint32(0, ++n); return b } })
  const report = mod.receive('p256:reporter', { t: 'report', report: { target: { h: 'f'.repeat(64) }, reason: 'P0' } })
  assert.ok(report)
  for (let i = 0; i < 500; i++) mod.receive('p256:j' + i, { t: 'join' })
  for (let a = 0; a < 6; a++) {
    for (let i = 0; i < 120; i++) lists.get('mw.files').push({ h: (a.toString(16) + i.toString(16).padStart(3, '0')).padEnd(64, '0'), author: 'p256:author' + a, ts: i, v: { ih: (a.toString(16) + i.toString(16).padStart(3, '0')).padEnd(40, '1'), len: 1, name: 'x', mime: 'text/plain', t: i } })
  }
  const q1 = await mod.methods['mod.queue']({}, {})
  const q2 = await mod.methods['mod.queue']({}, {})
  for (const q of [q1, q2]) {
    assert.ok(q.some((x) => x.id === report.id), 'the report is still listed')
    const count = (k) => q.filter((x) => x.kind === k).length
    assert.ok(count('join') <= QUEUE_CAPS.join)
    assert.ok(count('listing') <= QUEUE_CAPS.listing)
    const perAuthor = new Map()
    for (const x of q) if (x.kind === 'listing') perAuthor.set(x.author, (perAuthor.get(x.author) || 0) + 1)
    for (const v of perAuthor.values()) assert.ok(v <= QUEUE_LISTINGS_PER_AUTHOR)
  }
  // One sender: one open join, one open report per target, at most QUEUE_PER_SENDER open items.
  const mod2 = createModService({ api: modApi(new Map()) })
  const j1 = mod2.receive('p256:spam', { t: 'join' })
  assert.equal(mod2.receive('p256:spam', { t: 'join' }).id, j1.id)
  const t1 = mod2.receive('p256:spam', { t: 'report', report: { target: { h: '1'.repeat(64) } } })
  assert.equal(mod2.receive('p256:spam', { t: 'report', report: { target: t1.target } }).id, t1.id)
  assert.ok(mod2.receive('p256:spam', { t: 'report', report: { target: { h: '2'.repeat(64) } } }))
  assert.equal(mod2.receive('p256:spam', { t: 'report', report: { target: { h: '3'.repeat(64) } } }), null, 'over ' + QUEUE_PER_SENDER + ' open items')
  assert.equal(mod2.size, QUEUE_PER_SENDER)
  mod.destroy()
  mod2.destroy()
})

// ------------------------------------------------------------------------------------------------ CONF-1

test('CONF-1: the upload card says "No always-on copy" unless the pin key was written with owner standing', async () => {
  const run = async (ownerWritten) => {
    let note
    const A = {
      win: { navigator: { language: 'en' } },
      api: {
        service: (n) => (n === 'files' ? { methods: { 'files.list': async () => [{ ref: 'k1', label: 'avail.keptBySite', name: 'a.txt' }] } } : null),
        cfg: () => ({ pin: 'p256:pinnode' })
      },
      node: { state: { kv: new Map([['_mw.cfg', { v: { pin: 'p256:pinnode' }, h: 'h'.repeat(64), author: 'p256:mod' }]]), ownerWritten: new Set(ownerWritten ? ['h'.repeat(64)] : []) } },
      uploads: new Map([['u1', { kind: 'files', key: 'k1', since: Date.now() }]]),
      uploadsPoll: true,
      ui: { setUploads: (rows, opts) => { note = opts.note } }
    }
    await __c2WireUi.refreshUploads(A)
    return note
  }
  const { seedText } = await import('../../src/loader/strings.js')
  assert.equal(await run(false), seedText('avail.noPin', 'en'), 'a moderator-written pin key does not count')
  assert.equal(await run(true), null)
})

test('integrator (PTR-8 on loopback): a loopback page may read a loopback cs=; a public page never reads one', () => {
  assert.equal(loopbackPair('http://abc.localhost:4931/x', 'http://localhost:4931/ws/s.json'), true);
  assert.equal(loopbackPair('http://127.0.0.1:5/', 'http://localhost:6/a'), true);
  assert.equal(loopbackPair('https://site.example/', 'http://127.0.0.1:9/x'), false);
  assert.equal(loopbackPair('http://abc.localhost:4931/', 'https://evil.example/s.json'), false);
  assert.equal(loopbackPair('http://abc.localhost:4931/', 'http://u:p@localhost:4931/s.json'), false);
});
