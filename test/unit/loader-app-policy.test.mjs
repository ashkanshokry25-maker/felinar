// Unit tests for src/loader/policy.js and the shell's lifecycle plan (ARCHITECTURE §8; v0.2.1
// DIGEST-AMENDMENTS B6, C2; research digest 2.4, w1-08 Mobile policy v1).
// Run: node --test test/unit/loader-app-policy.test.mjs
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import {
  classifyNetwork, networkTypeOf, detectEnvironment, policyClass, policyColumn, computePolicy, watchLifecycle,
  NETWORK_CLASSES, POLICY_CLASSES
} from '../../src/loader/policy.js'
import { lifecyclePlan } from '../../src/loader/app.js'
import { CONFIG } from '../../src/loader/config.js'
import { seedBudget } from '../../src/loader/seed-budget.js'

const ROOT = fileURLToPath(new URL('../../', import.meta.url))
const IPHONE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148'
const MAC = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15'

const env = (isMobile, connection) => detectEnvironment({ nav: { userAgent: isMobile ? IPHONE : MAC, connection, onLine: true }, win: null })

test('four-class network classifier: wifi, cellular, unknown, saveData; Save-Data wins', () => {
  assert.deepEqual(NETWORK_CLASSES, ['wifi', 'cellular', 'unknown', 'saveData'])
  assert.equal(classifyNetwork({ type: 'wifi' }), 'wifi')
  assert.equal(classifyNetwork({ type: 'ethernet' }), 'wifi')
  for (const type of ['cellular', 'bluetooth', 'other', 'mixed', 'none', 'wimax']) assert.equal(classifyNetwork({ type }), 'cellular', type)
  assert.equal(classifyNetwork({ type: 'unknown' }), 'unknown')
  assert.equal(classifyNetwork({ effectiveType: '4g' }), 'unknown', 'desktop Chromium exposes only effectiveType')
  assert.equal(classifyNetwork(null), 'unknown', 'iOS, Firefox and most WebViews have no API')
  assert.equal(classifyNetwork({ type: 'wifi', saveData: true }), 'saveData')
  assert.equal(networkTypeOf({ type: 'bluetooth' }), 'cellular')
})

test('mozConnection and webkitConnection are never read', () => {
  const e = detectEnvironment({ nav: { userAgent: IPHONE, mozConnection: { type: 'wifi' }, webkitConnection: { type: 'wifi' } }, win: null })
  assert.equal(e.networkClass, 'unknown')
  assert.equal(e.networkType, 'unknown')
  const src = readFileSync(ROOT + 'src/loader/policy.js', 'utf8').replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '')
  assert.doesNotMatch(src, /mozConnection|webkitConnection/)
})

test('policy classes: desktop, mobileUnmetered, mobileUnknown, mobileMetered; a metered network is metered on any device', () => {
  assert.deepEqual(POLICY_CLASSES, ['desktop', 'mobileUnmetered', 'mobileUnknown', 'mobileMetered'])
  assert.equal(policyClass(env(false, { type: 'wifi' })), 'desktop')
  assert.equal(policyClass(env(false, null)), 'desktop')
  assert.equal(policyClass(env(true, { type: 'wifi' })), 'mobileUnmetered')
  assert.equal(policyClass(env(true, null)), 'mobileUnknown')
  assert.equal(policyClass(env(true, { type: 'cellular' })), 'mobileMetered')
  assert.equal(policyClass(env(false, { type: 'wifi', saveData: true })), 'mobileMetered')
  // v0.2 env objects (no networkClass) still classify.
  assert.equal(policyClass({ isMobile: true, networkType: 'cellular', saveData: false }), 'mobileMetered')
})

test('C2: uploads are off by default on every mobile class; the per-origin opt-in turns them on at 128 KiB/s', () => {
  const desktop = computePolicy(env(false, null), {})
  assert.equal(desktop.uploadsEnabled, true)
  assert.equal(desktop.uploadLimit, 1048576)
  for (const conn of [{ type: 'wifi' }, null, { type: 'cellular' }, { type: 'wifi', saveData: true }]) {
    const p = computePolicy(env(true, conn), {})
    assert.equal(p.uploadsEnabled, false, JSON.stringify(conn))
    assert.equal(p.uploadLimit, 0)
    const opted = computePolicy(env(true, conn), { shareOnNetwork: true })
    assert.equal(opted.uploadsEnabled, true, 'opt-in ' + JSON.stringify(conn))
    assert.equal(opted.uploadLimit, CONFIG.policy.mobileOptInUploadLimit)
    assert.equal(computePolicy(env(true, conn), { shareOnNetwork: true, share: false }).uploadsEnabled, false, 'Share Off wins')
    assert.equal(computePolicy(env(true, conn), { shareOnNetwork: true, hostOnly: true }).uploadsEnabled, false, 'host only wins')
  }
})

