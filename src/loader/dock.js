// src/loader/dock.js: dock mode, "Keep this screen on and share for 2 hours" (v0.3 C2, seed-policy lane;
// docs/research/v03/SEEDING-AND-ZERO-SETUP-DESIGN.md 3.1.4, S1 D3).
//
// A phone on a charger keeps its page open and visible with the Screen Wake Lock API, and only that: no audio, no
// media element and no other keep-alive (SZ 3.1.9; telling the operating system that media plays when none does
// is a dark pattern, S1 F3). A browser suspends a hidden page whatever a page does, so dock mode ends when the page
// is hidden; it also ends on unplug or a battery under dockMinBattery where the Battery Status API exists
// (Chromium), at its time limit (2 hours by default, at most dockCapMs = 8 hours, chosen) and when the person stops
// it. Where the browser cannot read the battery (iOS, Firefox), dock mode starts only on the person's declaration
// "plugged in, on Wi-Fi" (declared: true) and cannot notice an unplug.
//
// Every browser global comes in through createDock's arguments (or is looked up lazily), so Node 22 runs it with
// fakes. Wake Lock requests live here and in src/calls/session.js only (test/unit/lint-contrib.test.mjs).

import { CONFIG } from './config.js'

const MAX_TIMER_MS = 2147483647

function globalNav () { return typeof navigator !== 'undefined' ? navigator : null }
function globalDoc () { return typeof document !== 'undefined' ? document : null }
function globalSetTimeout () { return typeof setTimeout === 'function' ? setTimeout : null }
function globalClearTimeout () { return typeof clearTimeout === 'function' ? clearTimeout : null }

/**
 * createDock({ nav, doc, now, setTimeout, clearTimeout, battery, config }) → {
 *   supported() → boolean (navigator.wakeLock.request exists),
 *   start({ ms, declared }) → Promise<state>: call it from a click; resolves with on: true, or on: false and a
 *     reason ('unsupported', 'hidden', 'declare', 'unplugged', 'battery', 'denied', 'user' when stop() came first);
 *     it never rejects. While on, start() again sets a new time limit from now.
 *   stop(reason = 'user') → state,
 *   state() → { on, until, reason, declared } (until: epoch ms; reason: why the last run ended or did not start),
 *   on('start' | 'stop', fn(state)) → unsubscribe }
 * Stop reasons: 'hidden' (the page was hidden), 'unplugged', 'battery' (below dockMinBattery), 'cap' (the time
 * limit), 'user', 'released' (the browser released the lock while the page stayed visible).
 * battery: a BatteryManager (or any EventTarget with charging and level), null when the browser has none, or
 * undefined to ask nav.getBattery() at start.
 */
