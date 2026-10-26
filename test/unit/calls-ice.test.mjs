// Unit tests for src/calls/ice.js (SZ 3.5 "ICE and relay"; R 2.7.8; PEER B6): the site's own STUN and TURN only, the
// relay policy, address classes, received-candidate filtering, our own candidates before they are sent, and SDP
// candidate lines and connection addresses.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  iceConfig, stunServers, turnServers, addressClass, parseCandidate, filterCandidate, sanitizeLocal, sanitizeSdp,
} from '../../src/calls/ice.js';

const VEC = JSON.parse(readFileSync(fileURLToPath(new URL('../vectors/calls.json', import.meta.url)), 'utf8'));
const byId = (id) => VEC.vectors.find((v) => v.id === id);

test('golden vectors: candidate rules and the ICE configuration', () => {
  const f = byId('calls-ice-001-filter');
  assert.deepEqual(f.input.map(({ candidate, sameLan }) => ({ keep: filterCandidate(candidate, { sameLan }), send: sanitizeLocal(candidate, { sameLan }) })), f.expect);
  const c = byId('calls-ice-002-config');
  assert.deepEqual(iceConfig(c.input), c.expect);
});

test('iceConfig: only the site\'s own servers; no default public STUN; relay policy only with a relay and the person\'s choice', () => {
  const none = iceConfig({});
  assert.deepEqual(none.config.iceServers, [], 'nothing configured: no server at all (never a default public one)');
  assert.equal(none.config.iceTransportPolicy, 'all');
  assert.equal(none.config.bundlePolicy, 'max-bundle');
  assert.equal(none.config.rtcpMuxPolicy, 'require');
  assert.equal(none.relay, false);
  assert.equal(none.stun, false);
  const s = iceConfig({ stun: ['stun:stun.example.org:3478'], relayOnly: true });
  assert.deepEqual(s.config.iceServers, [{ urls: ['stun:stun.example.org:3478'] }]);
  assert.equal(s.config.iceTransportPolicy, 'all', '"Hide my IP" without a relay cannot hide anything (the service refuses the call)');
  assert.equal(s.relayOnly, false);
  const t = iceConfig({ stun: 'stun:stun.example.org', turn: [{ urls: 'turns:relay.example.org:5349', username: 'u', credential: 'c', operator: 'Hub' }] });
  assert.equal(t.relay, true);
  assert.equal(t.operator, 'Hub');
  assert.equal(t.config.iceTransportPolicy, 'all', 'the relay is a fallback unless the person chose relay only');
  assert.equal(iceConfig({ turn: { urls: 'turn:relay.example.org', username: 'u', credential: 'c' }, relayOnly: true }).config.iceTransportPolicy, 'relay');
});

test('server lists: valid stun:/stuns: and turn:/turns: URLs only, at most 4, credentials required for TURN', () => {
  assert.deepEqual(stunServers(['stun:a.example', 'stun:a.example', 'http://x', 'stun:b.example:3478?transport=udp', 'stuns:c.example:5349', 'stun:[2001:db8::1]:3478', 'stun:e.example']),
    ['stun:a.example', 'stun:b.example:3478?transport=udp', 'stuns:c.example:5349', 'stun:[2001:db8::1]:3478']);
  assert.deepEqual(stunServers('stun:one.example'), ['stun:one.example']);
  assert.deepEqual(stunServers(null), []);
  assert.deepEqual(stunServers(['stun:bad host']), []);
  assert.deepEqual(turnServers({ urls: ['turn:r.example'], username: 'u' }).servers, [], 'no credential');
  assert.deepEqual(turnServers({ urls: ['stun:r.example'], username: 'u', credential: 'c' }).servers, [], 'not a TURN URL');
  assert.deepEqual(turnServers({ endpoint: 'https://hub.example/turn' }).servers, [], 'option (b) is resolved by the loader first');
  assert.deepEqual(turnServers({ urls: 'turn:r.example:3478', username: 'u', credential: 'c' }), { servers: [{ urls: ['turn:r.example:3478'], username: 'u', credential: 'c' }], operator: null });
});

test('address classes: private, loopback, link-local, shared, unspecified, multicast, mDNS, names, IPv6 forms', () => {
  const table = {
    '10.0.0.1': 'private', '172.16.0.1': 'private', '172.31.255.255': 'private', '172.32.0.1': 'public', '192.168.0.1': 'private',
    '127.0.0.1': 'loopback', '127.8.8.8': 'loopback', '169.254.1.1': 'link-local', '100.64.0.1': 'shared', '100.127.255.255': 'shared',
    '100.128.0.1': 'public', '0.0.0.0': 'unspecified', '224.0.0.251': 'multicast', '198.51.100.7': 'public', '8.8.8.8': 'public',
    '::': 'unspecified', '::1': 'loopback', '0:0:0:0:0:0:0:1': 'loopback', 'fe80::1': 'link-local', 'FE80::ABCD%en0': 'link-local',
    'fd00::1': 'private', 'fc12:3456::1': 'private', 'fec0::1': 'private', 'ff02::1': 'multicast', '2001:db8::1': 'public',
    '::ffff:10.1.2.3': 'private', '::ffff:198.51.100.1': 'public', '[::1]': 'loopback', 'a1b2c3d4-e5f6-4789-abcd-ef0123456789.local': 'mdns',
    'host.example.org': 'hostname', '': 'invalid', '1:2:3': 'invalid', '1::2::3': 'invalid', '300.1.1.1': 'hostname',
  };
  for (const [a, c] of Object.entries(table)) assert.equal(addressClass(a), c, a);
});

