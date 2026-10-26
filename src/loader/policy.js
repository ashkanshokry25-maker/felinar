// src/loader/policy.js: bandwidth, connection, battery and visibility policy (ARCHITECTURE §8,
// DESIGN-REVIEW items 19, S4; v0.2.1 DIGEST-AMENDMENTS B6, C2). Pure functions plus one lifecycle
// watcher; every browser global is looked up lazily (or injected) so the module runs unchanged in Node
// for tests.

import { CONFIG } from './config.js'
import { seedBudget } from './seed-budget.js'

// "Mobile" = coarse primary pointer or a mobile user agent (§8). iPadOS sends a desktop UA but has a
// coarse pointer, so it counts as mobile.
const MOBILE_UA_RE = /Mobi|Android|iPhone|iPad|iPod|Silk|Kindle|Opera Mini|IEMobile/i

// Network Information API types that mean "metered or not proven unmetered" (research w1-08 Mobile
// policy v1): a phone on any of these only downloads.
const METERED_TYPES = new Set(['cellular', 'bluetooth', 'other', 'mixed', 'none', 'wimax'])

/** The four network classes of the v0.2.1 classifier (C2). */
export const NETWORK_CLASSES = Object.freeze(['wifi', 'cellular', 'unknown', 'saveData'])
/** The four policy classes (research digest 2.4): the §8 table columns. */
export const POLICY_CLASSES = Object.freeze(['desktop', 'mobileUnmetered', 'mobileUnknown', 'mobileMetered'])

function globalNav () { return typeof navigator !== 'undefined' ? navigator : null }
function globalWin () { return typeof window !== 'undefined' ? window : null }

/**
 * classifyNetwork(connection) → 'wifi' | 'cellular' | 'unknown' | 'saveData' (v0.2.1 C2).
 * Only navigator.connection is read (Chromium): mozConnection and webkitConnection are dead (Firefox
 * Android removed the API in 99) and are never consulted. Save-Data wins over the connection type;
 * 'wifi' covers wifi and ethernet ("not known to be metered", not "free": a phone hotspot looks the
 * same); a missing API (iOS, Firefox, most WebViews) is 'unknown'.
 */
export function classifyNetwork (connection) {
  if (!connection || typeof connection !== 'object') return 'unknown'
  if (connection.saveData === true) return 'saveData'
  const type = typeof connection.type === 'string' ? connection.type : ''
  if (type === 'wifi' || type === 'ethernet') return 'wifi'
  if (METERED_TYPES.has(type)) return 'cellular'
  return 'unknown'
}

/** v0.2 three-value network type, kept for callers that read env.networkType. */
export function networkTypeOf (connection) {
  const type = connection && typeof connection.type === 'string' ? connection.type : ''
  if (type === 'wifi' || type === 'ethernet') return 'wifi'
  if (METERED_TYPES.has(type)) return 'cellular'
  return 'unknown'
}

/**
 * detectEnvironment() → { isMobile, networkType: 'wifi'|'cellular'|'unknown',
 *   networkClass: 'wifi'|'cellular'|'unknown'|'saveData', saveData, battery: { charging, level } | null, online }
 * Battery comes from an earlier readBattery() (navigator.getBattery is asynchronous).
 */
export function detectEnvironment ({ nav = globalNav(), win = globalWin(), battery = null } = {}) {
  const ua = nav && typeof nav.userAgent === 'string' ? nav.userAgent : ''
  let coarse = false
  try {
    coarse = !!(win && typeof win.matchMedia === 'function' && win.matchMedia('(pointer: coarse)').matches)
  } catch (_) { coarse = false }
  const connection = nav && nav.connection && typeof nav.connection === 'object' ? nav.connection : null
  return {
    isMobile: coarse || MOBILE_UA_RE.test(ua),
    networkType: networkTypeOf(connection),
    networkClass: classifyNetwork(connection),
    saveData: !!(connection && connection.saveData === true),
    battery: normalizeBattery(battery),
    online: !(nav && nav.onLine === false)
  }
}

function normalizeBattery (b) {
  if (!b || typeof b !== 'object') return null
  return { charging: b.charging !== false, level: typeof b.level === 'number' ? b.level : 1 }
}

