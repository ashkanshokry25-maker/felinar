// Unit tests for src/loader/dock.js (v0.3 C2, seed-policy lane; SEEDING-AND-ZERO-SETUP-DESIGN.md 3.1.4, S1 D3):
// dock mode takes a screen Wake Lock from a click and nothing else, and ends on hide, unplug, a battery under 20%,
// its time limit (2 hours by default, 8 at most) or the person; without a battery API it needs the person's word.
// Run: node --test test/unit/dock.test.mjs
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import { createDock } from '../../src/loader/dock.js'
import { CONFIG } from '../../src/loader/config.js'

const ROOT = fileURLToPath(new URL('../../', import.meta.url))
const HOUR = 3600000

class FakeSentinel extends EventTarget {
  constructor () { super(); this.released = false; this.type = 'screen' }
  release () {
    if (!this.released) { this.released = true; this.dispatchEvent(new Event('release')) }
    return Promise.resolve()
  }
}

class FakeBattery extends EventTarget {
  constructor (charging = true, level = 0.8) { super(); this.charging = charging; this.level = level }
}

function fakeClock (start = 1000000) {
  let t = start
  let seq = 0
  const timers = new Map()
  return {
    now: () => t,
    setTimeout: (fn, ms) => { const id = ++seq; timers.set(id, { fn, at: t + ms }); return id },
    clearTimeout: (id) => { timers.delete(id) },
    advance (ms) {
      t += ms
      for (const [id, x] of Array.from(timers)) if (x.at <= t && timers.has(id)) { timers.delete(id); x.fn() }
    },
    fire () { for (const [id, x] of Array.from(timers)) { timers.delete(id); x.fn() } },
    pending: () => timers.size,
    set (v) { t = v }
  }
}

// lazy: pass battery undefined to createDock (look it up with nav.getBattery at start); a destructuring default
// would replace an explicit undefined.
function setup ({ battery = new FakeBattery(), lazy = false, wakeLock = true, reject = false, throws = false, getBattery = null } = {}) {
  const clock = fakeClock()
  const doc = Object.assign(new EventTarget(), { visibilityState: 'visible' })
  const requests = []
  const sentinels = []
  const nav = {}
  if (wakeLock) {
    nav.wakeLock = {
      request (type) {
        requests.push(type)
        if (throws) throw new Error('NotAllowedError')
        if (reject) return Promise.reject(Object.assign(new Error('denied'), { name: 'NotAllowedError' }))
        const s = new FakeSentinel()
        sentinels.push(s)
        return Promise.resolve(s)
      }
    }
  }
  if (getBattery) nav.getBattery = getBattery
  const dock = createDock({ nav, doc, now: clock.now, setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout, battery: lazy ? undefined : battery, config: CONFIG })
  const events = []
  dock.on('start', (s) => events.push(['start', s.reason, s.on]))
  dock.on('stop', (s) => events.push(['stop', s.reason, s.on]))
  return { dock, doc, nav, clock, requests, sentinels, events, battery }
}

const hide = (doc) => { doc.visibilityState = 'hidden'; doc.dispatchEvent(new Event('visibilitychange')) }

test('supported() needs navigator.wakeLock.request', () => {
  assert.equal(setup().dock.supported(), true)
  assert.equal(setup({ wakeLock: false }).dock.supported(), false)
  assert.equal(createDock({ nav: null, doc: null }).supported(), false)
  assert.equal(createDock({ nav: { wakeLock: {} }, doc: null }).supported(), false)
})

