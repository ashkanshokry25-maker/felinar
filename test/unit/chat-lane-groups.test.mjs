// Unit tests for src/chat/groups.js (R 2.7.7, MF-37): U-CH-6 (concurrent rekeys converge on one epoch; a
// removed member cannot decrypt the next epoch; a newcomer cannot decrypt the previous one), plus admin checks,
// the member cap and the 7-day grace on the previous epoch.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { hex, utf8 } from '../../src/chain/canonical.js';
import { generateKeyPair, exportPublicKey, sign } from '../../src/chain/crypto.js';
import { GroupState, nextEpochId, resolveConcurrent, commitOf, GENESIS, signAdminList, tieKey } from '../../src/chat/groups.js';
import { sealGroup, openGroup } from '../../src/chat/seal.js';
import { DAY_MS, GROUP_MAX } from '../../src/chat/limits.js';

const L = 'mw1:groupLedger';
const T0 = 20381 * DAY_MS;

async function person() {
  const kp = await generateKeyPair();
  return { pub: await exportPublicKey(kp.publicKey), sign: (b) => sign(kp.privateKey, b) };
}

async function msg(state, sender, text) {
  const r = state.record();
  return sealGroup({ groupSecret: state.secretFor(r.epochId), ledgerId: L, groupId: state.groupId, epochId: hex.decode(r.epochId), day: 20381, sender, message: { t: T0, n: 1, kind: 8, body: utf8.encode(text) } });
}

async function canRead(secret, state, epochIdHex, env) {
  if (!secret) return false;
  const o = await openGroup({ groupSecret: secret, ledgerId: L, groupId: state.groupId, epochId: hex.decode(epochIdHex), env });
  return o.ok;
}

test('epochId arithmetic and resolveConcurrent (largest removal set, then SHA-256(prev | creator), then epochId; union of removals)', async () => {
  const a = await person();
  const b = await person();
  const c = commitOf(new Uint8Array(32).fill(1));
  const e = nextEpochId(GENESIS, a.pub, c);
  assert.equal(e.length, 32);
  assert.deepEqual(nextEpochId(null, a.pub, c), e);
  assert.notDeepEqual(nextEpochId(e, a.pub, c), e);
  assert.throws(() => nextEpochId(new Uint8Array(31), a.pub, c), TypeError);
  const kids = [
    { epochId: 'ff' + '00'.repeat(31), removed: ['x'] },
    { epochId: '01' + '00'.repeat(31), removed: ['y'] },
    { epochId: '80' + '00'.repeat(31), removed: [] },
  ];
  const w = resolveConcurrent(kids);
  assert.equal(w.epochId, '01' + '00'.repeat(31), 'equal removal sets and no creator: the lowest epochId');
  assert.deepEqual(w.removed, ['x', 'y']);
  assert.equal(w.losers.length, 2);
  // The largest removal set wins whatever the epochId (a creator can grind its epochId, not its removals' meaning).
  assert.equal(resolveConcurrent([{ epochId: '00'.repeat(32), removed: [] }, { epochId: 'ff'.repeat(32), removed: ['z'] }]).epochId, 'ff'.repeat(32));
  // Between creators the tie-break is SHA-256(prev | creator), which neither can change by grinding.
  const prev = 'ab'.repeat(32);
  const x = { epochId: '00'.repeat(32), removed: [], prev, creator: a.pub };
  const y = { epochId: 'ff'.repeat(32), removed: [], prev, creator: b.pub };
  const want = tieKey(prev, a.pub) < tieKey(prev, b.pub) ? x : y;
  assert.equal(resolveConcurrent([x, y]).epochId, want.epochId);
  assert.equal(resolveConcurrent([Object.assign({}, x, { epochId: 'ff'.repeat(32) }), Object.assign({}, y, { epochId: '00'.repeat(32) })]).creator, want.creator, 'the epochId does not decide between creators');
});

