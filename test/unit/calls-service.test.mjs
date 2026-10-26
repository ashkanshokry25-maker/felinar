// Unit tests for src/calls/service.js (SVC contract; SZ 3.5) in Node: real chat services sealing SIG with K_pair over
// fake wires (test/fixtures/calls/peers.mjs) and the fake WebRTC of test/fixtures/calls/fake-webrtc.mjs.
//   gating in the SVC order; E-CL-1's shape (ring, accept with video, connected, the certificate equals the sealed
//   answer's fingerprint, no SDP text in any frame, mute and camera off reach the peer, hang up closes both connections
//   and ends every capture track); E-CL-3's shape (a non-contact's ring makes no RTCPeerConnection, no offer after a
//   decline, the callee makes none before accepting); no answer, busy, ring limits, a fingerprint mismatch, no path,
//   media errors, metered networks, screen sharing inside the card's click, visibility, the relay choice, a relaying
//   neighbour that cannot read SIG, the Wake Lock, Media Session and the seeding yield.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createCallService, CALL_METHODS, CALL_EVENTS } from '../../src/calls/service.js';
import { decodeSignal } from '../../src/calls/signal.js';
import { decode, T } from '../../src/chat/frames.js';
import { FLAG_HOLD, FLAG_STRANGER, CT_LENGTHS } from '../../src/chat/limits.js';
import { RING_TTL_MS, CONNECT_TIMEOUT_MS, RINGS_PER_HOUR, CALL_FLAGS, setCallFlag } from '../../src/calls/limits.js';
import { utf8 } from '../../src/chain/canonical.js';
import { createFakeNetwork } from '../fixtures/calls/fake-webrtc.mjs';
import { fakeClock, people, person, connect, knowEachOther, until, code, CLICK, NOCLICK } from '../fixtures/calls/peers.mjs';

const has = (u8, s) => {
  const t = utf8.encode(s);
  outer: for (let i = 0; i + t.length <= u8.length; i++) {
    for (let k = 0; k < t.length; k++) if (u8[i + k] !== t[k]) continue outer;
    return true;
  }
  return false;
};

/** Watches what a person's lane sends (frames before the Noise layer) and what its SIG seam receives. */
function watch(p) {
  const out = { frames: [], received: [] };
  const lane = p.chatSvc.lane;
  const send = lane.send.bind(lane);
  lane.send = (frame, opts) => {
    out.frames.push(new Uint8Array(frame));
    return send(frame, opts);
  };
  p.chatSvc.sig.onReceive((pub, payload, meta) => {
    const d = decodeSignal(payload);
    out.received.push({ pub, meta, msg: d.ok ? d.msg : null });
  });
  return out;
}

async function callConnected(clock, net, { video = true, opts = [] } = {}) {
  const [a, b] = await people(clock, net, 2, { opts });
  const st = await a.call('calls.start', { to: b.pub, video });
  await until(clock, () => b.events.ring.length, { label: 'ring' });
  b.answers['call.incoming'] = video ? 'video' : 'audio';
  await b.call('calls.accept', { id: st.id });
  await until(clock, () => a.events.state.some((s) => s.state === 'connected') && b.events.state.some((s) => s.state === 'connected'), { label: 'connected' });
  return { a, b, id: st.id };
}

const firstPair = async (p) => (await p.calls.inspect()).calls[0].pairs[0];

test('the method table, the events and the loader-only functions', async () => {
  const s = createCallService({});
  for (const m of CALL_METHODS) assert.equal(typeof s.methods[m], 'function', m);
  assert.deepEqual(CALL_EVENTS, ['ring', 'state', 'peer', 'ended']);
  for (const f of ['answer', 'setVisible', 'setNetwork', 'media', 'inspect', 'destroy']) assert.equal(typeof s[f], 'function', f);
  assert.throws(() => s.on('nope', () => {}), TypeError);
  assert.deepEqual(await s.methods['calls.list']({}, NOCLICK), []);
  await s.destroy();
  assert.equal(await code(s.methods['calls.list']({}, NOCLICK)), 'E_POLICY', 'destroyed');
});