test('C2: caps 128 / 48 / 24 MiB (an unknown phone network keeps 24 MiB until confirmed); pointer max lowers them', () => {
  assert.equal(computePolicy(env(false, null), {}).maxSiteBytes, 128 * 1048576)
  assert.equal(computePolicy(env(true, { type: 'wifi' }), {}).maxSiteBytes, 48 * 1048576)
  assert.equal(computePolicy(env(true, null), {}).maxSiteBytes, 24 * 1048576)
  assert.equal(computePolicy(env(true, null), { shareOnNetwork: true }).maxSiteBytes, 48 * 1048576)
  assert.equal(computePolicy(env(true, { type: 'cellular' }), {}).maxSiteBytes, 24 * 1048576)
  assert.equal(computePolicy(env(false, null), { pointerMax: 1000 }).maxSiteBytes, 1000)
  assert.equal(computePolicy(env(false, null), { pointerMax: 1e12 }).maxSiteBytes, 128 * 1048576, 'never raised')
})

test('C2: phones lock uploads when hidden (hiddenAction lock) and rebuild after more than 10 s; desktop keeps 60 s', () => {
  const phone = computePolicy(env(true, { type: 'wifi' }), {})
  assert.equal(phone.hiddenAction, 'lock')
  assert.equal(phone.hiddenBehaviour, 'destroy', 'v0.2 field kept for the drop-in runtime')
  assert.equal(phone.rebuildAfterHiddenMs, 10000)
  const desk = computePolicy(env(false, null), {})
  assert.equal(desk.hiddenAction, 'keep')
  assert.equal(desk.rebuildAfterHiddenMs, 60000)
  const onBattery = computePolicy(detectEnvironment({ nav: { userAgent: MAC }, win: null, battery: { charging: false, level: 0.4 } }), {})
  assert.equal(onBattery.hiddenAction, 'battery')
})

test('B6: per-swarm caps and numwant: content soft = maxConns (30/8/6/4), hard = soft + ceil(soft/2); rendezvous 6/9 desktop, 3/5 mobile', () => {
  const desk = computePolicy(env(false, null), {})
  assert.deepEqual([desk.maxConns, desk.content.soft, desk.content.hard], [30, 30, 45])
  assert.deepEqual(desk.rendezvous, { soft: 6, hard: 9 })
  assert.equal(desk.numwant, 3)
  const unmetered = computePolicy(env(true, { type: 'wifi' }), {})
  assert.deepEqual([unmetered.maxConns, unmetered.content.hard], [8, 12])
  assert.deepEqual(unmetered.rendezvous, { soft: 3, hard: 5 })
  assert.equal(computePolicy(env(true, null), {}).maxConns, 6)
  const metered = computePolicy(env(true, { type: 'cellular' }), {})
  assert.deepEqual([metered.maxConns, metered.numwant], [4, 2])
  assert.deepEqual(metered.rendezvous, { soft: 3, hard: 5 })
})

test('the v0.2 column stays for the drop-in web-seed rule: unknown phones count as cellular until "Share on this network"', () => {
  assert.equal(policyColumn(env(false, null)), 'desktop')
  assert.equal(policyColumn(env(true, { type: 'wifi' })), 'mobileWifi')
  assert.equal(policyColumn(env(true, null)), 'cellular')
  assert.equal(policyColumn(env(true, null), { shareOnNetwork: true }), 'mobileWifi')
  assert.equal(policyColumn(env(true, { type: 'cellular' }), { shareOnNetwork: true }), 'cellular')
  assert.equal(computePolicy(env(true, null), {}).leaveVersionSwarm, true)
})