test('U-CH-6: concurrent rekeys by two admins converge on one epoch for every member, in any order', async () => {
  const ana = await person();
  const bo = await person();
  const cy = await person();
  const dee = await person();
  const created = await GroupState.create({ ledgerId: L, name: 'friends', creator: ana, members: [bo.pub, cy.pub, dee.pub], now: () => T0 });
  const anaState = created.state;
  // Ana makes Bo an admin (a rekey), then both admins change the group at the same time from that epoch.
  const promote = await anaState.rekey({ signer: ana, admins: [ana.pub, bo.pub] });
  const boState = new GroupState({ ledgerId: L, groupId: anaState.groupId, me: bo.pub, now: () => T0 });
  const cyState = new GroupState({ ledgerId: L, groupId: anaState.groupId, me: cy.pub, now: () => T0 });
  for (const s of [boState, cyState]) {
    assert.equal((await s.receive(created.record, created.secret)).ok, true);
    assert.equal((await s.receive(promote.record, promote.secret)).ok, true);
  }
  assert.equal(boState.isAdmin(bo.pub), true);
  const base = anaState.current;
  const byAna = await anaState.rekey({ signer: ana, remove: [dee.pub] });
  const byBo = await boState.rekey({ signer: bo, remove: [cy.pub] });
  assert.equal(byAna.record.prev, base);
  assert.equal(byBo.record.prev, base);
  // Cy hears Bo first, Ana and Bo hear each other; all land on the same (lowest) epoch.
  const r1 = await anaState.receive(byBo.record, byBo.secret);
  const r2 = await boState.receive(byAna.record, byAna.secret);
  await cyState.receive(byBo.record, null); // Cy was removed by Bo: no secret
  const r3 = await cyState.receive(byAna.record, byAna.secret);
  // One removal each: the tie-break is SHA-256(prev | creator), the same for everyone, in any arrival order.
  const winner = resolveConcurrent([byAna.record, byBo.record]).epochId;
  for (const s of [anaState, boState, cyState]) assert.equal(s.current, winner);
  assert.equal(r1.conflict, true);
  assert.equal(r2.conflict, true);
  assert.equal(r3.conflict, true);
  // The union of removals: neither Cy nor Dee is an effective member, whichever commit won.
  for (const s of [anaState, boState]) {
    const eff = s.effectiveMembers();
    assert.ok(eff.indexOf(dee.pub) < 0);
    assert.ok(eff.indexOf(cy.pub) < 0);
  }
  assert.equal(cyState.left, true, 'Cy is out whichever commit won');
  // Every admin of the winner re-applies the removal the losing commit had and the winner lacks.
  const who = winner === byAna.record.epochId ? cy.pub : dee.pub;
  assert.deepEqual(r1.reapply, [who]);
  assert.deepEqual(r2.reapply, [who]);
  const re = await anaState.rekey({ signer: ana, remove: r1.reapply });
  assert.ok(re.record.members.indexOf(who) < 0);
  assert.deepEqual(anaState.pending, [], 'applied: nothing pending any more');
  assert.equal((await boState.receive(re.record, re.secret)).ok, true);
  assert.deepEqual(boState.reapplyPlan(), { remove: [], add: [] });
});

test('code review v0.3: a removed admin cannot fork the group from an earlier epoch and take it back (no grinding)', async () => {
  let t = T0;
  const now = () => t;
  const A = await person();
  const B = await person();
  const C = await person();
  const created = await GroupState.create({ ledgerId: L, name: 'g', creator: A, members: [B.pub, C.pub], now });
  const gA = created.state;
  const e1 = await gA.rekey({ signer: A, admins: [A.pub, B.pub] });
  const gC = new GroupState({ ledgerId: L, groupId: gA.groupId, me: C.pub, now });
  assert.equal((await gC.adopt(created.record, created.secret)).ok, true);
  assert.equal((await gC.receive(e1.record, e1.secret)).ok, true);
  // A removes B; B does not get the new secret.
  t += 3600000;
  const e2 = await gA.rekey({ signer: A, remove: [B.pub] });
  assert.equal((await gC.receive(e2.record, e2.secret)).ok, true);
  assert.equal(gC.current, e2.record.epochId);
  // Days later B, still an admin in E1, makes children of E1 that remove A, grinding the lowest epochId of 64.
  t += 3 * DAY_MS;
  const forker = new GroupState({ ledgerId: L, groupId: gA.groupId, me: B.pub, now });
  await forker.adopt(e1.record, e1.secret);
  const adminsB = await signAdminList({ ledger: L, groupId: gA.groupId, admins: [B.pub], signer: B, t });
  const forks = [];
  for (let i = 0; i < 64; i++) forks.push(await forker._commit({ prev: hex.decode(e1.record.epochId), signer: B, members: [B.pub, C.pub], removed: [A.pub], admins: adminsB, name: 'g' }));
  forks.sort((x, y) => (x.record.epochId < y.record.epochId ? -1 : 1));
  const fork = forks[0];
  const r = await gC.receive(fork.record, fork.secret);
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'creator-removed');
  assert.equal(gC.current, e2.record.epochId);
  assert.notDeepEqual(gC.secretFor(gC.current), fork.secret, 'C never encrypts to a secret B holds');
  assert.deepEqual(gC.secretFor(gC.current), e2.secret);
  assert.equal(gC.secretFor(fork.record.epochId), null);
  assert.ok(gC.effectiveMembers().indexOf(B.pub) < 0);
  assert.ok(gC.effectiveMembers().indexOf(A.pub) >= 0, 'the refused fork removes nobody');
  assert.equal(gC.isAdmin(A.pub), true);
  // A second genesis for the same group (anyone who knows the group id can sign one) never replaces the first.
  const g2 = await forker._commit({ prev: GENESIS, signer: B, members: [B.pub, C.pub], removed: [], admins: adminsB, name: 'g' });
  assert.equal((await gC.receive(g2.record, g2.secret)).reason, 'genesis');
  assert.equal(gC.current, e2.record.epochId);
});