export function createDock ({
  nav = globalNav(), doc = globalDoc(), now = () => Date.now(),
  setTimeout: setT = globalSetTimeout(), clearTimeout: clearT = globalClearTimeout(),
  battery = undefined, config = CONFIG
} = {}) {
  const seed = (config && config.seed) || CONFIG.seed
  const num = (v, d) => { const n = Number(v); return Number.isFinite(n) && n > 0 ? n : d }
  const defaultMs = num(seed.dockDefaultMs, CONFIG.seed.dockDefaultMs)
  const capMs = num(seed.dockCapMs, CONFIG.seed.dockCapMs)
  const minBattery = Number.isFinite(Number(seed.dockMinBattery)) ? Number(seed.dockMinBattery) : CONFIG.seed.dockMinBattery
  const clock = typeof now === 'function' ? now : () => Date.now()

  let st = { on: false, until: null, reason: null, declared: false }
  let gen = 0 // bumped by every start and stop, so a start still waiting for its lock knows it was overtaken
  let sentinel = null
  let manager = null
  let timer = null
  let releasing = false
  let pendingStart = null
  const offs = []
  const listeners = { start: new Set(), stop: new Set() }

  const copy = () => ({ on: st.on, until: st.until, reason: st.reason, declared: st.declared })
  const emit = (type) => {
    const s = copy()
    for (const fn of Array.from(listeners[type] || [])) {
      try { fn(s) } catch (err) { if (typeof console !== 'undefined') console.error('[mw] dock ' + type + ' listener failed', err) }
    }
  }
  const listen = (target, type, fn) => {
    if (!target || typeof target.addEventListener !== 'function') return
    target.addEventListener(type, fn)
    offs.push(() => { try { target.removeEventListener(type, fn) } catch (_) { /* gone */ } })
  }
  const hidden = () => !!(doc && doc.visibilityState === 'hidden')
  const durationOf = (ms) => Math.min(num(ms, defaultMs), capMs)
  const batteryProblem = (m) => {
    if (!m) return null
    if (m.charging === false) return 'unplugged'
    const level = Number(m.level)
    if (Number.isFinite(level) && level < minBattery) return 'battery'
    return null
  }
  const releaseLock = (s) => {
    if (!s || typeof s.release !== 'function') return
    try {
      const r = s.release()
      if (r && typeof r.then === 'function') r.then(null, () => {})
    } catch (_) { /* already released */ }
  }

  function supported () {
    return !!(nav && nav.wakeLock && typeof nav.wakeLock.request === 'function')
  }

  function clearTimer () {
    if (timer !== null && typeof clearT === 'function') { try { clearT(timer) } catch (_) { /* gone */ } }
    timer = null
  }

  function schedule () {
    clearTimer()
    if (!st.on || typeof setT !== 'function') return
    const wait = Math.max(0, Math.min(MAX_TIMER_MS, st.until - clock()))
    timer = setT(() => {
      timer = null
      if (!st.on) return
      if (clock() >= st.until) stop('cap')
      else schedule()
    }, wait)
  }

  function stop (reason = 'user') {
    gen++
    if (!st.on) {
      // A start still waiting for its lock is cancelled; it resolves with this reason.
      if (pendingStart) st = { on: false, until: null, reason: String(reason || 'user'), declared: false }
      return copy()
    }
    const s = sentinel
    sentinel = null
    manager = null
    clearTimer()
    while (offs.length) offs.pop()()
    releasing = true
    releaseLock(s)
    releasing = false
    st = { on: false, until: null, reason: String(reason || 'user'), declared: false }
    emit('stop')
    return copy()
  }

  function refuse (reason) {
    st = { on: false, until: null, reason, declared: false }
    return copy()
  }

  function start (opts = {}) {
    if (st.on) {
      const { ms, declared = false } = opts || {}
      st = { on: true, until: clock() + durationOf(ms), reason: null, declared: st.declared || declared === true }
      schedule()
      emit('start')
      return Promise.resolve(copy())
    }
    // A second click while the first start waits for its lock gets the same answer.
    if (pendingStart) return pendingStart
    const p = begin(opts || {})
    pendingStart = p
    const done = () => { if (pendingStart === p) pendingStart = null }
    p.then(done, done)
    return p
  }

  async function begin ({ ms, declared = false }) {
    const my = ++gen
    if (!supported()) return refuse('unsupported')
    if (hidden()) return refuse('hidden')
    let m = battery
    if (m && typeof m === 'object') {
      const problem = batteryProblem(m)
      if (problem) return refuse(problem)
    } else if (m === null && declared !== true) {
      return refuse('declare')
    }
    // The request goes out before any await, inside the click that started dock mode.
    let pending
    try { pending = Promise.resolve(nav.wakeLock.request('screen')) } catch (_) { return refuse('denied') }
    if (m === undefined) {
      m = null
      if (nav && typeof nav.getBattery === 'function') {
        try { m = (await nav.getBattery()) || null } catch (_) { m = null }
      }
      const problem = my !== gen ? null : m ? batteryProblem(m) : (declared === true ? null : 'declare')
      if (my !== gen || problem) {
        pending.then(releaseLock, () => {})
        return my !== gen ? copy() : refuse(problem)
      }
    }
    let s
    try { s = await pending } catch (_) { return my !== gen ? copy() : refuse('denied') }
    if (my !== gen) { releaseLock(s); return copy() }
    if (hidden()) { releaseLock(s); return refuse('hidden') }
    sentinel = s
    manager = m && typeof m === 'object' ? m : null
    st = { on: true, until: clock() + durationOf(ms), reason: null, declared: declared === true }
    listen(doc, 'visibilitychange', () => { if (hidden()) stop('hidden') })
    if (manager) {
      const check = () => { const problem = batteryProblem(manager); if (problem) stop(problem) }
      listen(manager, 'chargingchange', check)
      listen(manager, 'levelchange', check)
    }
    listen(s, 'release', () => { if (!releasing && st.on && sentinel === s) stop(hidden() ? 'hidden' : 'released') })
    schedule()
    emit('start')
    return copy()
  }

  function on (type, fn) {
    if (!listeners[type] || typeof fn !== 'function') return () => {}
    listeners[type].add(fn)
    return () => listeners[type].delete(fn)
  }

  return { supported, start, stop, state: copy, on }
}