test('received candidates: private, loopback and link-local dropped unless both chose "same local network"; mDNS passes', () => {
  const host = (addr) => 'candidate:1 1 udp 2122260223 ' + addr + ' 50000 typ host generation 0';
  for (const a of ['192.168.1.5', '10.0.0.8', '127.0.0.1', '169.254.4.4', 'fe80::1', 'fd00::5', '100.64.1.1']) {
    assert.equal(filterCandidate(host(a)), false, a);
    assert.equal(filterCandidate(host(a), { sameLan: true }), true, a + ' with same local network');
  }
  assert.equal(filterCandidate(host('0.0.0.0'), { sameLan: true }), false, 'never the unspecified address');
  assert.equal(filterCandidate(host('224.0.0.1'), { sameLan: true }), false, 'never multicast');
  assert.equal(filterCandidate(host('example.org')), false, 'never a name the peer chose for us to look up');
  assert.equal(filterCandidate(host('a1b2c3d4-e5f6-4789-abcd-ef0123456789.local')), true);
  assert.equal(filterCandidate(host('198.51.100.9')), true);
  assert.equal(filterCandidate({ candidate: host('198.51.100.9') }), true, 'an RTCIceCandidate-like object');
  for (const bad of ['', 'candidate:', 'candidate:1 1 udp 1 1.2.3.4', 'candidate:1 1 sctp 1 198.51.100.1 1 typ host', 'candidate:1 1 udp 1 198.51.100.1 70000 typ host',
    'candidate:1 1 udp 1 198.51.100.1 1 typ magic', 'candidate:1 1 udp 1 198.51.100.1 1 kind host', host('198.51.100.9') + ' dangling', host('198.51.100.9') + '\r\na=x']) {
    assert.equal(filterCandidate(bad, { sameLan: true }), false, JSON.stringify(bad));
  }
});

test('our own candidates: private host candidates stay here; a private related address is masked; extensions are kept', () => {
  const srflx = 'candidate:842163049 1 udp 1677729535 198.51.100.7 50000 typ srflx raddr 192.168.1.20 rport 54321 generation 0 ufrag abcd network-id 1 network-cost 10';
  assert.equal(sanitizeLocal(srflx), 'candidate:842163049 1 udp 1677729535 198.51.100.7 50000 typ srflx raddr 0.0.0.0 rport 0 generation 0 ufrag abcd network-id 1 network-cost 10');
  assert.equal(sanitizeLocal(srflx, { sameLan: true }), srflx, 'same local network: unchanged');
  assert.equal(sanitizeLocal('candidate:1 1 udp 1 192.168.1.20 5 typ host'), null);
  assert.equal(sanitizeLocal('candidate:1 1 udp 1 fe80::2 5 typ srflx raddr fe80::1 rport 9'), null);
  assert.equal(sanitizeLocal('candidate:1 1 udp 1 2001:db8::2 5 typ srflx raddr fd00::1 rport 9'), 'candidate:1 1 udp 1 2001:db8::2 5 typ srflx raddr :: rport 0');
  assert.equal(sanitizeLocal('candidate:1 1 tcp 1 198.51.100.2 9 typ host tcptype active'), 'candidate:1 1 tcp 1 198.51.100.2 9 typ host tcptype active');
  const p = parseCandidate('a=candidate:1 2 UDP 33 198.51.100.2 9 typ relay raddr 203.0.113.9 rport 3478');
  assert.deepEqual([p.component, p.protocol, p.type, p.raddr, p.rport], [2, 'udp', 'relay', '203.0.113.9', 3478]);
});

test('SDP: a=candidate lines follow the same rules both ways; private c= and a=rtcp: addresses are masked; line endings kept', () => {
  const sdp = ['v=0', 'm=audio 9 UDP/TLS/RTP/SAVPF 111', 'c=IN IP4 192.168.1.20', 'a=rtcp:9 IN IP4 192.168.1.20',
    'a=candidate:1 1 udp 2122260223 192.168.1.20 50000 typ host', 'a=candidate:3 1 udp 1686052607 198.51.100.7 50000 typ srflx raddr 192.168.1.20 rport 50000',
    'a=candidate:4 1 udp 1 4a3c.local 50000 typ host', 'm=video 9 UDP/TLS/RTP/SAVPF 96', 'c=IN IP6 fe80::1', 'c=IN IP4 198.51.100.7', ''].join('\r\n');
  const out = sanitizeSdp(sdp, { direction: 'out' });
  assert.ok(out.indexOf('\r\n') > 0 && out.indexOf('\n\n') < 0);
  assert.ok(!/192\.168/.test(out), 'no private address left: ' + out);
  assert.ok(!/fe80/.test(out));
  assert.match(out, /c=IN IP4 0\.0\.0\.0\r\na=rtcp:9 IN IP4 0\.0\.0\.0/);
  assert.match(out, /c=IN IP6 ::\r\n/);
  assert.match(out, /typ srflx raddr 0\.0\.0\.0 rport 0/);
  assert.match(out, /4a3c\.local/);
  assert.match(out, /c=IN IP4 198\.51\.100\.7/);
  const inbound = sanitizeSdp(sdp, { direction: 'in' });
  assert.ok(inbound.indexOf('a=candidate:1 1 udp 2122260223 192.168.1.20') < 0, 'a received private candidate is dropped');
  assert.ok(inbound.indexOf('raddr 192.168.1.20') > 0, 'a received related address is left alone (it is not used to connect)');
  const lan = sanitizeSdp(sdp, { direction: 'in', sameLan: true });
  assert.ok(lan.indexOf('a=candidate:1 1 udp 2122260223 192.168.1.20') > 0);
  assert.equal(sanitizeSdp(sdp.replace(/\r\n/g, '\n'), { direction: 'out' }).indexOf('\r'), -1, 'LF stays LF');
  assert.equal(sanitizeSdp(42), 42);
});