test('code review v0.3: a sibling is accepted only while its parent is current or within 7 days of its replacement', async () => {
  for (const [days, accepted] of [[3, true], [8, false]]) {
    let t = T0;
    const now = () => t;
    const A = await person();
    const B = await person();
    const C = await person();
    const D = await person();
    const Z = await person();
    const created = await GroupState.create({ ledgerId: L, creator: A, members: [B.pub, C.pub], now });
    const gA = created.state;
    const e1 = await gA.rekey({ signer: A, admins: [A.pub, B.pub] });
    const gB = new GroupState({ ledgerId: L, groupId: gA.groupId, me: B.pub, now });
    const gC = new GroupState({ ledgerId: L, groupId: gA.groupId, me: C.pub, now });
    for (const s of [gB, gC]) {
      await s.adopt(created.record, created.secret);
      await s.receive(e1.record, e1.secret);
    }
    const e2 = await gA.rekey({ signer: A, add: [D.pub] });
    await gC.receive(e2.record, e2.secret);
    t += days * DAY_MS;
    // B (not removed, offline since E1) changes E1: a sibling of E2.
    const late = await gB.rekey({ signer: B, add: [Z.pub] });
    assert.equal(late.record.prev, e1.record.epochId);
    const r = await gC.receive(late.record, late.secret);
    assert.equal(r.ok, accepted, days + ' days');
    if (!accepted) {
      assert.equal(r.reason, 'stale-parent');
      assert.equal(gC.current, e2.record.epochId);
    }
  }
});

test('code review v0.3: removals win when the removal arrives second; the losing adder re-adds on top', async () => {
  const A = await person();
  const B = await person();
  const C = await person();
  const Y = await person();
  const created = await GroupState.create({ ledgerId: L, creator: A, members: [B.pub, C.pub], now: () => T0 });
  const gA = created.state;
  const e1 = await gA.rekey({ signer: A, admins: [A.pub, B.pub] });
  const states = {};
  for (const [name, who] of [['B', B], ['C', C]]) {
    states[name] = new GroupState({ ledgerId: L, groupId: gA.groupId, me: who.pub, now: () => T0 });
    await states[name].adopt(created.record, created.secret);
    await states[name].receive(e1.record, e1.secret);
  }
  // Concurrently: B adds Y, A removes B.
  const bAdd = await states.B.rekey({ signer: B, add: [Y.pub] });
  const aRm = await gA.rekey({ signer: A, remove: [B.pub] });
  // C hears B's change first, then A's: A's removal of B wins all the same, and nobody encrypts to B's secret.
  assert.equal((await states.C.receive(bAdd.record, bAdd.secret)).current, bAdd.record.epochId);
  const rc = await states.C.receive(aRm.record, aRm.secret);
  assert.equal(rc.ok, true);
  assert.equal(states.C.current, aRm.record.epochId);
  assert.deepEqual(states.C.secretFor(states.C.current), aRm.secret);
  assert.ok(states.C.effectiveMembers().indexOf(B.pub) < 0);
  assert.equal(states.C.listening().filter((e) => e.current).length, 1);
  // A hears B's change after its own removal of B: refused.
  assert.equal((await gA.receive(bAdd.record, bAdd.secret)).reason, 'creator-removed');
  // Two concurrent changes by admins who stay: A removes C while B adds Y; A's removal ranks first and B re-adds Y.
  const A2 = await person();
  const made = await GroupState.create({ ledgerId: L, creator: A2, members: [B.pub, C.pub], now: () => T0 });
  const p = await made.state.rekey({ signer: A2, admins: [A2.pub, B.pub] });
  const sB = new GroupState({ ledgerId: L, groupId: made.state.groupId, me: B.pub, now: () => T0 });
  await sB.adopt(made.record, made.secret);
  await sB.receive(p.record, p.secret);
  const addY = await sB.rekey({ signer: B, add: [Y.pub] });
  const rmC = await made.state.rekey({ signer: A2, remove: [C.pub] });
  const rb = await sB.receive(rmC.record, rmC.secret);
  assert.equal(sB.current, rmC.record.epochId, 'the removal ranks first');
  assert.deepEqual(rb.readd, [Y.pub], 'B re-applies its addition on top');
  assert.deepEqual(sB.reapplyPlan(), { remove: [], add: [Y.pub] });
  const again = await sB.rekey({ signer: B, add: sB.reapplyPlan().add });
  assert.ok(again.record.members.indexOf(Y.pub) >= 0 && again.record.members.indexOf(C.pub) < 0);
  void addY;
});

