// src/loader/seed-budget.js: the seed budget of smart seeding (v0.3 C2, seed-policy lane;
// docs/research/v03/SEEDING-AND-ZERO-SETUP-DESIGN.md 3.1.2 to 3.1.4, S1 D1 to D3; ARCHITECTURE 8).
//
// Three lanes in spending order:
//   H hand-off: the member's own new items until a pin receipt or two complete peer copies exist; on by default
//     everywhere, item by item, with the per-upload card (MF-45);
//   K keep: items the member chose to share, and the site torrent while sharing is on;
//   E echo: items already held, by copy deficit, then recency (src/loader/seed-planner.js orders them).
// seedBudget() turns the device, the network and how it is known, power, the dock and call state and the person's
// choices into per-lane rates and caps: one row of the SZ 3.1.3 table (CONFIG.seed.rows). It decides nothing about
// wires: src/loader/torrent.js (seed-engine lane) enforces the budget with choke locks, never throttleUpload(0).
// Counters are local only (src/loader/seed-meters.js); nothing here is ever a reward (ARCHITECTURE 8).
//
// Pure: no browser global is read, so Node 22 runs it unchanged. Rates are bytes per second, caps are bytes,
// Infinity means none, 0 means the lane is off.

import { CONFIG } from './config.js'

/** The lanes in spending order: hand-off, keep, echo. */
export const SEED_LANES = Object.freeze(['H', 'K', 'E'])

/**
 * The base rows of the SZ 3.1.3 table that seedBudget() reports in `row` (rows 1 to 5), plus 'hostOnly'. Row 6
 * (local wire) is reported in `local` and row 7 (during a call) in `call`; both apply on top of a base row.
 */
export const SEED_ROWS = Object.freeze(['desktop', 'phoneCharging', 'phoneWifi', 'phoneLimited', 'metered', 'hostOnly'])

/** The lanes the month cap counts (SZ 3.1.3: "Month (K + E)"). */
export const MONTH_LANES = Object.freeze(['K', 'E'])

const NETWORK_CLASSES = ['wifi', 'cellular', 'unknown', 'saveData']
const SHAPING_FLOOR = 32768

function seedConfig (config) {
  const s = (config && config.seed) || CONFIG.seed
  const rows = Object.assign({}, CONFIG.seed.rows, s.rows || {})
  return Object.assign({}, CONFIG.seed, s, { rows })
}

function shapingFloor (config) {
  const v = Number(config && config.policy && config.policy.minShapingBytes)
  return Number.isFinite(v) && v > 0 ? Math.floor(v) : SHAPING_FLOOR
}

/** The network class of an env, as policy.js networkClassOf (a unit test keeps the two in step). */
export function networkOfEnv (env) {
  const e = env || {}
  if (NETWORK_CLASSES.indexOf(e.networkClass) >= 0) return e.networkClass
  if (e.saveData) return 'saveData'
  if (e.networkType === 'wifi') return 'wifi'
  if (e.networkType === 'cellular') return 'cellular'
  return 'unknown'
}

// { charging, level } as detectEnvironment reports it (policy.js normalizeBattery), or null when unknown.
function batteryOf (b) {
  if (!b || typeof b !== 'object') return null
  const level = Number(b.level)
  return { charging: b.charging !== false, level: Number.isFinite(level) ? Math.min(1, Math.max(0, level)) : 1 }
}

function rate (v) {
  const n = Number(v)
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0
}

function cap (v) {
  if (v === null || v === undefined || v === Infinity) return Infinity
  const n = Number(v)
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0
}

// Everything seedBudget() reads, normalized once.
function contextOf (env, prefs, config) {
  const e = env || {}
  const p = prefs || {}
  const s = seedConfig(config)
  const net = networkOfEnv(e)
  return {
    s,
    floor: shapingFloor(config),
    phone: !!e.isMobile,
    net,
    metered: net === 'cellular' || net === 'saveData',
    wifiByConnection: net === 'wifi',
    // A declaration counts only where the browser cannot tell: never against connection.type.
    declaredWifi: net === 'unknown' && (p.declaredWifi === true || e.networkProof === 'declared'),
    declaredPlugged: p.declaredPlugged === true,
    battery: batteryOf(e.battery),
    dock: e.dock === true,
    call: e.call ? { limited: !!(typeof e.call === 'object' && e.call.limited === true) } : null,
    hostOnly: p.hostOnly === true,
    share: p.share !== false,
    shareOnNetwork: p.shareOnNetwork === true,
    seedAsked: p.seedAsked === true,
    phoneDefaultOn: typeof p.phoneDefaultOn === 'boolean' ? p.phoneDefaultOn : s.phoneDefaultOn === true,
    handoffWhileHidden: typeof p.handoffWhileHidden === 'boolean' ? p.handoffWhileHidden : s.handoffWhileHidden === true
  }
}

