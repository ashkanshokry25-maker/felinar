// Unit tests for src/loader/availability.js (v0.3 C2, lane seed-engine; SZ 3.1.5, S1 D6): every tier and
// label, the windows (60 s bitfields, 10 min web seed probe, 15 min heartbeat), atLeast at the wire cap, and
// liars stay 'reported'. Run: node --test test/unit/availability.test.mjs
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'

import {
  evidence, availableOf, publicEvidence, handoffState, sameEvidence, isLabel,
  TIERS, WINDOWS, LABELS, HANDOFF_LABELS, HANDOFF_STATES
} from '../../src/loader/availability.js'

const NOW = 1_800_000_000_000
const live = (id, extra = {}) => Object.assign({ id, complete: true, at: NOW }, extra)

describe('constants', () => {
  test('tiers, windows and label keys are exactly those of SZ 3.1.5', () => {
    assert.deepEqual(TIERS, ['E0', 'E1', 'E2', 'E3', 'E4'])
    assert.deepEqual(WINDOWS, { bitfieldMs: 60000, webseedMs: 600000, heartbeatMs: 900000 })
    assert.deepEqual(Object.values(LABELS).sort(), ['avail.heldBy', 'avail.keptBySite', 'avail.noPin', 'avail.nobody', 'avail.onlyHere'])
    assert.deepEqual(HANDOFF_LABELS, { waiting: 'handoff.waiting', sending: 'handoff.sending' })
    assert.deepEqual(HANDOFF_STATES, ['onlyHere', 'waiting', 'sending', 'kept', 'sent', 'nobody'])
    for (const k of Object.values(LABELS)) assert.equal(isLabel(k), true)
    assert.equal(isLabel('avail.forever'), false)
  })
})