test('code review v0.3: the union of removals is applied; a member who missed epochs re-adopts from an admin', async () => {
  const A = await person();
  const B = await person();
  const C = await person();
  const X = await person();
  const Z = await person();
  const created = await GroupState.create({ ledgerId: L, creator: A, members: [B.pub, C.pub, X.pub, Z.pub], now: () => T0 });
  const gA = created.state;
  const e1 = await gA.rekey({ signer: A, admins: [A.pub, B.pub] });
  const gB = new GroupState({ ledgerId: L, groupId: gA.groupId, me: B.pub, now: () => T0 });
  const gC = new GroupState({ ledgerId: L, groupId: gA.groupId, me: C.pub, now: () => T0 });
  for (const s of [gB, gC]) {
    await s.adopt(created.record, created.secret);
    await s.receive(e1.record, e1.secret);
  }
  const ra = await gA.rekey({ signer: A, remove: [X.pub] });
  const rb = await gB.rekey({ signer: B, remove: [Z.pub] });
  await gC.receive(ra.record, ra.secret);
  await gC.receive(rb.record, rb.secret);
  const win = resolveConcurrent([ra.record, rb.record]);
  const lost = win.epochId === ra.record.epochId ? Z.pub : X.pub;
  assert.equal(gC.current, win.epochId);
  assert.ok(gC.members().indexOf(lost) >= 0, 'the winner still lists the member the losing admin removed');
  assert.ok(gC.effectiveMembers().indexOf(lost) < 0, '... but it is not an effective member');
  assert.ok(gC.effectiveMembers().indexOf(X.pub) < 0 && gC.effectiveMembers().indexOf(Z.pub) < 0);
  assert.deepEqual(gC.pending, [lost]);
  assert.equal(gC.isAdmin(lost), false);
  // A member who missed an epoch (its invite expired) gets a later one: the parent is unknown, so it re-adopts it
  // (the service does this only for an admin of its current epoch).
  const gA2 = (await GroupState.create({ ledgerId: L, creator: A, members: [C.pub], now: () => T0 })).state;
  const first = gA2.record();
  const gC2 = new GroupState({ ledgerId: L, groupId: gA2.groupId, me: C.pub, now: () => T0 });
  await gC2.adopt(first, gA2.secretFor(first.epochId));
  const old = gC2.current;
  await gA2.rekey({ signer: A, add: [Z.pub] });
  const e3 = await gA2.rekey({ signer: A, add: [X.pub] });
  assert.equal((await gC2.receive(e3.record, e3.secret)).reason, 'unknown-parent');
  assert.equal(gC2.isAdmin(A.pub), true);
  const re = await gC2.readopt(e3.record, e3.secret);
  assert.equal(re.ok, true);
  assert.equal(gC2.current, e3.record.epochId);
  assert.ok(gC2.listening().some((e) => hex.encode(e.epochId) === old), 'the old epoch stays for its grace');
});

