// Unit tests for src/loader/seed-meters.js (v0.3 C2, seed-policy lane; SEEDING-AND-ZERO-SETUP-DESIGN.md 3.1.3;
// ARCHITECTURE 8 "no incentive layer"): session and month counters, the UTC month rollover, local wires outside the
// month, remaining() against a seed budget, and stores that throw, reject or answer late.
// Run: node --test test/unit/seed-meters.test.mjs
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import { createSeedMeters, monthKeyOf } from '../../src/loader/seed-meters.js'
import { seedBudget } from '../../src/loader/seed-budget.js'

const ROOT = fileURLToPath(new URL('../../', import.meta.url))
const MiB = 1048576

function mapStore () {
  const m = new Map()
  const writes = []
  return { m, writes, get: (k) => m.get(k), set: (k, v) => { writes.push([k, v]); m.set(k, JSON.parse(JSON.stringify(v))) } }
}

test('monthKeyOf is the UTC calendar month', () => {
  assert.equal(monthKeyOf(Date.UTC(2026, 9, 31, 23, 59, 59)), '2026-10')
  assert.equal(monthKeyOf(Date.UTC(2026, 10, 1, 0, 0, 0)), '2026-11')
  assert.equal(monthKeyOf(Date.UTC(2027, 0, 1)), '2027-01')
})

test('session counters per lane; the month counts K and E only, and never local wires', () => {
  let t = Date.UTC(2026, 9, 20, 12)
  const s = createSeedMeters({ now: () => t })
  s.add('H', 1000)
  s.add('K', 2000)
  s.add('E', 3000)
  s.add('K', 500, { local: true })
  s.add('E', 700, { local: true })
  s.add('H', 900, { local: true })
  assert.deepEqual(['H', 'K', 'E'].map((l) => s.sessionUsed(l)), [1000, 2000, 3000])
  assert.deepEqual(['H', 'K', 'E'].map((l) => s.sessionUsed(l, { local: true })), [900, 500, 700])
  assert.equal(s.monthUsed(), 5000, 'K + E on wires that were not local')
  for (const bad of [['X', 10], ['K', -5], ['K', 0], ['K', NaN], ['K', 'abc'], ['K', Infinity]]) s.add(...bad)
  assert.equal(s.monthUsed(), 5000, 'junk is ignored')
  assert.equal(s.sessionUsed('X'), 0)
})

test('the month resets at a UTC month change, the session does not', () => {
  let t = Date.UTC(2026, 9, 31, 23, 59, 0)
  const store = mapStore()
  const s = createSeedMeters({ storage: store, now: () => t })
  s.add('K', 4000)
  s.add('E', 1000)
  assert.equal(s.monthUsed(), 5000)
  t = Date.UTC(2026, 10, 1, 0, 0, 1)
  assert.equal(s.monthUsed(), 0, 'a new month')
  assert.equal(s.snapshot().month.key, '2026-11')
  assert.equal(s.sessionUsed('K'), 4000, 'the session is the page session')
  s.add('K', 10)
  s.flush()
  assert.deepEqual(store.m.get('seedMeters'), { v: 1, month: '2026-11', K: 10, E: 0 })
})

test('the stored month survives a reload in the same month and is dropped in another', () => {
  const store = mapStore()
  let t = Date.UTC(2026, 9, 5)
  const a = createSeedMeters({ storage: store, now: () => t, key: 'seedMeters:https://example.test' })
  a.add('K', 3 * MiB)
  a.add('E', MiB)
  a.flush()
  assert.deepEqual(store.m.get('seedMeters:https://example.test'), { v: 1, month: '2026-10', K: 3 * MiB, E: MiB })
  const b = createSeedMeters({ storage: store, now: () => t, key: 'seedMeters:https://example.test' })
  assert.equal(b.monthUsed(), 4 * MiB, 'synchronous store: loaded at once')
  assert.equal(b.sessionUsed('K'), 0, 'a new page session')
  t = Date.UTC(2026, 10, 2)
  const c = createSeedMeters({ storage: store, now: () => t, key: 'seedMeters:https://example.test' })
  assert.equal(c.monthUsed(), 0, 'last month\'s record is not this month')
  store.m.set('other', { v: 2, month: '2026-11', K: 99, E: 99 })
  assert.equal(createSeedMeters({ storage: store, now: () => t, key: 'other' }).monthUsed(), 0, 'another record version is ignored')
})

test('an asynchronous store: bytes counted before the record arrives are merged, and nothing is written before it', async () => {
  const m = new Map([['seedMeters', { v: 1, month: '2026-10', K: 100, E: 50 }]])
  const writes = []
  let release
  const gate = new Promise((resolve) => { release = resolve })
  const store = { get: async (k) => { await gate; return m.get(k) }, set: async (k, v) => { writes.push(v); m.set(k, v) } }
  const t = Date.UTC(2026, 9, 9)
  const s = createSeedMeters({ storage: store, now: () => t })
  s.add('K', 10)
  s.flush()
  assert.equal(writes.length, 0, 'never overwrite the stored month before it was read')
  assert.equal(s.snapshot().loaded, false)
  release()
  await s.ready
  assert.equal(s.monthUsed(), 160)
  assert.equal(s.snapshot().loaded, true)
  s.flush()
  assert.deepEqual(writes[writes.length - 1], { v: 1, month: '2026-10', K: 110, E: 50 })
})