describe('labels by evidence', () => {
  test('nothing: avail.nobody, no tier, count 0, unknown', () => {
    const ev = evidence({ now: NOW })
    assert.equal(ev.label, LABELS.nobody)
    assert.equal(ev.tier, null)
    assert.equal(ev.count, 0)
    assert.equal(ev.atLeast, false)
    assert.equal(ev.reported, false)
    assert.equal(availableOf(ev), 'unknown')
    assert.deepEqual(ev.sources, [])
  })

  test('E0 alone: only on this device; a local object needs complete and not unverified', () => {
    const ev = evidence({ local: true, now: NOW })
    assert.equal(ev.label, LABELS.onlyHere)
    assert.equal(ev.tier, 'E0')
    assert.equal(ev.count, 0)
    assert.equal(ev.local, true)
    assert.equal(ev.checkedAt, NOW)
    assert.equal(availableOf(ev), 'online')
    assert.equal(evidence({ local: { complete: true, at: NOW - 5 }, now: NOW }).checkedAt, NOW - 5)
    assert.equal(evidence({ local: { complete: true, verified: false }, now: NOW }).label, LABELS.nobody, 'unverified bytes are not E0')
    assert.equal(evidence({ local: { complete: false }, now: NOW }).label, LABELS.nobody)
  })

  test('E0 and E1: kept by you and at least {n} others (reported), counted by distinct holder', () => {
    const ev = evidence({ local: true, wires: [live('a'), live('b'), live('b'), { id: 'c', complete: false, at: NOW }], now: NOW })
    assert.equal(ev.label, LABELS.heldBy)
    assert.equal(ev.tier, 'E1')
    assert.equal(ev.count, 2, 'one peer on two wires counts once; an incomplete bitfield not at all')
    assert.deepEqual(ev.params, { n: 2 })
    assert.equal(ev.reported, true)
    assert.equal(availableOf(ev), 'online')
    assert.deepEqual(ev.sources, ['E0', 'E1'])
  })

  test('E1 without E0: available only while a holder is online (avail.noPin), never "kept by you"', () => {
    const ev = evidence({ wires: [live('a')], now: NOW })
    assert.equal(ev.label, LABELS.noPin)
    assert.equal(ev.tier, 'E1')
    assert.equal(ev.count, 1)
    assert.equal(ev.local, false)
    assert.equal(availableOf(ev), 'online')
  })

  test('E3: the web seed answered a probe within 10 minutes; older is not evidence', () => {
    const ok = evidence({ webseed: { ok: true, at: NOW - 4 * 60000 }, now: NOW })
    assert.equal(ok.label, LABELS.keptBySite)
    assert.equal(ok.tier, 'E3')
    assert.equal(ok.params.age, 4 * 60000)
    assert.equal(ok.checkedAt, NOW - 4 * 60000)
    assert.equal(ok.reported, false)
    assert.equal(availableOf(ok), 'kept')
    assert.equal(evidence({ webseed: { ok: true, at: NOW - WINDOWS.webseedMs - 1 }, now: NOW }).label, LABELS.nobody)
    assert.equal(evidence({ webseed: { ok: false, at: NOW }, now: NOW }).label, LABELS.nobody, 'a failed probe is no evidence')
    const two = evidence({ webseed: [{ ok: true, at: NOW - 9 * 60000 }, { ok: true, at: NOW - 60000 }], now: NOW })
    assert.equal(two.checkedAt, NOW - 60000, 'the newest passing probe')
  })

  test('E4: a receipt, or a heartbeat at most 15 minutes old that lists the item', () => {
    const r = evidence({ pin: { configured: true, receipt: { at: NOW - 30000 } }, local: true, now: NOW })
    assert.equal(r.label, LABELS.keptBySite)
    assert.equal(r.tier, 'E4')
    assert.equal(r.params.age, 30000)
    const hb = evidence({ pin: { configured: true, heartbeat: { at: NOW - 14 * 60000, has: true } }, now: NOW })
    assert.equal(hb.tier, 'E4')
    assert.equal(evidence({ pin: { configured: true, heartbeat: { at: NOW - 16 * 60000, has: true } }, now: NOW }).label, LABELS.nobody, 'a stale heartbeat')
    assert.equal(evidence({ pin: { configured: true, heartbeat: { at: NOW, has: false } }, now: NOW }).label, LABELS.nobody, 'a heartbeat that does not list it')
    const both = evidence({ pin: { configured: true, receipt: { at: NOW - 60000 }, heartbeat: { at: NOW - 1000, has: true } }, webseed: { ok: true, at: NOW - 5000 }, now: NOW })
    assert.equal(both.tier, 'E4', 'the pin outranks the web seed')
    assert.equal(both.checkedAt, NOW - 1000, 'checked at the freshest evidence')
    assert.deepEqual(both.sources, ['E3', 'E4'])
  })

  test('E2 (v0.4 spot-checks): a checked holder is not "reported"; a mix stays reported', () => {
    const all = evidence({ local: true, wires: [live('a', { checked: true })], now: NOW })
    assert.equal(all.tier, 'E2')
    assert.equal(all.reported, false)
    const mix = evidence({ local: true, wires: [live('a', { checked: true }), live('b')], now: NOW })
    assert.equal(mix.tier, 'E2')
    assert.equal(mix.reported, true)
  })
})

describe('windows, caps and liars', () => {
  test('a bitfield older than 60 s is no longer E1; a future timestamp beyond the window neither', () => {
    assert.equal(evidence({ wires: [live('a', { at: NOW - 60000 })], now: NOW }).count, 1, 'exactly 60 s still counts')
    assert.equal(evidence({ wires: [live('a', { at: NOW - 60001 })], now: NOW }).count, 0)
    assert.equal(evidence({ wires: [live('a', { at: NOW + 120000 })], now: NOW }).count, 0)
    assert.equal(evidence({ wires: [{ id: 'x', complete: true }], now: NOW }).count, 0, 'no timestamp, no evidence')
  })

  test('atLeast when the wires seen reach the cap (a phone sees at most 8)', () => {
    const wires = Array.from({ length: 8 }, (_, i) => live('p' + i, { complete: i < 3 }))
    const ev = evidence({ local: true, wires, cap: 8, now: NOW })
    assert.equal(ev.count, 3)
    assert.equal(ev.atLeast, true)
    assert.equal(evidence({ local: true, wires: wires.slice(0, 5), cap: 8, now: NOW }).atLeast, false)
    assert.equal(evidence({ local: true, wires: { list: wires, cap: 8 }, now: NOW }).atLeast, true, 'the { list, cap } form')
    assert.equal(evidence({ local: true, wires: wires.slice(0, 1), capped: true, now: NOW }).atLeast, true, 'capped given directly')
    assert.equal(evidence({ local: true, wires: [], capped: true, now: NOW }).atLeast, false, 'no count, nothing to bound')
  })

  test('liars: complete bitfields from wires that serve nothing still only make a reported count, never "kept"', () => {
    const liars = Array.from({ length: 5 }, (_, i) => live('liar' + i))
    const ev = evidence({ wires: liars, now: NOW })
    assert.equal(ev.reported, true)
    assert.notEqual(ev.label, LABELS.keptBySite)
    assert.equal(ev.count, 5, 'the count never exceeds what the wires showed')
    assert.notEqual(availableOf(ev), 'kept')
  })

  test('malformed input never throws and never invents evidence', () => {
    for (const bad of [undefined, null, {}, { wires: 'x' }, { wires: [null, 7, 'a'] }, { webseed: 'yes' }, { pin: 'yes' }, { local: 'yes' }, { now: 'soon' }]) {
      const ev = evidence(bad)
      assert.equal(ev.label, LABELS.nobody, JSON.stringify(bad))
      assert.equal(ev.count, 0)
    }
  })

  test('without a pin node the label notes avail.noPin; with one it does not', () => {
    assert.deepEqual(evidence({ local: true, now: NOW }).notes, [LABELS.noPin])
    assert.deepEqual(evidence({ local: true, pin: { configured: true }, now: NOW }).notes, [])
    assert.deepEqual(evidence({ wires: [live('a')], now: NOW }).notes, [], 'the label is noPin already')
  })
})