test('code review v0.3: group state survives a reload (every epoch of the grace window, the parents siblings need)', async () => {
  let t = T0;
  const now = () => t;
  const A = await person();
  const B = await person();
  const C = await person();
  const X = await person();
  const Y = await person();
  const made = await GroupState.create({ ledgerId: L, name: 'g', creator: A, members: [B.pub, C.pub, X.pub], now });
  const gA = made.state;
  const e1 = await gA.rekey({ signer: A, admins: [A.pub, B.pub] });
  const gB = new GroupState({ ledgerId: L, groupId: gA.groupId, me: B.pub, now });
  await gB.adopt(e1.record, e1.secret);
  const gC = new GroupState({ ledgerId: L, groupId: gA.groupId, me: C.pub, now });
  await gC.adopt(e1.record, e1.secret);
  // Concurrent rekeys of E1: A removes X, B adds Y; A's removal ranks first.
  const ra = await gA.rekey({ signer: A, remove: [X.pub] });
  const rb = await gB.rekey({ signer: B, add: [Y.pub] });
  assert.equal(resolveConcurrent([ra.record, rb.record]).epochId, ra.record.epochId);
  // C hears the losing child first, then its tab reloads (the service keeps toJSON() in its sealed store).
  await gC.receive(rb.record, rb.secret);
  const before = await msg(gC, C, 'sent under the losing epoch before the reload');
  const saved = JSON.parse(JSON.stringify(gC.toJSON()));
  t += 3600000;
  const back = await GroupState.fromJSON(saved, { ledgerId: L, me: C.pub, now });
  assert.equal(back.current, rb.record.epochId);
  const rw = await back.receive(ra.record, ra.secret);
  assert.equal(rw.ok, true, 'the winner is accepted after the reload: ' + rw.reason);
  assert.equal(back.current, ra.record.epochId);
  const next = await gA.rekey({ signer: A, add: [] });
  assert.equal((await back.receive(next.record, next.secret)).ok, true, 'and the next epoch');
  assert.equal(back.current, next.record.epochId);
  // The previous epoch's secret survived: a message sent under it before the replacement still opens.
  assert.ok(back.listening().some((e) => hex.encode(e.epochId) === rb.record.epochId));
  assert.equal(await canRead(back.secretFor(rb.record.epochId), back, rb.record.epochId, before), true);
  // The old v1 format (current epoch only) still restores.
  const v1 = new GroupState({ ledgerId: L, groupId: gA.groupId, me: C.pub, now });
  assert.equal((await v1.adopt(rb.record, rb.secret)).ok, true);
  // A broken or foreign state restores nothing.
  assert.equal(await GroupState.fromJSON({ v: 2, groupId: 'x', root: 'nope', epochs: [] }, { ledgerId: L, me: C.pub, now }), null);
  const tampered = JSON.parse(JSON.stringify(saved));
  tampered.epochs.forEach((e) => { e.record.members = [C.pub]; });
  assert.equal(await GroupState.fromJSON(tampered, { ledgerId: L, me: C.pub, now }), null, 'records are verified again');
  // Bounded: after weeks of rekeys only the grace window (and the current epoch) is kept.
  for (let i = 0; i < 6; i++) {
    t += 3 * DAY_MS;
    const e = await gA.rekey({ signer: A, add: [] });
    await back.receive(e.record, e.secret);
  }
  const kept = back.toJSON();
  assert.ok(kept.epochs.length <= 5, 'kept ' + kept.epochs.length);
  const again = await GroupState.fromJSON(JSON.parse(JSON.stringify(kept)), { ledgerId: L, me: C.pub, now });
  assert.equal(again.current, back.current);
  const late = await gA.rekey({ signer: A, add: [] });
  assert.equal((await again.receive(late.record, late.secret)).ok, true);
});

test('U-CH-6: a removed member cannot read the next epoch; a newcomer cannot read the previous one', async () => {
  const ana = await person();
  const bo = await person();
  const cy = await person();
  const eve = await person();
  const g = await GroupState.create({ ledgerId: L, creator: ana, members: [bo.pub, cy.pub], now: () => T0 });
  const st = g.state;
  const e0 = st.current;
  const oldMsg = await msg(st, ana, 'before Eve joined');
  // Remove Cy: a new secret that only Ana and Bo receive.
  const rm = await st.rekey({ signer: ana, remove: [cy.pub] });
  const e1 = st.current;
  assert.notEqual(e1, e0);
  assert.ok(rm.record.members.indexOf(cy.pub) < 0);
  const afterRemove = await msg(st, ana, 'Cy is out');
  assert.equal(await canRead(g.secret, st, e1, afterRemove), false, 'Cy holds only the old secret');
  assert.equal(await canRead(rm.secret, st, e1, afterRemove), true);
  // Add Eve: another epoch; Eve adopts it from her invite.
  const add = await st.rekey({ signer: ana, add: [eve.pub] });
  const eveState = new GroupState({ ledgerId: L, groupId: st.groupId, me: eve.pub, now: () => T0 });
  assert.equal((await eveState.adopt(add.record, add.secret)).ok, true);
  assert.equal(eveState.current, st.current);
  assert.equal(eveState.secretFor(e0), null);
  assert.equal(eveState.secretFor(e1), null);
  assert.equal(await canRead(add.secret, st, e0, oldMsg), false, 'Eve cannot read the epoch before she joined');
  assert.equal(await canRead(add.secret, st, e1, afterRemove), false);
  const now = await msg(st, ana, 'welcome Eve');
  assert.equal(await canRead(eveState.secretFor(eveState.current), st, eveState.current, now), true);
});

