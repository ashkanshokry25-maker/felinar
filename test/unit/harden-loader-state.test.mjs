// harden-loader (v0.3, V03-DESIGN-REVIEW MF-28, MF-30, MF-31, MF-76, 2.8.8, 2.17.5): loader state helpers.
// TTL and timer clamps, the AD wording, signed pins and refusals (per-device non-extractable key, 7-day refusals),
// withdrawals (30 days, re-sign), read-only ownerless hub ledgers, rotationDecision, loaderFloorOk,
// '#host:name@<fp>' links, pslHubCheck, storage lines and the web-seed filter for every forbidden host class.
// Run: node --test test/unit/harden-loader-state.test.mjs
import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'

import {
  createDeviceKey, signPin, verifyPin, signRefusal, verifyRefusal, withdrawalState, isReadOnlyHubLedger,
  rotationDecision, loaderFloorOk, compareVersions, parseHostFingerprintLink, ownerFingerprint, fingerprintMatches,
  pslHubCheck, publicSuffixOf, clampTimerMs, clampTtlSeconds, MAX_TIMER_MS, AD_WORDING,
  REFUSAL_TTL_MS, WITHDRAWAL_MAX_MS, ROTATION_DELAY_MS
} from '../../src/loader/harden.js'
import { ttlUntil, resolveTxt, MIN_TTL_SECONDS, MAX_TTL_SECONDS } from '../../src/loader/doh.js'
import { filterWebseeds, isPublicWebHost, WEBSEED_MAX_WS, WEBSEED_MAX_XS } from '../../src/common/magnet.js'
import { parsePointer, formatPointer, signPointer, withdrawalRecord, nextKeyCommitment } from '../../src/common/pointer.js'
import { storageLines, ledgerBudgetFor } from '../../src/loader/policy.js'
import { CONFIG } from '../../src/loader/config.js'
import { generateKeyPair, exportPublicKey } from '../../src/chain/crypto.js'

const NOW = Date.UTC(2026, 9, 20, 12, 0, 0)
const NOW_S = Math.floor(NOW / 1000)
const DAY = 86400000
const BTIH = 'a'.repeat(40)

async function key () {
  const kp = await generateKeyPair()
  return { privateKey: kp.privateKey, pub: await exportPublicKey(kp.publicKey) }
}

// ---- DNS TTL and timers (MF-30) -------------------------------------------------------------------------------

test('TTL clamp: 5 min to 1 day whatever the resolver says; the bounds cannot be widened', () => {
  assert.equal(MIN_TTL_SECONDS, 300)
  assert.equal(MAX_TTL_SECONDS, 86400)
  for (const [ttl, want] of [[0, 300], [-5, 300], [NaN, 300], [null, 300], ['9999', 300], [60, 300], [3600, 3600], [86400, 86400], [2 ** 31, 86400], [Infinity, 300], [Number.MAX_SAFE_INTEGER, 86400]]) {
    assert.equal(clampTtlSeconds(ttl), want, String(ttl))
  }
  assert.equal(clampTtlSeconds(10, { min: 1 }), 300, 'min below 5 min is raised')
  assert.equal(clampTtlSeconds(10 ** 9, { max: 10 ** 9 }), 86400, 'max above 1 day is lowered')
  assert.equal(ttlUntil(2 ** 40, NOW), NOW + 86400 * 1000)
  assert.equal(ttlUntil(1, NOW), NOW + 300 * 1000)
  assert.equal(CONFIG.pointer.maxTtlMs, 86400000)
})

test('timer clamp: never above 2^31 - 1 ms (larger delays fire at once), NaN and negatives become the floor', () => {
  assert.equal(MAX_TIMER_MS, 2 ** 31 - 1)
  assert.equal(clampTimerMs(2 ** 31), MAX_TIMER_MS)
  assert.equal(clampTimerMs(400 * DAY), MAX_TIMER_MS, 'a 400-day record expiry')
  assert.equal(clampTimerMs(Infinity), MAX_TIMER_MS)
  assert.equal(clampTimerMs(NaN), 0)
  assert.equal(clampTimerMs(-1), 0)
  assert.equal(clampTimerMs('1500'), 1500)
  assert.equal(clampTimerMs(1.7), 1)
  assert.equal(clampTimerMs(-1, { min: 1000 }), 1000)
  assert.equal(CONFIG.harden.maxTimerMs, MAX_TIMER_MS)
})

