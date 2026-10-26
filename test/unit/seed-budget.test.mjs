// Unit tests for src/loader/seed-budget.js (v0.3 C2, seed-policy lane; SEEDING-AND-ZERO-SETUP-DESIGN.md 3.1.3 and
// 3.1.4, S1 D2 and D3): every row of the budget table, the "I am on Wi-Fi" variants, dock mode, the call row, the
// SZ-1 and SZ-2 flags, host-only and Share Off.
// Run: node --test test/unit/seed-budget.test.mjs
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { seedBudget, laneRates, networkOfEnv, SEED_LANES, SEED_ROWS, MONTH_LANES } from '../../src/loader/seed-budget.js'
import { networkClassOf, classifyNetwork, detectEnvironment } from '../../src/loader/policy.js'
import { CONFIG } from '../../src/loader/config.js'

const KiB = 1024
const MiB = 1024 * KiB
const GiB = 1024 * MiB

// env builders: the detectEnvironment() shape plus the C2 fields.
const desk = (net = 'unknown', battery = null, extra = {}) => Object.assign({ isMobile: false, networkClass: net, saveData: net === 'saveData', battery, online: true }, extra)
const phone = (net = 'unknown', battery = null, extra = {}) => Object.assign({ isMobile: true, networkClass: net, saveData: net === 'saveData', battery, online: true }, extra)
const plug = (level) => ({ charging: true, level })
const unplug = (level) => ({ charging: false, level })
const rates = (b) => [b.lanes.H.rate, b.lanes.K.rate, b.lanes.E.rate]
const local = (b) => [b.local.H, b.local.K, b.local.E]

test('exports: lanes H, K, E in spending order; the base rows; the month counts K and E', () => {
  assert.deepEqual(SEED_LANES, ['H', 'K', 'E'])
  assert.deepEqual(SEED_ROWS, ['desktop', 'phoneCharging', 'phoneWifi', 'phoneLimited', 'metered', 'hostOnly'])
  assert.deepEqual(MONTH_LANES, ['K', 'E'])
  assert.ok(Object.isFrozen(SEED_LANES) && Object.isFrozen(CONFIG.seed.rows.desktop))
})

test('CONFIG.seed: the owner flags default to the v0.3 behaviour and the rows are the SZ 3.1.3 table in bytes', () => {
  const s = CONFIG.seed
  assert.equal(s.phoneDefaultOn, false, 'SZ-1 not signed')
  assert.equal(s.handoffWhileHidden, false, 'SZ-2 not signed')
  assert.equal(s.superSeed, false)
  assert.deepEqual([s.echoTargetCopies, s.dockDefaultMs, s.dockCapMs, s.dockMinBattery], [3, 2 * 3600000, 8 * 3600000, 0.2])
  const R = s.rows
  assert.deepEqual(R.desktop, { H: MiB, K: MiB, E: 256 * KiB, session: null, month: 20e9 })
  assert.deepEqual(R.phoneCharging, { H: MiB, K: 256 * KiB, E: 256 * KiB, session: 64 * MiB, month: GiB })
  assert.deepEqual(R.phoneWifi, { H: 512 * KiB, K: 128 * KiB, E: 0, session: 32 * MiB, month: 256 * MiB })
  assert.deepEqual(R.phoneLimited, { H: 128 * KiB, K: 0, E: 0, session: 32 * MiB, month: 256 * MiB, wifi: { H: 512 * KiB, K: 128 * KiB, E: 0 } })
  assert.deepEqual(R.metered, { H: 128 * KiB, K: 0, E: 0, session: 16 * MiB, month: 0 })
  assert.deepEqual(R.local, { H: MiB, K: 512 * KiB, E: 256 * KiB, session: 128 * MiB })
  assert.deepEqual(R.call, { phoneH: 128 * KiB, phoneK: 0, phoneE: 0, desktopKFactor: 0.5, desktopE: 0 })
})