test('gating, in the SVC order: E_HOST_ONLY first (no card, no capture, no connection), E_UNSUPPORTED in drop-in, E_POLICY, E_NEEDS_GESTURE, E_NOT_SIGNED_IN', async () => {
  const clock = fakeClock();
  const net = createFakeNetwork();
  const [a, b] = await people(clock, net, 2);
  a.state.hostOnly = true;
  for (const m of CALL_METHODS) {
    if (m === 'calls.state' || m === 'calls.list' || m === 'calls.hangup' || m === 'calls.mute') continue;
    assert.equal(await code(a.call(m, { to: b.pub, id: 'AAECAwQFBgcICQoLDA0ODw', on: true })), 'E_HOST_ONLY', m);
  }
  assert.deepEqual(await a.call('calls.list', {}), [], 'reads still answer');
  assert.equal(a.prompts.length, 0, 'no card');
  assert.equal(a.browser.mediaDevices.calls.length, 0, 'no capture');
  assert.equal(a.browser.pcs.length, 0, 'no connection');
  a.state.hostOnly = false;
  const dropin = await person(clock, net, { callDeps: { mode: 'dropin' } });
  assert.equal(await code(dropin.call('calls.start', { to: b.pub })), 'E_UNSUPPORTED', 'a page load would end the call');
  a.cfg.calls = 'off';
  assert.equal(await code(a.call('calls.start', { to: b.pub })), 'E_POLICY');
  assert.equal(await code(a.call('calls.accept', { id: 'AAECAwQFBgcICQoLDA0ODw' })), 'E_POLICY');
  a.cfg.calls = 'on';
  assert.equal(await code(a.call('calls.start', { to: b.pub })), 'E_POLICY', 'only the value contacts turns calls on');
  a.cfg.calls = 'contacts';
  assert.equal(await code(a.call('calls.start', { to: b.pub }, NOCLICK)), 'E_NEEDS_GESTURE');
  assert.equal(await code(a.call('calls.start', { to: b.pub }, { activation: 'yes' })), 'E_NEEDS_GESTURE', 'only the boolean true from the loader');
  assert.equal(await code(a.call('calls.screen', { id: 'AAECAwQFBgcICQoLDA0ODw', on: true }, NOCLICK)), 'E_NEEDS_GESTURE');
  assert.equal(await code(a.call('calls.start', { to: b.pub }, { activation: true, tab: 'follower' })), 'E_POLICY', 'calls run in the leader tab');
  const anon = await person(clock, net, { callDeps: { keys: null } });
  assert.equal(await code(anon.call('calls.start', { to: b.pub })), 'E_NOT_SIGNED_IN');
  const noRtc = await person(clock, net, { callDeps: { RTCPeerConnection: undefined } });
  assert.equal(await code(noRtc.call('calls.start', { to: b.pub })), 'E_UNSUPPORTED');
  const noStun = await person(clock, net, { callDeps: { stun: [] } });
  assert.equal(await code(noStun.call('calls.start', { to: b.pub })), 'E_POLICY', 'the site\'s own STUN is required (MF-44)');
  const hide = await person(clock, net, { prefs: { hideIp: true } });
  assert.equal(await code(hide.call('calls.start', { to: b.pub })), 'E_POLICY', '"Hide my IP" without a relay cannot be honoured');
  await a.chatSvc.methods['chat.disable']({}, CLICK);
  assert.equal(await code(a.call('calls.start', { to: b.pub })), 'E_POLICY', 'chat must be on');
  assert.equal(a.prompts.length, 0, 'no card in any of these');
  for (const p of [a, b, dropin, anon, noRtc, noStun, hide]) await p.close();
});

test('targets: contacts only (E_NOT_CONTACT), not oneself, a group this tab holds (E_NOT_MEMBER), a key without a chat key is E_PEER_UNREACHABLE', async () => {
  const clock = fakeClock();
  const net = createFakeNetwork();
  const [a, b] = await people(clock, net, 2);
  const stranger = await person(clock, net, { name: 'S' });
  assert.equal(await code(a.call('calls.start', { to: stranger.pub })), 'E_NOT_CONTACT');
  assert.equal(await code(a.call('calls.start', { to: [b.pub, stranger.pub] })), 'E_NOT_CONTACT');
  assert.equal(await code(a.call('calls.start', { to: a.pub })), 'E_BAD_REQUEST');
  assert.equal(await code(a.call('calls.start', { to: [a.pub] })), 'E_BAD_REQUEST');
  assert.equal(await code(a.call('calls.start', { to: 'NoSuchGroup1234' })), 'E_NOT_MEMBER');
  assert.equal(await code(a.call('calls.start', { to: 42 })), 'E_BAD_REQUEST');
  await a.chatSvc.methods['chat.contacts.add']({ pub: stranger.pub }, CLICK);
  assert.equal(await code(a.call('calls.start', { to: stranger.pub })), 'E_PEER_UNREACHABLE', 'no wire, so no chat key: not connected now');
  await a.chatSvc.methods['chat.contacts.block']({ pub: b.pub }, CLICK);
  assert.equal(await code(a.call('calls.start', { to: b.pub })), 'E_NOT_CONTACT', 'blocked');
  assert.equal(a.prompts.length, 0);
  for (const p of [a, b, stranger]) await p.close();
});

