// Unit tests for the shell's consent rules (v0.2.1 DIGEST-AMENDMENTS C1; production digest D18, P0-17;
// research digest D33, P0-10, P1-7): the consent mode (consent= and aud=), the versioned consent record per
// origin, and no DNS-over-HTTPS lookup before a choice.
// Run: node --test test/unit/loader-app-consent.test.mjs
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import {
  consentModeFor, audienceOf, recipientsKey, makeConsentRecord, consentFromRecord, dnsAllowedBy, consentKeyFor, resolvePointer
} from '../../src/loader/app.js'
import { CONFIG } from '../../src/loader/config.js'
import { STRINGS } from '../../src/loader/strings.js'

const ROOT = fileURLToPath(new URL('../../', import.meta.url))
const BTIH = 'ab'.repeat(20)

test('consent mode: consent=gate and consent=notice are the owner\'s; otherwise aud= decides (C1)', () => {
  assert.equal(consentModeFor({ consent: 'gate' }), 'gate')
  assert.equal(consentModeFor({ consent: 'notice', aud: 'eea' }), 'notice', 'an explicit notice is the owner\'s documented choice')
  assert.equal(consentModeFor({}), 'notice')
  assert.equal(consentModeFor({ aud: 'general' }), 'notice')
  for (const aud of ['personal', 'eea', 'EU', 'uk', 'qc', 'quebec', 'sensitive', 'kids', 'general,eea', 'general+uk']) {
    assert.equal(consentModeFor({ aud }), 'gate', aud)
  }
  assert.equal(consentModeFor({ extra: { aud: 'qc' } }), 'gate', 'aud= kept as an unknown key by a v0.2 parser')
  assert.equal(consentModeFor({ aud: 'eea%2Cuk' }), 'gate', 'percent-encoded values are decoded once')
  assert.deepEqual(audienceOf({ aud: 'General, EEA' }), ['general', 'eea'])
})

test('the consent record is versioned, per origin, day precision, and names its recipients', () => {
  const rec = makeConsentRecord({ choice: 'accepted', scope: 'https://site.example', rcpt: 'a,b', now: Date.UTC(2026, 9, 19, 17, 5) })
  assert.deepEqual(rec, { v: CONFIG.consent.version, choice: 'accepted', dns: true, day: '2026-10-19', scope: 'https://site.example', rcpt: 'a,b' })
  assert.equal(makeConsentRecord({ choice: 'host-only' }).dns, false, 'host only does not allow the DoH lookup by itself')
  assert.equal(makeConsentRecord({ choice: 'host-only', dns: true }).dns, true, 'unless the visitor allowed it in the DNS card')
  assert.equal(consentKeyFor('shell', 'mw1:x'), 'consent', 'per origin')
  assert.equal(consentKeyFor('hub-sub', 'mw1:x'), 'consent', 'a hub label is its own origin')
  assert.equal(consentKeyFor('hub-shared', 'mw1:x'), 'consent:mw1:x', 'the shared demo hub keeps one choice per site')
})

test('a stored choice counts only with the current version; an accepted choice is asked again when recipients change', () => {
  const rcpt = recipientsKey({ signed: true, tr: ['wss://t.example'] })
  const accepted = makeConsentRecord({ choice: 'accepted', rcpt })
  assert.equal(consentFromRecord(accepted, { rcpt }), 'accepted')
  assert.equal(consentFromRecord(accepted, { rcpt: rcpt + ',new.example' }), 'pending', 'new recipients: ask again')
  assert.equal(consentFromRecord(Object.assign({}, accepted, { v: CONFIG.consent.version - 1 }), { rcpt }), 'pending', 'a version bump re-asks')
  assert.equal(consentFromRecord('accepted', { rcpt }), 'pending', 'v0.2 records (a bare string) are not reused')
  assert.equal(consentFromRecord(null), 'pending')
  const hostOnly = makeConsentRecord({ choice: 'host-only', rcpt })
  assert.equal(consentFromRecord(hostOnly, { rcpt: 'other' }), 'host-only', 'a refusal involves no recipients')
  assert.equal(dnsAllowedBy(accepted), true)
  assert.equal(dnsAllowedBy(hostOnly), false)
  assert.equal(dnsAllowedBy(null), false)
})