test('AD flag: reported as the words "resolver says validated", never as a badge field', async () => {
  assert.equal(AD_WORDING, 'resolver says validated')
  const answer = (ad) => async () => ({ status: 200, text: async () => JSON.stringify({ Status: 0, AD: ad, Answer: [{ type: 16, TTL: 60, data: '"v=mw1"' }] }) })
  const yes = await resolveTxt('_magnet.example.com', { fetch: answer(true) })
  assert.equal(yes.ad, true)
  assert.equal(yes.adWording, 'resolver says validated')
  assert.equal(yes.ttl, 60, 'the raw TTL is reported; callers clamp it')
  const no = await resolveTxt('_magnet.example.com', { fetch: answer(false) })
  assert.equal(no.adWording, null)
  // A hostile timeout value does not overflow the guard timer (it would fire at once).
  const slow = await resolveTxt('_magnet.example.com', { fetch: answer(false), timeoutMs: 2 ** 40 })
  assert.equal(slow.status, 0)
})

// ---- signed pins and refusals (MF-30) -------------------------------------------------------------------------

test('device key: ECDSA P-256, the private half is non-extractable', async () => {
  const dk = await createDeviceKey()
  assert.equal(dk.privateKey.extractable, false)
  assert.equal(dk.privateKey.algorithm.name, 'ECDSA')
  assert.match(dk.pub, /^p256:/)
  await assert.rejects(globalThis.crypto.subtle.exportKey('jwk', dk.privateKey))
})

test('pins are signed by the device key: a rewritten pin, another device or another scope fails', async () => {
  const dk = await createDeviceKey()
  const other = await createDeviceKey()
  const owner = await key()
  const thief = await key()
  const pin = await signPin(dk, { scope: 'Example.COM', owner: owner.pub, seq: NOW_S, now: NOW })
  assert.equal(pin.scope, 'example.com')
  assert.equal(pin.firstSeen, NOW)
  assert.deepEqual(await verifyPin(pin, dk.pub, { scope: 'example.com' }), { ok: true, reason: null })
  assert.equal((await verifyPin(Object.assign({}, pin, { owner: thief.pub }), dk.pub)).reason, 'bad-sig', 'same-origin code swapped the key')
  assert.equal((await verifyPin(Object.assign({}, pin, { seq: 0 }), dk.pub)).reason, 'bad-sig', 'or lowered the floor')
  assert.equal((await verifyPin(pin, other.pub)).reason, 'other-device')
  assert.equal((await verifyPin(Object.assign({}, pin, { by: other.pub }), other.pub)).reason, 'bad-sig')
  assert.equal((await verifyPin(pin, dk.pub, { scope: 'shop.example' })).reason, 'other-scope')
  assert.equal((await verifyPin(null, dk.pub)).reason, 'malformed')
  await assert.rejects(signPin({ privateKey: null, pub: dk.pub }, { scope: 'x.example', owner: owner.pub }), TypeError)
})