test('E-CL-1 shape: ring, accept with video, connected; the certificate equals the sealed answer; SIG frames carry no SDP text; mute and camera off reach the peer; hang up ends everything', { timeout: 120000 }, async () => {
  const clock = fakeClock();
  const net = createFakeNetwork();
  const [a, b] = await people(clock, net, 2, { wire: false });
  const wireBytes = [];
  connect(a, b, { tap: (u8) => wireBytes.push(u8) });
  await knowEachOther(clock, a, b);
  const wa = watch(a);
  const wb = watch(b);
  const t0 = clock.now();
  const st = await a.call('calls.start', { to: b.pub, video: true });
  assert.deepEqual(a.prompts.map((p) => p[0]), ['call.start']);
  assert.equal(a.prompts[0][1].to, b.pub);
  assert.equal(a.prompts[0][1].name, 'P1');
  assert.equal(a.prompts[0][1].video, true);
  assert.equal(st.state, 'ringing');
  assert.equal(a.browser.pcs.length, 0, 'the caller makes no connection before an accept');
  await until(clock, () => b.events.ring.length, { label: 'ring' });
  const ring = b.events.ring[0];
  assert.deepEqual([ring.id, ring.from, ring.kind, ring.name], [st.id, a.pub, 'video', 'P0']);
  assert.equal(b.browser.pcs.length, 0, 'the callee makes no connection before accepting');
  assert.equal(b.browser.mediaDevices.calls.length, 0, 'nor any capture');
  b.answers['call.incoming'] = 'video';
  const acc = await b.call('calls.accept', { id: st.id });
  assert.equal(b.prompts[0][0], 'call.incoming');
  assert.equal(acc.state, 'connecting');
  await until(clock, () => a.events.state.some((s) => s.state === 'connected') && b.events.state.some((s) => s.state === 'connected'), { label: 'connected' });
  assert.ok(clock.now() - t0 < 10000, 'connected within 10 s');
  // The certificate in getStats equals the fingerprint in the sealed answer the caller received.
  const pa = await firstPair(a);
  const pb = await firstPair(b);
  assert.equal(pa.fingerprint.status, 'ok');
  assert.equal(pb.fingerprint.status, 'ok');
  const answer = wa.received.find((r) => r.msg && r.msg.k === 'answer');
  assert.ok(answer, 'the answer came as SIG');
  assert.equal(answer.meta.contact, true);
  const fpInAnswer = /a=fingerprint:sha-256 ([0-9A-F:]+)/.exec(answer.msg.sdp)[1];
  assert.equal(pa.fingerprint.actual, fpInAnswer);
  assert.equal(pa.fingerprint.expected, fpInAnswer);
  // Every SIG frame: type 0x0B, no hold or stranger flag; the offer in the 16,000 bucket; no SDP or candidate text.
  const sigs = wa.frames.concat(wb.frames).map((f) => decode(f)).filter((d) => d.type === T.SIG);
  assert.ok(sigs.length >= 4, sigs.length + ' SIG frames');
  for (const d of sigs) assert.equal(d.header.flags & (FLAG_HOLD | FLAG_STRANGER), 0);
  assert.ok(sigs.some((d) => d.fields.ct.length === CT_LENGTHS[3]), 'an offer or answer fills the 16,000-byte bucket');
  for (const f of wa.frames.concat(wb.frames).concat(wireBytes)) {
    for (const s of ['v=0', 'a=fingerprint', 'candidate:', 'ice-ufrag']) assert.equal(has(f, s), false, 'clear text "' + s + '" in a frame');
  }
  // Media both ways; private candidates stayed home.
  const bytes = (await firstPair(a)).bytes;
  assert.ok(bytes.audioSent > 0 && bytes.videoSent > 0 && bytes.audioReceived > 0 && bytes.videoReceived > 0, JSON.stringify(bytes));
  assert.ok(pa.stats.withheld >= 2, 'loopback and LAN host candidates were not sent (' + pa.stats.withheld + ')');
  for (const r of wb.received) if (r.msg && r.msg.cand) for (const c of r.msg.cand) assert.ok(!/ 192\.168\.| 127\.0\.0\.1 /.test(c), c);
  // The Wake Lock during a visible video call; Media Session actions; the seeding yield.
  await until(clock, () => a.browser.wakeLock.held === 1, { label: 'wake lock' });
  assert.deepEqual(Object.keys(a.browser.mediaSession.handlers).sort(), ['hangup', 'togglecamera', 'togglemicrophone']);
  assert.deepEqual(a.state.yields.at(-1), { active: true, limited: false, connections: 1, video: true });
  // The loader's call panel gets tracks; the state has no stream.
  const media = a.calls.media(st.id);
  assert.equal(media.local.camera.kind, 'video');
  assert.equal(media.remote[0].pub, b.pub);
  assert.equal(media.remote[0].camera.kind, 'video');
  assert.ok(!JSON.stringify(a.events.state.at(-1)).includes('track'), 'no stream in the state');
  // Mute and camera off reach the peer over mw-call.
  await a.call('calls.mute', { id: st.id, on: true });
  await until(clock, () => b.events.peer.some((p) => p.pub === a.pub && p.mute === true), { label: 'mute at B' });
  assert.equal(a.calls.media(st.id).local.audio.enabled, false);
  await a.call('calls.camera', { id: st.id, on: false });
  await until(clock, () => b.events.peer.some((p) => p.pub === a.pub && p.camera === false), { label: 'camera off at B' });
  assert.equal(a.calls.media(st.id).local.camera, null, 'the camera itself stopped');
  assert.equal(a.browser.tracks.filter((t) => t.kind === 'video' && t.readyState === 'live').length, 0);
  await a.call('calls.camera', { id: st.id, on: true });
  await until(clock, () => b.events.peer.filter((p) => p.pub === a.pub).at(-1).camera === true, { label: 'camera on again at B' });
  // Hidden: the Wake Lock goes.
  a.calls.setVisible(false);
  await until(clock, () => a.browser.wakeLock.held === 0, { label: 'wake lock released on hide' });
  a.calls.setVisible(true);
  await until(clock, () => a.browser.wakeLock.held === 1, { label: 'wake lock again' });
  // Hang up: both connections close and every capture track ends.
  await a.call('calls.hangup', { id: st.id });
  await until(clock, () => b.events.ended.length === 1, { label: 'B ended' });
  await clock.advance(500); // the caller's connection closes 200 ms after its 'leave' went out on mw-call
  assert.equal(a.events.ended[0].reason, 'hangup');
  assert.equal(a.events.ended[0].code, null);
  assert.equal(b.events.ended[0].reason, 'hangup');
  assert.ok(a.events.ended[0].duration >= 0);
  assert.ok(a.browser.pcs.every((pc) => pc.closed) && b.browser.pcs.every((pc) => pc.closed), 'both connections closed');
  assert.equal(a.browser.live().length, 0, 'A ended every capture track');
  assert.equal(b.browser.live().length, 0, 'B ended every capture track');
  assert.equal(a.browser.wakeLock.held, 0);
  assert.deepEqual(a.browser.mediaSession.handlers, {}, 'Media Session handlers cleared');
  assert.equal(a.state.yields.at(-1), null);
  assert.equal((await a.call('calls.state', { id: st.id })).state, 'ended');
  assert.deepEqual(await a.call('calls.list', {}), []);
  assert.equal(await a.call('calls.state', { id: 'AAAAAAAAAAAAAAAAAAAAAA' }), null);
  assert.equal(await code(a.call('calls.state', { id: 'x' })), 'E_BAD_REQUEST');
  await a.close();
  await b.close();
});

