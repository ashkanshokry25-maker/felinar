// harden-loader (v0.3, V03-DESIGN-REVIEW 2.5.3, MF-04, MF-28, SC-6): pointer freeze fields org=, nx=, ml=,
// idp=; nx= enforcement in verifyPointer({ previousRecord }); the rot= v1 input refused; the 900-byte limit
// with four org= entries; vectors ptr-019 onward. Run: node --test test/unit/harden-loader-pointer.test.mjs
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'

import {
  parsePointer, formatPointer, signingInput, signPointer, verifyPointer, verifyRotation, signRotation, rotationInput,
  ledgerIdFor, pointerBudget, hubLabelFor, nextKeyCommitment, isOriginString, isLoaderVersion, withdrawalRecord,
  ORG_MAX, POINTER_SIZE_MAX, ROTATION_PREFIX_V2
} from '../../src/common/pointer.js'
import * as pointer from '../../src/common/pointer.js'
import { generateKeyPair, exportPublicKey, sign } from '../../src/chain/crypto.js'
import { b64url, utf8 } from '../../src/chain/canonical.js'

const BTIH = '6b3a0d1c5e7f90214365879aabbccddeeff00112'
const NOW = 1792411200000
const NOW_S = NOW / 1000
const EXP = NOW_S + 90 * 86400
const SCOPE = 'example.com'

async function key () {
  const kp = await generateKeyPair()
  return { privateKey: kp.privateKey, pub: await exportPublicKey(kp.publicKey) }
}

function base (owner, more = {}) {
  return Object.assign({ btih: BTIH, dn: 'Peer Guestbook', tr: ['wss://tracker.example.com'], owner: owner.pub, seq: NOW_S - 100, exp: EXP }, more)
}

async function signed (owner, more = {}, scope = SCOPE) {
  return parsePointer(formatPointer(await signPointer(base(owner, more), scope, owner.privateKey))).record
}

test('org=, nx=, ml=, idp= round trip: parsed fields, canonical order, signed', async () => {
  const k1 = await key()
  const k2 = await key()
  const nx = await nextKeyCommitment(k2.pub)
  assert.match(nx, /^[A-Za-z0-9_-]{43}$/)
  assert.equal(nx, createHash('sha256').update(k2.pub, 'utf8').digest('base64url'), 'nx = b64url sha256 of the UTF-8 key string')
  const rec = await signed(k1, { org: ['https://example.com', 'https://www.example.com:8443'], nx, ml: '0.3.0', idp: 'https://id.example' })
  assert.deepEqual(rec.org, ['https://example.com', 'https://www.example.com:8443'])
  assert.equal(rec.nx, nx)
  assert.equal(rec.ml, '0.3.0')
  assert.equal(rec.idp, 'https://id.example')
  assert.deepEqual(rec.extra, {}, 'named fields, not extra')
  const text = formatPointer(rec)
  assert.match(text, /; org=https:\/\/example\.com; org=https:\/\/www\.example\.com:8443; nx=[A-Za-z0-9_-]{43}; ml=0\.3\.0; idp=https:\/\/id\.example; seq=/)
  const input = signingInput(rec, SCOPE)
  for (const line of ['org=https://example.com', 'org=https://www.example.com:8443', 'nx=' + nx, 'ml=0.3.0', 'idp=https://id.example']) {
    assert.ok(input.split('\n').includes(line), 'signed: ' + line)
  }
  assert.equal((await verifyPointer(rec, SCOPE, { now: NOW })).ok, true)
  // Every one of them is signed: changing any breaks the signature.
  for (const [k, v] of [['org', ['https://example.com']], ['nx', await nextKeyCommitment(k1.pub)], ['ml', '0.3.1'], ['idp', 'https://other.example']]) {
    const tampered = parsePointer(formatPointer(Object.assign({}, rec, { [k]: v, pairs: null }))).record
    assert.equal((await verifyPointer(tampered, SCOPE, { now: NOW })).reason, 'bad-sig', k + ' is signed')
  }
})