// [name, env, prefs, row, [H, K, E], session of an active lane, month cap]
const ROWS = [
  ['desktop, network unknown (Chromium exposes only effectiveType)', desk(), {}, 'desktop', [MiB, MiB, 256 * KiB], Infinity, 20e9],
  ['desktop on Wi-Fi', desk('wifi'), {}, 'desktop', [MiB, MiB, 256 * KiB], Infinity, 20e9],
  ['desktop on battery under 20% stays row 1 ("Desktop, not metered")', desk('unknown', unplug(0.1)), {}, 'desktop', [MiB, MiB, 256 * KiB], Infinity, 20e9],
  ['desktop on a cellular connection is metered', desk('cellular'), { shareOnNetwork: true }, 'metered', [128 * KiB, 0, 0], 16 * MiB, 0],
  ['desktop with Save-Data is metered', desk('saveData'), {}, 'metered', [128 * KiB, 0, 0], 16 * MiB, 0],
  ['row 2: phone, Wi-Fi by connection.type, charging, 80%', phone('wifi', plug(0.8)), { shareOnNetwork: true }, 'phoneCharging', [MiB, 256 * KiB, 256 * KiB], 64 * MiB, GiB],
  ['row 2 at exactly 50%', phone('wifi', plug(0.5)), { shareOnNetwork: true }, 'phoneCharging', [MiB, 256 * KiB, 256 * KiB], 64 * MiB, GiB],
  ['row 3: phone, Wi-Fi proven, unplugged, 60%', phone('wifi', unplug(0.6)), { shareOnNetwork: true }, 'phoneWifi', [512 * KiB, 128 * KiB, 0], 32 * MiB, 256 * MiB],
  ['row 4: charging at 49% on proven Wi-Fi gets the Wi-Fi rates', phone('wifi', plug(0.49)), { shareOnNetwork: true }, 'phoneLimited', [512 * KiB, 128 * KiB, 0], 32 * MiB, 256 * MiB],
  ['row 4: unplugged at 30% on proven Wi-Fi', phone('wifi', unplug(0.3)), { shareOnNetwork: true }, 'phoneLimited', [512 * KiB, 128 * KiB, 0], 32 * MiB, 256 * MiB],
  ['row 4: unplugged at exactly 20%', phone('wifi', unplug(0.2)), { shareOnNetwork: true }, 'phoneLimited', [512 * KiB, 128 * KiB, 0], 32 * MiB, 256 * MiB],
  ['row 4: nothing provable (iOS, Firefox)', phone(), { shareOnNetwork: true }, 'phoneLimited', [128 * KiB, 0, 0], 32 * MiB, 256 * MiB],
  ['row 4 after "I am on Wi-Fi"', phone(), { shareOnNetwork: true, declaredWifi: true }, 'phoneLimited', [512 * KiB, 128 * KiB, 0], 32 * MiB, 256 * MiB],
  ['row 4 with the declaration carried as networkProof', phone('unknown', null, { networkProof: 'declared' }), { shareOnNetwork: true }, 'phoneLimited', [512 * KiB, 128 * KiB, 0], 32 * MiB, 256 * MiB],
  ['row 4: Wi-Fi by connection.type without a battery API', phone('wifi'), { shareOnNetwork: true }, 'phoneLimited', [512 * KiB, 128 * KiB, 0], 32 * MiB, 256 * MiB],
  ['row 4: a charging phone under 20% (the table has no row for it)', phone('wifi', plug(0.1)), { shareOnNetwork: true }, 'phoneLimited', [512 * KiB, 128 * KiB, 0], 32 * MiB, 256 * MiB],
  ['row 4: battery known but the network unknown', phone('unknown', plug(0.9)), { shareOnNetwork: true }, 'phoneLimited', [128 * KiB, 0, 0], 32 * MiB, 256 * MiB],
  ['row 5: cellular (K and E 0 even after "Share on this network")', phone('cellular', plug(0.9)), { shareOnNetwork: true }, 'metered', [128 * KiB, 0, 0], 16 * MiB, 0],
  ['row 5: Save-Data wins over Wi-Fi', phone('saveData', plug(0.9)), { shareOnNetwork: true }, 'metered', [128 * KiB, 0, 0], 16 * MiB, 0],
  ['row 5: under 20% unplugged on Wi-Fi', phone('wifi', unplug(0.19)), { shareOnNetwork: true }, 'metered', [128 * KiB, 0, 0], 16 * MiB, 0],
  ['row 5: a declaration never beats connection.type', phone('cellular'), { shareOnNetwork: true, declaredWifi: true }, 'metered', [128 * KiB, 0, 0], 16 * MiB, 0]
]