test('E-CL-3 shape: a non-contact\'s ring makes no RTCPeerConnection; after a decline no offer leaves the caller', { timeout: 60000 }, async () => {
  const clock = fakeClock();
  const net = createFakeNetwork();
  const [a, b] = await people(clock, net, 2);
  const x = await person(clock, net, { name: 'X' });
  connect(x, b);
  await knowEachOther(clock, x, b);
  // X adds B as a contact on its side; B never accepted X: the ring is sealed but B is not listening for it.
  await x.chatSvc.methods['chat.contacts.add']({ pub: b.pub }, CLICK);
  const xs = await x.call('calls.start', { to: b.pub });
  assert.equal(xs.state, 'ringing');
  await clock.advance(5000);
  assert.equal(b.events.ring.length, 0, 'no ring from a non-contact');
  assert.equal(b.browser.pcs.length, 0, 'no RTCPeerConnection');
  await x.call('calls.hangup', { id: xs.id });
  // A declined call: no offer, no connection, no candidate.
  const wa = watch(a);
  const st = await a.call('calls.start', { to: b.pub, video: true });
  await until(clock, () => b.events.ring.length === 1, { label: 'ring' });
  b.answers['call.incoming'] = 'decline';
  assert.equal(await code(b.call('calls.accept', { id: st.id })), 'E_USER_CANCELLED');
  await until(clock, () => a.events.ended.length === 1, { label: 'A ended' });
  assert.deepEqual([a.events.ended[0].reason, a.events.ended[0].code], ['declined', 'E_DECLINED']);
  assert.equal(b.events.ended[0].reason, 'declined');
  const kinds = wa.frames.map((f) => decode(f)).filter((d) => d.type === T.SIG).length;
  assert.equal(kinds, 1, 'one SIG frame left A: the ring');
  assert.equal(a.browser.pcs.length, 0, 'no connection at the caller');
  assert.equal(b.browser.pcs.length, 0, 'none at the callee');
  assert.equal(a.browser.live().length, 0, 'the caller\'s preview capture stopped');
  // decline() without a card.
  const st2 = await a.call('calls.start', { to: b.pub });
  await until(clock, () => b.events.ring.length === 2, { label: 'second ring' });
  assert.deepEqual(await b.call('calls.decline', { id: st2.id }, NOCLICK), { id: st2.id, state: 'ended' });
  await until(clock, () => a.events.ended.length === 2, { label: 'declined again' });
  assert.equal(await code(b.call('calls.decline', { id: st2.id })), 'E_BAD_REQUEST', 'nothing rings any more');
  for (const p of [a, b, x]) await p.close();
});