test('org= and idp= take exact origins only; ml= takes x.y.z; at most four org=; nx= is 43 b64url characters', () => {
  assert.equal(ORG_MAX, 4)
  for (const good of ['https://example.com', 'https://example.com:8443', 'https://xn--bcher-kva.example', 'http://localhost:8080', 'http://127.0.0.1:5173']) assert.equal(isOriginString(good), true, good)
  for (const bad of ['https://example.com/', 'https://Example.com', 'https://example.com:443', 'https://example.com/path', 'http://example.com', 'https://u@example.com', 'example.com', 'null', 'https://example.com?q', '']) assert.equal(isOriginString(bad), false, bad)
  for (const good of ['0.3.0', '1.0.0', '10.20.30']) assert.equal(isLoaderVersion(good), true, good)
  for (const bad of ['0.3', '01.0.0', '0.3.0-beta', 'v0.3.0', '']) assert.equal(isLoaderVersion(bad), false, bad)
  const head = 'v=mw1; btih=' + BTIH
  const orgs = (n) => Array.from({ length: n }, (_, i) => '; org=https://s' + i + '.example').join('')
  assert.equal(parsePointer(head + orgs(4)).ok, true)
  assert.equal(parsePointer(head + orgs(5)).error, 'bad-value')
  assert.equal(parsePointer(head + '; org=https://a.example; org=https://a.example').error, 'bad-value', 'no duplicates')
  assert.equal(parsePointer(head + '; org=https://a.example/').error, 'bad-value')
  assert.equal(parsePointer(head + '; nx=short').error, 'bad-value')
  assert.equal(parsePointer(head + '; ml=0.3').error, 'bad-value')
  assert.equal(parsePointer(head + '; idp=https://id.example/x').error, 'bad-value')
  assert.equal(parsePointer(head + '; ml=0.3.0; idp=https://id.example').record.ml, '0.3.0')
})

test('size: four org= entries with nx=, ml=, idp= stay within the 900-byte limit', async () => {
  const k1 = await key()
  const k2 = await key()
  const rec = await signed(k1, {
    xs: ['https://example.com/_mw/t/' + BTIH + '.torrent'],
    ws: ['https://cdn.example.com/ws/'],
    org: ['https://example.com', 'https://www.example.com', 'https://shop.example.com', 'https://blog.example.com'],
    nx: await nextKeyCommitment(k2.pub),
    ml: '0.3.0',
    idp: 'https://id.example'
  })
  const budget = pointerBudget(formatPointer(rec))
  assert.equal(budget.withinMax, true, budget.bytes + ' bytes')
  assert.ok(budget.bytes <= POINTER_SIZE_MAX)
  assert.equal(rec.org.length, 4)
})

test('nx= (MF-28): a later owner key must hash to the previous nx; a match rotates silently without rot=', async () => {
  const k1 = await key()
  const k2 = await key()
  const thief = await key()
  const prev = await signed(k1, { nx: await nextKeyCommitment(k2.pub) })
  // The committed key, no rot= at all: accepted against the pin of k1 (the owner may have lost k1).
  const next = await signed(k2, { lo: k1.pub, seq: NOW_S })
  const ok = await verifyPointer(next, SCOPE, { now: NOW, pinnedOwner: k1.pub, previousRecord: prev })
  assert.equal(ok.ok, true)
  assert.equal(ok.rotated, true)
  assert.equal(ok.nx, 'match')
  // A thief holding k1 signs a valid rot= v2 to a key of their own: refused, whatever rot says.
  const rot = await signRotation({ owner: thief.pub, seq: NOW_S, scope: SCOPE }, k1.privateKey)
  const stolen = await signed(thief, { lo: k1.pub, rot, seq: NOW_S })
  assert.equal(await verifyRotation(stolen, k1.pub, SCOPE), true, 'the rot itself is valid')
  const refused = await verifyPointer(stolen, SCOPE, { now: NOW, pinnedOwner: k1.pub, previousRecord: prev })
  assert.equal(refused.ok, false)
  assert.equal(refused.reason, 'nx-mismatch')
  assert.equal(refused.nx, 'mismatch')
  // Without a pin too (a visitor who knows only the previous record).
  assert.equal((await verifyPointer(stolen, SCOPE, { now: NOW, previousRecord: prev })).reason, 'nx-mismatch')
  // Without previousRecord the v0.2.1 behaviour holds: a valid rot is silent (the caller supplies prev to enforce nx).
  assert.equal((await verifyPointer(stolen, SCOPE, { now: NOW, pinnedOwner: k1.pub })).rotated, true)
})