test('SZ 3.1.3 rows 1 to 5: row, lane rates, session and month caps', () => {
  for (const [name, env, prefs, row, expect, session, month] of ROWS) {
    const b = seedBudget(env, prefs)
    assert.equal(b.row, row, name)
    assert.deepEqual(rates(b), expect, name)
    for (const l of SEED_LANES) assert.equal(b.lanes[l].session, b.lanes[l].rate > 0 ? session : 0, name + ' session ' + l)
    assert.deepEqual(b.month, { cap: month, lanes: ['K', 'E'] }, name + ' month')
    assert.equal(b.call, false)
  }
})

test('phones: K and E stay 0 until "Share on this network" (today\'s behaviour); H runs with the per-upload card', () => {
  for (const env of [phone('wifi', plug(0.8)), phone('wifi', unplug(0.6)), phone(), phone('unknown', null, { networkProof: 'declared' })]) {
    const b = seedBudget(env, {})
    assert.equal(b.lanes.K.rate, 0, JSON.stringify(env))
    assert.equal(b.lanes.E.rate, 0)
    assert.ok(b.lanes.H.rate > 0, 'H is on')
    assert.equal(b.local.K, 0, 'local wires too')
    assert.equal(b.local.E, 0)
    assert.equal(b.defaultOn, false)
  }
  assert.deepEqual(rates(seedBudget(phone('wifi', plug(0.8)), {})), [MiB, 0, 0])
})

test('Share Off gives K and E 0 and keeps H; host-only gives 0 everywhere', () => {
  for (const [env, prefs] of [[desk(), {}], [phone('wifi', plug(0.8)), { shareOnNetwork: true }], [phone(), { shareOnNetwork: true, declaredWifi: true }]]) {
    const on = seedBudget(env, prefs)
    const off = seedBudget(env, Object.assign({}, prefs, { share: false }))
    assert.equal(off.lanes.H.rate, on.lanes.H.rate, 'H kept')
    assert.equal(off.lanes.H.session, on.lanes.H.session)
    assert.deepEqual([off.lanes.K.rate, off.lanes.E.rate, off.lanes.K.session, off.lanes.E.session], [0, 0, 0, 0])
    assert.deepEqual([off.local.K, off.local.E], [0, 0])
    assert.equal(off.local.H, on.local.H)
    assert.equal(off.row, on.row)
  }
  for (const env of [desk(), phone('wifi', plug(0.8)), phone('cellular')]) {
    const b = seedBudget(env, { hostOnly: true, shareOnNetwork: true, handoffWhileHidden: true, phoneDefaultOn: true })
    assert.deepEqual(b, {
      row: 'hostOnly',
      call: false,
      lanes: { H: { rate: 0, session: 0 }, K: { rate: 0, session: 0 }, E: { rate: 0, session: 0 } },
      month: { cap: 0, lanes: ['K', 'E'] },
      local: { H: 0, K: 0, E: 0, session: 0, on: false },
      hiddenH: false,
      defaultOn: false,
      ask: null
    })
  }
})