/**
 * readBattery({ nav, onChange }) → Promise<{ charging, level } | null>. Uses navigator.getBattery
 * where present (Chromium); resolves null elsewhere. onChange(battery) fires on charging/level changes.
 */
export async function readBattery ({ nav = globalNav(), onChange = null } = {}) {
  if (!nav || typeof nav.getBattery !== 'function') return null
  try {
    const manager = await nav.getBattery()
    if (!manager) return null
    if (typeof onChange === 'function' && typeof manager.addEventListener === 'function') {
      const fire = () => { try { onChange(normalizeBattery(manager)) } catch (_) { /* listener errors stay local */ } }
      manager.addEventListener('chargingchange', fire)
      manager.addEventListener('levelchange', fire)
    }
    return normalizeBattery(manager)
  } catch (_) {
    return null
  }
}

/** The network class of an environment, also for v0.2 env objects that only carry networkType/saveData. */
export function networkClassOf (env) {
  const e = env || {}
  if (NETWORK_CLASSES.includes(e.networkClass)) return e.networkClass
  if (e.saveData) return 'saveData'
  if (e.networkType === 'wifi') return 'wifi'
  if (e.networkType === 'cellular') return 'cellular'
  return 'unknown'
}

/**
 * policyClass(env) → 'desktop' | 'mobileUnmetered' | 'mobileUnknown' | 'mobileMetered' (v0.2.1 C2).
 * A metered network (cellular or Save-Data) is mobileMetered on any device (v0.2 treated a desktop with
 * Save-Data as cellular too); otherwise a desktop is desktop and a phone is classified by its network.
 */
export function policyClass (env) {
  const e = env || {}
  const net = networkClassOf(e)
  if (net === 'cellular' || net === 'saveData') return 'mobileMetered'
  if (!e.isMobile) return 'desktop'
  return net === 'wifi' ? 'mobileUnmetered' : 'mobileUnknown'
}

/**
 * policyColumn(env, prefs) → the v0.2 column name ('desktop' | 'mobileWifi' | 'cellular'), kept because
 * the drop-in runtime keys its web-seed egress rule on it (src/dropin/rules.js). An unknown phone network
 * counts as cellular until the visitor taps "Share on this network" (prefs.shareOnNetwork, per origin).
 */
export function policyColumn (env, prefs = {}) {
  const cls = policyClass(env)
  if (cls === 'desktop') return 'desktop'
  if (cls === 'mobileUnmetered') return 'mobileWifi'
  if (cls === 'mobileUnknown') return prefs && prefs.shareOnNetwork === true ? 'mobileWifi' : 'cellular'
  return 'cellular'
}

/**
 * computePolicy(env, prefs, config) → {
 *   class, column, maxConns, uploadsEnabled, uploadLimit, maxSiteBytes, storageBudget, hostOnly,
 *   hiddenBehaviour: 'keep'|'destroy'|'battery'   (v0.2 field, still used by the drop-in runtime),
 *   hiddenAction: 'keep'|'lock'|'battery'          (v0.2.1: phones lock uploads at once when hidden),
 *   rebuildAfterHiddenMs, numwant, content: { soft, hard }, rendezvous: { soft, hard }, leaveVersionSwarm,
 *   seedBudget }
 * prefs: { share (default true), hostOnly, shareOnNetwork, pointerMax, uploadLimit (bytes/s) }; the seed budget also
 *   reads declaredWifi, declaredPlugged, seedAsked, phoneDefaultOn and handoffWhileHidden.
 * v0.3 C2 (seed-policy): seedBudget = seedBudget(env, prefs, config) from src/loader/seed-budget.js (the SZ 3.1.3
 * lanes H, K and E; env may add networkProof, dock and call). Every other field is computed exactly as before.
 * Uploads (v0.2.1 C2): on by default only on desktop; every mobile class is download-only until the
 * per-origin opt-in "Share on this network" (prefs.shareOnNetwork), then mobileOptInUploadLimit.
 */