test('refusals expire after 7 days, are signed, and cannot be stretched', async () => {
  const dk = await createDeviceKey()
  const k = await key()
  assert.equal(REFUSAL_TTL_MS, 7 * DAY)
  const r = await signRefusal(dk, { scope: 'example.com', owner: k.pub, now: NOW })
  assert.equal(r.exp, NOW + 7 * DAY)
  assert.equal((await verifyRefusal(r, dk.pub, { now: NOW + 6 * DAY, scope: 'example.com' })).ok, true)
  assert.equal((await verifyRefusal(r, dk.pub, { now: NOW + 7 * DAY })).reason, 'expired')
  const long = await signRefusal(dk, { scope: 'example.com', owner: k.pub, now: NOW, ttlMs: 365 * DAY })
  assert.equal(long.exp, NOW + 7 * DAY, 'a longer ttl is clamped to 7 days')
  assert.equal((await verifyRefusal(Object.assign({}, r, { exp: NOW + 30 * DAY }), dk.pub, { now: NOW })).reason, 'too-long')
  assert.equal((await verifyRefusal(Object.assign({}, r, { exp: NOW + 6 * DAY }), dk.pub, { now: NOW })).reason, 'bad-sig')
  assert.equal((await verifyRefusal(r, dk.pub, { now: NOW, scope: 'other.example' })).reason, 'other-scope')
  assert.equal((await verifyRefusal({ v: 1 }, dk.pub)).reason, 'malformed')
})

// ---- withdrawals, hubs ------------------------------------------------------------------------------------------

test('withdrawals bind at most 30 days after signing (seq) and are due for re-signing a week before', async () => {
  assert.equal(WITHDRAWAL_MAX_MS, 30 * DAY)
  const k = await key()
  const make = async (seqS, expS) => parsePointer(formatPointer(await signPointer(withdrawalRecord({ owner: k.pub, seq: seqS, exp: expS }), 'example.com', k.privateKey))).record
  const w = await make(NOW_S, NOW_S + 90 * 86400)
  const s0 = withdrawalState(w, { now: NOW })
  assert.equal(s0.binding, true)
  assert.equal(s0.expiresAt, NOW + 30 * DAY, 'min(exp, seq + 30 days)')
  assert.equal(s0.tooLong, true, 'exp more than 30 days after seq')
  assert.equal(s0.resignDue, false)
  assert.equal(withdrawalState(w, { now: NOW + 24 * DAY }).resignDue, true)
  assert.equal(withdrawalState(w, { now: NOW + 30 * DAY }).binding, false, 'a replayed old withdrawal stops binding')
  const short = await make(NOW_S, NOW_S + 10 * 86400)
  assert.equal(withdrawalState(short, { now: NOW }).expiresAt, NOW + 10 * DAY)
  assert.equal(withdrawalState(short, { now: NOW }).tooLong, false)
  assert.equal(withdrawalState(short, { now: NOW, maxMs: 365 * DAY }).expiresAt, NOW + 10 * DAY, 'maxMs cannot widen 30 days')
  assert.equal(withdrawalState({ withdrawn: false, seq: NOW_S, exp: NOW_S + 1 }).binding, false, 'not a withdrawal')
})

test('isReadOnlyHubLedger: ownerless ledgers are read-only on hubs only', async () => {
  const k = await key()
  const signed = parsePointer(formatPointer(await signPointer({ btih: BTIH, owner: k.pub, seq: 1, exp: NOW_S + 86400 }, 'example.com', k.privateKey))).record
  const unsigned = parsePointer('magnet:?xt=urn:btih:' + BTIH).record
  assert.equal(isReadOnlyHubLedger({ hub: true, record: unsigned }), true)
  assert.equal(isReadOnlyHubLedger({ hub: true, record: signed, ledgerId: 'btih:' + BTIH }), true)
  assert.equal(isReadOnlyHubLedger({ hub: true, record: signed, ledgerId: 'mw1:abc' }), false)
  assert.equal(isReadOnlyHubLedger({ hub: false, record: unsigned }), false)
  assert.equal(isReadOnlyHubLedger({ hub: true, record: null }), true)
})