test('row 6: local wires get the local row on phones (outside the month cap), the desktop row on a desktop, never a lift on metered networks', () => {
  // Code review v0.3 (browser): the local row needs Wi-Fi proven by the browser or declared by the person.
  const p = seedBudget(phone('wifi'), { shareOnNetwork: true })
  assert.deepEqual(local(p), [MiB, 512 * KiB, 256 * KiB], 'any phone on Wi-Fi, local wire')
  assert.equal(p.local.session, 128 * MiB)
  assert.equal(p.local.on, true)
  const d = seedBudget(desk())
  assert.deepEqual(local(d), [MiB, MiB, 256 * KiB])
  assert.equal(d.local.session, Infinity)
  for (const env of [phone('cellular', plug(0.9)), phone('wifi', unplug(0.1)), desk('saveData')]) {
    const b = seedBudget(env, { shareOnNetwork: true })
    assert.equal(b.local.on, false, 'carriers hand out private host addresses too')
    assert.deepEqual(local(b), rates(b), 'the row\'s own rates')
    assert.equal(b.local.session, 16 * MiB)
  }
  // Code review v0.3 (browser): a phone whose network the browser cannot tell may be on mobile data: no local lift
  // until the person says "I am on Wi-Fi".
  const unknown = seedBudget({ isMobile: true, networkClass: 'unknown' }, { shareOnNetwork: true })
  assert.equal(unknown.local.on, false)
  assert.deepEqual(local(unknown), rates(unknown))
  assert.equal(seedBudget({ isMobile: true, networkClass: 'unknown' }, { shareOnNetwork: true, declaredWifi: true }).local.on, true)
  assert.deepEqual(laneRates(p, { local: true }), { H: MiB, K: 512 * KiB, E: 256 * KiB })
  assert.deepEqual(laneRates(p), { H: 512 * KiB, K: 128 * KiB, E: 0 })
  assert.deepEqual(laneRates(seedBudget(phone(), { shareOnNetwork: true })), { H: 128 * KiB, K: 0, E: 0 })
  assert.deepEqual(laneRates(null), { H: 0, K: 0, E: 0 })
})

test('row 7: during a call phones send H at most 128 KiB/s and stop K and E; a desktop halves K only while limited and stops E', () => {
  const base = seedBudget(phone('wifi', plug(0.8)), { shareOnNetwork: true })
  const inCall = seedBudget(phone('wifi', plug(0.8), { call: { limited: false } }), { shareOnNetwork: true })
  assert.equal(inCall.call, true)
  assert.equal(inCall.row, 'phoneCharging', 'the row underneath stays')
  assert.deepEqual(rates(inCall), [128 * KiB, 0, 0])
  assert.equal(inCall.lanes.H.session, 64 * MiB, 'session and month caps stay those of the row')
  assert.deepEqual(inCall.month, base.month)
  assert.deepEqual(local(inCall), [128 * KiB, 0, 0], 'calls take priority over local wires too')
  assert.deepEqual(rates(seedBudget(phone('cellular', null, { call: { limited: true } }), {})), [128 * KiB, 0, 0])
  const dFree = seedBudget(desk('wifi', null, { call: { limited: false } }))
  assert.deepEqual(rates(dFree), [MiB, MiB, 0])
  const dLimited = seedBudget(desk('wifi', null, { call: { limited: true } }))
  assert.deepEqual(rates(dLimited), [MiB, 512 * KiB, 0])
  assert.deepEqual(local(dLimited), [MiB, 512 * KiB, 0])
  assert.equal(seedBudget(desk('wifi', null, { call: null })).call, false)
  assert.deepEqual(rates(seedBudget(desk('wifi', null, { call: true }))), [MiB, MiB, 0], 'call: true counts as a call that is not limited')
})

