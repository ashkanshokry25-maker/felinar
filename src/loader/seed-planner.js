// src/loader/seed-planner.js: which held items get the seed budget, in what order (v0.3 C2, seed-policy lane;
// docs/research/v03/SEEDING-AND-ZERO-SETUP-DESIGN.md 3.1.2, S1 D1).
//
// Spending order: H hand-off first (oldest first), then K keep, then E echo; K and E by copy deficit (the echo
// target, 3 complete online copies, minus the complete copies seen; larger first), then recency (the newest
// openedAt first); ties by infohash. E skips what a pin keeps, what is not complete here (a partial copy never
// makes an item available), and everything while its rate is 0; any lane whose rate is 0 plans nothing. Within a
// lane, each item that gets budget gets an equal share of the lane rate, and no more items than leave each at
// least the 32 KiB/s shaping floor (ARCHITECTURE 8), so a 256 KiB/s echo lane serves 8 items at a time.
//
// The planner never fetches, never re-lanes and never reads a browser global: the engine (torrent.js) assigns the
// lane (H ends at a pin receipt or two complete peer copies, SZ 3.1.2) and applies the plan.

import { CONFIG } from './config.js'
import { SEED_LANES } from './seed-budget.js'

const SHAPING_FLOOR = 32768

function laneRate (budget, lane) {
  const v = Number(budget && budget.lanes && budget.lanes[lane] && budget.lanes[lane].rate)
  if (v === Infinity) return Infinity
  return Number.isFinite(v) && v > 0 ? v : 0
}

function timeOf (v, nowMs) {
  if (v === null || v === undefined || v === '') return null
  const t = Number(v)
  if (!Number.isFinite(t)) return null
  return Number.isFinite(nowMs) ? Math.min(t, nowMs) : t
}

function byIh (a, b) {
  return a.ih < b.ih ? -1 : a.ih > b.ih ? 1 : 0
}

// H: oldest first (an item without openedAt counts as the oldest), then infohash.
function hOrder (a, b) {
  const ta = a.t === null ? -Infinity : a.t
  const tb = b.t === null ? -Infinity : b.t
  if (ta !== tb) return ta < tb ? -1 : 1
  return byIh(a, b)
}

// K and E: larger copy deficit first, then the newest openedAt (an item without one comes last), then infohash.
function deficitOrder (a, b) {
  if (a.deficit !== b.deficit) return b.deficit - a.deficit
  const ta = a.t === null ? -Infinity : a.t
  const tb = b.t === null ? -Infinity : b.t
  if (ta !== tb) return ta > tb ? -1 : 1
  return byIh(a, b)
}

/**
 * planSeeding({ items, budget, now, config }) → { order: [ih], idle: [ih], share: { [ih]: fraction of its lane rate } }
 * items: [{ ih, lane: 'H'|'K'|'E', bytes, complete, copies: { complete, atLeast }, pinned, openedAt, own }].
 * budget: a seedBudget() result (or anything with lanes[lane].rate); without one every item is idle.
 * now: a timestamp in ms (or a function returning one); an openedAt in the future counts as now. Without a finite
 * number, openedAt is taken as given.
 * order: the items that get budget, H then K then E, each lane in its order. idle: every other item with a usable
 * ih, sorted by ih. share: for each ordered item, its fraction of its lane rate (the fractions of a lane add up to
 * 1). Items without an ih string are ignored; a repeated ih keeps its first entry. bytes, copies.atLeast and own are
 * accepted for the engine's convenience and do not change the plan in C2.
 */
export function planSeeding ({ items = [], budget = null, now = null, config = CONFIG } = {}) {
  const seed = (config && config.seed) || CONFIG.seed
  const targetRaw = Number(seed.echoTargetCopies)
  const target = Number.isFinite(targetRaw) && targetRaw > 0 ? Math.floor(targetRaw) : 3
  const floorRaw = Number(config && config.policy && config.policy.minShapingBytes)
  const floor = Number.isFinite(floorRaw) && floorRaw > 0 ? floorRaw : SHAPING_FLOOR
  const nowRaw = typeof now === 'function' ? now() : now
  const nowMs = typeof nowRaw === 'number' && Number.isFinite(nowRaw) ? nowRaw : NaN

  const seen = new Set()
  const groups = { H: [], K: [], E: [] }
  const idle = []
  for (const it of Array.isArray(items) ? items : []) {
    if (!it || typeof it.ih !== 'string' || !it.ih || seen.has(it.ih)) continue
    seen.add(it.ih)
    const lane = it.lane
    if (SEED_LANES.indexOf(lane) < 0 || !(laneRate(budget, lane) > 0)) { idle.push(it.ih); continue }
    if (lane === 'E' && (it.pinned === true || it.complete !== true)) { idle.push(it.ih); continue }
    // Review round R 5.3 (MP-14): copies.complete counts peers whose OWN bitfield says complete, which nobody checked, so
    // lying peers could push an item behind every other. Reported copies count as one at most; checked ones (a pin
    // receipt: pinned, or copies.checked) count in full.
    const reported = Math.max(0, Math.floor(Number(it.copies && it.copies.complete) || 0))
    const checked = Math.max(0, Math.floor(Number(it.copies && it.copies.checked) || 0)) + (it.pinned === true ? 1 : 0)
    const copies = checked + (reported > checked ? 1 : 0)
    groups[lane].push({ ih: it.ih, t: timeOf(it.openedAt, nowMs), deficit: target - copies })
  }

  const order = []
  const share = {}
  for (const lane of SEED_LANES) {
    const g = groups[lane]
    if (!g.length) continue
    g.sort(lane === 'H' ? hOrder : deficitOrder)
    const r = laneRate(budget, lane)
    const fit = r === Infinity ? g.length : Math.max(1, Math.floor(r / floor))
    const active = g.slice(0, Math.min(fit, g.length))
    for (const x of active) { order.push(x.ih); share[x.ih] = 1 / active.length }
    for (const x of g.slice(active.length)) idle.push(x.ih)
  }
  idle.sort()
  return { order, idle, share }
}