test('stores that throw or reject leave the counters in memory', async () => {
  const t = Date.UTC(2026, 9, 9)
  const throwing = { get () { throw new Error('blocked') }, set () { throw new Error('blocked') } }
  const a = createSeedMeters({ storage: throwing, now: () => t })
  a.add('K', 10)
  a.flush()
  assert.equal(a.monthUsed(), 10)
  assert.equal(a.snapshot().persistent, false)

  const setThrows = { get: () => undefined, set () { throw new Error('quota') } }
  const b = createSeedMeters({ storage: setThrows, now: () => t })
  b.add('E', 20)
  assert.equal(b.snapshot().persistent, false, 'one failed write: memory for the rest of the page')
  b.add('E', 5)
  assert.equal(b.monthUsed(), 25)

  const rejecting = { get: () => Promise.reject(new Error('no db')), set: () => Promise.reject(new Error('no db')) }
  const c = createSeedMeters({ storage: rejecting, now: () => t })
  await c.ready
  c.add('K', 7)
  assert.equal(c.monthUsed(), 7)
  assert.equal(c.snapshot().persistent, false)

  const lateReject = { get: () => undefined, set: () => Promise.reject(new Error('later')) }
  const d = createSeedMeters({ storage: lateReject, now: () => t })
  d.add('K', 1)
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(d.snapshot().persistent, false)
  assert.equal(d.monthUsed(), 1)

  for (const storage of [null, {}, { get: () => 1 }]) {
    const e = createSeedMeters({ storage, now: () => t })
    e.add('K', 3)
    assert.equal(e.monthUsed(), 3, 'no usable store: memory only')
    assert.equal(e.snapshot().persistent, false)
  }
})

test('writes are throttled without timers: at most one per persistMs from add(), at once from flush()', () => {
  let t = Date.UTC(2026, 9, 9)
  const store = mapStore()
  const s = createSeedMeters({ storage: store, now: () => t, persistMs: 5000 })
  for (let i = 0; i < 100; i++) s.add('K', 16384)
  assert.equal(store.writes.length, 1, 'the first add writes, the next 99 within 5 s do not')
  t += 5000
  s.add('K', 16384)
  assert.equal(store.writes.length, 2)
  s.add('H', 999)
  s.add('K', 1, { local: true })
  s.flush()
  assert.equal(store.writes.length, 2, 'H and local bytes do not change the stored record')
  s.add('E', 16384)
  s.flush()
  assert.equal(store.writes.length, 3, 'flush writes at once')
  s.flush()
  assert.equal(store.writes.length, 3, 'nothing new, nothing written')
  assert.deepEqual(store.m.get('seedMeters'), { v: 1, month: '2026-10', K: 101 * 16384, E: 16384 }, 'H and local bytes are never stored')
})

test('remaining(budget): per lane bytes left in the session, the month (K and E) and on local wires', () => {
  const t = Date.UTC(2026, 9, 9)
  const s = createSeedMeters({ now: () => t })
  const phone = seedBudget({ isMobile: true, networkClass: 'wifi', battery: { charging: false, level: 0.6 } }, { shareOnNetwork: true })
  assert.equal(phone.row, 'phoneWifi')
  s.add('H', 2 * MiB)
  s.add('K', 30 * MiB)
  s.add('K', 3 * MiB, { local: true })
  let r = s.remaining(phone)
  assert.deepEqual(r.H, { session: 30 * MiB, month: Infinity, local: 128 * MiB }, 'H is outside the month cap')
  assert.deepEqual(r.K, { session: 2 * MiB, month: 226 * MiB, local: 125 * MiB })
  assert.deepEqual(r.E, { session: 0, month: 226 * MiB, local: 128 * MiB }, 'E is off in row 3: no session')
  s.add('K', 10 * MiB)
  r = s.remaining(phone)
  assert.equal(r.K.session, 0, 'never below 0')
  const desk = seedBudget({ isMobile: false, networkClass: 'unknown' }, {})
  const rd = s.remaining(desk)
  assert.equal(rd.K.session, Infinity, 'desktop: no session cap')
  assert.equal(rd.K.month, 20e9 - 40 * MiB)
  const metered = seedBudget({ isMobile: true, networkClass: 'cellular' }, {})
  assert.deepEqual(s.remaining(metered).K, { session: 0, month: 0, local: 0 })
  assert.equal(s.remaining(metered).H.session, 14 * MiB)
  for (const l of ['H', 'K', 'E']) assert.deepEqual(s.remaining(null)[l], { session: 0, month: l === 'H' ? Infinity : 0, local: 0 }, 'no budget: nothing left')
})

test('snapshot() is a frozen copy for the SDK; the module holds no network code and nothing that ranks', () => {
  const t = Date.UTC(2026, 9, 9)
  const s = createSeedMeters({ now: () => t })
  s.add('E', 42)
  const snap = s.snapshot()
  assert.deepEqual(JSON.parse(JSON.stringify(snap)), { session: { H: 0, K: 0, E: 42 }, local: { H: 0, K: 0, E: 0 }, month: { key: '2026-10', K: 0, E: 42, used: 42 }, persistent: false, loaded: true })
  assert.ok(Object.isFrozen(snap) && Object.isFrozen(snap.session) && Object.isFrozen(snap.month))
  assert.throws(() => { 'use strict'; snap.session.E = 0 })
  s.add('E', 1)
  assert.equal(snap.session.E, 42, 'a copy, not a view')
  const code = readFileSync(ROOT + 'src/loader/seed-meters.js', 'utf8').replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '')
  assert.doesNotMatch(code, /\bfetch\s*\(|XMLHttpRequest|WebSocket|sendBeacon|postMessage|RTCPeerConnection|\brank|\bscore|\breward|\bcredit/i)
})