test('recipients: tracker hosts of the pointer (defaults only when unsigned) and the STUN operators', () => {
  const signed = recipientsKey({ signed: true, tr: ['wss://t.example/announce', 'wss://u.example'] })
  assert.equal(signed, ['global.stun.twilio.com:3478', 'stun.cloudflare.com:3478', 't.example', 'u.example'].sort().join(','))
  const unsigned = recipientsKey({ signed: false, tr: [] })
  for (const t of CONFIG.trackers) assert.ok(unsigned.includes(new URL(t).host))
})

// ---- no DoH before consent -------------------------------------------------------------------------

function deps ({ cachedAnswer = null, cachedPointer = null, records = {} } = {}) {
  const calls = { resolveTxt: 0 }
  const prefs = new Map()
  if (cachedAnswer) prefs.set('dns:site.example', cachedAnswer)
  return {
    calls,
    prefs,
    parsePointer: (text) => {
      const m = /btih=([0-9a-f]{40})/.exec(text)
      return m ? { ok: true, record: { v: 'mw1', btih: m[1], signed: false, raw: text, tr: [], ws: ['https://site.example/ws/'], xs: [] } } : { ok: false, error: 'no btih' }
    },
    verifyPointer: async () => ({ ok: true }),
    verifyRotation: async () => false,
    ledgerIdFor: async (record) => 'btih:' + record.btih,
    pickRecord: (list) => list[0],
    joinTxtData: (t) => t.replace(/^"|"$/g, ''),
    resolveTxt: async () => { calls.resolveTxt++; return { resolver: 'cloudflare', strings: [records.dns || 'v=mw1; btih=' + 'cd'.repeat(20)], ad: false, ttl: 300 } },
    shouldSkipDoh: () => false,
    cache: {
      getPin: async () => null,
      savePin: async () => {},
      getPointer: async () => cachedPointer,
      savePointer: async () => {},
      getPref: async (k, d) => (prefs.has(k) ? prefs.get(k) : d),
      setPref: async (k, v) => { prefs.set(k, v) }
    }
  }
}

const ctx = (extra) => Object.assign({ mode: 'shell', scope: 'site.example', dnsHost: 'site.example', now: Date.now(), config: CONFIG }, extra)

test('C1: with a page tag and no choice yet, the site resolves from <meta> and the DoH lookup waits (no request)', async () => {
  const d = deps()
  const r = await resolvePointer(ctx({ metaText: 'v=mw1; btih=' + BTIH, blockOnDns: false, dohAllowed: false }), d)
  assert.equal(r.source, 'meta')
  assert.equal(d.calls.resolveTxt, 0)
  assert.equal(r.dnsDeferred, true)
  assert.equal(r.dnsNeedsConsent, true)
})

test('C1: a DNS-only site with nothing cached throws E_NEEDS_CONSENT instead of asking a resolver', async () => {
  const d = deps()
  await assert.rejects(resolvePointer(ctx({ blockOnDns: true, dohAllowed: false }), d), { code: 'E_NEEDS_CONSENT' })
  assert.equal(d.calls.resolveTxt, 0)
})

test('C1: a cached pointer or a cached DNS answer (local data) still resolves without a lookup', async () => {
  const cachedPointer = { record: { btih: BTIH, signed: false }, raw: 'v=mw1; btih=' + BTIH, source: 'dns' }
  const d1 = deps({ cachedPointer })
  const r1 = await resolvePointer(ctx({ blockOnDns: true, dohAllowed: false }), d1)
  assert.equal(r1.source, 'cache')
  assert.equal(d1.calls.resolveTxt, 0)
  const d2 = deps({ cachedAnswer: { strings: ['v=mw1; btih=' + BTIH], ttlUntil: Date.now() + 60000 } })
  const r2 = await resolvePointer(ctx({ blockOnDns: true, dohAllowed: false }), d2)
  assert.equal(r2.source, 'dns')
  assert.equal(d2.calls.resolveTxt, 0)
})

test('C1: after a choice that allows it, the DoH lookup runs', async () => {
  const d = deps()
  const r = await resolvePointer(ctx({ blockOnDns: true, dohAllowed: true }), d)
  assert.equal(d.calls.resolveTxt, 1)
  assert.equal(r.source, 'dns')
})