export function computePolicy (env, prefs = {}, config = CONFIG) {
  const p = prefs || {}
  const e = env || {}
  const pol = config.policy
  const cls = policyClass(e)
  const column = policyColumn(e, p)
  const table = pol[cls] || pol.desktop
  const limits = config.limits
  const mobile = cls !== 'desktop'

  // 128 / 48 / 24 MiB by column: an unknown phone network keeps the 24 MiB cap of a metered one until the
  // visitor confirms the network ("Share on this network"); research digest 4.1 row 25 allows 48 MiB there
  // only together with an "ask before downloading more than 16 MiB" card, which v0.2.1 does not have.
  let maxSiteBytes = column === 'desktop' ? limits.maxSiteBytesDesktop : column === 'mobileWifi' ? limits.maxSiteBytesMobile : limits.maxSiteBytesCellular
  const pointerMax = Number(p.pointerMax)
  if (Number.isFinite(pointerMax) && pointerMax > 0) maxSiteBytes = Math.min(maxSiteBytes, Math.floor(pointerMax))

  let uploadLimit = table.uploadLimit || 0
  if (mobile && p.shareOnNetwork === true) uploadLimit = pol.mobileOptInUploadLimit || 131072
  const customLimit = Number(p.uploadLimit)
  if (uploadLimit > 0 && Number.isFinite(customLimit) && customLimit > 0) uploadLimit = Math.min(uploadLimit, Math.floor(customLimit))
  // Shaping only at 32 KiB/s or more: anything lower is raised to the floor, never set to zero.
  if (uploadLimit > 0) uploadLimit = Math.max(uploadLimit, pol.minShapingBytes)

  const hostOnly = p.hostOnly === true
  const uploadsEnabled = !hostOnly && p.share !== false && uploadLimit > 0
  if (!uploadsEnabled) uploadLimit = 0

  let hiddenBehaviour = 'keep'
  if (mobile || e.isMobile) hiddenBehaviour = 'destroy'
  else if (!uploadsEnabled || (e.battery && e.battery.charging === false)) hiddenBehaviour = 'battery'
  const hiddenAction = hiddenBehaviour === 'destroy' ? 'lock' : hiddenBehaviour

  const soft = Math.max(1, table.maxConns || 1)
  const hard = soft + Math.max(1, Math.ceil(soft * (Number(pol.contentHardExtra) || 0.5)))
  const rv = (pol.rendezvous && (mobile || e.isMobile ? pol.rendezvous.mobile : pol.rendezvous.desktop)) || { soft: 3, hard: 5 }

  const deviceClass = deviceClassOf(e)
  return {
    class: cls,
    deviceClass,
    // v0.3 (MF-39): one wire budget per tab across every swarm, by device class (desktop 40, phones 8, chosen).
    wireBudget: wireBudgetFor(deviceClass, config),
    // v0.3 (R 2.8.8, 3.2.3): the ledger's line in the storage budget (64 MiB phones, 256 MiB desktop, chosen).
    ledgerBudget: ledgerBudgetFor(deviceClass, config),
    column,
    maxConns: soft,
    uploadsEnabled,
    uploadLimit,
    maxSiteBytes,
    hiddenBehaviour,
    hiddenAction,
    rebuildAfterHiddenMs: mobile || e.isMobile ? (pol.rebuildAfterHiddenMobileMs || 10000) : (pol.rebuildAfterHiddenMs || 60000),
    storageBudget: e.isMobile ? limits.storageBudgetMobile : limits.storageBudgetDesktop,
    hostOnly,
    numwant: Math.max(0, Math.min(5, table.numwant === undefined ? 3 : table.numwant)),
    content: { soft, hard },
    rendezvous: { soft: rv.soft, hard: rv.hard },
    // §5.5: on a metered or unconfirmed phone network, leave the version swarm once the site is complete
    // and uploads are off; the rendezvous swarm keeps the ledger in sync.
    leaveVersionSwarm: column === 'cellular' && !uploadsEnabled,
    // v0.3 C2 (seed-policy): the per-lane seed budget from the same env and prefs; enforcement is torrent.js's.
    seedBudget: seedBudget(e, p, config)
  }
}