test('no answer: rings expire after 45 s (E_NO_ANSWER); busy: a second caller gets E_BUSY', { timeout: 60000 }, async () => {
  const clock = fakeClock();
  const net = createFakeNetwork();
  const [a, b, c] = await people(clock, net, 3);
  const st = await a.call('calls.start', { to: b.pub });
  await until(clock, () => b.events.ring.length === 1, { label: 'ring' });
  assert.ok(b.events.ring[0].expiresAt - clock.now() <= RING_TTL_MS);
  await clock.advance(RING_TTL_MS + 100);
  assert.deepEqual([a.events.ended[0].reason, a.events.ended[0].code], ['no-answer', 'E_NO_ANSWER']);
  await until(clock, () => b.events.ended.length === 1, { label: 'B\'s ring ended' });
  assert.ok(['no-answer', 'cancelled'].includes(b.events.ended[0].reason));
  assert.equal(await code(b.call('calls.accept', { id: st.id })), 'E_BAD_REQUEST', 'an expired ring cannot be accepted');
  // B in a call with A; C rings B: busy.
  const live = await a.call('calls.start', { to: b.pub });
  await until(clock, () => b.events.ring.length === 2, { label: 'ring 2' });
  b.answers['call.incoming'] = 'audio';
  await b.call('calls.accept', { id: live.id });
  const cs = await c.call('calls.start', { to: b.pub });
  await until(clock, () => c.events.ended.length === 1, { label: 'C ended' });
  assert.deepEqual([c.events.ended[0].id, c.events.ended[0].reason, c.events.ended[0].code], [cs.id, 'busy', 'E_BUSY']);
  assert.equal(b.events.ring.length, 2, 'B saw no third ring');
  assert.equal(await code(b.call('calls.start', { to: c.pub })), 'E_BUSY', 'one call at a time');
  for (const p of [a, b, c]) await p.close();
});

test('ring limits: one pending ring per contact and at most 10 an hour (E_LIMIT, before any card)', { timeout: 60000 }, async () => {
  const clock = fakeClock();
  const net = createFakeNetwork();
  const [a, b] = await people(clock, net, 2);
  for (let i = 0; i < RINGS_PER_HOUR; i++) {
    const st = await a.call('calls.start', { to: b.pub });
    await until(clock, () => b.events.ring.length === i + 1, { label: 'ring ' + (i + 1) });
    await b.call('calls.decline', { id: st.id });
    await until(clock, () => a.events.ended.length === i + 1, { label: 'ended ' + (i + 1) });
  }
  const before = a.prompts.length;
  assert.equal(await code(a.call('calls.start', { to: b.pub })), 'E_LIMIT', 'the 11th ring of the hour');
  assert.equal(a.prompts.length, before, 'no card');
  await clock.advance(3600000);
  const st = await a.call('calls.start', { to: b.pub });
  assert.equal(st.state, 'ringing', 'a new hour');
  for (const p of [a, b]) await p.close();
});

test('a fingerprint mismatch in getStats hangs up with E_CALL_FAILED; no path is E_CALL_FAILED after 30 s', { timeout: 60000 }, async () => {
  const clock = fakeClock();
  const net = createFakeNetwork();
  const [a, b] = await people(clock, net, 2);
  // Only the caller's getStats shows another certificate than the sealed answer named (a man in the middle there).
  net.tamper = (pc) => (pc.browser.name === a.browser.name ? 'AA:'.repeat(31) + 'AA' : null);
  const st = await a.call('calls.start', { to: b.pub });
  await until(clock, () => b.events.ring.length, { label: 'ring' });
  await b.call('calls.accept', { id: st.id });
  await until(clock, () => a.events.ended.length && b.events.ended.length, { label: 'both ended' });
  assert.deepEqual([a.events.ended[0].reason, a.events.ended[0].code], ['fingerprint', 'E_CALL_FAILED']);
  assert.ok(!a.events.state.some((s) => s.participants.some((p) => p.state === 'direct' || p.state === 'relayed')), 'never shown as connected');
  assert.ok(a.browser.pcs.every((pc) => pc.closed));
  // Both sides tampered: whoever checks first fails the call; the other ends too.
  net.tamper = () => 'BB:'.repeat(31) + 'BB';
  const s1 = await a.call('calls.start', { to: b.pub });
  await until(clock, () => b.events.ring.length === 2, { label: 'ring' });
  await b.call('calls.accept', { id: s1.id });
  await until(clock, () => a.events.ended.length === 2 && b.events.ended.length === 2, { label: 'both ended again' });
  assert.ok([a.events.ended[1].code, b.events.ended[1].code].includes('E_CALL_FAILED'));
  assert.equal(a.events.ended[1].code === 'E_CALL_FAILED' || b.events.ended[1].code === 'E_CALL_FAILED', true);
  net.tamper = null;
  net.block = true;
  const st2 = await a.call('calls.start', { to: b.pub });
  await until(clock, () => b.events.ring.length === 3, { label: 'ring 3' });
  await b.call('calls.accept', { id: st2.id });
  await clock.advance(CONNECT_TIMEOUT_MS + 1000);
  await until(clock, () => a.events.ended.length === 3 && b.events.ended.length === 3, { label: 'no path' });
  assert.equal(a.events.ended[2].code, 'E_CALL_FAILED');
  assert.equal(b.events.ended[2].code, 'E_CALL_FAILED');
  assert.equal(a.browser.live().length + b.browser.live().length, 0);
  for (const p of [a, b]) await p.close();
});

