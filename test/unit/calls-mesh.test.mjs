// Unit tests for src/calls/mesh.js (SZ 3.5 "Scope" and "Flow"): key order, politeness, caps, rosters; and mesh calls
// end to end in Node over real chat services (SIG sealed with K_pair over fake wires) and the fake WebRTC of
// test/fixtures/calls: E-CL-2's shape (a group of four from a metered context is audio only, 3 connected pairs each
// with audio from 3 peers, a leaver's pairs close within 5 s, a video call to five people is E_LIMIT) and a call from a
// chat group whose members are not each other's contacts.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Mesh, compareKeys, politeFor, offererOf, capFor, checkCap } from '../../src/calls/mesh.js';
import { CAP_AUDIO, CAP_VIDEO, LEAVE_CLOSE_MS } from '../../src/calls/limits.js';
import { createFakeNetwork } from '../fixtures/calls/fake-webrtc.mjs';
import { fakeClock, people, person, connect, knowEachOther, until, code, CLICK } from '../fixtures/calls/peers.mjs';

const A = 'p256:A';
const B = 'p256:B';
const C = 'p256:C';
const D = 'p256:D';

test('key order, politeness and the offering side', () => {
  assert.equal(compareKeys(A, B), -1);
  assert.equal(compareKeys(B, A), 1);
  assert.equal(compareKeys(A, A), 0);
  assert.equal(politeFor(B, A), true, 'the higher key is polite');
  assert.equal(politeFor(A, B), false);
  assert.equal(offererOf(C, B), B, 'the lower key offers');
  assert.equal(offererOf(B, C), B);
});

test('caps (chosen, SZ-4): 6 people audio only, 4 with video; everyone counts', () => {
  assert.equal(capFor(false), CAP_AUDIO);
  assert.equal(capFor(true), CAP_VIDEO);
  assert.equal(checkCap(6, false), 6);
  assert.equal(checkCap(4, true), 4);
  assert.throws(() => checkCap(7, false), (e) => e.code === 'E_LIMIT');
  assert.throws(() => checkCap(5, true), (e) => e.code === 'E_LIMIT');
});

test('Mesh, caller side: invitees ring, acceptors join, the roster names who joined (without its addressee)', () => {
  let now = 0;
  const m = new Mesh({ me: A, caller: A, video: true, now: () => now });
  assert.equal(m.isCaller, true);
  for (const p of [D, B, C]) m.add(p, 'ringing');
  assert.equal(m.add(A), null, 'never oneself');
  assert.deepEqual(m.ringing(), [D, B, C]);
  assert.equal(m.count(), 4);
  assert.equal(m.isMesh(), true);
  m.set(B, 'connecting');
  m.set(D, 'connecting');
  assert.deepEqual(m.rosterFor(B), [D]);
  assert.deepEqual(m.rosterFor(C), [B, D], 'in key order');
  m.set(C, 'left', 'declined');
  assert.equal(m.set(C, 'direct'), false, 'who left stays left');
  assert.equal(m.get(C).reason, 'declined');
  assert.equal(m.shouldOffer(B), true, 'the caller offers to every acceptor');
  m.set(B, 'direct');
  now = 5;
  m.set(D, 'left', 'hangup');
  assert.deepEqual(m.joined(), [B]);
  assert.equal(m.isMesh(), false);
  assert.equal(m.finished(), false);
  m.set(B, 'left');
  assert.equal(m.finished(), true);
  assert.deepEqual(m.list().map((x) => [x.pub, x.state, x.reason]), [[B, 'left', 'hangup'], [C, 'left', 'declined'], [D, 'left', 'hangup']]);
});

test('Mesh, callee side: the caller\'s roster adds and drops pairs; the lower key of a pair offers; the caller always does', () => {
  const m = new Mesh({ me: C, caller: A });
  m.add(A, 'connecting');
  assert.deepEqual(m.applyRoster([B, D, C, A]), { add: [B, D], drop: [] }, 'neither me nor the caller');
  assert.equal(m.shouldOffer(A), false, 'the caller offers to me');
  assert.equal(m.shouldOffer(B), false, 'B < C: B offers');
  assert.equal(m.shouldOffer(D), true, 'C < D: I offer');
  assert.equal(m.isMember(B), true);
  assert.equal(m.isMember('p256:Z'), false);
  assert.deepEqual(m.applyRoster([D]), { add: [], drop: [B] });
  assert.equal(m.get(B).state, 'left');
  assert.equal(m.isMember(B), false);
  assert.equal(m.isMember(A), true);
  assert.throws(() => new Mesh({}), TypeError);
});

async function pairsOf(p) {
  const st = await p.calls.inspect();
  return st.calls[0] ? st.calls[0].pairs : [];
}

