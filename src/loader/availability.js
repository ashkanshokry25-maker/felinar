// src/loader/availability.js: honest availability from evidence tiers (v0.3 C2, lane seed-engine;
// docs/research/v03/SEEDING-AND-ZERO-SETUP-DESIGN.md 3.1.5, S1 D6, F8). Pure: no DOM, no clock of its own,
// runs unchanged in Node for tests.
//
// Evidence tiers (windows chosen in SZ 3.1.5):
//   E0  this device holds every piece, verified
//   E1  complete bitfields on live wires within the last 60 s ("reported": a bitfield can lie; a phone sees
//       at most 8 wires, so a count is a sample: atLeast when the wire cap bounds it)
//   E2  a holder answered a spot-check (v0.4; supported here when a wire record says checked: true)
//   E3  the web seed answered a probe within the last 10 minutes
//   E4  a mw_pin1 receipt, or a signed pin heartbeat at most 15 minutes old that lists the item
// A label never shows a number above its evidence and never says "forever"; tracker counts are not evidence
// here (they appear only as "{n} connected to this site (tracker report)", a string of lane docs-strings).
//
//   evidence({ local, wires, webseed, pin, now, cap, capped }) -> { tier, count, atLeast, reported, checkedAt,
//     label, params, local, sources, notes }
//   availableOf(ev) -> 'kept' | 'online' | 'unknown'      (the v0.3 'available' values, kept for compatibility)
//   publicEvidence(ev) -> { tier, count, atLeast, reported, checkedAt }   (the SDK object)
//   handoffState({ ev, requested, pinPct }) -> { state, label, params }   (own items: SZ 3.1.5 hand-off states)
//   sameEvidence(a, b) -> boolean                                          (change detection for 'evidence' events)

/** The evidence tiers, weakest first. */
export const TIERS = Object.freeze(['E0', 'E1', 'E2', 'E3', 'E4'])

/** Windows of SZ 3.1.5 (chosen): bitfields 60 s, a web seed probe 10 minutes, a pin heartbeat 15 minutes. */
export const WINDOWS = Object.freeze({ bitfieldMs: 60000, webseedMs: 600000, heartbeatMs: 900000 })

/** The label keys of SZ 3.1.5 (texts in src/loader/strings.js SEED_TEXT, lane docs-strings). */
export const LABELS = Object.freeze({
  onlyHere: 'avail.onlyHere',
  heldBy: 'avail.heldBy',
  keptBySite: 'avail.keptBySite',
  nobody: 'avail.nobody',
  noPin: 'avail.noPin'
})

/** The hand-off label keys of SZ 3.1.5. */
export const HANDOFF_LABELS = Object.freeze({ waiting: 'handoff.waiting', sending: 'handoff.sending' })

/**
 * Hand-off states of an own item, in the order an upload moves through them (SZ 3.1.5, S1 D4 step 5), and 'nobody'
 * for an own item this device does not hold (restored from the ledger on another device) with no holder known.
 */
export const HANDOFF_STATES = Object.freeze(['onlyHere', 'waiting', 'sending', 'kept', 'sent', 'nobody'])

const LABEL_VALUES = new Set(Object.values(LABELS))

function num (v) {
  if (v === null || v === undefined || v === '' || typeof v === 'boolean') return null
  const n = Number(v)
  return Number.isFinite(n) ? n : null
}

function fresh (at, now, windowMs) {
  const t = num(at)
  if (t === null) return false
  // A timestamp from the future (a clock that runs ahead) is accepted up to the window, never beyond it.
  return now - t <= windowMs && t - now <= windowMs
}

function localHeld (local) {
  if (local === true) return true
  if (!local || typeof local !== 'object') return false
  return local.complete === true && local.verified !== false
}

function wireList (wires) {
  if (Array.isArray(wires)) return wires
  if (wires && typeof wires === 'object' && Array.isArray(wires.list)) return wires.list
  return []
}

function webseedList (webseed) {
  if (!webseed) return []
  return Array.isArray(webseed) ? webseed : [webseed]
}