test('pslHubCheck: persistent identity only on a host exactly one label under a listed public suffix', () => {
  const psl = ['hub.example', 'github.io', '*.ck', '!www.ck', '// comment']
  assert.deepEqual(pslHubCheck('alice.hub.example', psl), { persistentIdentity: true, listed: true, publicSuffix: 'hub.example', registrable: 'alice.hub.example' })
  assert.equal(pslHubCheck('Alice.Hub.Example.', psl).persistentIdentity, true, 'normalized')
  assert.equal(pslHubCheck('alice.other-hub.example', psl).persistentIdentity, false, 'a hub that is not on the PSL')
  assert.equal(pslHubCheck('alice.other-hub.example', psl).registrable, 'other-hub.example')
  assert.equal(pslHubCheck('a.b.hub.example', psl).persistentIdentity, false, 'two labels deep shares b.hub.example')
  assert.equal(pslHubCheck('hub.example', psl).persistentIdentity, false, 'the hub itself')
  assert.equal(pslHubCheck('127.0.0.1', psl).persistentIdentity, false)
  assert.equal(pslHubCheck('', psl).persistentIdentity, false)
  assert.equal(pslHubCheck('alice.hub.example', []).persistentIdentity, false, 'no list, no persistent identity')
  assert.equal(publicSuffixOf('foo.bar.ck', psl), 'bar.ck', 'wildcard')
  assert.equal(publicSuffixOf('www.ck', psl), 'ck', 'exception')
  assert.equal(publicSuffixOf('x.y.github.io', psl), 'github.io')
})

// ---- owner key changes (MF-28) ----------------------------------------------------------------------------------

test('rotationDecision: accept, delay or confirm, with the "owner changed N minutes ago" inputs', async () => {
  const k1 = await key()
  const k2 = await key()
  const k3 = await key()
  const nx2 = await nextKeyCommitment(k2.pub)
  const prev = { owner: k1.pub, seq: NOW_S - 86400 }
  const next = { owner: k2.pub, lo: k1.pub, rot: 'x', seq: NOW_S - 600 }
  assert.equal(ROTATION_DELAY_MS, DAY)
  assert.equal((await rotationDecision({ prev, next: { owner: k1.pub, seq: NOW_S }, now: NOW })).decision, 'accept')
  // Returning visitor: a vouched rot= is accepted with the notice; an unvouched change asks.
  const r1 = await rotationDecision({ prev, next, now: NOW, rotOk: true })
  assert.deepEqual([r1.decision, r1.reason, r1.minutesAgo], ['accept', 'rotated', 10])
  assert.equal((await rotationDecision({ prev, next, now: NOW, rotOk: false })).decision, 'confirm')
  // First visit: a rotation younger than 24 h is delayed until it ages, unless nx matches.
  const d = await rotationDecision({ next, firstVisit: true, now: NOW })
  assert.equal(d.decision, 'delay')
  assert.equal(d.reason, 'recent-rotation')
  assert.equal(d.until, (NOW_S - 600) * 1000 + DAY)
  assert.equal(d.minutesAgo, 10)
  assert.equal((await rotationDecision({ next, firstVisit: true, now: NOW + DAY })).decision, 'accept')
  const viaNx = await rotationDecision({ prev: { owner: k1.pub, nx: nx2 }, next, firstVisit: true, now: NOW })
  assert.deepEqual([viaNx.decision, viaNx.reason, viaNx.nx], ['accept', 'nx-match', 'match'])
  const bad = await rotationDecision({ prev: { owner: k1.pub, nx: nx2 }, next: { owner: k3.pub, lo: k1.pub, rot: 'x', seq: NOW_S }, now: NOW, rotOk: true })
  assert.deepEqual([bad.decision, bad.reason], ['confirm', 'nx-mismatch'], 'a valid rot from a stolen key is not enough')
  // A first visit to a site that never rotated: nothing to delay.
  assert.equal((await rotationDecision({ next: { owner: k1.pub, seq: NOW_S }, firstVisit: true, now: NOW })).decision, 'accept')
  // A seq in the future cannot make minutesAgo negative.
  assert.equal((await rotationDecision({ next: Object.assign({}, next, { seq: NOW_S + 3600 }), firstVisit: true, now: NOW })).minutesAgo, 0)
  await assert.rejects(rotationDecision({ next: null }), TypeError)
})