test('E-CL-2 shape: a group call of four from a metered context is audio only; 3 pairs each with audio both ways; a leaver\'s pairs close within 5 s', { timeout: 120000 }, async () => {
  const clock = fakeClock();
  const net = createFakeNetwork({ sdpPad: 400 });
  const group = await people(clock, net, 4, { opts: [{ policy: { class: 'mobileMetered', metered: true } }] });
  const [caller, ...others] = group;
  // A video call to five people is over the cap of 4 with video (6 people).
  const extra = [];
  for (let i = 0; i < 2; i++) extra.push(await person(clock, net, { name: 'X' + i }));
  for (const x of extra) await caller.chatSvc.methods['chat.contacts.add']({ pub: x.pub }, CLICK);
  assert.equal(await code(caller.call('calls.start', { to: others.map((o) => o.pub).concat(extra.map((x) => x.pub)), video: true })), 'E_LIMIT');
  assert.equal(await code(caller.call('calls.start', { to: others.map((o) => o.pub).concat(extra.map((x) => x.pub)).concat(['p256:' + 'A'.repeat(87)]), video: false })), 'E_BAD_REQUEST', 'not a key');
  assert.equal(caller.prompts.length, 0, 'no card before the cap check');
  // The group call, asked with video from a metered network: the metered card, then audio only.
  const st = await caller.call('calls.start', { to: others.map((o) => o.pub), video: true });
  assert.deepEqual(caller.prompts.map((p) => p[0]), ['call.group', 'call.metered']);
  assert.equal(caller.prompts[0][1].metered, true);
  assert.equal(st.kind, 'audio');
  assert.equal(st.notice, 'metered');
  assert.equal(st.local.camera, false);
  assert.equal(caller.browser.mediaDevices.calls[0].video, false, 'no camera was asked for');
  await until(clock, () => others.every((o) => o.events.ring.length === 1), { label: 'three rings' });
  for (const o of others) {
    assert.equal(o.events.ring[0].kind, 'audio');
    assert.equal(o.events.ring[0].roster.length, 2, 'the other two invitees');
    o.answers['call.group'] = 'audio';
    await o.call('calls.accept', { id: st.id });
    assert.equal(o.prompts.at(-1)[0], 'call.group', 'a group call asks with the group card (everyone will see the IP address)');
  }
  await until(clock, async () => {
    for (const p of group) {
      const pairs = await pairsOf(p);
      if (pairs.length !== 3 || !pairs.every((x) => x.connectionState === 'connected' && (x.state === 'direct' || x.state === 'relayed'))) return false;
    }
    return true;
  }, { label: 'every context has 3 connected pairs', ms: 60000, real: 60000 });
  for (const p of group) {
    const pairs = await pairsOf(p);
    for (const x of pairs) {
      assert.ok(x.bytes.audioReceived > 0 && x.bytes.audioSent > 0, p.name + ': audio both ways with ' + x.pub.slice(0, 12));
      assert.equal(x.bytes.videoSent, 0, p.name + ': audio only');
      assert.equal(x.fingerprint.status, 'ok', 'the certificate matches the sealed SDP');
    }
  }
  // The pairs between non-callers were made by the lower key (the caller made its own three).
  const offers = [];
  for (const p of group) for (const pc of p.browser.pcs) if (pc.localDescription && pc.currentLocalDescription && pc.currentLocalDescription.type === 'offer') offers.push(p.name);
  assert.equal(offers.filter((n) => n === caller.name).length, 3);
  // A leaver: its pairs close within 5 s everywhere.
  const leaver = others[1];
  const t0 = clock.now();
  await leaver.call('calls.hangup', { id: st.id });
  await until(clock, async () => {
    for (const p of group) {
      if (p === leaver) continue;
      const pairs = await pairsOf(p);
      if (pairs.some((x) => x.pub === leaver.pub)) return false;
    }
    return true;
  }, { label: 'the leaver\'s pairs closed', ms: LEAVE_CLOSE_MS });
  assert.ok(clock.now() - t0 <= LEAVE_CLOSE_MS);
  for (const p of group) {
    if (p === leaver) continue;
    assert.equal((await pairsOf(p)).length, 2, p.name + ' keeps its other two pairs');
    const me = p.events.state.at(-1).participants.find((x) => x.pub === leaver.pub);
    assert.equal(me.state, 'left');
  }
  assert.equal(leaver.events.ended.length, 1);
  assert.equal(leaver.browser.live().length, 0, 'the leaver ended every capture track');
  for (const p of group.concat(extra)) await p.close();
});

test('a call from a chat group: members who are not each other\'s contacts signal as members of the group (calls on)', { timeout: 120000 }, async () => {
  const clock = fakeClock();
  const net = createFakeNetwork({ sdpPad: 300 });
  // A knows B and C; B and C do not know each other; all three are in A's group.
  const [a, b, c] = await people(clock, net, 3, { contacts: false });
  for (const [x, y] of [[a, b], [b, a], [a, c], [c, a]]) await x.chatSvc.methods['chat.contacts.add']({ pub: y.pub }, CLICK);
  const g = await a.chatSvc.methods['chat.group.create']({ name: 'trio', members: [b.pub, c.pub] }, CLICK);
  await until(clock, () => b.chatEvents.group.some((e) => e.groupId === g.groupId) && c.chatEvents.group.some((e) => e.groupId === g.groupId), { label: 'the group reached B and C', ms: 120000 });
  assert.equal(b.chatSvc.sig.contact(c.pub), null, 'B and C are not contacts');
  const st = await a.call('calls.start', { to: g.groupId });
  assert.equal(st.group, g.groupId);
  assert.equal(a.prompts[0][0], 'call.group');
  await until(clock, () => b.events.ring.length && c.events.ring.length, { label: 'rings' });
  assert.equal(b.events.ring[0].group, g.groupId);
  b.answers['call.group'] = 'audio';
  c.answers['call.group'] = 'audio';
  await b.call('calls.accept', { id: st.id });
  await c.call('calls.accept', { id: st.id });
  await until(clock, async () => (await pairsOf(b)).length === 2 && (await pairsOf(c)).length === 2 &&
    (await pairsOf(b)).every((x) => x.connectionState === 'connected') && (await pairsOf(c)).every((x) => x.connectionState === 'connected'), { label: 'B and C connected to each other too', ms: 60000, real: 60000 });
  // Calls off: group members who are not contacts are no longer heard (only contacts and listen sets).
  b.cfg.calls = 'off';
  assert.equal(await code(b.call('calls.start', { to: c.pub })), 'E_POLICY');
  for (const p of [a, b, c]) await p.close();
});