test('watchLifecycle measures hidden time with timestamps and never listens to beforeunload or unload', () => {
  const types = []
  const doc = Object.assign(new EventTarget(), { visibilityState: 'visible' })
  const win = new EventTarget()
  const origAdd = win.addEventListener.bind(win)
  win.addEventListener = (t, fn) => { types.push(t); return origAdd(t, fn) }
  let now = 1000
  const seen = []
  const stop = watchLifecycle({ onHidden: () => seen.push('hidden'), onVisible: (ms) => seen.push(['visible', ms]), onPageShow: (p) => seen.push(['pageshow', p]) }, { doc, win, now: () => now })
  doc.visibilityState = 'hidden'
  doc.dispatchEvent(new Event('visibilitychange'))
  now += 12345
  doc.visibilityState = 'visible'
  doc.dispatchEvent(new Event('visibilitychange'))
  win.dispatchEvent(Object.assign(new Event('pageshow'), { persisted: true }))
  assert.deepEqual(seen, ['hidden', ['visible', 12345], ['pageshow', true]])
  assert.ok(!types.includes('beforeunload') && !types.includes('unload'))
  stop()
  for (const file of ['src/loader/app.js', 'src/loader/policy.js', 'src/loader/torrent.js']) {
    const code = readFileSync(ROOT + file, 'utf8').replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '')
    assert.doesNotMatch(code, /['"](beforeunload|unload)['"]/, file + ' listens to unload')
  }
})

test('lifecyclePlan (C2): phones never pause on hidden; visible after more than 10 s, online and a bfcache restore rebuild', () => {
  const phone = computePolicy(env(true, { type: 'wifi' }), {})
  assert.deepEqual(lifecyclePlan('hidden', { policy: phone }), { flush: true, pause: false, rebuild: false, batteryTimer: false, clearBatteryTimer: false })
  assert.equal(lifecyclePlan('visible', { policy: phone, hiddenFor: 9000 }).rebuild, false)
  assert.equal(lifecyclePlan('visible', { policy: phone, hiddenFor: 10001 }).rebuild, true)
  assert.equal(lifecyclePlan('online', { policy: phone }).rebuild, true)
  assert.equal(lifecyclePlan('pageshow', { policy: phone, persisted: true }).rebuild, true)
  assert.equal(lifecyclePlan('pageshow', { policy: phone, persisted: false }).rebuild, false)
  assert.deepEqual(lifecyclePlan('pagehide', { policy: phone }), { flush: true, pause: true, rebuild: false, batteryTimer: false, clearBatteryTimer: false })
  const desk = computePolicy(env(false, null), {})
  assert.equal(lifecyclePlan('visible', { policy: desk, hiddenFor: 30000 }).rebuild, false)
  assert.equal(lifecyclePlan('visible', { policy: desk, hiddenFor: 60001 }).rebuild, true)
  assert.equal(lifecyclePlan('visible', { policy: desk, hiddenFor: 0, suspended: true }).rebuild, true, 'a paused client always comes back')
  const battery = computePolicy(detectEnvironment({ nav: { userAgent: MAC }, win: null, battery: { charging: false, level: 0.4 } }), {})
  assert.equal(lifecyclePlan('hidden', { policy: battery }).batteryTimer, true)
})

test('code review round 1: watchNetwork re-runs detection on navigator.connection "change" (Wi-Fi to mobile data), stop() ends it', async () => {
  const { watchNetwork, detectEnvironment, computePolicy } = await import('../../src/loader/policy.js')
  const conn = new EventTarget()
  conn.type = 'wifi'
  const nav = { userAgent: 'Mozilla/5.0 (Linux; Android 14) Mobile', connection: conn, onLine: true }
  const win = { matchMedia: () => ({ matches: true }) }
  let policy = computePolicy(detectEnvironment({ nav, win }), {})
  assert.equal(policy.column, 'mobileWifi')
  assert.equal(policy.maxSiteBytes, 50331648)
  let calls = 0
  const stop = watchNetwork({ nav, onChange: () => { calls++; policy = computePolicy(detectEnvironment({ nav, win }), {}) } })
  conn.type = 'cellular'
  conn.dispatchEvent(new Event('change'))
  assert.equal(calls, 1)
  assert.equal(policy.column, 'cellular', 'the metered policy applies at once')
  assert.equal(policy.maxSiteBytes, 25165824, '24 MiB instead of 48 MiB')
  assert.equal(policy.leaveVersionSwarm, true)
  stop()
  conn.type = 'wifi'
  conn.dispatchEvent(new Event('change'))
  assert.equal(calls, 1, 'stopped')
  assert.equal(typeof watchNetwork({ nav: { connection: null }, onChange: () => {} }), 'function', 'no Network Information API: a no-op')
})

test('v0.3 C2 (seed-policy): computePolicy adds seedBudget from the same env and prefs; every other field is unchanged', () => {
  const V03_KEYS = ['class', 'deviceClass', 'wireBudget', 'ledgerBudget', 'column', 'maxConns', 'uploadsEnabled', 'uploadLimit', 'maxSiteBytes',
    'hiddenBehaviour', 'hiddenAction', 'rebuildAfterHiddenMs', 'storageBudget', 'hostOnly', 'numwant', 'content', 'rendezvous', 'leaveVersionSwarm']
  const cases = [
    [env(false, null), {}], [env(true, { type: 'wifi' }), { shareOnNetwork: true }], [env(true, null), {}],
    [env(true, { type: 'cellular' }), { hostOnly: true }], [env(false, { type: 'wifi', saveData: true }), { share: false, pointerMax: 1000 }]
  ]
  for (const [e, prefs] of cases) {
    const p = computePolicy(e, prefs)
    assert.deepEqual(Object.keys(p), V03_KEYS.concat('seedBudget'))
    assert.deepEqual(p.seedBudget, seedBudget(e, prefs))
  }
  // The C2 env fields and prefs reach the seed budget and nothing else.
  const strip = (p) => { const o = Object.assign({}, p); delete o.seedBudget; return o }
  const base = computePolicy(env(true, { type: 'wifi' }), { shareOnNetwork: true })
  const c2 = computePolicy(Object.assign({}, env(true, { type: 'wifi' }), { networkProof: 'connection', dock: true, call: { limited: true } }),
    { shareOnNetwork: true, declaredWifi: true, declaredPlugged: true, seedAsked: true, phoneDefaultOn: true, handoffWhileHidden: true })
  assert.deepEqual(strip(c2), strip(base))
  assert.notDeepEqual(c2.seedBudget, base.seedBudget)
  assert.equal(computePolicy(env(true, { type: 'cellular' }), { hostOnly: true }).seedBudget.row, 'hostOnly')
  assert.equal(computePolicy(env(false, null), {}, { policy: CONFIG.policy, limits: CONFIG.limits }).seedBudget.row, 'desktop', 'a config without seed falls back to CONFIG.seed')
})