/**
 * watchLifecycle(handlers, { doc, win, now }) → stop()
 * handlers: { onHidden(), onVisible(hiddenForMs), onPageHide(persisted), onPageShow(persisted),
 *   onOnline(), onOffline(), onFreeze(), onResume() }. Handler errors are caught and logged.
 * Hidden time is measured by comparing timestamps (timers do not run while a phone suspends the page).
 * beforeunload and unload are never used (they disable the back/forward cache and are not delivered when
 * a phone discards the page).
 */
export function watchLifecycle (handlers = {}, { doc = (typeof document !== 'undefined' ? document : null), win = globalWin(), now = () => Date.now() } = {}) {
  const h = handlers || {}
  const offs = []
  const call = (name, ...args) => {
    const fn = h[name]
    if (typeof fn !== 'function') return
    try { fn(...args) } catch (err) {
      if (typeof console !== 'undefined') console.error('[mw] lifecycle handler ' + name + ' failed', err)
    }
  }
  const on = (target, type, fn) => {
    if (!target || typeof target.addEventListener !== 'function') return
    target.addEventListener(type, fn)
    offs.push(() => target.removeEventListener(type, fn))
  }
  let hiddenAt = doc && doc.visibilityState === 'hidden' ? now() : null
  let lastState = doc ? doc.visibilityState : 'visible'
  on(doc, 'visibilitychange', () => {
    const state = doc.visibilityState
    if (state === lastState) return
    lastState = state
    if (state === 'hidden') {
      hiddenAt = now()
      call('onHidden')
    } else {
      const after = hiddenAt === null ? 0 : Math.max(0, now() - hiddenAt)
      hiddenAt = null
      call('onVisible', after)
    }
  })
  on(win, 'pagehide', (e) => call('onPageHide', !!(e && e.persisted)))
  on(win, 'pageshow', (e) => call('onPageShow', !!(e && e.persisted)))
  on(win, 'online', () => call('onOnline'))
  on(win, 'offline', () => call('onOffline'))
  on(doc, 'freeze', () => call('onFreeze'))
  on(doc, 'resume', () => call('onResume'))
  return function stop () {
    while (offs.length) {
      const off = offs.pop()
      try { off() } catch (_) { /* already gone */ }
    }
  }
}

/**
 * lifecyclePlan(event, { policy, hiddenFor, suspended, persisted }) → { flush, pause, rebuild, batteryTimer,
 * clearBatteryTimer } (ARCHITECTURE §8; v0.2.1 C2). Phones (hiddenAction 'lock') do not destroy the client
 * when hidden: the TorrentManager choke-locks every wire at once and the OS suspends the page; on return
 * after more than policy.rebuildAfterHiddenMs (10 s on phones, 60 s on desktop), on 'online' and on a
 * back/forward-cache restore the client is destroyed and rebuilt (fresh tracker sockets, re-joined swarms,
 * the ledger re-attached through the 'torrent' event). Hidden time comes from timestamps, never timers.
 * beforeunload and unload are never used.
 */
export function lifecyclePlan (event, { policy = null, hiddenFor = 0, suspended = false, persisted = false } = {}) {
  const p = policy || {}
  const plan = { flush: false, pause: false, rebuild: false, batteryTimer: false, clearBatteryTimer: false }
  const action = p.hiddenAction || (p.hiddenBehaviour === 'destroy' ? 'lock' : p.hiddenBehaviour) || 'keep'
  switch (event) {
    case 'hidden':
      plan.flush = true
      plan.batteryTimer = action === 'battery'
      plan.pause = action === 'destroy'
      break
    case 'visible': {
      plan.clearBatteryTimer = true
      const after = Number(p.rebuildAfterHiddenMs) || CONFIG.policy.rebuildAfterHiddenMs
      plan.rebuild = !!suspended || hiddenFor > after
      break
    }
    case 'pagehide': case 'freeze':
      plan.flush = true
      plan.pause = true
      break
    case 'pageshow':
      plan.rebuild = !!persisted
      break
    case 'online': case 'resume':
      plan.rebuild = true
      break
  }
  return plan
}