test('media errors: E_MEDIA_DENIED and E_NO_DEVICE leave the ring as it was; a missing camera falls back to audio', { timeout: 60000 }, async () => {
  const clock = fakeClock();
  const net = createFakeNetwork();
  const [a, b] = await people(clock, net, 2, { opts: [{ browser: { noCamera: true } }, { browser: { denied: true } }] });
  const st = await a.call('calls.start', { to: b.pub, video: true });
  assert.equal(st.local.camera, false, 'no camera: audio only');
  await until(clock, () => b.events.ring.length, { label: 'ring' });
  assert.equal(await code(b.call('calls.accept', { id: st.id })), 'E_MEDIA_DENIED');
  assert.equal((await b.call('calls.state', { id: st.id })).state, 'ringing', 'still ringing: the person can fix the permission');
  b.browser.mediaDevices.denied = false;
  b.browser.mediaDevices.noMic = true;
  assert.equal(await code(b.call('calls.accept', { id: st.id })), 'E_NO_DEVICE');
  b.browser.mediaDevices.noMic = false;
  b.answers['call.incoming'] = 'audio';
  await b.call('calls.accept', { id: st.id });
  await until(clock, () => a.events.state.some((s) => s.state === 'connected'), { label: 'connected at last' });
  assert.equal(await code(a.call('calls.camera', { id: st.id, on: true })), 'E_NO_DEVICE');
  for (const p of [a, b]) await p.close();
});

test('metered networks start audio only (call.metered); SZ-4: an unknown phone network defaults to audio unless video was asked', { timeout: 60000 }, async () => {
  const clock = fakeClock();
  const net = createFakeNetwork();
  const [a, b, c] = await people(clock, net, 3, { opts: [{}, { policy: { class: 'mobileMetered', metered: true } }, { policy: { class: 'mobileUnknown' } }] });
  const st = await a.call('calls.start', { to: b.pub, video: true });
  await until(clock, () => b.events.ring.length, { label: 'ring' });
  b.answers['call.incoming'] = 'video';
  const acc = await b.call('calls.accept', { id: st.id });
  assert.deepEqual(b.prompts.map((p) => p[0]), ['call.incoming', 'call.metered']);
  assert.equal(b.prompts[0][1].metered, true);
  assert.equal(acc.local.camera, false);
  assert.equal(acc.notice, 'metered');
  await until(clock, () => b.events.state.some((s) => s.state === 'connected'), { label: 'connected' });
  // Video on a metered network if the person turns it on: 300 kbit/s scaled by 2, audio at 24.
  await b.call('calls.camera', { id: st.id, on: true });
  await until(clock, () => b.browser.pcs[0].paramsLog.some((x) => x.kind === 'video' && x.encoding.maxBitrate === 300000 && x.encoding.scaleResolutionDownBy === 2), { label: 'metered video encoding' });
  assert.ok(b.browser.pcs[0].paramsLog.some((x) => x.kind === 'audio' && x.encoding.maxBitrate === 24000));
  assert.ok(a.browser.pcs[0].paramsLog.some((x) => x.kind === 'video' && x.encoding.maxBitrate === 800000), 'the desktop side sends 800 kbit/s in a call of two');
  await b.call('calls.hangup', { id: st.id });
  await until(clock, () => a.events.ended.length === 1, { label: 'ended' });
  // An unknown phone network: the loader's answer() without video stays audio; with video it is video.
  const st2 = await a.call('calls.start', { to: c.pub, video: true });
  await until(clock, () => c.events.ring.length, { label: 'ring c' });
  const ans = await c.calls.answer(st2.id, { video: false });
  assert.equal(ans.local.camera, false);
  assert.equal(c.prompts.length, 0, 'answer() is the loader\'s own card: no second card');
  for (const p of [a, b, c]) await p.close();
});