/**
 * evidence({ local, wires, webseed, pin, now, cap, capped }) -> the evidence of one item (an infohash).
 *   local:   true, or { complete, verified? }: this device holds every piece, verified (E0)
 *   wires:   [{ id?, complete, at, checked? }] or { list, cap }: what live wires report (at = the last time the wire
 *            was seen open with that bitfield; an open wire passes now, a closed one its close time)
 *   webseed: { ok, at } or a list of them: web seed probe results (E3 when ok within 10 minutes)
 *   pin:     { configured, receipt: { at } | null, heartbeat: { at, has } | null } (E4)
 *   now:     ms since the epoch (the caller's clock; never read here)
 *   cap:     the swarm's wire cap: the count is atLeast when the wires seen reach it; capped: the same, given directly
 * Returns { tier, count, atLeast, reported, checkedAt, label, params, local, sources, notes }:
 *   tier      the tier the label rests on ('E0'..'E4') or null
 *   count     distinct complete holders online (other than this device), never more than the evidence shows
 *   atLeast   the wire cap bounds count (there may be more holders this device cannot see)
 *   reported  count rests on bitfields nobody checked (false once every counted holder is spot-checked, E2)
 *   checkedAt when the evidence behind the label was last seen (ms), null when there is none
 *   label     one key of LABELS; params its placeholders ({ n } or { age } in ms)
 *   sources   every tier present (the "Why?" line of S1 D6); notes: extra label keys (avail.noPin without a pin)
 */
export function evidence (args) {
  const a = args && typeof args === 'object' ? args : {}
  const { local = null, wires = [], webseed = null, pin = null, now = 0, cap = Infinity, capped = undefined } = a
  const t = num(now) === null ? 0 : Number(now)
  const sources = []
  const e0 = localHeld(local)
  if (e0) sources.push('E0')

  // E1 and E2: distinct complete holders whose wires were live within the window.
  const list = wireList(wires)
  const holders = new Map()
  let seen = 0
  for (const w of list) {
    if (!w || typeof w !== 'object') continue
    seen++
    if (w.complete !== true || !fresh(w.at, t, WINDOWS.bitfieldMs)) continue
    const key = w.id !== undefined && w.id !== null ? 'id:' + String(w.id) : w
    const prev = holders.get(key)
    const at = Number(w.at)
    const checked = w.checked === true
    if (!prev) holders.set(key, { at, checked })
    else holders.set(key, { at: Math.max(prev.at, at), checked: prev.checked || checked })
  }
  const count = holders.size
  let checkedCount = 0
  let holdersAt = null
  for (const h of holders.values()) {
    if (h.checked) checkedCount++
    holdersAt = holdersAt === null ? h.at : Math.max(holdersAt, h.at)
  }
  if (count > 0) sources.push(checkedCount > 0 ? 'E2' : 'E1')
  const wireCap = num(wires && !Array.isArray(wires) && typeof wires === 'object' ? wires.cap : cap)
  const atLeast = capped === true || (capped === undefined && wireCap !== null && wireCap > 0 && seen >= wireCap)

  // E3: a web seed that answered a probe within 10 minutes.
  let wsAt = null
  for (const p of webseedList(webseed)) {
    if (!p || p.ok !== true || !fresh(p.at, t, WINDOWS.webseedMs)) continue
    wsAt = wsAt === null ? Number(p.at) : Math.max(wsAt, Number(p.at))
  }
  if (wsAt !== null) sources.push('E3')

  // E4: a pin receipt (verified by src/loader/pinwire.js) or a fresh signed heartbeat that lists the item.
  let pinAt = null
  const p = pin && typeof pin === 'object' ? pin : null
  if (p && p.receipt && num(p.receipt.at) !== null) pinAt = Number(p.receipt.at)
  if (p && p.heartbeat && p.heartbeat.has === true && fresh(p.heartbeat.at, t, WINDOWS.heartbeatMs)) {
    pinAt = pinAt === null ? Number(p.heartbeat.at) : Math.max(pinAt, Number(p.heartbeat.at))
  }
  if (pinAt !== null) sources.push('E4')
  const pinConfigured = !!(p && p.configured === true)

  let tier = null
  let label = LABELS.nobody
  let params = {}
  let checkedAt = null
  let reported = false
  if (pinAt !== null || wsAt !== null) {
    tier = pinAt !== null ? 'E4' : 'E3'
    checkedAt = Math.max(pinAt === null ? -Infinity : pinAt, wsAt === null ? -Infinity : wsAt)
    label = LABELS.keptBySite
    params = { age: Math.max(0, t - checkedAt) }
  } else if (e0 && count > 0) {
    tier = checkedCount > 0 ? 'E2' : 'E1'
    checkedAt = holdersAt
    label = LABELS.heldBy
    params = { n: count }
    reported = checkedCount < count
  } else if (e0) {
    tier = 'E0'
    checkedAt = local && typeof local === 'object' && num(local.at) !== null ? Number(local.at) : t
    label = LABELS.onlyHere
  } else if (count > 0) {
    // Others hold it and this device does not: available only while one of them is online (no always-on copy
    // of this item exists for the site). The table has no "held by others" sentence; avail.noPin is the true one.
    tier = checkedCount > 0 ? 'E2' : 'E1'
    checkedAt = holdersAt
    label = LABELS.noPin
    params = { n: count }
    reported = checkedCount < count
  }
  const notes = []
  if (!pinConfigured && label !== LABELS.keptBySite && label !== LABELS.noPin) notes.push(LABELS.noPin)
  return { tier, count, atLeast: count > 0 && atLeast, reported, checkedAt, label, params, local: e0, sources, notes }
}

