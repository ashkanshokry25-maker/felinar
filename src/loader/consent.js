// src/loader/consent.js: the consent rules shared by the shell (app.js) and drop-in mode (src/dropin/engine.js)
// as pure functions (v0.2.1 DIGEST-AMENDMENTS C1; ARCHITECTURE §8; production digest D18, P0-17; research
// w2b-06 R1). The card itself is UI (shell ui.js, drop-in panel.js); this module decides which card, what a
// stored choice means and what a new record holds. Node and browsers.
//
//   consentModeFor   'gate' | 'notice' from consent= and aud= (an EEA, UK, Quebec or personal-data audience gates)
//   recipientsKey    the third parties a "Share and load" covers (tracker and STUN hosts)
//   makeConsentRecord / consentFromRecord / dnsAllowedBy   the versioned record { v, choice, dns, day, scope, rcpt }
//   consentKeyFor    its prefs key: per origin ('consent'), per ledger only on the shared demo hub

import { CONFIG } from './config.js'
import { announceListFor } from './torrent.js'
import { stunUrlsOf } from './connectivity.js'

/** audienceOf(record) → the lowercase tokens of the pointer's aud= key (kept and signed by pointer.js). */
export function audienceOf (record) {
  const r = record || {}
  let raw = typeof r.aud === 'string' ? r.aud : (r.extra && typeof r.extra.aud === 'string' ? r.extra.aud : '')
  try { raw = decodeURIComponent(raw) } catch (_) { /* keep as is */ }
  return String(raw).toLowerCase().split(/[\s,+|/]+/).filter(Boolean)
}

/**
 * consentModeFor(record, config) → 'gate' | 'notice'. An explicit consent=gate or consent=notice is the
 * owner's choice; without one, a gate token in aud= (ARCHITECTURE §4, code review round 1: personal data
 * or an EEA, UK or Quebec audience, kids or sensitive content: personal, eea, eu, uk, qc, quebec, kids,
 * sensitive) makes the blocking gate the default; general and unknown tokens do not. The region is never
 * inferred from the browser.
 */
export function consentModeFor (record, config = CONFIG) {
  const consent = record && typeof record.consent === 'string' ? record.consent.trim().toLowerCase() : ''
  if (consent === 'gate') return 'gate'
  if (consent === 'notice') return 'notice'
  const gateAud = (config.consent && config.consent.gateAudiences) || []
  return audienceOf(record).some((t) => gateAud.includes(t)) ? 'gate' : 'notice'
}

/**
 * recipientsKey(record, config) → the third parties a "Share and load" covers: tracker and STUN host
 * names, sorted and joined. A stored choice with other recipients is asked again.
 */
export function recipientsKey (record, config = CONFIG) {
  const hosts = new Set()
  for (const url of announceListFor(record || {}, config.trackers)) {
    try { hosts.add(new URL(url).host.toLowerCase()) } catch (_) { /* skip */ }
  }
  for (const u of stunUrlsOf(config.stun)) hosts.add(String(u).replace(/^stuns?:/i, '').toLowerCase())
  return Array.from(hosts).sort().join(',')
}

/**
 * makeConsentRecord({ choice, dns, scope, rcpt, now, config }) → { v, choice, dns, day, scope, rcpt }:
 * the versioned consent record stored per origin (per ledger on the shared demo hub). day has day
 * precision; dns says the visitor allowed the DNS-over-HTTPS lookup ("Share and load" always does).
 */
export function makeConsentRecord ({ choice, dns = false, scope = null, rcpt = '', now = Date.now(), config = CONFIG } = {}) {
  return { v: config.consent.version, choice, dns: !!(dns || choice === 'accepted'), day: new Date(now).toISOString().slice(0, 10), scope, rcpt: rcpt || '' }
}

/**
 * consentFromRecord(record, { rcpt, config }) → 'accepted' | 'host-only' | 'pending'. A record of another
 * version (the card text or the recipients' rules changed) is 'pending'; so is an 'accepted' record whose
 * recipients differ from rcpt. v0.2 records (a bare string per ledger) are never read: the card changed.
 */
export function consentFromRecord (record, { rcpt = null, config = CONFIG } = {}) {
  if (!record || typeof record !== 'object' || record.v !== config.consent.version) return 'pending'
  if (record.choice !== 'accepted' && record.choice !== 'host-only') return 'pending'
  if (record.choice === 'accepted' && rcpt !== null && record.rcpt !== rcpt) return 'pending'
  return record.choice
}

/** dnsAllowedBy(record, config) → may the DoH lookup run without asking (C1)? */
export function dnsAllowedBy (record, config = CONFIG) {
  return !!(record && typeof record === 'object' && record.v === config.consent.version && (record.dns === true || record.choice === 'accepted'))
}

/** The prefs key of the consent record: per origin, except the shared demo hub (one origin, many sites). */
export function consentKeyFor (mode, ledgerId) {
  return mode === 'hub-shared' ? 'consent:' + (ledgerId || '') : 'consent'
}