test('screen sharing: the card first, then getDisplayMedia in the same click; contentHint detail; the peer sees it; stop from the browser', { timeout: 60000 }, async () => {
  const clock = fakeClock();
  const net = createFakeNetwork();
  const { a, b, id } = await callConnected(clock, net);
  // A WebKit-like gesture rule: getDisplayMedia works only while the card's click is being handled.
  let inClick = false;
  a.browser.mediaDevices.gesture = () => inClick;
  a.answers['call.screen'] = () => {
    inClick = true;
    setImmediate(() => { inClick = false; });
    return true;
  };
  assert.deepEqual(await a.call('calls.screen', { id, on: true }), { id, screen: true });
  assert.equal(a.prompts.at(-1)[0], 'call.screen');
  assert.equal(a.browser.mediaDevices.displayCalls, 1);
  assert.deepEqual(a.browser.mediaDevices.displayConstraints, { video: { frameRate: { ideal: 15, max: 15 } }, audio: false });
  const screen = a.calls.media(id).local.screen;
  assert.equal(screen.contentHint, 'detail');
  await until(clock, () => b.events.peer.some((p) => p.pub === a.pub && p.screen === true), { label: 'screen at B' });
  await until(clock, () => a.browser.pcs[0].paramsLog.some((x) => x.mid === '2' && x.encoding.maxBitrate === 1200000 && x.encoding.maxFramerate === 15), { label: 'screen encoding' });
  // The person stops sharing from the browser's own control.
  screen._end();
  await until(clock, () => b.events.peer.filter((p) => p.pub === a.pub).at(-1).screen === false, { label: 'screen off at B' });
  assert.equal(a.events.state.at(-1).local.screen, false);
  // A cancelled picker; a card answered no; a browser without getDisplayMedia (Android).
  a.browser.mediaDevices.displayCancel = true;
  assert.equal(await code(a.call('calls.screen', { id, on: true })), 'E_USER_CANCELLED', 'the picker was cancelled');
  a.browser.mediaDevices.displayCancel = false;
  const before = a.browser.mediaDevices.displayCalls;
  a.answers['call.screen'] = false;
  assert.equal(await code(a.call('calls.screen', { id, on: true })), 'E_USER_CANCELLED', 'the card was answered no');
  assert.equal(a.browser.mediaDevices.displayCalls, before, 'a refused card opens no picker');
  a.answers['call.screen'] = true;
  inClick = false;
  assert.equal(await code(a.call('calls.screen', { id, on: true })), 'E_NEEDS_GESTURE', 'outside the click (WebKit): InvalidStateError');
  delete a.browser.mediaDevices.getDisplayMedia;
  assert.equal(await code(a.call('calls.screen', { id, on: true })), 'E_UNSUPPORTED');
  for (const p of [a, b]) await p.close();
});

test('visibility: a track the browser muted is reported, and taken again with replaceTrack when the page is visible', { timeout: 60000 }, async () => {
  const clock = fakeClock();
  const net = createFakeNetwork();
  const { a, b, id } = await callConnected(clock, net);
  const old = a.calls.media(id).local.camera;
  old._mute(true);
  await until(clock, () => a.events.state.at(-1).paused.camera === true, { label: 'paused' });
  a.calls.setVisible(true);
  await until(clock, () => a.events.state.at(-1).paused.camera === false, { label: 'taken again' });
  const fresh = a.calls.media(id).local.camera;
  assert.notEqual(fresh, old);
  assert.equal(old.readyState, 'ended');
  await until(clock, () => a.browser.pcs[0].trackLog.some((x) => x.kind === 'video' && x.mid === '1' && x.track === fresh.id), { label: 'replaceTrack' });
  for (const p of [a, b]) await p.close();
});

test('"Hide my IP from people I call" with a relay: relay-only ICE, the relay named in the card, participants shown as relayed', { timeout: 60000 }, async () => {
  const clock = fakeClock();
  const net = createFakeNetwork();
  net.relay = true;
  const turn = { urls: ['turn:relay.example.test:3478'], username: 'u', credential: 'c', operator: 'Example Hub' };
  const { a, b } = await callConnected(clock, net, { opts: [{ prefs: { hideIp: true }, callDeps: { turn } }, { callDeps: { turn } }] });
  assert.equal(a.browser.pcs[0].config.iceTransportPolicy, 'relay');
  assert.equal(b.browser.pcs[0].config.iceTransportPolicy, 'all');
  assert.deepEqual(a.prompts[0][1].relay, { operator: 'Example Hub' });
  assert.equal(a.prompts[0][1].relayOnly, true);
  assert.deepEqual(b.prompts[0][1].relay, { operator: 'Example Hub' });
  await until(clock, () => a.events.peer.some((p) => p.state === 'relayed'), { label: 'relayed' });
  assert.equal(a.events.state.at(-1).participants[0].path, 'relayed');
  for (const p of [a, b]) await p.close();
});