test('loaderFloorOk: ml= is a minimum loader version; malformed values fail closed', () => {
  assert.equal(loaderFloorOk(null, '0.2.1'), true)
  assert.equal(loaderFloorOk('', '0.2.1'), true)
  assert.equal(loaderFloorOk('0.2.1', '0.2.1'), true)
  assert.equal(loaderFloorOk('0.3.0', '0.2.1'), false)
  assert.equal(loaderFloorOk('0.2.0', '0.3.0'), true)
  assert.equal(loaderFloorOk('0.10.0', '0.9.9'), false, 'numeric, not lexical')
  assert.equal(loaderFloorOk('0.3', '0.3.0'), false)
  assert.equal(loaderFloorOk('0.3.0', 'dev'), false)
  assert.equal(loaderFloorOk('0.1.0'), true, 'defaults to CONFIG.version')
  assert.equal(compareVersions('1.0.0', '0.99.99'), 1)
  assert.ok(Number.isNaN(compareVersions('x', '1.0.0')))
})

test("'#host:name@<fp>' links: parsed strictly; the fingerprint is a prefix of b64url sha256 of the owner key", async () => {
  const k = await key()
  const fp = await ownerFingerprint(k.pub)
  assert.equal(fp, createHash('sha256').update(k.pub, 'utf8').digest('base64url'))
  assert.deepEqual(parseHostFingerprintLink('#host:Blog.Example.@' + fp.slice(0, 22)), { host: 'blog.example', fp: fp.slice(0, 22) })
  assert.deepEqual(parseHostFingerprintLink('host:blog.example@' + fp), { host: 'blog.example', fp })
  for (const bad of ['#host:blog.example', '#host:@' + fp, '#host:blog.example@short', '#site:blog.example@' + fp, '#host:localhost@' + fp, '#host:bl og.example@' + fp, '#host:1.2.3.4@' + fp, null]) {
    assert.equal(parseHostFingerprintLink(bad), null, String(bad))
  }
  assert.equal(await fingerprintMatches(fp.slice(0, 16), k.pub), true)
  assert.equal(await fingerprintMatches(fp.slice(1, 17), k.pub), false)
  assert.equal(await fingerprintMatches(fp.slice(0, 8), k.pub), false, 'at least 16 characters (96 bits)')
})

// ---- storage lines (R 2.8.8) ------------------------------------------------------------------------------------

test('storage lines: ledgers 64 MiB on phones and 256 MiB on desktop; files at most half of what remains', () => {
  const MiB = 1048576
  assert.equal(ledgerBudgetFor('phone'), 64 * MiB)
  assert.equal(ledgerBudgetFor('desktop'), 256 * MiB)
  assert.equal(ledgerBudgetFor({ isMobile: true }), 64 * MiB)
  const d = storageLines({ deviceClass: 'desktop', siteBytes: 12 * MiB, ledgerBytes: 20 * MiB })
  assert.equal(d.total, CONFIG.limits.storageBudgetDesktop)
  assert.equal(d.ledgerMax, 256 * MiB)
  assert.equal(d.filesMax, Math.floor((512 - 12 - 20) * MiB / 2))
  const p = storageLines({ deviceClass: 'phone', siteBytes: 40 * MiB, ledgerBytes: 500 * MiB })
  assert.equal(p.ledgerMax, 64 * MiB)
  assert.equal(p.filesMax, Math.floor((128 - 40 - 64) * MiB / 2), 'a ledger over its line counts at its line')
  assert.equal(storageLines({ deviceClass: 'phone', siteBytes: 200 * MiB }).filesMax, 0)
})

// ---- web-seed filter for unsigned records (MF-76) ---------------------------------------------------------------