test('start from a click: one screen Wake Lock, 2 hours by default, at most 8, the start event', async () => {
  const { dock, clock, requests, events } = setup()
  const s = await dock.start()
  assert.deepEqual(s, { on: true, until: clock.now() + 2 * HOUR, reason: null, declared: false })
  assert.deepEqual(requests, ['screen'])
  assert.deepEqual(events, [['start', null, true]])
  assert.deepEqual(dock.state(), s)
  assert.equal(clock.pending(), 1, 'one timer for the time limit')
  const long = setup()
  assert.equal((await long.dock.start({ ms: 20 * HOUR })).until, long.clock.now() + 8 * HOUR, 'capped at dockCapMs')
  const short = setup()
  assert.equal((await short.dock.start({ ms: HOUR })).until, short.clock.now() + HOUR)
  const junk = setup()
  assert.equal((await junk.dock.start({ ms: -5 })).until, junk.clock.now() + 2 * HOUR)
})

test('stop reasons: hidden, unplugged, battery, cap, user, released; each releases the lock once and removes its listeners', async () => {
  const cases = [
    ['hidden', (x) => hide(x.doc)],
    ['unplugged', (x) => { x.battery.charging = false; x.battery.dispatchEvent(new Event('chargingchange')) }],
    ['battery', (x) => { x.battery.level = 0.19; x.battery.dispatchEvent(new Event('levelchange')) }],
    ['cap', (x) => x.clock.advance(2 * HOUR)],
    ['user', (x) => x.dock.stop()],
    ['released', (x) => x.sentinels[0].release()]
  ]
  for (const [reason, act] of cases) {
    const x = setup()
    await x.dock.start()
    act(x)
    assert.deepEqual(x.dock.state(), { on: false, until: null, reason, declared: false }, reason)
    assert.equal(x.sentinels[0].released, true, reason + ': lock released')
    assert.deepEqual(x.events, [['start', null, true], ['stop', reason, false]], reason)
    hide(x.doc)
    x.battery.charging = false
    x.battery.dispatchEvent(new Event('chargingchange'))
    x.clock.fire()
    assert.equal(x.events.length, 2, reason + ': nothing fires after the stop')
    assert.equal(x.clock.pending(), 0, reason + ': no timer left')
    assert.deepEqual(x.dock.stop(), x.dock.state(), 'stop() again changes nothing')
    assert.equal(x.events.length, 2)
  }
})

test('the time limit: a timer that fires early reschedules; a level change above the floor or a charging change to plugged does not stop', async () => {
  const x = setup()
  await x.dock.start({ ms: HOUR })
  x.clock.advance(30 * 60000)
  x.battery.level = 0.5
  x.battery.dispatchEvent(new Event('levelchange'))
  x.battery.dispatchEvent(new Event('chargingchange'))
  assert.equal(x.dock.state().on, true)
  x.clock.set(x.clock.now() - 60000)
  x.clock.fire()
  assert.equal(x.dock.state().on, true, 'the clock says the hour is not over')
  assert.equal(x.clock.pending(), 1)
  x.clock.advance(HOUR)
  assert.equal(x.dock.state().reason, 'cap')
})

test('start is refused when it cannot run safely, with the reason, and never rejects', async () => {
  const refusals = [
    ['unsupported', { wakeLock: false }, {}],
    ['unplugged', { battery: new FakeBattery(false, 0.9) }, {}],
    ['battery', { battery: new FakeBattery(true, 0.1) }, {}],
    ['declare', { battery: null }, {}],
    ['denied', { reject: true }, {}],
    ['denied', { throws: true }, {}]
  ]
  for (const [reason, opts, startOpts] of refusals) {
    const x = setup(opts)
    const s = await x.dock.start(startOpts)
    assert.deepEqual(s, { on: false, until: null, reason, declared: false }, reason)
    assert.deepEqual(x.events, [], reason + ': no start event')
    assert.equal(x.clock.pending(), 0)
    for (const sen of x.sentinels) assert.equal(sen.released, true)
  }
  const hidden = setup()
  hidden.doc.visibilityState = 'hidden'
  assert.equal((await hidden.dock.start()).reason, 'hidden')
  assert.deepEqual(hidden.requests, [], 'a hidden page asks for nothing')
  const noBattery = setup({ battery: new FakeBattery(false, 0.9) })
  await noBattery.dock.start()
  assert.deepEqual(noBattery.requests, [], 'a known unplug asks for nothing')
})