test('dock mode: on the person\'s word ("plugged in, on Wi-Fi") it applies row 2 where the browser cannot tell, never against what it can', () => {
  const ios = seedBudget(phone('unknown', null, { dock: true }), { declaredWifi: true, declaredPlugged: true })
  assert.equal(ios.row, 'phoneCharging')
  assert.deepEqual(rates(ios), [MiB, 256 * KiB, 256 * KiB], 'starting dock mode is the person\'s choice to share: K and E run while it lasts')
  assert.equal(ios.ask, null)
  const noWord = seedBudget(phone('unknown', null, { dock: true }), {})
  assert.equal(noWord.row, 'phoneLimited')
  assert.deepEqual(rates(noWord), [128 * KiB, 0, 0])
  assert.equal(noWord.ask, 'wifi')
  const chromiumLow = seedBudget(phone('wifi', plug(0.3), { dock: true }), { declaredPlugged: true })
  assert.equal(chromiumLow.row, 'phoneLimited', 'a battery the browser reads at 30% is not row 2')
  assert.deepEqual(rates(chromiumLow), [512 * KiB, 128 * KiB, 0])
  const unplugged = seedBudget(phone('unknown', unplug(0.9), { dock: true }), { declaredWifi: true, declaredPlugged: true })
  assert.equal(unplugged.row, 'phoneLimited', 'the Battery Status API beats the declaration')
  assert.equal(seedBudget(phone('unknown', plug(0.7), { dock: true }), { declaredWifi: true }).row, 'phoneCharging')
  assert.equal(seedBudget(phone('unknown', plug(0.7)), { declaredWifi: true, shareOnNetwork: true }).row, 'phoneLimited', 'outside dock mode row 2 needs connection.type')
  assert.equal(seedBudget(phone('cellular', null, { dock: true }), { declaredWifi: true, declaredPlugged: true }).row, 'metered')
})

test('SZ-1 behind a flag: phones run K and E by default only in row 2, ask once, and stop when the card is declined', () => {
  const env = phone('wifi', plug(0.8))
  const on = seedBudget(env, { phoneDefaultOn: true })
  assert.deepEqual(rates(on), [MiB, 256 * KiB, 256 * KiB])
  assert.equal(on.defaultOn, true)
  assert.equal(on.ask, 'consent', 'the card was not answered')
  const cfg = Object.assign({}, CONFIG, { seed: Object.assign({}, CONFIG.seed, { phoneDefaultOn: true }) })
  assert.deepEqual(seedBudget(env, {}, cfg), on, 'the config flag does the same')
  assert.equal(seedBudget(env, { phoneDefaultOn: false }, cfg).lanes.K.rate, 0, 'prefs override the config flag')
  const declined = seedBudget(env, { phoneDefaultOn: true, seedAsked: true })
  assert.deepEqual(rates(declined), [MiB, 0, 0])
  assert.equal(declined.ask, null)
  const accepted = seedBudget(env, { phoneDefaultOn: true, seedAsked: true, shareOnNetwork: true })
  assert.deepEqual(rates(accepted), [MiB, 256 * KiB, 256 * KiB])
  assert.equal(accepted.ask, null)
  assert.equal(seedBudget(env, { phoneDefaultOn: true, shareOnNetwork: true }).ask, null)
  assert.equal(seedBudget(env, { phoneDefaultOn: true, share: false }).ask, null, 'no card while Share is Off')
  const row3 = seedBudget(phone('wifi', unplug(0.6)), { phoneDefaultOn: true })
  assert.deepEqual(rates(row3), [512 * KiB, 0, 0], 'row 2 is the one default-on case')
  assert.equal(row3.defaultOn, false)
  assert.equal(row3.ask, null)
  assert.equal(seedBudget(env, {}).ask, null, 'without SZ-1 there is no card')
  assert.equal(seedBudget(env, {}).defaultOn, false)
  assert.equal(seedBudget(desk(), {}).defaultOn, true, 'a desktop off metered networks shares by default')
  assert.equal(seedBudget(desk('cellular'), {}).defaultOn, false)
})

test('SZ-2 behind a flag: hiddenH only on phones with handoffWhileHidden, prefs over config', () => {
  assert.equal(seedBudget(phone('wifi', plug(0.8)), {}).hiddenH, false, 'default off')
  assert.equal(seedBudget(phone('wifi', plug(0.8)), { handoffWhileHidden: true }).hiddenH, true)
  assert.equal(seedBudget(phone('cellular'), { handoffWhileHidden: true }).hiddenH, true, 'H runs on cellular with the card')
  assert.equal(seedBudget(desk(), { handoffWhileHidden: true }).hiddenH, false, 'desktops keep seeding when hidden anyway')
  const cfg = Object.assign({}, CONFIG, { seed: Object.assign({}, CONFIG.seed, { handoffWhileHidden: true }) })
  assert.equal(seedBudget(phone(), {}, cfg).hiddenH, true)
  assert.equal(seedBudget(phone(), { handoffWhileHidden: false }, cfg).hiddenH, false)
})