/**
 * watchNetwork({ nav, onChange }) → stop() (code review round 1): where navigator.connection exists
 * (Chromium on Android), a change of network (Wi-Fi to mobile data and back, Save-Data) calls
 * onChange(), so the caller detects the environment again and recomputes its policy. Elsewhere it
 * does nothing; the callers also re-detect on 'online' and when the page becomes visible.
 */
export function watchNetwork ({ nav = globalNav(), onChange = null } = {}) {
  const conn = nav && nav.connection && typeof nav.connection.addEventListener === 'function' ? nav.connection : null
  if (!conn || typeof onChange !== 'function') return () => {}
  const fire = () => { try { onChange() } catch (err) { if (typeof console !== 'undefined') console.error('[mw] network change handler failed', err) } }
  conn.addEventListener('change', fire)
  return () => { try { conn.removeEventListener('change', fire) } catch (_) { /* gone */ } }
}

// ---------------------------------------------------------------------------------------------
// v0.3 hardening (harden-loader): one wire budget per tab, storage lines (V03-DESIGN-REVIEW 2.7.1,
// 2.8.8, 3.2.3; MF-39; ARCHITECTURE 15.10)
// ---------------------------------------------------------------------------------------------

/**
 * Swarm kinds in budget priority order (highest first): site > rendezvous > hub > chat > open group > files. 'hub' is the
 * follow lane of a hub page (review round R 5.3, SCALE-6: it joined as 'group' and shared that kind's 4 wires with every
 * open group); while it syncs, the TorrentManager puts it first (hubFirst below).
 */
export const SWARM_PRIORITY = Object.freeze(['site', 'rendezvous', 'hub', 'chat', 'group', 'file'])

/**
 * deviceClassOf(env) → 'desktop' | 'phone'. The wire budget and the storage lines follow the device, not
 * the network: a phone (coarse pointer or mobile UA, as isMobile) is 'phone' on any network; a desktop on a
 * metered network stays 'desktop' (its upload policy is still mobileMetered).
 */
export function deviceClassOf (env) {
  return env && env.isMobile ? 'phone' : 'desktop'
}

function budgetConfig (config) {
  const b = (config && config.wireBudget) || CONFIG.wireBudget
  return {
    desktop: Number(b.desktop) > 0 ? Math.floor(b.desktop) : 40,
    phone: Number(b.phone) > 0 ? Math.floor(b.phone) : 8,
    priority: withHub(Array.isArray(b.priority) && b.priority.length ? b.priority.slice() : SWARM_PRIORITY.slice(), b.hubFirst === true),
    floors: Object.assign({ site: 2, rendezvous: 2, hub: 1, chat: 1, group: 1, file: 1 }, b.floors || {})
  }
}

/** budgetPriority(config) → the swarm kinds in budget priority order, as the budget functions read them (SCALE-6). */
export function budgetPriority (config = CONFIG) {
  return budgetConfig(config).priority
}

// A priority list from a config written before the 'hub' kind gets it after 'rendezvous'; hubFirst (a hub lane is
// syncing, SCALE-6) moves it to the front, so over budget every other swarm gives up wires down to its floor first.
function withHub (list, hubFirst) {
  const out = list.filter((k) => k !== 'hub')
  if (hubFirst) return ['hub'].concat(out)
  const at = out.indexOf('rendezvous')
  out.splice(at >= 0 ? at + 1 : out.length, 0, 'hub')
  return out
}

/**
 * wireBudgetFor(deviceClassOrEnv, config) → the total WebRTC wires one tab may hold across every swarm:
 * 40 on desktop, 8 on phones (chosen; G-SC-2 measures the ceiling). Accepts 'desktop' | 'phone', a policy
 * class ('mobile...' counts as phone) or an env object.
 */
export function wireBudgetFor (deviceClassOrEnv, config = CONFIG) {
  const b = budgetConfig(config)
  let cls = deviceClassOrEnv
  if (cls && typeof cls === 'object') cls = deviceClassOf(cls)
  if (typeof cls === 'string' && cls !== 'desktop') return b.phone
  return b.desktop
}

