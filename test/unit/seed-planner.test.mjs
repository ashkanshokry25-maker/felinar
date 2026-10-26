// Unit tests for src/loader/seed-planner.js (v0.3 C2, seed-policy lane; SEEDING-AND-ZERO-SETUP-DESIGN.md 3.1.2, S1
// D1): the spending order H, K, E; copy deficit then recency; pinned and incomplete items skipped by E; lanes at
// rate 0; the shaping floor; deterministic ties.
// Run: node --test test/unit/seed-planner.test.mjs
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { planSeeding } from '../../src/loader/seed-planner.js'
import { seedBudget } from '../../src/loader/seed-budget.js'
import { CONFIG } from '../../src/loader/config.js'

const KiB = 1024
const budget = (H, K, E) => ({ lanes: { H: { rate: H }, K: { rate: K }, E: { rate: E } } })
const WIDE = budget(Infinity, Infinity, Infinity)
const ih = (n) => n.toString(16).padStart(40, '0')

test('spending order: H oldest first, then K, then E by copy deficit, then the newest openedAt', () => {
  const items = [
    { ih: 'e-new-1copy', lane: 'E', complete: true, copies: { complete: 1 }, openedAt: 900 },
    { ih: 'e-old-0copy', lane: 'E', complete: true, copies: { complete: 0 }, openedAt: 100 },
    { ih: 'e-new-0copy', lane: 'E', complete: true, copies: { complete: 0 }, openedAt: 800 },
    { ih: 'e-3copies', lane: 'E', complete: true, copies: { complete: 3, atLeast: true }, openedAt: 1000 },
    { ih: 'k-site', lane: 'K', complete: true, copies: { complete: 5 }, openedAt: 50 },
    { ih: 'k-rare', lane: 'K', complete: false, copies: { complete: 0 }, openedAt: 10 },
    { ih: 'h-new', lane: 'H', openedAt: 700, own: true },
    { ih: 'h-old', lane: 'H', openedAt: 200, own: true }
  ]
  const plan = planSeeding({ items, budget: WIDE, now: 2000 })
  // Review round R 5.3 (MP-14): reported (unchecked) copies count as one at most, so 3 reported copies rank like 1 and
  // the newer opening goes first.
  assert.deepEqual(plan.order, ['h-old', 'h-new', 'k-rare', 'k-site', 'e-new-0copy', 'e-old-0copy', 'e-3copies', 'e-new-1copy'])
  assert.deepEqual(plan.idle, [])
  assert.equal(plan.share['h-old'], 0.5)
  assert.equal(plan.share['k-site'], 0.5)
  assert.equal(plan.share['e-3copies'], 0.25, 'an item with reported copies still echoes')
})

test('E skips pinned and incomplete items; a lane at rate 0 plans nothing; unknown lanes are idle', () => {
  const items = [
    { ih: 'e-pinned', lane: 'E', complete: true, pinned: true, copies: { complete: 0 } },
    { ih: 'e-partial', lane: 'E', complete: false, copies: { complete: 0 } },
    { ih: 'e-ok', lane: 'E', complete: true, copies: { complete: 0 } },
    { ih: 'k-pinned', lane: 'K', complete: true, pinned: true },
    { ih: 'h-1', lane: 'H', openedAt: 1 },
    { ih: 'x-1', lane: 'X' }
  ]
  const all = planSeeding({ items, budget: WIDE, now: 10 })
  assert.deepEqual(all.order, ['h-1', 'k-pinned', 'e-ok'], 'K keeps pinned items: the person chose them')
  assert.deepEqual(all.idle, ['e-partial', 'e-pinned', 'x-1'], 'idle is sorted by ih')
  const noEcho = planSeeding({ items, budget: budget(Infinity, Infinity, 0), now: 10 })
  assert.deepEqual(noEcho.order, ['h-1', 'k-pinned'])
  assert.deepEqual(noEcho.idle, ['e-ok', 'e-partial', 'e-pinned', 'x-1'])
  const hostOnly = planSeeding({ items, budget: seedBudget({}, { hostOnly: true }), now: 10 })
  assert.deepEqual(hostOnly.order, [])
  assert.equal(hostOnly.idle.length, 6)
  const none = planSeeding({ items })
  assert.deepEqual(none.order, [], 'without a budget nothing seeds')
  assert.deepEqual(none.share, {})
})

test('the shaping floor: no more items per lane than leave each 32 KiB/s, equal shares that add up to 1', () => {
  const items = []
  for (let i = 0; i < 12; i++) items.push({ ih: ih(i), lane: 'E', complete: true, copies: { complete: i % 3 }, openedAt: i })
  for (let i = 0; i < 6; i++) items.push({ ih: ih(100 + i), lane: 'H', openedAt: 100 - i })
  const phone = seedBudget({ isMobile: true, networkClass: 'cellular' }, {})
  assert.equal(phone.lanes.H.rate, 128 * KiB)
  const p = planSeeding({ items, budget: Object.assign({}, phone, { lanes: Object.assign({}, phone.lanes, { E: { rate: 256 * KiB, session: 1 } }) }), now: 1000 })
  const hs = p.order.filter((x) => x >= ih(100))
  assert.equal(hs.length, 4, '128 KiB/s / 32 KiB/s = 4 hand-offs at a time, oldest first')
  assert.deepEqual(hs, [ih(105), ih(104), ih(103), ih(102)])
  const es = p.order.filter((x) => x < ih(100))
  assert.equal(es.length, 8, '256 KiB/s serves 8 echoed items')
  assert.ok(es.slice(0, 4).every((x) => parseInt(x, 16) % 3 === 0), 'the largest deficits first')
  assert.equal(p.idle.length, 6)
  let sum = 0
  for (const x of es) sum += p.share[x]
  assert.ok(Math.abs(sum - 1) < 1e-9)
  for (const x of hs) assert.equal(p.share[x], 0.25)
  const one = planSeeding({ items: [{ ih: 'a', lane: 'H' }, { ih: 'b', lane: 'H' }], budget: budget(1000, 0, 0) })
  assert.deepEqual(one.order, ['a'], 'a lane under the floor still serves one item')
  const floorCfg = { seed: CONFIG.seed, policy: { minShapingBytes: 64 * KiB } }
  assert.equal(planSeeding({ items, budget: budget(128 * KiB, 0, 0), config: floorCfg }).order.length, 2, 'the floor comes from config.policy')
})