test('the first-run card offers a same-layer refusal and the shell has no consent path before it', () => {
  assert.equal(STRINGS.consentShare, 'Share and load')
  assert.equal(STRINGS.consentHostOnly, 'Load from host only')
  for (const k of ['consentTitle', 'consentText', 'consentChoice', 'consentMobile', 'consentDns']) {
    assert.equal(typeof STRINGS[k], 'string', k)
    assert.doesNotMatch(STRINGS[k], /[–—“”]/, k + ' uses no dashes or curly quotes')
  }
  assert.doesNotMatch(STRINGS.consentText, /offline/i, 'no offline promise (iOS clears storage)')
  const app = readFileSync(ROOT + 'src/loader/app.js', 'utf8')
  assert.doesNotMatch(app, /showNotice\(/, 'the v0.2 [Settings] [OK] notice is gone from the shell')
  // persist() is requested only from the consent click (digest P1-7): never in afterRender.
  const after = app.slice(app.indexOf('function afterRender (A) {'), app.indexOf('function checkPageTagUpdate') > 0 ? app.indexOf('async function checkPageTagUpdate') : undefined)
  assert.doesNotMatch(after, /requestPersist/)
})

test('code review round 1: the aud= token table, one definition: every token pinned', async () => {
  const { AUDIENCES } = await import('../../src/common/pointer.js')
  const gate = ['personal', 'eea', 'eu', 'uk', 'qc', 'quebec', 'kids', 'sensitive']
  assert.deepEqual(CONFIG.consent.gateAudiences.slice().sort(), gate.slice().sort())
  for (const t of gate) assert.equal(consentModeFor({ aud: t }), 'gate', t)
  assert.equal(consentModeFor({ aud: 'general' }), 'notice', 'general has no effect')
  assert.equal(consentModeFor({ aud: 'unknown-token' }), 'notice', 'unknown tokens are ignored')
  assert.equal(consentModeFor({}), 'notice')
  assert.equal(consentModeFor({ aud: 'general,KIDS' }), 'gate', 'any gate token in the list, any case')
  assert.equal(consentModeFor({ aud: 'kids', consent: 'notice' }), 'notice', 'an explicit consent= is the owner\'s choice')
  assert.deepEqual(AUDIENCES.slice().sort(), ['general', 'kids', 'sensitive'], 'the content classes')
  const pointerSource = readFileSync(new URL('../../src/common/pointer.js', import.meta.url), 'utf8')
  assert.equal(/kids forces host-only/.test(pointerSource), false, 'no claim nothing implements')
})

// Post-wave fix B: a shell page with a page tag still asks DNS-over-HTTPS for updates after "Share and load"
// (scheduleUpdateCheck), so the card and the gate name the service that choice covers.
test('post-wave fix B: the card and the gate name the DNS-over-HTTPS service when the page will ask it for updates', async () => {
  const { __test } = await import('../../src/loader/app.js')
  const { shouldSkipDoh, dohOverrideFromMeta } = await import('../../src/loader/doh.js')
  const metaDoc = (content) => ({ querySelector: (sel) => (content && sel === 'meta[name="mw-doh"]' ? { getAttribute: () => content } : null) })
  const fakeA = (dnsHost, override = null) => {
    const ui = { cards: [], gates: [] }
    ui.showConsentCard = (o) => { ui.cards.push(o); return () => {} }
    ui.showGate = (o) => { ui.gates.push(o); return () => {} }
    ui.setStatus = () => {}
    ui.setBanner = () => {}
    return { ui, dnsHost, doc: metaDoc(override), deps: { doh: { shouldSkipDoh, dohOverrideFromMeta } }, record: { btih: BTIH, ws: ['https://site.example/ws/'] }, mode: { mode: 'shell' }, env: {}, consentWaiters: { settle: () => 0 }, config: CONFIG, win: { location: {} } }
  }
  const pub = fakeA('www.example.com')
  __test.showConsentCard(pub)
  assert.equal(pub.ui.cards[0].dnsUpdate, true, 'a public hostname: the card names the resolvers')
  assert.equal(pub.ui.cards[0].dohHost, null, 'the loader\'s own resolvers')
  __test.openGate(pub)
  await new Promise((r) => setImmediate(r))
  assert.equal(pub.ui.gates[0].dnsUpdate, true, 'the gate too')
  for (const host of ['localhost', '127.0.0.1', 'printer.local', 'site.example', null]) {
    const A = fakeA(host)
    __test.showConsentCard(A)
    assert.equal(A.ui.cards[0].dnsUpdate, false, String(host) + ' is never looked up, so the card does not name a resolver')
  }
  const own = fakeA('www.example.com', 'https://doh.example.net/dns-query?name={name}&type={type}')
  __test.showConsentCard(own)
  assert.equal(own.ui.cards[0].dohHost, 'doh.example.net', '<meta name="mw-doh"> names the only resolver asked')
  __test.askBeforeDns(own)
  assert.equal(own.ui.cards[1].dns, true)
  assert.equal(own.ui.cards[1].dohHost, 'doh.example.net', 'the DNS-only card names it as well')
  // The texts: who, what, when; the override replaces the default names; the same character rules.
  assert.match(STRINGS.consentDnsUpdate, /If you choose to share, your browser also asks a DNS-over-HTTPS service \(Cloudflare, dns\.sb or Google\)/)
  assert.match(STRINGS.consentDnsUpdate, /at most once a minute while this page is open/)
  assert.match(STRINGS.consentDnsUpdate, /sees your IP address and the name of this site/)
  assert.match(STRINGS.gateDnsUpdate, /DNS-over-HTTPS service \(Cloudflare, dns\.sb or Google\)/)
  assert.match(STRINGS.consentDnsAgain, /whichever you choose/)
  const named = STRINGS.dohNamed(STRINGS.consentDnsUpdate, 'doh.example.net')
  assert.match(named, /service \(doh\.example\.net\)/)
  assert.doesNotMatch(named, /Cloudflare/)
  assert.equal(STRINGS.dohNamed(STRINGS.consentDns, null), STRINGS.consentDns)
  for (const k of ['consentDnsUpdate', 'gateDnsUpdate', 'consentDnsAgain']) assert.doesNotMatch(STRINGS[k], /[–—“”]/, k)
  // ui.js shows them: the update sentence on the card and the gate, the "asks again" sentence on the DNS-only card.
  const ui = readFileSync(ROOT + 'src/loader/ui.js', 'utf8')
  assert.match(ui, /if \(dnsUpdate\) gateO\.box\.appendChild\(el\('p', \{ class: 'mw-consent-dns', text: S\.dohNamed\(S\.gateDnsUpdate, dohHost\) \}\)\)/)
  assert.match(ui, /S\.dohNamed\(S\.consentDnsUpdate, dohHost\)/)
  assert.match(ui, /text: S\.consentDnsAgain/)
})

test('code review round 3 (N1): after a re-ask, "Load from host only" stores dns: false on a page-tag site and keeps dns: true on a DNS-only site', async () => {
  const { __test } = await import('../../src/loader/app.js')
  const { makeConsentRecord, consentFromRecord, dnsAllowedBy, recipientsKey } = await import('../../src/loader/consent.js')
  const fakeA = (dnsNeedsConsent) => {
    const prefs = new Map()
    const record = { btih: BTIH, signed: false, tr: ['wss://new.example/announce'], ws: [], xs: [] }
    const old = makeConsentRecord({ choice: 'accepted', rcpt: 'old-recipients', config: CONFIG })
    const cache = { getPref: async (k, d) => (prefs.has(k) ? prefs.get(k) : d), setPref: async (k, v) => { prefs.set(k, v) } }
    return { prefs, record, consentRecord: old, resolved: { dnsNeedsConsent }, mode: { mode: 'shell' }, origin: 'https://site.example', ledgerId: null, config: CONFIG, deps: { cache } }
  }
  const page = fakeA(true)
  assert.equal(consentFromRecord(page.consentRecord, { rcpt: recipientsKey(page.record, CONFIG), config: CONFIG }), 'pending', 'the recipients changed, so the card asks again')
  assert.equal(dnsAllowedBy(page.consentRecord, CONFIG), true, 'the earlier accepted record allowed the lookup')
  const rec = await __test.saveConsentRecord(page, 'host-only')
  assert.equal(rec.dns, false, 'page-tag site: host only stores dns: false, whatever the earlier record said')
  assert.equal(dnsAllowedBy(page.prefs.get('consent'), CONFIG), false, 'so no update check may run')
  const dnsOnly = fakeA(false)
  const rec2 = await __test.saveConsentRecord(dnsOnly, 'host-only')
  assert.equal(rec2.dns, true, 'DNS-only site: either choice allows the lookup that resolves the pointer, so the permission carries over')
})
