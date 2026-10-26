// Unit tests for src/loader/localwire.js (v0.3 C2, seed-policy lane; SEEDING-AND-ZERO-SETUP-DESIGN.md 3.1.3 row 6):
// a wire is local only when the selected ICE pair joins two host candidates on private, link-local or loopback
// addresses, mDNS names or hidden addresses; reflexive and relayed candidates never are.
// Run: node --test test/unit/localwire.test.mjs
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { isLocalPair, selectedPair, addressKind } from '../../src/loader/localwire.js'

// An RTCStatsReport-like Map: a transport pointing at pair P, and the two candidates of P.
function report ({ local = { candidateType: 'host', address: '192.168.1.20' }, remote = { candidateType: 'host', address: '192.168.1.31' }, transport = true, pair = {} } = {}) {
  const stats = new Map()
  if (transport) stats.set('T1', { id: 'T1', type: 'transport', selectedCandidatePairId: 'P1' })
  stats.set('P1', Object.assign({ id: 'P1', type: 'candidate-pair', localCandidateId: 'L1', remoteCandidateId: 'R1', state: 'succeeded', nominated: true }, pair))
  stats.set('L1', Object.assign({ id: 'L1', type: 'local-candidate', protocol: 'udp', port: 50000 }, local))
  stats.set('R1', Object.assign({ id: 'R1', type: 'remote-candidate', protocol: 'udp', port: 50001 }, remote))
  return stats
}

test('a private host pair is local', () => {
  assert.deepEqual(isLocalPair(report()), { local: true, reason: 'local' })
  for (const [a, b] of [['10.0.0.2', '10.0.0.3'], ['172.16.5.1', '172.31.0.9'], ['fd00::1', 'fc12::2'], ['fe80::1%en0', 'fe80::2'], ['::ffff:192.168.0.2', '192.168.0.3']]) {
    assert.equal(isLocalPair(report({ local: { candidateType: 'host', address: a }, remote: { candidateType: 'host', address: b } })).local, true, a + ' ' + b)
  }
  // Code review v0.3 (browser): 100.64/10 is carrier-grade NAT and overlay space (RFC 6598, Tailscale), not one local network.
  assert.deepEqual(isLocalPair(report({ local: { candidateType: 'host', address: '100.64.0.1' }, remote: { candidateType: 'host', address: '100.127.255.254' } })), { local: false, reason: 'public-address' })
})

test('mDNS names and hidden addresses count as local on a host pair', () => {
  assert.deepEqual(isLocalPair(report({ remote: { candidateType: 'host', address: '6f1c6b0e-2f6c-4a9e-9b4d-5b1d1f0b7a11.local' } })), { local: true, reason: 'local' })
  assert.equal(isLocalPair(report({ remote: { candidateType: 'host' } })).local, true, 'no address field')
  assert.equal(isLocalPair(report({ remote: { candidateType: 'host', address: '' } })).local, true, 'an empty address')
  assert.equal(isLocalPair(report({ local: { candidateType: 'host', ip: '192.168.1.2' }, remote: { candidateType: 'host', ip: '192.168.1.3' } })).local, true, 'the ip field of Chromium before 2021')
})

test('srflx, prflx and relay are never local, whatever the address', () => {
  for (const type of ['srflx', 'prflx', 'relay']) {
    assert.deepEqual(isLocalPair(report({ remote: { candidateType: type, address: '192.168.1.31' } })), { local: false, reason: type })
    assert.deepEqual(isLocalPair(report({ local: { candidateType: type, address: '10.0.0.1' } })), { local: false, reason: type })
  }
  assert.deepEqual(isLocalPair(report({ remote: { candidateType: 'serverreflexive', address: '10.0.0.9' } })), { local: false, reason: 'srflx' }, 'old Firefox names')
  assert.deepEqual(isLocalPair(report({ remote: { candidateType: 'relayed', address: '10.0.0.9' } })), { local: false, reason: 'relay' })
  assert.deepEqual(isLocalPair(report({ remote: { address: '10.0.0.9' } })), { local: false, reason: 'not-host' }, 'no candidate type')
})