/**
 * pickRow(ctx) → a base row id. The most restrictive row that applies wins: a metered network (the connection API
 * beats any declaration) or a battery under 20% unplugged is row 5 on any phone; a desktop is row 1 unless its
 * network is metered. Row 2 needs Wi-Fi by connection.type, charging and 50% or more; in dock mode the person's word
 * ("plugged in, on Wi-Fi") stands in for what the browser cannot read, never against what it can (S1 D3).
 */
function pickRow (c) {
  if (!c.phone) return c.metered ? 'metered' : 'desktop'
  if (c.metered) return 'metered'
  const b = c.battery
  if (b && !b.charging && b.level < 0.2) return 'metered'
  const wifi = c.wifiByConnection || c.declaredWifi
  if (c.wifiByConnection && b && b.charging && b.level >= 0.5) return 'phoneCharging'
  if (c.dock && wifi && (b ? b.charging && b.level >= 0.5 : c.declaredPlugged)) return 'phoneCharging'
  if (c.wifiByConnection && b && !b.charging && b.level >= 0.5) return 'phoneWifi'
  return 'phoneLimited'
}

// K and E on a phone stay off unless the person turned on "Share on this network", started dock mode (a
// click-started, time-boxed share), or the owner turned on SZ-1 and row 2 applies and the seed.ask card was not
// declined (seedAsked without shareOnNetwork).
function phoneKeepOn (c, row) {
  if (c.shareOnNetwork || c.dock) return true
  return c.phoneDefaultOn && row === 'phoneCharging' && !c.seedAsked
}

function overlayCall (r, c) {
  if (!c.call) return r
  const C = c.s.rows.call || CONFIG.seed.rows.call
  if (c.phone) return { H: Math.min(r.H, rate(C.phoneH)), K: Math.min(r.K, rate(C.phoneK)), E: Math.min(r.E, rate(C.phoneE)) }
  const f = Number(C.desktopKFactor)
  const K = c.call.limited ? Math.floor(r.K * (Number.isFinite(f) && f >= 0 && f <= 1 ? f : 0.5)) : r.K
  return { H: r.H, K, E: Math.min(r.E, rate(C.desktopE)) }
}

// Shaping only at 32 KiB/s or more (ARCHITECTURE 8): a positive rate below the floor is raised, never zeroed.
function floored (r, floor) {
  const out = {}
  for (const l of SEED_LANES) out[l] = r[l] > 0 ? Math.max(r[l], floor) : 0
  return out
}

function build (c) {
  const R = c.s.rows
  const row = pickRow(c)
  const def = R[row] || CONFIG.seed.rows[row]
  const wifi = c.wifiByConnection || c.declaredWifi
  const src = row === 'phoneLimited' && wifi && def.wifi ? def.wifi : def
  let r = { H: rate(src.H), K: rate(src.K), E: rate(src.E) }
  const keepOn = c.share && (!c.phone || phoneKeepOn(c, row))
  if (!keepOn) r = { H: r.H, K: 0, E: 0 }
  r = floored(overlayCall(r, c), c.floor)
  const session = cap(def.session)
  const lanes = {}
  for (const l of SEED_LANES) lanes[l] = { rate: r[l], session: r[l] > 0 ? session : 0 }

  // Row 6: a local wire costs battery, not data, so it sits outside the month cap. It never lifts a metered network
  // or a battery under 20% unplugged (a carrier can hand out 10/8 host addresses): there the local wire gets the
  // row's own rates and session, and local.on is false (count such wires like any other). The same holds for a phone
  // whose network the browser cannot tell (every iPhone, Firefox for Android) until the person says "I am on Wi-Fi":
  // it may be on mobile data (code review v0.3, browser).
  let local
  if (row === 'metered' || (c.phone && c.net === 'unknown' && !c.declaredWifi)) {
    local = { H: r.H, K: r.K, E: r.E, session: r.H || r.K || r.E ? session : 0, on: false }
  } else {
    const L = c.phone ? (R.local || CONFIG.seed.rows.local) : def
    let lr = { H: rate(L.H), K: rate(L.K), E: rate(L.E) }
    if (!keepOn) lr = { H: lr.H, K: 0, E: 0 }
    lr = floored(overlayCall(lr, c), c.floor)
    const ls = c.phone ? cap(L.session) : session
    local = { H: lr.H, K: lr.K, E: lr.E, session: lr.H || lr.K || lr.E ? ls : 0, on: true }
  }

  return {
    row,
    call: !!c.call,
    lanes,
    month: { cap: cap(def.month), lanes: MONTH_LANES.slice() },
    local,
    hiddenH: c.phone && c.handoffWhileHidden && lanes.H.rate > 0,
    defaultOn: c.phone ? row === 'phoneCharging' && c.phoneDefaultOn : row === 'desktop',
    ask: null
  }
}

