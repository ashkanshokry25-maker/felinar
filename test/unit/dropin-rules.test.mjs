// Unit tests for src/dropin/rules.js: the web-seed egress rule, the announce gate, which consent
// card shows, version retention, and the hard-feature check. Plain data in, plain data out.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DROPIN, webseedDecision, dropinRecord, announceAllowed, promptFor, consentFromPref, planVersions, missingFeatures } from '../../src/dropin/rules.js';
import { computePolicy } from '../../src/loader/policy.js';

const A = 'a'.repeat(40);
const B = 'b'.repeat(40);
const C = 'c'.repeat(40);
const D = 'd'.repeat(40);

test('webseedDecision: the host is a web seed only on unmetered networks with a worker that answers /_mw/ws/', () => {
  const desktop = computePolicy({ isMobile: false, networkType: 'unknown', saveData: false, battery: null, online: true }, {});
  const wifiPhone = computePolicy({ isMobile: true, networkType: 'wifi', saveData: false, battery: null, online: true }, {});
  const phoneUnknown = computePolicy({ isMobile: true, networkType: 'unknown', saveData: false, battery: null, online: true }, {});
  const cellular = computePolicy({ isMobile: true, networkType: 'cellular', saveData: false, battery: null, online: true }, {});
  const saveData = computePolicy({ isMobile: false, networkType: 'wifi', saveData: true, battery: null, online: true }, {});
  const ours = { mode: 'ours', controlled: true };
  assert.deepEqual(webseedDecision({ policy: desktop, sw: ours }), { allowed: true, reason: null });
  assert.equal(webseedDecision({ policy: wifiPhone, sw: ours }).allowed, true);
  assert.deepEqual(webseedDecision({ policy: phoneUnknown, sw: ours }), { allowed: false, reason: 'metered' }, 'unknown network on a phone counts as cellular');
  assert.equal(webseedDecision({ policy: cellular, sw: ours }).reason, 'metered');
  assert.equal(webseedDecision({ policy: saveData, sw: ours }).reason, 'metered', 'Save-Data');
  assert.deepEqual(webseedDecision({ policy: desktop, sw: { mode: 'integrated', controlled: true } }), { allowed: true, reason: null });
  assert.equal(webseedDecision({ policy: desktop, sw: { mode: 'foreign', controlled: true } }).reason, 'foreign-worker', 'no web seed without our rewrite');
  assert.equal(webseedDecision({ policy: desktop, sw: { mode: 'off' } }).reason, 'sw-off');
  assert.equal(webseedDecision({ policy: desktop, sw: { mode: 'uncontrolled', controlled: false } }).reason, 'uncontrolled');
  assert.equal(webseedDecision({ policy: desktop, sw: { mode: 'ours', controlled: false } }).reason, 'uncontrolled');
  assert.equal(webseedDecision({ policy: desktop, sw: { mode: 'none' } }).reason, 'no-worker');
  assert.equal(webseedDecision({}).allowed, false);
});

test('dropinRecord: adds https://<host>/_mw/ws/ to ws= without touching the verified record', () => {
  const record = Object.freeze({ btih: A, signed: true, xs: ['/_mw/t/' + A + '.torrent'], ws: [], tr: ['wss://t.test'] });
  const on = dropinRecord(record, { origin: 'https://site.test', allowWebseed: true });
  assert.deepEqual(on.ws, ['https://site.test/_mw/ws/']);
  assert.deepEqual(on.xs, ['/_mw/t/' + A + '.torrent']);
  assert.equal(on.signed, true);
  assert.deepEqual(record.ws, [], 'the original is untouched');
  assert.deepEqual(dropinRecord(record, { origin: 'https://site.test', allowWebseed: false }).ws, []);
  assert.deepEqual(dropinRecord(record, { origin: 'https://site.test/', allowWebseed: true }).ws, ['https://site.test/_mw/ws/'], 'no double slash');
  const withOwn = dropinRecord(Object.assign({}, record, { ws: ['https://cdn.test/files/'] }), { origin: 'https://site.test', allowWebseed: true });
  assert.deepEqual(withOwn.ws, ['https://cdn.test/files/', 'https://site.test/_mw/ws/'], 'the publisher\'s own web seed stays');
  assert.deepEqual(dropinRecord(Object.assign({}, record, { ws: ['https://site.test/_mw/ws/'] }), { origin: 'https://site.test', allowWebseed: true }).ws, ['https://site.test/_mw/ws/'], 'no duplicate');
  assert.deepEqual(dropinRecord({ btih: A }, {}).tr, []);
  assert.equal(DROPIN.webseedPath, '/_mw/ws/');
});