test('ties break by infohash; a repeated infohash keeps its first entry; otherwise input order does not change the plan', () => {
  const items = [
    { ih: 'cc', lane: 'E', complete: true, copies: { complete: 1 }, openedAt: 5 },
    { ih: 'aa', lane: 'E', complete: true, copies: { complete: 1 }, openedAt: 5 },
    { ih: 'bb', lane: 'E', complete: true, copies: { complete: 1 }, openedAt: 5 },
    { ih: 'h2', lane: 'H' },
    { ih: 'h1', lane: 'H' },
    { ih: 'aa', lane: 'H' }
  ]
  const a = planSeeding({ items, budget: WIDE, now: 10 })
  assert.deepEqual(a.order, ['h1', 'h2', 'aa', 'bb', 'cc'], 'H without openedAt ties by ih; the repeated aa stays E')
  const b = planSeeding({ items: items.slice().reverse(), budget: WIDE, now: 10 })
  assert.deepEqual(b.order.filter((x) => x !== 'aa'), ['h1', 'h2', 'bb', 'cc'])
  assert.deepEqual(planSeeding({ items: [{ ih: 'x', lane: 'K', openedAt: null }, { ih: 'y', lane: 'K', openedAt: 3 }], budget: WIDE }).order, ['y', 'x'], 'K and E: no openedAt comes last')
  assert.deepEqual(planSeeding({ items: [{ ih: 'a', lane: 'K', openedAt: null }, { ih: 'b', lane: 'K', openedAt: -5 }], budget: WIDE }).order, ['b', 'a'], 'null is missing, not time 0')
  assert.deepEqual(planSeeding({ items: [{ ih: 'b', lane: 'H', openedAt: -5 }, { ih: 'a', lane: 'H' }], budget: WIDE }).order, ['a', 'b'], 'H: a missing openedAt counts as the oldest')
})

test('recency uses openedAt with future times counted as now; copies default to none; junk items are ignored', () => {
  const items = [
    { ih: 'future', lane: 'K', copies: { complete: 0 }, openedAt: 99999 },
    { ih: 'recent', lane: 'K', copies: { complete: 0 }, openedAt: 500 },
    { ih: 'nocopies', lane: 'K', openedAt: 1 },
    { ih: 'many', lane: 'K', copies: { complete: 9 }, openedAt: 2 },
    null, { lane: 'K' }, { ih: '', lane: 'K' }, { ih: 7, lane: 'K' }
  ]
  const p = planSeeding({ items, budget: WIDE, now: 500 })
  assert.deepEqual(p.order, ['future', 'recent', 'nocopies', 'many'], 'the future openedAt ties with now and breaks by ih')
  assert.deepEqual(p.idle, [])
  assert.deepEqual(planSeeding({ items, budget: WIDE, now: () => 500 }).order, p.order, 'now may be a function')
  for (const odd of ['', '500', null, NaN]) {
    const q = planSeeding({ items: items.concat({ ih: 'aaa-later', lane: 'K', copies: { complete: 0 }, openedAt: 600 }), budget: WIDE, now: odd })
    assert.deepEqual(q.order, ['future', 'aaa-later', 'recent', 'nocopies', 'many'], 'no usable now: openedAt is taken as given (' + String(odd) + ')')
  }
  assert.deepEqual(planSeeding({ items: 'nope', budget: WIDE }), { order: [], idle: [], share: {} })
  assert.deepEqual(planSeeding(), { order: [], idle: [], share: {} })
  const cfg = { seed: Object.assign({}, CONFIG.seed, { echoTargetCopies: 1 }), policy: CONFIG.policy }
  const t1 = planSeeding({ items: [{ ih: 'a', lane: 'E', complete: true, copies: { complete: 0 }, openedAt: 1 }, { ih: 'b', lane: 'E', complete: true, copies: { complete: 2 }, openedAt: 9 }], budget: WIDE, config: cfg })
  assert.deepEqual(t1.order, ['a', 'b'], 'the target comes from config.seed.echoTargetCopies')
})

test('pure: the inputs are not changed and the same inputs give the same plan', () => {
  const items = [{ ih: 'a', lane: 'E', complete: true, copies: { complete: 0 }, openedAt: 1 }, { ih: 'b', lane: 'H', openedAt: 2 }]
  const before = JSON.stringify(items)
  const b = budget(Infinity, Infinity, Infinity)
  const x = planSeeding({ items, budget: b, now: 5 })
  const y = planSeeding({ items, budget: b, now: 5 })
  assert.deepEqual(x, y)
  assert.equal(JSON.stringify(items), before)
})