test('ask "wifi" only where "I am on Wi-Fi" would raise a lane', () => {
  assert.equal(seedBudget(phone(), {}).ask, 'wifi', 'H 128 to 512 KiB/s')
  assert.equal(seedBudget(phone(), { share: false }).ask, 'wifi', 'H still rises with Share Off')
  assert.equal(seedBudget(phone(), { declaredWifi: true }).ask, null, 'already declared')
  assert.equal(seedBudget(phone('wifi'), {}).ask, null, 'proven by connection.type')
  assert.equal(seedBudget(phone('cellular'), {}).ask, null, 'a declaration never beats connection.type')
  assert.equal(seedBudget(phone('unknown', unplug(0.1)), {}).ask, null, 'under 20% unplugged the row does not change')
  assert.equal(seedBudget(phone('unknown', null, { call: {} }), {}).ask, null, 'during a call nothing rises')
  assert.equal(seedBudget(desk(), {}).ask, null)
})

test('robust inputs: v0.2 env objects, missing prefs, a partial config, custom rows, the 32 KiB/s shaping floor, fresh objects', () => {
  assert.equal(seedBudget({ isMobile: true, networkType: 'cellular', saveData: false }).row, 'metered')
  assert.equal(seedBudget({ isMobile: false, networkType: 'wifi', saveData: true }).row, 'metered')
  assert.equal(seedBudget(null).row, 'desktop')
  assert.equal(seedBudget(phone(), null).row, 'phoneLimited')
  const partial = { policy: { minShapingBytes: 32768 } }
  assert.deepEqual(seedBudget(desk(), {}, partial), seedBudget(desk(), {}), 'a test config without seed falls back to CONFIG.seed')
  const custom = { seed: Object.assign({}, CONFIG.seed, { rows: { desktop: { H: 10000, K: 2 * MiB, E: 0, session: 5 * MiB, month: 7 } } }), policy: { minShapingBytes: 32768 } }
  const c = seedBudget(desk(), {}, custom)
  assert.deepEqual(rates(c), [32768, 2 * MiB, 0], 'a positive rate under the floor is raised, never zeroed')
  assert.deepEqual([c.lanes.H.session, c.lanes.E.session, c.month.cap], [5 * MiB, 0, 7])
  assert.deepEqual(seedBudget(phone(), {}, custom).lanes.H.rate, 128 * KiB, 'rows the custom config leaves out come from CONFIG')
  const a = seedBudget(desk())
  a.lanes.H.rate = 1
  a.month.lanes.push('H')
  assert.equal(seedBudget(desk()).lanes.H.rate, MiB)
  assert.deepEqual(seedBudget(desk()).month.lanes, ['K', 'E'])
  assert.equal(typeof seedBudget(phone('wifi', { level: 0.9 })).row, 'string', 'a battery without charging counts as charging, like normalizeBattery')
  assert.equal(seedBudget(phone('wifi', { level: 0.9 }), { shareOnNetwork: true }).row, 'phoneCharging')
})

test('networkOfEnv agrees with policy.js networkClassOf (the two classifiers stay in step)', () => {
  const envs = [
    {}, { networkClass: 'wifi' }, { networkClass: 'cellular' }, { networkClass: 'saveData' }, { networkClass: 'unknown' },
    { networkType: 'wifi' }, { networkType: 'cellular' }, { networkType: 'unknown', saveData: true }, { networkClass: 'bogus', networkType: 'wifi' }
  ]
  for (const e of envs) assert.equal(networkOfEnv(e), networkClassOf(e), JSON.stringify(e))
  for (const connection of [{ type: 'wifi' }, { type: 'ethernet' }, { type: 'cellular' }, { type: 'wifi', saveData: true }, null]) {
    const env = detectEnvironment({ nav: { userAgent: 'Android Mobile', connection, onLine: true }, win: null })
    assert.equal(networkOfEnv(env), classifyNetwork(connection))
  }
})