describe('SDK object, hand-off states, change detection', () => {
  test('publicEvidence keeps only { tier, count, atLeast, reported, checkedAt }', () => {
    const ev = evidence({ local: true, wires: [live('a')], now: NOW })
    assert.deepEqual(publicEvidence(ev), { tier: 'E1', count: 1, atLeast: false, reported: true, checkedAt: NOW })
    assert.deepEqual(publicEvidence(null), { tier: null, count: 0, atLeast: false, reported: false, checkedAt: null })
  })

  test('own uploads: onlyHere -> handoff.waiting -> handoff.sending -> keptBySite; a peer copy reads as sent', () => {
    const only = handoffState({ ev: evidence({ local: true, pin: { configured: true }, now: NOW }) })
    assert.deepEqual(only, { state: 'onlyHere', label: 'avail.onlyHere', params: {} })
    const waiting = handoffState({ ev: evidence({ local: true, pin: { configured: true }, now: NOW }), requested: true })
    assert.deepEqual(waiting, { state: 'waiting', label: 'handoff.waiting', params: {} })
    const sending = handoffState({ ev: evidence({ local: true, pin: { configured: true }, now: NOW }), requested: true, pinPct: 62.7 })
    assert.deepEqual(sending, { state: 'sending', label: 'handoff.sending', params: { pct: 62 } })
    const kept = handoffState({ ev: evidence({ local: true, pin: { configured: true, receipt: { at: NOW - 2000 } }, now: NOW }), requested: true, pinPct: 100 })
    assert.equal(kept.state, 'kept')
    assert.equal(kept.label, 'avail.keptBySite')
    assert.equal(kept.params.age, 2000)
    const sent = handoffState({ ev: evidence({ local: true, wires: [live('bo')], now: NOW }) })
    assert.deepEqual(sent, { state: 'sent', label: 'avail.heldBy', params: { n: 1 } })
    // An own item this device does not hold (restored from the ledger elsewhere): never "Only on this device".
    assert.deepEqual(handoffState({ ev: evidence({ now: NOW }) }), { state: 'nobody', label: 'avail.nobody', params: {} })
    assert.deepEqual(handoffState({ ev: evidence({ wires: [live('bo')], now: NOW }) }), { state: 'sent', label: 'avail.noPin', params: { n: 1 } })
    assert.equal(handoffState().state, 'nobody')
    assert.equal(handoffState({ ev: evidence({ local: true, now: NOW }) }).state, 'onlyHere')
  })

  test('sameEvidence compares what a label shows', () => {
    const a = evidence({ local: true, wires: [live('a')], now: NOW })
    const b = evidence({ local: true, wires: [live('a', { at: NOW - 10 })], now: NOW })
    const c = evidence({ local: true, wires: [live('a'), live('b')], now: NOW })
    assert.equal(sameEvidence(a, b), true)
    assert.equal(sameEvidence(a, c), false)
    assert.equal(sameEvidence(null, null), true)
    assert.equal(sameEvidence(a, null), false)
  })
})