/**
 * allocateWireBudget(total, demands, config) → { [kind]: wires } (pure). Swarms with a demand (their own
 * cap, or the wires they want) get, in priority order, first their floor (site 2, rendezvous 2, chat,
 * group and files 1 each) while the budget lasts, then the rest up to their demand, highest priority
 * first. Kinds without a demand get 0. The sum never exceeds `total`.
 */
export function allocateWireBudget (total, demands = {}, config = CONFIG) {
  const b = budgetConfig(config)
  const out = {}
  let left = Math.max(0, Math.floor(Number(total) || 0))
  const want = (k) => Math.max(0, Math.floor(Number(demands && demands[k]) || 0))
  const kinds = b.priority.concat(Object.keys(demands || {}).filter((k) => b.priority.indexOf(k) < 0))
  for (const k of kinds) out[k] = 0
  for (const k of kinds) {
    const n = Math.min(want(k), Math.max(0, Math.floor(Number(b.floors[k]) || 0)), left)
    out[k] += n
    left -= n
  }
  for (const k of kinds) {
    const n = Math.min(want(k) - out[k], left)
    out[k] += n
    left -= n
  }
  return out
}

/**
 * budgetVictim(counts, total, config) → the swarm kind that must give up one wire, or null when the
 * counted wires fit the budget (pure). Over budget, the lowest priority swarm that holds more than its
 * floor loses a wire; when every swarm is at or below its floor, the lowest priority swarm with a wire.
 */
export function budgetVictim (counts = {}, total = 40, config = CONFIG) {
  const b = budgetConfig(config)
  const kinds = b.priority.concat(Object.keys(counts || {}).filter((k) => b.priority.indexOf(k) < 0))
  const n = (k) => Math.max(0, Math.floor(Number(counts && counts[k]) || 0))
  let used = 0
  for (const k of kinds) used += n(k)
  if (used <= total) return null
  for (let i = kinds.length - 1; i >= 0; i--) {
    const k = kinds[i]
    if (n(k) > Math.max(0, Number(b.floors[k]) || 0)) return k
  }
  for (let i = kinds.length - 1; i >= 0; i--) if (n(kinds[i]) > 0) return kinds[i]
  return null
}

/** ledgerBudgetFor(deviceClassOrEnv, config) → bytes a ledger may take in the storage budget (64 MiB phones, 256 MiB desktop, chosen). */
export function ledgerBudgetFor (deviceClassOrEnv, config = CONFIG) {
  const s = (config && config.storageBudget) || CONFIG.storageBudget
  let cls = deviceClassOrEnv
  if (cls && typeof cls === 'object') cls = deviceClassOf(cls)
  return typeof cls === 'string' && cls !== 'desktop' ? s.ledgerPhone : s.ledgerDesktop
}

/**
 * storageLines({ deviceClass, total, siteBytes, ledgerBytes }, config) → { total, site, ledgerMax, ledger,
 * filesMax } (R 2.8.8, pure). total defaults to the device's storage budget (limits.storageBudget*); the
 * ledger may use up to ledgerBudgetFor(deviceClass) (and never more than what the site leaves); files get
 * at most filesShare (50 percent) of what remains after the site and its ledger, LRU across files.
 */
export function storageLines ({ deviceClass = 'desktop', total = null, siteBytes = 0, ledgerBytes = 0 } = {}, config = CONFIG) {
  const limits = config.limits || CONFIG.limits
  const share = Number(((config.storageBudget || CONFIG.storageBudget) || {}).filesShare)
  const phone = deviceClass !== 'desktop'
  const t = Number.isFinite(Number(total)) && Number(total) > 0 ? Math.floor(Number(total)) : (phone ? limits.storageBudgetMobile : limits.storageBudgetDesktop)
  const site = Math.max(0, Math.floor(Number(siteBytes) || 0))
  const ledger = Math.max(0, Math.floor(Number(ledgerBytes) || 0))
  const ledgerMax = Math.max(0, Math.min(ledgerBudgetFor(phone ? 'phone' : 'desktop', config), t - site))
  const remaining = Math.max(0, t - site - Math.min(ledger, ledgerMax))
  return { total: t, site, ledgerMax, ledger, filesMax: Math.floor(remaining * (Number.isFinite(share) && share >= 0 && share <= 1 ? share : 0.5)) }
}