test('a public address on either end is not local (a host pair over the internet, for example global IPv6)', () => {
  assert.deepEqual(isLocalPair(report({ remote: { candidateType: 'host', address: '203.0.113.7' } })), { local: false, reason: 'public-address' })
  assert.deepEqual(isLocalPair(report({ local: { candidateType: 'host', address: '2001:db8::5' }, remote: { candidateType: 'host', address: 'x.local' } })), { local: false, reason: 'public-address' })
  assert.deepEqual(isLocalPair(report({ remote: { candidateType: 'host', address: '172.32.0.1' } })), { local: false, reason: 'public-address' }, 'just outside 172.16/12')
  assert.deepEqual(isLocalPair(report({ remote: { candidateType: 'host', address: '100.128.0.1' } })), { local: false, reason: 'public-address' }, 'just outside 100.64/10')
})

test('no pair, no candidate, no stats', () => {
  assert.deepEqual(isLocalPair(null), { local: false, reason: 'no-stats' })
  assert.deepEqual(isLocalPair(undefined), { local: false, reason: 'no-stats' })
  assert.deepEqual(isLocalPair(new Map()), { local: false, reason: 'no-pair' })
  assert.deepEqual(isLocalPair(report({ transport: false, pair: { nominated: false } })), { local: false, reason: 'no-pair' }, 'a pair that is not selected, not nominated')
  assert.deepEqual(isLocalPair(report({ transport: false, pair: { state: 'in-progress' } })), { local: false, reason: 'no-pair' })
  const s = report()
  s.delete('R1')
  assert.deepEqual(isLocalPair(s), { local: false, reason: 'no-candidate' })
})

test('the selected pair: transport.selectedCandidatePairId, else selected (Firefox), else nominated and succeeded with the most bytes', () => {
  const s = report({ transport: false, pair: { bytesSent: 10 } })
  s.set('P2', { id: 'P2', type: 'candidate-pair', localCandidateId: 'L2', remoteCandidateId: 'R2', state: 'succeeded', nominated: true, bytesSent: 5000 })
  s.set('L2', { id: 'L2', type: 'local-candidate', candidateType: 'srflx', address: '198.51.100.4' })
  s.set('R2', { id: 'R2', type: 'remote-candidate', candidateType: 'srflx', address: '198.51.100.9' })
  assert.equal(selectedPair(s).id, 'P2', 'most bytes')
  assert.deepEqual(isLocalPair(s), { local: false, reason: 'srflx' })
  s.get('P1').selected = true
  assert.equal(selectedPair(s).id, 'P1', 'Firefox marks the pair in use')
  assert.equal(isLocalPair(s).local, true)
  s.set('T1', { id: 'T1', type: 'transport', selectedCandidatePairId: 'P2' })
  assert.equal(selectedPair(s).id, 'P2', 'the transport wins')
})

test('stats as an array, an array of [id, stats] pairs, or a plain object', () => {
  const m = report()
  assert.equal(isLocalPair(Array.from(m.values())).local, true)
  assert.equal(isLocalPair(Array.from(m)).local, true)
  const obj = {}
  for (const [k, v] of m) obj[k] = v
  assert.equal(isLocalPair(obj).local, true)
  const badValues = { values () { throw new Error('gone') } }
  assert.deepEqual(isLocalPair(badValues), { local: false, reason: 'no-stats' })
})

test('addressKind: private ranges, link-local, loopback, mDNS, hidden, public', () => {
  const kinds = {
    '10.255.0.1': 'private', '127.0.0.1': 'private', '169.254.10.1': 'private', '172.16.0.0': 'private', '172.31.255.255': 'private',
    '192.168.0.1': 'private', '100.64.0.0': 'public', '::1': 'private', 'fc00::': 'private', 'fdff:ffff::1': 'private',
    'fe80::abcd': 'private', 'febf::1': 'private', '[fe80::1]': 'private', 'ABCD.local': 'mdns', 'host.local.': 'mdns',
    '': 'hidden', null: 'hidden', '8.8.8.8': 'public', '192.169.0.1': 'public', 'fec0::1': 'public', '2606:4700::1': 'public',
    '256.1.1.1': 'public', 'example.com': 'public'
  }
  for (const [a, k] of Object.entries(kinds)) assert.equal(addressKind(a === 'null' ? null : a), k, a)
  assert.equal(addressKind(undefined), 'hidden')
})