test('nx= is sticky under one owner: the same key cannot re-commit or drop it (closes the two-step theft)', async () => {
  const k1 = await key()
  const k2 = await key()
  const thief = await key()
  const nx2 = await nextKeyCommitment(k2.pub)
  const prev = await signed(k1, { nx: nx2 })
  const same = await signed(k1, { nx: nx2, seq: NOW_S })
  assert.equal((await verifyPointer(same, SCOPE, { now: NOW, pinnedOwner: k1.pub, previousRecord: prev })).ok, true)
  const recommit = await signed(k1, { nx: await nextKeyCommitment(thief.pub), seq: NOW_S })
  const r1 = await verifyPointer(recommit, SCOPE, { now: NOW, pinnedOwner: k1.pub, previousRecord: prev })
  assert.equal(r1.reason, 'nx-changed')
  assert.equal(r1.nx, 'changed')
  const dropped = await signed(k1, { seq: NOW_S })
  assert.equal((await verifyPointer(dropped, SCOPE, { now: NOW, pinnedOwner: k1.pub, previousRecord: prev })).reason, 'nx-changed')
  // A withdrawal by the same owner carries nx= forward (withdrawalRecord takes it).
  const w = await signPointer(withdrawalRecord({ owner: k1.pub, seq: NOW_S, exp: EXP, nx: nx2 }), SCOPE, k1.privateKey)
  const wv = await verifyPointer(parsePointer(formatPointer(w)).record, SCOPE, { now: NOW, pinnedOwner: k1.pub, previousRecord: prev })
  assert.equal(wv.ok, true)
  assert.equal(wv.withdrawn, true)
  assert.throws(() => withdrawalRecord({ owner: k1.pub, seq: 1, exp: 2, nx: 'bad' }), TypeError)
  // A previous record without nx= sets no constraint; the new record may start one.
  const plain = await signed(k1)
  assert.equal((await verifyPointer(prev, SCOPE, { now: NOW, pinnedOwner: k1.pub, previousRecord: plain })).ok, true)
})

test('rot= v1 (MF-28, PTR A5): deleted; signRotation and rotationInput need a scope; a v1 rot= is refused', async () => {
  assert.equal(pointer.ROTATION_PREFIX, undefined, 'the v1 prefix is no longer exported')
  assert.equal(ROTATION_PREFIX_V2, 'mw-rot-v2\n')
  const k1 = await key()
  const k2 = await key()
  assert.throws(() => rotationInput(k2.pub, 5), TypeError)
  await assert.rejects(signRotation({ owner: k2.pub, seq: 5 }, k1.privateKey), TypeError)
  const v1 = b64url.encode(await sign(k1.privateKey, utf8.encode('mw-rot-v1\n' + k2.pub + '\n' + NOW_S)))
  const rec = await signed(k2, { rot: v1, seq: NOW_S })
  assert.equal(await verifyRotation(rec, k1.pub, SCOPE), false)
  assert.equal(await verifyRotation(rec, k1.pub), false)
  const v = await verifyPointer(rec, SCOPE, { now: NOW, pinnedOwner: k1.pub })
  assert.equal(v.ok, false)
  assert.equal(v.reason, 'owner-changed')
  // v2 still works.
  const v2 = await signRotation({ owner: k2.pub, seq: NOW_S, scope: SCOPE }, k1.privateKey)
  const good = await signed(k2, { rot: v2, seq: NOW_S })
  assert.equal((await verifyPointer(good, SCOPE, { now: NOW, pinnedOwner: k1.pub })).rotated, true)
})