test('announceAllowed: consent, no host-only, WebRTC, 3 s visible and a live page, all together', () => {
  const ok = { consent: 'accepted', hostOnly: false, visible: true, suspended: false, webrtc: true };
  assert.equal(announceAllowed(ok), true);
  for (const [k, v] of [['consent', 'pending'], ['consent', 'host-only'], ['hostOnly', true], ['visible', false], ['suspended', true], ['webrtc', false]]) {
    assert.equal(announceAllowed(Object.assign({}, ok, { [k]: v })), false, k + '=' + v);
  }
  assert.equal(announceAllowed({}), false);
  assert.equal(DROPIN.visibleAnnounceMs, 3000);
});

test('promptFor: notice by default, gate for consent=gate, nothing when stored, forced host-only or handled by the site', () => {
  assert.equal(promptFor({}), 'notice');
  assert.equal(promptFor({ recordConsent: 'gate' }), 'gate');
  assert.equal(promptFor({ recordConsent: 'notice' }), 'notice');
  assert.equal(promptFor({ consent: 'accepted' }), null);
  assert.equal(promptFor({ consent: 'host-only', recordConsent: 'gate' }), null);
  assert.equal(promptFor({ webrtc: false }), null, 'nothing to ask: no peer connection can happen');
  assert.equal(promptFor({ siteHandlesConsent: true }), null);
  assert.equal(promptFor({ siteHandlesConsent: true, recordConsent: 'gate' }), null);
});

test('consentFromPref: strings and the older { state } shape; anything else is pending', () => {
  assert.equal(consentFromPref('accepted'), 'accepted');
  assert.equal(consentFromPref('host-only'), 'host-only');
  assert.equal(consentFromPref({ state: 'accepted' }), 'accepted');
  for (const v of [undefined, null, 'pending', 'yes', 5, {}, { state: 'maybe' }]) assert.equal(consentFromPref(v), 'pending');
});

test('planVersions: the current one plus at most one previous, and that one only while a client renders it', () => {
  assert.deepEqual(planVersions({ versions: [], current: A }), { versions: [A], drop: [] });
  assert.deepEqual(planVersions({ versions: [A], current: A }), { versions: [A], drop: [] }, 'nothing new');
  const live = { [A]: 1 };
  assert.deepEqual(planVersions({ versions: [A], current: B, live }), { versions: [B, A], drop: [] }, 'the old page is still open: keep its copy');
  assert.deepEqual(planVersions({ versions: [A], current: B, live: {} }), { versions: [B], drop: [A] }, 'nobody renders it any more: delete');
  assert.deepEqual(planVersions({ versions: [A], current: B, live: { [A]: 0 } }), { versions: [B], drop: [A] });
  assert.deepEqual(planVersions({ versions: [B, A], current: C, live: { [A]: 2, [B]: 1 } }), { versions: [C, B], drop: [A] }, 'at most two: the newer previous wins');
  assert.deepEqual(planVersions({ versions: [B, A], current: C, live: { [A]: 2 } }), { versions: [C, A], drop: [B] }, 'a live older one beats a dead newer one');
  assert.deepEqual(planVersions({ versions: [B, A], current: C, live: null }), { versions: [C, B], drop: [A] }, 'unknown: keep the most recent previous');
  assert.deepEqual(planVersions({ versions: [A, A, 'junk', null], current: B }), { versions: [B, A], drop: [] }, 'duplicates and junk are ignored');
  assert.deepEqual(planVersions({ versions: [C, B, A], current: B, live: null }), { versions: [B, C], drop: [A] }, 'current is never listed twice');
  assert.deepEqual(planVersions({ versions: [D], current: 'not-a-hash' }), { versions: [D], drop: [] }, 'no valid current: nothing is deleted');
});

test('missingFeatures: hard requirements only, with a readable label', () => {
  const full = { indexedDB: {}, crypto: { subtle: {} }, fetch() {}, TextEncoder, ReadableStream, BigInt, AbortController, MessageChannel, Blob, isSecureContext: true };
  assert.deepEqual(missingFeatures(full), []);
  const lacking = Object.assign({}, full, { indexedDB: undefined, crypto: {}, isSecureContext: false });
  const missing = missingFeatures(lacking);
  assert.ok(missing.includes('IndexedDB'));
  assert.ok(missing.some((m) => m.startsWith('Web Crypto')));
  assert.ok(missing.some((m) => m.startsWith('a secure context')));
  assert.equal(missingFeatures(Object.assign({}, full, { RTCPeerConnection: undefined, navigator: {} })).length, 0, 'soft features are not hard requirements');
  assert.ok(missingFeatures(null).length > 0);
  assert.deepEqual(missingFeatures({ indexedDB: {}, crypto: { subtle: {} }, fetch() {}, TextEncoder, ReadableStream, BigInt, AbortController, MessageChannel, Blob }), [], 'isSecureContext undefined: not judged');
});
