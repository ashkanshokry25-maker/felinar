// src/loader/seed-meters.js: local byte counters of smart seeding (v0.3 C2, seed-policy lane;
// docs/research/v03/SEEDING-AND-ZERO-SETUP-DESIGN.md 3.1.3; ARCHITECTURE 8 "no incentive layer").
//
// Per lane (H, K, E): the bytes uploaded this page session, kept apart for local wires (a host-to-host pair,
// src/loader/localwire.js), and the K plus E bytes of the current UTC calendar month, the only figure that is
// stored. The counters are local only: this module has no network code, sends nothing, reports nothing to the site
// beyond the read-only snapshot, and ranks nothing. They exist so the seed budget can stop a lane at its session or
// month cap and the person can see what this device gave.
//
// Storage is the loader's per-origin pref store { get(key), set(key, value) }, synchronous or returning promises;
// every call is wrapped, and a store that throws or rejects leaves the counters in memory for the rest of the page.
// Writes are throttled (at most one every persistMs, chosen 5 s) without timers: add() writes when the last write
// is old enough and flush() writes at once (the loader calls it when the page is hidden). Only the engine tab of an
// origin seeds (ARCHITECTURE 5.9), so one writer owns the key.

import { SEED_LANES, MONTH_LANES } from './seed-budget.js'

const RECORD_VERSION = 1

/** monthKeyOf(ms) → 'YYYY-MM' of the UTC calendar month of a timestamp. */
export function monthKeyOf (ms) {
  const d = new Date(Number(ms) || 0)
  const m = d.getUTCMonth() + 1
  return d.getUTCFullYear() + '-' + (m < 10 ? '0' : '') + m
}

function bytesOf (v) {
  const n = Math.floor(Number(v))
  return Number.isFinite(n) && n > 0 ? n : 0
}

function capOf (v) {
  if (v === Infinity) return Infinity
  const n = Number(v)
  return Number.isFinite(n) && n > 0 ? n : 0
}

function left (capValue, used) {
  return capValue === Infinity ? Infinity : Math.max(0, capValue - used)
}

/**
 * createSeedMeters({ storage, now, key = 'seedMeters', persistMs = 5000 }) → {
 *   add(lane, bytes, { local = false }), sessionUsed(lane, { local = false }), monthUsed(),
 *   remaining(budget) → { H: { session, month, local }, K: {...}, E: {...} },
 *   snapshot() → frozen { session: { H, K, E }, local: { H, K, E }, month: { key, K, E, used }, persistent, loaded },
 *   flush(), ready: Promise<void> }
 * key: the pref key of the month record (the loader passes 'seedMeters:' + origin, like its other per-origin prefs).
 * monthUsed() is K plus E bytes of the current UTC month on wires that were not local; it resets at a month change.
 * remaining(budget) reads a seedBudget() result: session = the lane's session cap minus the lane's session bytes;
 * month = the month cap minus monthUsed() for K and E, Infinity for H; local = local.session minus the lane's local
 * bytes (0 when the lane's local rate is 0). A missing or malformed cap counts as 0 (the lane stops), Infinity as
 * none.
 */
export function createSeedMeters ({ storage = null, now = () => Date.now(), key = 'seedMeters', persistMs = 5000 } = {}) {
  const clock = typeof now === 'function' ? now : () => Date.now()
  const session = { H: 0, K: 0, E: 0 }
  const local = { H: 0, K: 0, E: 0 }
  let month = { key: monthKeyOf(clock()), K: 0, E: 0 }
  let persistent = !!(storage && typeof storage.get === 'function' && typeof storage.set === 'function')
  let loaded = !persistent
  let dirty = false
  let lastWrite = -Infinity
  const throttleMs = Number.isFinite(Number(persistMs)) && Number(persistMs) >= 0 ? Number(persistMs) : 5000

  function roll () {
    const k = monthKeyOf(clock())
    if (k !== month.key) {
      month = { key: k, K: 0, E: 0 }
      dirty = true
    }
  }

  function write (force) {
    if (!persistent || !loaded || !dirty) return
    const t = clock()
    if (!force && t - lastWrite < throttleMs) return
    lastWrite = t
    dirty = false
    const record = { v: RECORD_VERSION, month: month.key, K: month.K, E: month.E }
    try {
      const w = storage.set(key, record)
      if (w && typeof w.then === 'function') w.then(null, () => { persistent = false })
    } catch (_) {
      persistent = false
    }
  }

  function applyStored (v) {
    loaded = true
    roll()
    if (v && typeof v === 'object' && v.v === RECORD_VERSION && v.month === month.key) {
      month.K += bytesOf(v.K)
      month.E += bytesOf(v.E)
    }
    write(false)
  }

  let ready = Promise.resolve()
  if (persistent) {
    let r
    try { r = storage.get(key) } catch (_) { persistent = false; r = undefined }
    if (r && typeof r.then === 'function') {
      ready = r.then(applyStored, () => { persistent = false; applyStored(undefined) })
    } else {
      applyStored(r)
    }
  }

  function add (lane, bytes, { local: isLocal = false } = {}) {
    if (SEED_LANES.indexOf(lane) < 0) return
    const n = bytesOf(bytes)
    if (!n) return
    roll()
    if (isLocal) { local[lane] += n; return }
    session[lane] += n
    if (MONTH_LANES.indexOf(lane) >= 0) {
      month[lane] += n
      dirty = true
      write(false)
    }
  }

  function sessionUsed (lane, { local: isLocal = false } = {}) {
    if (SEED_LANES.indexOf(lane) < 0) return 0
    return isLocal ? local[lane] : session[lane]
  }

  function monthUsed () {
    roll()
    return month.K + month.E
  }

  function remaining (budget) {
    const b = budget || {}
    const used = monthUsed()
    const monthLanes = b.month && Array.isArray(b.month.lanes) ? b.month.lanes : MONTH_LANES
    const monthCap = capOf(b.month && b.month.cap)
    const localCap = capOf(b.local && b.local.session)
    const out = {}
    for (const l of SEED_LANES) {
      const lb = (b.lanes && b.lanes[l]) || {}
      // A lane whose local rate is 0 has no local allowance, as a lane whose rate is 0 has no session.
      const localOn = capOf(b.local && b.local[l]) > 0
      out[l] = {
        session: left(capOf(lb.session), session[l]),
        month: monthLanes.indexOf(l) >= 0 ? left(monthCap, used) : Infinity,
        local: localOn ? left(localCap, local[l]) : 0
      }
    }
    return out
  }

  function snapshot () {
    roll()
    return Object.freeze({
      session: Object.freeze({ H: session.H, K: session.K, E: session.E }),
      local: Object.freeze({ H: local.H, K: local.K, E: local.E }),
      month: Object.freeze({ key: month.key, K: month.K, E: month.E, used: month.K + month.E }),
      persistent,
      loaded
    })
  }

  function flush () {
    roll()
    write(true)
  }

  return { add, sessionUsed, monthUsed, remaining, snapshot, flush, get ready () { return ready } }
}