test('without a battery API dock mode runs on the person\'s word ("plugged in, on Wi-Fi") and cannot notice an unplug', async () => {
  const x = setup({ battery: null })
  const s = await x.dock.start({ declared: true })
  assert.equal(s.on, true)
  assert.equal(s.declared, true)
  hide(x.doc)
  assert.equal(x.dock.state().reason, 'hidden', 'hiding still ends it')
})

test('a lazy battery lookup: the lock is requested inside the click, before any await', async () => {
  const mgr = new FakeBattery(true, 0.9)
  const x = setup({ lazy: true, getBattery: async () => mgr })
  const p = x.dock.start()
  assert.deepEqual(x.requests, ['screen'], 'requested synchronously')
  const s = await p
  assert.equal(s.on, true)
  mgr.charging = false
  mgr.dispatchEvent(new Event('chargingchange'))
  assert.equal(x.dock.state().reason, 'unplugged', 'the looked-up manager is watched')

  const low = setup({ lazy: true, getBattery: async () => new FakeBattery(true, 0.05) })
  assert.equal((await low.dock.start()).reason, 'battery')
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(low.sentinels[0].released, true, 'the lock taken for the click is given back')

  const none = setup({ lazy: true })
  assert.equal((await none.dock.start()).reason, 'declare', 'no getBattery: the person must declare')
  const declared = setup({ lazy: true })
  assert.equal((await declared.dock.start({ declared: true })).on, true)
  const failing = setup({ lazy: true, getBattery: async () => { throw new Error('blocked') } })
  assert.equal((await failing.dock.start({ declared: true })).on, true, 'a failing lookup counts as no battery API')
})

test('a second click while the lock is pending gets the same answer; stop() while pending cancels the start', async () => {
  const x = setup()
  const a = x.dock.start()
  const b = x.dock.start()
  assert.equal(a, b)
  await a
  assert.deepEqual(x.requests, ['screen'], 'one lock')

  const y = setup()
  const p = y.dock.start()
  const st = y.dock.stop()
  assert.equal(st.on, false)
  const s = await p
  assert.deepEqual(s, { on: false, until: null, reason: 'user', declared: false })
  assert.equal(y.sentinels[0].released, true)
  assert.deepEqual(y.events, [], 'it never started')
  assert.equal(y.clock.pending(), 0)
})

test('start while on sets a new time limit from now and keeps the same lock; listeners unsubscribe', async () => {
  const x = setup()
  let starts = 0
  const off = x.dock.on('start', () => { starts++ })
  await x.dock.start({ ms: HOUR })
  x.clock.advance(30 * 60000)
  const s = await x.dock.start({ ms: 2 * HOUR, declared: true })
  assert.equal(s.until, x.clock.now() + 2 * HOUR)
  assert.equal(s.declared, true)
  assert.deepEqual(x.requests, ['screen'])
  assert.equal(starts, 2)
  off()
  await x.dock.start()
  assert.equal(starts, 2)
  assert.equal(typeof x.dock.on('nope', () => {}), 'function')
  x.dock.on('stop', () => { throw new Error('listener bug') })
  const errors = []
  const orig = console.error
  console.error = (...a) => errors.push(a)
  try { x.dock.stop() } finally { console.error = orig }
  assert.equal(x.dock.state().reason, 'user', 'a throwing listener does not stop the stop')
  assert.equal(errors.length, 1)
})

test('dock mode keeps the screen on with Wake Lock only: no audio, media element, media session or audio session', () => {
  const code = readFileSync(ROOT + 'src/loader/dock.js', 'utf8').replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '')
  assert.doesNotMatch(code, /\bAudio\b|AudioContext|createElement|\.play\s*\(|mediaSession|audioSession|getUserMedia|\.loop\b/)
  assert.match(code, /wakeLock\.request\('screen'\)/)
})