test('vectors ptr-019 onward: parse, signing input, format, verification (nx), ledger id, size; ptr-023 supersedes ptr-010', async () => {
  const doc = JSON.parse(readFileSync(new URL('../vectors/pointer.json', import.meta.url), 'utf8'))
  const ids = doc.vectors.map((v) => v.id)
  const from = ids.indexOf('ptr-019-freeze-fields')
  assert.ok(from > 0, 'ptr-019 is appended')
  assert.deepEqual(ids.slice(0, from).slice(-1), ['ptr-018-unsigned-hub-label'], 'appended after the v0.2.1 vectors')
  const fresh = doc.vectors.slice(from)
  assert.ok(fresh.length >= 8)
  for (const v of fresh) {
    const res = parsePointer(v.text)
    assert.equal(res.ok, v.expect.parse.ok, v.id + ': parse')
    if (!res.ok) { assert.equal(res.error, v.expect.parse.error, v.id); continue }
    const r = res.record
    for (const [k, want] of Object.entries(v.expect.parse.fields)) assert.deepEqual(r[k], want, v.id + ': field ' + k)
    assert.equal(signingInput(r, v.scope), v.expect.signingInput, v.id + ': signing input')
    assert.equal(formatPointer(r), v.expect.format, v.id + ': format')
    const got = await verifyPointer(r, v.scope, v.verifyOptions)
    for (const [k, want] of Object.entries(v.expect.verify)) assert.deepEqual(got[k], want, v.id + ': verify.' + k)
    assert.equal(await ledgerIdFor(r, v.scope), v.expect.ledgerId, v.id + ': ledger id')
    const b = pointerBudget(v.text)
    assert.equal(b.bytes, v.expect.bytes, v.id + ': bytes')
    assert.equal(b.strings, v.expect.strings, v.id + ': strings')
    assert.equal(b.withinMax, true, v.id + ': within 900 bytes')
    if (v.expect.hubLabel) assert.equal(hubLabelFor(r, v.expect.ledgerId), v.expect.hubLabel, v.id + ': hub label')
    // nx= in the vectors is recomputed independently.
    if (v.verifyOptions && v.verifyOptions.previousRecord && v.keys) {
      assert.equal(v.verifyOptions.previousRecord.nx, createHash('sha256').update(v.keys.K4, 'utf8').digest('base64url'), v.id + ': nx of K4')
    }
  }
  const by = Object.fromEntries(doc.vectors.map((v) => [v.id, v]))
  assert.equal(by['ptr-023-rot-v1-refused'].supersedes, 'ptr-010-rotation')
  assert.equal(by['ptr-023-rot-v1-refused'].expect.verify.reason, 'owner-changed')
  // ptr-010 itself (frozen, never edited) now verifies as owner-changed: its rot= is over the v1 input.
  const old = by['ptr-010-rotation']
  const oldGot = await verifyPointer(parsePointer(old.text).record, old.scope, old.verifyOptions)
  assert.equal(oldGot.ok, false)
  assert.equal(oldGot.reason, 'owner-changed')
  assert.equal(by['ptr-021-nx-match'].expect.verify.nx, 'match')
  assert.equal(by['ptr-022-nx-mismatch'].expect.verify.reason, 'nx-mismatch')
  assert.equal(by['ptr-024-nx-changed'].expect.verify.reason, 'nx-changed')
  assert.equal(by['ptr-021-nx-match'].expect.ledgerId, by['ptr-019-freeze-fields'].expect.ledgerId, 'lo= keeps the ledger id across the nx rotation')
})