test('a relaying neighbour carries SIG it cannot read: no ring, no payload at the relay, no SDP text on its wires', { timeout: 90000 }, async () => {
  const clock = fakeClock();
  const net = createFakeNetwork();
  const a = await person(clock, net, { name: 'A' });
  const c = await person(clock, net, { name: 'C' });
  const b = await person(clock, net, { name: 'B' });
  const wire = [];
  connect(a, c, { tap: (u8) => wire.push(u8) });
  connect(c, b, { tap: (u8) => wire.push(u8) });
  await knowEachOther(clock, a, c);
  await knowEachOther(clock, c, b);
  // A and B learn each other's chat key without a wire (the CK travels inside the call roster in real meshes).
  assert.equal(await a.chatSvc.sig.learn(b.chatSvc.sig.ckOf(b.pub)), true);
  assert.equal(await b.chatSvc.sig.learn(a.chatSvc.sig.ckOf(a.pub)), true);
  await a.chatSvc.methods['chat.contacts.add']({ pub: b.pub }, CLICK);
  await b.chatSvc.methods['chat.contacts.add']({ pub: a.pub }, CLICK);
  await c.chatSvc.methods['chat.contacts.add']({ pub: a.pub }, CLICK);
  await c.chatSvc.methods['chat.contacts.add']({ pub: b.pub }, CLICK);
  const wc = watch(c);
  const st = await a.call('calls.start', { to: b.pub, video: true });
  await until(clock, () => b.events.ring.length, { label: 'ring through C', ms: 60000 });
  b.answers['call.incoming'] = 'video';
  await b.call('calls.accept', { id: st.id });
  await until(clock, () => a.events.state.some((s) => s.state === 'connected'), { label: 'connected through a relayed signalling path', ms: 60000, real: 60000 });
  assert.equal(c.events.ring.length, 0, 'C saw no ring');
  assert.equal(wc.received.length, 0, 'C\'s SIG seam opened nothing');
  assert.ok(c.chatSvc.lane.stats.relayed > 0, 'C relayed frames');
  for (const f of wire) for (const s of ['v=0', 'a=fingerprint', 'candidate:']) assert.equal(has(f, s), false);
  for (const p of [a, b, c]) await p.close();
});

test('state and events: participants with path, flags and names; a caller that hangs up while ringing cancels the callee\'s ring', { timeout: 60000 }, async () => {
  const clock = fakeClock();
  const net = createFakeNetwork();
  const [a, b] = await people(clock, net, 2);
  const st = await a.call('calls.start', { to: b.pub });
  assert.deepEqual(st.participants.map((p) => [p.pub, p.state, p.name]), [[b.pub, 'ringing', 'P1']]);
  assert.equal(st.kind, 'audio');
  assert.equal(st.role, 'caller');
  assert.equal(st.platform, null);
  await until(clock, () => b.events.ring.length, { label: 'ring' });
  const inc = await b.call('calls.state', { id: st.id });
  assert.equal(inc.role, 'callee');
  assert.equal(inc.state, 'ringing');
  assert.ok(inc.expiresAt > clock.now());
  await a.call('calls.hangup', { id: st.id });
  await until(clock, () => b.events.ended.length, { label: 'cancelled' });
  assert.equal(b.events.ended[0].reason, 'cancelled');
  assert.equal(b.browser.pcs.length, 0);
  const ios = await person(clock, net, { callDeps: { deviceClass: 'ios' } });
  await ios.chatSvc.methods['chat.contacts.add']({ pub: a.pub }, CLICK);
  connect(ios, a);
  await knowEachOther(clock, ios, a);
  const s2 = await ios.call('calls.start', { to: a.pub });
  // Code review v0.3: what phones do in the background ships only after its gate rows (CALL_FLAGS.phoneNotes).
  assert.equal(CALL_FLAGS.phoneNotes, false);
  assert.equal(s2.platform, null, 'no phone note before G-PS-1..4 and G-CL-2 ran');
  setCallFlag('phoneNotes', true);
  try {
    assert.equal((await ios.call('calls.state', { id: s2.id })).platform, 'call.ios', 'the panel shows the iPhone note once the rows pass');
  } finally {
    setCallFlag('phoneNotes', false);
  }
  assert.throws(() => setCallFlag('nope', true), TypeError);
  for (const p of [a, b, ios]) await p.close();
});

test('adaptation in a call: loss steps the camera down to a pause (state.local.videoPaused), the seeding yield says limited, a clean link brings it back', { timeout: 60000 }, async () => {
  const clock = fakeClock();
  const net = createFakeNetwork();
  const { a, b, id } = await callConnected(clock, net);
  net.loss = 0.2;
  await until(clock, () => a.events.state.at(-1).local.videoPaused === true, { label: 'video paused', ms: 60000 });
  const enc = a.browser.pcs[0].paramsLog.filter((x) => x.kind === 'video' && x.mid === '1').map((x) => x.encoding);
  assert.ok(enc.some((e) => e.maxBitrate === 400000), 'halved first');
  assert.ok(enc.some((e) => e.scaleResolutionDownBy === 4), 'then scaled');
  assert.equal(enc.at(-1).active, false, 'then paused');
  assert.ok(a.browser.pcs[0].paramsLog.filter((x) => x.kind === 'audio').every((x) => x.encoding.active !== false && x.encoding.maxBitrate === 32000), 'audio kept at 32 kbit/s');
  assert.equal(a.state.yields.at(-1).limited, true, 'seeding yields while the call is limited');
  net.loss = 0;
  await until(clock, () => a.events.state.at(-1).local.videoPaused === false, { label: 'video back', ms: 30000 });
  await a.call('calls.hangup', { id });
  for (const p of [a, b]) await p.close();
});