function hostOnlyBudget (c) {
  const lanes = {}
  for (const l of SEED_LANES) lanes[l] = { rate: 0, session: 0 }
  return {
    row: 'hostOnly',
    call: !!c.call,
    lanes,
    month: { cap: 0, lanes: MONTH_LANES.slice() },
    local: { H: 0, K: 0, E: 0, session: 0, on: false },
    hiddenH: false,
    defaultOn: false,
    ask: null
  }
}

/**
 * seedBudget(env, prefs = {}, config = CONFIG) → {
 *   row: 'desktop' | 'phoneCharging' | 'phoneWifi' | 'phoneLimited' | 'metered' | 'hostOnly' (SZ 3.1.3 rows 1 to 5),
 *   call: boolean (row 7 applies),
 *   lanes: { H: { rate, session }, K: { rate, session }, E: { rate, session } },
 *   month: { cap, lanes: ['K', 'E'] },
 *   local: { H, K, E, session, on },
 *   hiddenH: boolean, defaultOn: boolean, ask: 'consent' | 'wifi' | null }
 * env: detectEnvironment() output (isMobile, networkClass, saveData, battery { charging, level } or null) plus
 *   networkProof ('connection' | 'declared' | 'none'), dock (boolean) and call (null or { limited }).
 * prefs: { share, hostOnly, shareOnNetwork, declaredWifi, declaredPlugged, seedAsked, phoneDefaultOn?,
 *   handoffWhileHidden? } (the last two override CONFIG.seed).
 * Rates are bytes per second; session and month caps are bytes or Infinity (none). A lane's session cap is the
 * row's session figure for that lane (0 when the lane is off); local wires count against local.session per lane and
 * never against the month cap. Host-only gives 0 everywhere; Share Off gives K and E 0 and keeps H (the per-upload
 * card is the person's own choice).
 */
export function seedBudget (env, prefs = {}, config = CONFIG) {
  const c = contextOf(env, prefs, config)
  if (c.hostOnly) return hostOnlyBudget(c)
  const b = build(c)
  if (c.phone) {
    if (b.row === 'phoneCharging' && c.phoneDefaultOn && !c.dock && c.share && !c.shareOnNetwork && !c.seedAsked) {
      b.ask = 'consent'
    } else if (c.net === 'unknown' && !c.declaredWifi) {
      // 'wifi' when "I am on Wi-Fi" would raise a lane: the same budget with the declaration, compared lane by lane.
      const alt = build(contextOf(env, Object.assign({}, prefs || {}, { declaredWifi: true }), config))
      for (const l of SEED_LANES) if (alt.lanes[l].rate > b.lanes[l].rate) { b.ask = 'wifi'; break }
    }
  }
  return b
}

/** laneRates(budget, { local }) → { H, K, E } bytes per second of the lanes (local: the local-wire rates). */
export function laneRates (budget, { local = false } = {}) {
  const b = budget || {}
  const out = {}
  for (const l of SEED_LANES) {
    const v = local ? (b.local || {})[l] : ((b.lanes || {})[l] || {}).rate
    out[l] = rate(v)
  }
  return out
}