test('web-seed filter: every forbidden host class is dropped for unsigned records, without per-URL reasons', () => {
  const origin = 'https://site.example'
  const forbidden = [
    'http://cdn.example.com/ws/', // not https
    'https://localhost/x', 'https://app.localhost/x', // loopback names
    'https://127.0.0.1/x', 'https://127.1.2.3/x', 'https://0x7f.1/x', 'https://2130706433/x', 'https://0.0.0.0/x', // loopback IPv4 forms
    'https://[::1]/x', 'https://[::]/x', 'https://[::ffff:127.0.0.1]/x', // loopback IPv6
    'https://169.254.169.254/latest/meta-data', 'https://[fe80::1]/x', // link-local
    'https://10.0.0.1/x', 'https://172.16.5.4/x', 'https://172.31.255.255/x', 'https://192.168.1.1/x', 'https://100.64.0.1/x', // private
    'https://[fd00::1]/x', 'https://[fc00::5]/x', 'https://[::ffff:192.168.0.1]/x', 'https://[64:ff9b::a00:1]/x', 'https://[2002:c0a8:101::1]/x', // private IPv6 forms
    'https://224.0.0.1/x', 'https://255.255.255.255/x', 'https://[ff02::1]/x', // multicast, broadcast
    'https://printer.local/x', 'https://nas.home.arpa/x', 'https://svc.internal/x', 'https://router.lan/x', 'https://intranet/x', // LAN names
    'https://user:pw@cdn.example.com/x', // userinfo
    'ftp://cdn.example.com/x', 'javascript:alert(1)', 'https://[::1'
  ]
  for (const url of forbidden) {
    const f = filterWebseeds({ ws: [url], xs: [url] }, { origin })
    assert.deepEqual([f.ws, f.xs, f.dropped], [[], [], 2], url)
    assert.deepEqual(Object.keys(f).sort(), ['dropped', 'ws', 'xs'], 'a count only, no reasons')
  }
  for (const host of ['cdn.example.com', '8.8.8.8', '[2606:4700::1111]', '[::ffff:808:808]']) assert.equal(isPublicWebHost(host), true, host)
  // The page's own origin is allowed, http and loopback included (local development, the drop-in /_mw/ paths).
  const dev = filterWebseeds({ ws: ['/_mw/ws/', 'http://127.0.0.1:8080/ws/'], xs: ['/_mw/t/' + BTIH + '.torrent'] }, { origin: 'http://127.0.0.1:8080' })
  assert.deepEqual(dev, { ws: ['/_mw/ws/', 'http://127.0.0.1:8080/ws/'], xs: ['/_mw/t/' + BTIH + '.torrent'], dropped: 0 })
  assert.equal(filterWebseeds({ ws: ['http://127.0.0.1:9999/ws/'] }, { origin: 'http://127.0.0.1:8080' }).dropped, 1, 'another port is another origin')
})

test('web-seed filter: at most 4 ws= and 2 xs= for unsigned records; signed records get the host rule and caps 8 and 4 (PTR-8)', () => {
  assert.equal(WEBSEED_MAX_WS, 4)
  assert.equal(WEBSEED_MAX_XS, 2)
  assert.deepEqual([CONFIG.webseedFilter.maxWs, CONFIG.webseedFilter.maxXs], [4, 2])
  const ws = Array.from({ length: 7 }, (_, i) => 'https://cdn' + i + '.example.com/ws/')
  const xs = Array.from({ length: 5 }, (_, i) => 'https://t' + i + '.example.com/x.torrent')
  const f = filterWebseeds({ ws: ['https://10.0.0.1/'].concat(ws), xs }, { origin: 'https://site.example' })
  assert.deepEqual(f.ws, ws.slice(0, 4), 'the first four allowed, in order')
  assert.deepEqual(f.xs, xs.slice(0, 2))
  assert.equal(f.dropped, 1 + 3 + 3)
  // Review round R 5.3 (PTR-8): a signature proves nothing about the hosts; the private address is dropped for a
  // signed record too, and the caps are WEBSEED_SIGNED_MAX_WS / _XS.
  const s = filterWebseeds({ ws: ['https://10.0.0.1/'].concat(ws), xs }, { origin: 'https://site.example', signed: true })
  assert.deepEqual(s.ws, ws.slice(0, 7))
  assert.deepEqual(s.xs, xs.slice(0, 4))
  assert.equal(s.dropped, 1 + 1)
})