test('admin checks: a non-admin cannot rekey; a forged or tampered record is refused; the member cap is 32', async () => {
  const ana = await person();
  const bo = await person();
  const mallory = await person();
  const g = await GroupState.create({ ledgerId: L, creator: ana, members: [bo.pub], now: () => T0 });
  const boState = new GroupState({ ledgerId: L, groupId: g.state.groupId, me: bo.pub, now: () => T0 });
  await boState.receive(g.record, g.secret);
  await assert.rejects(boState.rekey({ signer: bo, add: [mallory.pub] }), (e) => e.code === 'E_NOT_ADMIN');
  // Mallory builds a commit on top of the current epoch with her own key and her own admin list.
  const mState = new GroupState({ ledgerId: L, groupId: g.state.groupId, me: mallory.pub, now: () => T0 });
  const forgedAdmins = await signAdminList({ ledger: L, groupId: g.state.groupId, admins: [mallory.pub], signer: mallory, t: T0 });
  const forged = await mState._commit({ prev: hex.decode(g.record.epochId), signer: mallory, members: [ana.pub, mallory.pub], removed: [bo.pub], admins: forgedAdmins, name: '' });
  assert.equal((await boState.receive(forged.record, forged.secret)).reason, 'not-admin');
  // Or with Ana's admin list copied in: the creator still is not an admin of the parent epoch.
  const copied = await mState._commit({ prev: hex.decode(g.record.epochId), signer: mallory, members: [ana.pub, mallory.pub], removed: [bo.pub], admins: g.record.admins, name: '' });
  assert.equal((await boState.receive(copied.record, copied.secret)).reason, 'not-admin');
  assert.equal(boState.current, g.record.epochId);
  // Tampering with any field of a real commit breaks it.
  const next = await g.state.rekey({ signer: ana, add: [mallory.pub] });
  for (const change of [{ members: [ana.pub, bo.pub] }, { epochId: '00'.repeat(32) }, { commit: '11'.repeat(32) }, { t: next.record.t + 1 }]) {
    const r = await boState.receive(Object.assign({}, next.record, change), next.secret);
    assert.equal(r.ok, false, JSON.stringify(Object.keys(change)));
  }
  assert.equal((await boState.receive(next.record, new Uint8Array(32))).reason, 'commit', 'a secret that does not match the commit');
  assert.equal((await boState.receive(next.record, next.secret)).ok, true);
  // Cap.
  const many = [];
  for (let i = 0; i < GROUP_MAX; i++) many.push((await person()).pub);
  await assert.rejects(GroupState.create({ ledgerId: L, creator: ana, members: many, now: () => T0 }), (e) => e.code === 'E_LIMIT');
  const ok = await GroupState.create({ ledgerId: L, creator: ana, members: many.slice(0, GROUP_MAX - 1), now: () => T0 });
  assert.equal(ok.state.members().length, GROUP_MAX);
  await assert.rejects(ok.state.rekey({ signer: ana, add: [mallory.pub] }), (e) => e.code === 'E_LIMIT');
});

test('grace: members keep listening on the previous epoch for 7 days', async () => {
  let t = T0;
  const ana = await person();
  const bo = await person();
  const g = await GroupState.create({ ledgerId: L, creator: ana, members: [bo.pub], now: () => t });
  const first = g.state.current;
  await g.state.rekey({ signer: ana, add: [(await person()).pub] });
  let ids = g.state.listening().map((e) => hex.encode(e.epochId));
  assert.ok(ids.includes(first));
  assert.equal(g.state.listening().filter((e) => e.current).length, 1);
  t = T0 + 7 * DAY_MS + 1;
  ids = g.state.listening().map((e) => hex.encode(e.epochId));
  assert.ok(!ids.includes(first));
  assert.equal(ids.length, 1);
});