/**
 * availableOf(ev) -> the v0.3 SDK value: 'kept' only with E3 or E4 evidence ("Kept by the site"), 'online' when
 * this device or a live holder has every piece, 'unknown' otherwise. A ws field or a pinned flag alone is no longer
 * 'kept' (S1 F8).
 */
export function availableOf (ev) {
  if (!ev || typeof ev !== 'object') return 'unknown'
  if (ev.label === LABELS.keptBySite) return 'kept'
  if (ev.local || ev.count > 0) return 'online'
  return 'unknown'
}

/** publicEvidence(ev) -> { tier, count, atLeast, reported, checkedAt }: the object the SDK passes to sites. */
export function publicEvidence (ev) {
  const e = ev && typeof ev === 'object' ? ev : {}
  return {
    tier: TIERS.indexOf(e.tier) >= 0 ? e.tier : null,
    count: Number.isSafeInteger(e.count) && e.count > 0 ? e.count : 0,
    atLeast: e.atLeast === true,
    reported: e.reported === true,
    checkedAt: num(e.checkedAt)
  }
}

/**
 * handoffState({ ev, requested, pinPct }) -> { state, label, params } for an item this person uploaded (SZ 3.1.5):
 *   kept      "Kept by the site" (E3 or E4)
 *   sending   an authenticated pin wire is fetching it: "Sending to the site: {pct}%"
 *   waiting   a pin request is queued: "Waiting for the site to accept it."
 *   sent      a peer holds every piece (no pin yet): the heldBy label (noPin when this device holds no copy); the
 *             MF-45 card text "Sent: one full copy reached {name}" (CARD_TEXT sentOnPhone) stays the loader's for peers
 *   onlyHere  "Only on this device. Keep this page open until it is sent." (this device holds every piece)
 *   nobody    this device holds no copy and no holder is known (an own item restored on another device)
 * pinPct is the share of the item the authenticated pin wire reports (0 to 100) or null.
 */
export function handoffState (args) {
  const a = args && typeof args === 'object' ? args : {}
  const e = a.ev && typeof a.ev === 'object' ? a.ev : evidence({})
  if (e.label === LABELS.keptBySite) return { state: 'kept', label: LABELS.keptBySite, params: Object.assign({}, e.params) }
  const pct = num(a.pinPct)
  if (pct !== null) return { state: 'sending', label: HANDOFF_LABELS.sending, params: { pct: Math.max(0, Math.min(100, Math.floor(pct))) } }
  if (a.requested === true) return { state: 'waiting', label: HANDOFF_LABELS.waiting, params: {} }
  if (e.count > 0) return { state: 'sent', label: e.local ? LABELS.heldBy : e.label, params: { n: e.count } }
  if (!e.local) return { state: 'nobody', label: e.label, params: Object.assign({}, e.params) }
  return { state: 'onlyHere', label: LABELS.onlyHere, params: {} }
}

/** sameEvidence(a, b) -> true when the two would show the same label and counts (no 'evidence' event needed). */
export function sameEvidence (a, b) {
  if (!a || !b) return a === b
  return a.tier === b.tier && a.count === b.count && a.atLeast === b.atLeast && a.reported === b.reported &&
    a.label === b.label && a.local === b.local
}

/** isLabel(key) -> true for one of the SZ 3.1.5 availability label keys. */
export function isLabel (key) {
  return LABEL_VALUES.has(key)
}
