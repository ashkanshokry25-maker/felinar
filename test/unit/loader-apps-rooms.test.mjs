// Unit tests for rooms in src/loader/apps.js (ARCHITECTURE 15.21): the owner's code and lane, the knock and the approval,
// the roster sealed under the room secret by the owner, the room secret sealed per member, group messages and how they reach everyone (also through members
// when the owner has no wire to someone), and what a rejected or outside person never gets; and that a room never carries the hint 'alone' of a
// conversation. Real WebCrypto, a fake rendezvous and
// a fake torrent manager (test/unit/fakes/apps-fakes.mjs). Run: node tools/run-unit.mjs test/unit/loader-apps-rooms.test.mjs
import { test, describe, afterEach } from 'node:test'
import assert from 'node:assert/strict'

import {
  encodeFrame, decodeFrame, sealRoster, sealGroupBody, sealRoomKey, sealHello, codeKey, splitCode, generateCode, signAccept, T, EXT_NAME, randomBytes
} from '../../src/loader/apps-crypto.js'
import { LIMITS } from '../../src/loader/apps.js'
import { makeWorld, makePerson, CoreRendezvous, FakeLink, until, settle } from './fakes/apps-fakes.mjs'

const created = []
afterEach(() => {
  for (const p of created.splice(0)) {
    try { p.apps.destroy() } catch (_) { /* gone */ }
  }
})

async function make (w, name, opts) {
  const p = await w.make(name, opts)
  created.push(p)
  return p
}

const CODE_RE = /^[a-km-np-z2-9]{4}-[a-km-np-z2-9]{4}-[a-km-np-z2-9]{4}$/
const roomOf = (P, id) => P.apps.state().rooms.find((r) => r.id === id)
const onlyRoom = (P) => P.apps.state().rooms[0]
const rec = (P, id) => P.apps.rooms.get(id)
const channelOf = (code) => code.replace(/-/g, '').slice(0, 4)
const secretOf = (code) => code.replace(/-/g, '').slice(4)

/** The owner makes a room, each of Ms asks to join and is accepted; resolves when every member holds the room secret. */
async function roomUp (w, O, Ms) {
  const r = await O.apps.createRoom()
  assert.ok(r.id, 'createRoom: ' + JSON.stringify(r))
  const ids = []
  for (const M of Ms) {
    const j = await M.apps.joinRoom(r.code)
    assert.ok(j.id, 'joinRoom: ' + JSON.stringify(j))
    ids.push(j.id)
  }
  await until(() => O.apps.state().requests.length === Ms.length, 'the join requests at the owner')
  for (const q of O.apps.state().requests.slice()) {
    const a = await O.apps.acceptMember(q.knock)
    assert.equal(a.id, r.id, 'acceptMember: ' + JSON.stringify(a))
  }
  await until(() => Ms.every((M, i) => roomOf(M, ids[i]).status === 'connected'), 'every member connected')
  return { id: r.id, code: r.code, ids }
}

const texts = (P, id) => roomOf(P, id).messages.map((m) => m.text)

/** Waits for a call that sleeps on the fake clock (the goodbye grace), moving the clock on until it is done. */
async function closing (w, promise) {
  let result
  let done = false
  promise.then((r) => { result = r; done = true })
  await until(() => { w.advance(60); return done }, 'the call to finish')
  return result
}

describe('creating a room', () => {
  test('createRoom: a code of 12 characters, a room the owner holds alone, a lane the rendezvous allows, nothing joined', async () => {
    const w = makeWorld()
    const O = await make(w, 'Owner')
    const r = await O.apps.createRoom()
    assert.match(r.code, CODE_RE)
    const room = roomOf(O, r.id)
    assert.equal(room.owner, true)
    assert.equal(room.status, 'open')
    assert.equal(room.code, r.code)
    assert.equal(room.codeClosed, null)
    assert.equal(room.members.length, 1)
    assert.deepEqual([room.members[0].you, room.members[0].owner, room.members[0].name], [true, true, 'Owner'])
    assert.deepEqual([room.messages.length, room.unread, room.peers], [0, 0, 0])
    const ch = w.rdv.channels.get(channelOf(r.code))
    assert.equal(ch.kind, 'room')
    assert.match(ch.lane, /^[0-9a-f]{40}$/)
    assert.ok(w.rdv.isAllowed(ch.lane))
    assert.equal(O.loadCalls.length, 0, 'the torrent manager is not loaded yet')
    assert.equal(O.tm.joined.length, 0, 'no lane is joined before anyone is accepted')
    assert.equal(w.net.frames.length, 0)
    assert.equal(O.apps.state().tm, false)
    assert.ok(!w.rdv.raw.join('\n').includes(secretOf(r.code)), 'the secret half of the code never reaches the rendezvous')
  })

  test('a person owns up to four rooms; each has its own code', async () => {
    const w = makeWorld()
    const O = await make(w, 'Owner')
    const codes = new Set()
    for (let i = 0; i < 4; i++) {
      const r = await O.apps.createRoom()
      assert.ok(r.id, JSON.stringify(r))
      codes.add(r.code)
    }
    assert.equal(codes.size, 4)
    assert.deepEqual(await O.apps.createRoom(), { error: 'too many rooms' })
    assert.equal(O.apps.state().rooms.length, 4)
  })

  test('not signed in, no keys and no rendezvous are named errors', async () => {
    const w = makeWorld()
    const out = await make(w, 'Out', { signedIn: false })
    assert.deepEqual(await out.apps.createRoom(), { error: 'not signed in' })
    assert.deepEqual(await out.apps.joinRoom('abcd-efgh-ijkm'), { error: 'not signed in' })
    const follower = await make(w, 'Follower')
    follower.identity.person = Object.assign({}, follower.identity.person)
    follower.identity.keys = () => null
    assert.deepEqual(await follower.apps.createRoom(), { error: 'not ready' })
  })

  test('joinRoom: a code that is not a code, one of your own, one nobody opened', async () => {
    const w = makeWorld()
    const O = await make(w, 'Owner')
    const M = await make(w, 'Mia')
    assert.deepEqual(await M.apps.joinRoom('nope'), { error: 'bad code' })
    assert.deepEqual(await M.apps.joinRoom('abcd-efgh-ijk0'), { error: 'bad code' })
    const r = await O.apps.createRoom()
    assert.deepEqual(await O.apps.joinRoom(r.code), { error: 'own code' })
    assert.deepEqual(await M.apps.joinRoom('abcd-efgh-ijkm'), { error: 'unknown code' })
    assert.equal(M.apps.state().rooms.length, 0, 'a failed join leaves nothing behind')
  })
})

describe('joining: the knock, the approval, and what moves before it', () => {
  test('a join request reaches the owner as a request of kind room; nothing is joined or loaded on either side before the owner accepts', async () => {
    const w = makeWorld()
    const O = await make(w, 'Owner')
    const M = await make(w, 'Mia')
    const r = await O.apps.createRoom()
    const j = await M.apps.joinRoom(r.code)
    assert.ok(j.knock && j.id)
    const mine = roomOf(M, j.id)
    assert.deepEqual([mine.status, mine.owner, mine.knock, mine.code], ['waiting', false, j.knock, null])
    await until(() => O.apps.state().requests.length === 1, 'the request')
    const q = O.apps.state().requests[0]
    assert.deepEqual([q.kind, q.roomId, q.from.name, q.knock], ['room', r.id, 'Mia', j.knock])
    assert.match(q.from.short, /^[a-km-np-z2-9]{4}-[a-km-np-z2-9]{4}$/)
    for (const P of [O, M]) {
      assert.equal(P.loadCalls.length, 0, P.name + ' did not load the manager')
      assert.equal(P.tm.joined.length, 0, P.name + ' did not join a lane')
    }
    assert.equal(w.net.frames.length, 0, 'no frame on any wire')
    assert.equal(w.net.members.size, 0)
    assert.ok(!w.rdv.raw.join('\n').includes(secretOf(r.code)))
  })

  test('accept: both join the same lane of kind group, and the member gets the roster and the room secret', async () => {
    const w = makeWorld()
    const O = await make(w, 'Owner')
    const M = await make(w, 'Mia')
    const room = await roomUp(w, O, [M])
    const lane = w.rdv.channels.get(channelOf(room.code)).lane
    assert.deepEqual(O.tm.joined, [{ kind: 'group', infoHash: lane, announce: ['wss://rendezvous.invalid/'] }])
    assert.deepEqual(M.tm.joined, [{ kind: 'group', infoHash: lane, announce: ['wss://rendezvous.invalid/'] }])
    assert.equal(O.apps.state().tm, true)
    assert.equal(O.loadCalls.length, 1)
    assert.equal(M.loadCalls.length, 1)
    const mine = roomOf(M, room.ids[0])
    assert.equal(mine.status, 'connected')
    assert.equal(mine.ownerPub, O.person.keys.pub)
    assert.deepEqual(mine.members.map((m) => [m.name, m.you, m.owner]), [['Owner', false, true], ['Mia', true, false]])
    assert.equal(O.apps.state().requests.length, 0)
    assert.equal(roomOf(O, room.id).members.length, 2)
    assert.equal(roomOf(O, room.id).peers, 1)
    assert.equal(mine.peers, 1)
  })

  test('the roster is the owner\'s, sealed under the room secret, and counts up with every member', async () => {
    const w = makeWorld()
    const O = await make(w, 'Owner')
    const [A, B] = [await make(w, 'Ann'), await make(w, 'Bob')]
    const room = await roomUp(w, O, [A, B])
    assert.equal(rec(O, room.id).seq, 3)
    await until(() => rec(A, room.ids[0]).seq === 3 && rec(B, room.ids[1]).seq === 3, 'the roster with three members at the members')
    for (const [P, id] of [[A, room.ids[0]], [B, room.ids[1]]]) {
      assert.deepEqual(roomOf(P, id).members.map((m) => m.name), ['Owner', 'Ann', 'Bob'])
    }
  })

  test('the owner rejecting a request: the member sees rejected, loads nothing, joins nothing, and never learns the lane', async () => {
    const w = makeWorld()
    const O = await make(w, 'Owner')
    const [A, E] = [await make(w, 'Ann'), await make(w, 'Eve')]
    const r = await O.apps.createRoom()
    const ja = await A.apps.joinRoom(r.code)
    const je = await E.apps.joinRoom(r.code)
    await until(() => O.apps.state().requests.length === 2, 'both requests')
    const byName = (n) => O.apps.state().requests.find((q) => q.from.name === n)
    assert.deepEqual(await O.apps.rejectMember(byName('Eve').knock), { ok: true })
    assert.ok((await O.apps.acceptMember(byName('Ann').knock)).id)
    await until(() => roomOf(E, je.id).status === 'rejected' && roomOf(A, ja.id).status === 'connected', 'the answers')
    assert.equal(roomOf(E, je.id).reason, 'rejected')
    assert.equal(E.loadCalls.length, 0)
    assert.equal(E.tm.joined.length, 0)
    assert.equal(rec(E, je.id).lane, null, 'the rejected member holds no lane')
    assert.equal(roomOf(E, je.id).members.length, 0)
    assert.deepEqual(await E.apps.sendRoom(je.id, 'let me in'), { error: 'rejected' })
    await O.apps.sendRoom(r.id, 'welcome Ann')
    await until(() => texts(A, ja.id).length === 1, 'the message at Ann')
    await settle(10)
    assert.deepEqual(texts(E, je.id), [])
    assert.equal(w.net.frames.filter((f) => f.from === 'Eve').length, 0, 'Eve wrote nothing and heard nothing')
  })

  test('cancelKnock withdraws a join request: the waiting room goes and the owner no longer sees it', async () => {
    const w = makeWorld()
    const O = await make(w, 'Owner')
    const M = await make(w, 'Mia')
    const r = await O.apps.createRoom()
    const j = await M.apps.joinRoom(r.code)
    await until(() => O.apps.state().requests.length === 1, 'the request')
    assert.deepEqual(await M.apps.cancelKnock(j.knock), { ok: true })
    assert.equal(M.apps.state().rooms.length, 0)
    await until(() => O.apps.state().requests.length === 0, 'the request is withdrawn')
    assert.deepEqual(await M.apps.cancelKnock(j.knock), { error: 'no request' })
  })

  test('leaving a waiting room cancels the knock too', async () => {
    const w = makeWorld()
    const O = await make(w, 'Owner')
    const M = await make(w, 'Mia')
    const r = await O.apps.createRoom()
    const j = await M.apps.joinRoom(r.code)
    await until(() => O.apps.state().requests.length === 1, 'the request')
    assert.deepEqual(await M.apps.leaveRoom(j.id), { ok: true })
    await until(() => O.apps.state().requests.length === 0, 'the request is withdrawn')
  })

  test('a second request from a person who is already inside is turned away; the room holds at most roomMembersMax people', async () => {
    const w = makeWorld()
    const O = await make(w, 'Owner', { limits: { roomMembersMax: 2 } })
    const [A, B] = [await make(w, 'Ann'), await make(w, 'Bob')]
    const r = await O.apps.createRoom()
    const ja = await A.apps.joinRoom(r.code)
    const jb = await B.apps.joinRoom(r.code)
    await until(() => O.apps.state().requests.length === 2, 'both requests')
    const [q1, q2] = O.apps.state().requests
    assert.ok((await O.apps.acceptMember(q1.knock)).id)
    assert.deepEqual(await O.apps.acceptMember(q2.knock), { error: 'room full' })
    await O.apps.rejectMember(q2.knock)
    await until(() => [ja, jb].some((j) => roomOf(A, j.id) || roomOf(B, j.id)), 'state')
    await until(() => O.apps.state().requests.length === 0, 'requests settle')
    assert.equal(roomOf(O, r.id).members.length, 2)
  })
})

describe('messages in a room', () => {
  test('a message reaches everyone once, in order, with the writer named; unread counts for others, not for the writer', async () => {
    const w = makeWorld()
    const O = await make(w, 'Owner')
    const [A, B] = [await make(w, 'Ann'), await make(w, 'Bob')]
    const room = await roomUp(w, O, [A, B])
    const [ia, ib] = room.ids
    const s1 = await A.apps.sendRoom(ia, 'hello *room*')
    assert.ok(s1.id)
    await until(() => texts(O, room.id).length === 1 && texts(B, ib).length === 1, 'the message at the others')
    await settle(15)
    const m = roomOf(B, ib).messages[0]
    assert.deepEqual([m.text, m.mine, m.from.name, m.from.pub, m.fmt, m.id], ['hello *room*', false, 'Ann', A.person.keys.pub, 'md1', s1.id])
    assert.match(m.from.short, /^[a-km-np-z2-9]{4}-[a-km-np-z2-9]{4}$/)
    const own = roomOf(A, ia).messages[0]
    assert.deepEqual([own.mine, own.status, own.text], [true, 'sent', 'hello *room*'])
    assert.deepEqual([roomOf(O, room.id).unread, roomOf(B, ib).unread, roomOf(A, ia).unread], [1, 1, 0])
    await B.apps.sendRoom(ib, 'hi Ann')
    await O.apps.sendRoom(room.id, 'welcome')
    await until(() => [O, A, B].every((P, i) => roomOf(P, [room.id, ia, ib][i]).messages.length === 3), 'all three messages everywhere')
    await settle(15)
    for (const [P, id] of [[O, room.id], [A, ia], [B, ib]]) {
      assert.equal(roomOf(P, id).messages.length, 3, P.name + ' has no duplicates')
      assert.deepEqual(roomOf(P, id).messages.map((x) => x.t), roomOf(P, id).messages.map((x) => x.t).slice().sort((p, q) => p - q))
    }
    assert.deepEqual(await B.apps.markRoomRead(ib), { ok: true })
    assert.equal(roomOf(B, ib).unread, 0)
    assert.deepEqual(await B.apps.markRoomRead('nope'), { error: 'no room' })
  })

  test('nothing readable is on the wire: no frame carries a message text, a name or a code', async () => {
    const w = makeWorld()
    const O = await make(w, 'Owner')
    const A = await make(w, 'Ann')
    const room = await roomUp(w, O, [A])
    await A.apps.sendRoom(room.ids[0], 'a very particular sentence about herons')
    await until(() => texts(O, room.id).length === 1, 'the message')
    const dec = new TextDecoder('utf-8')
    let groups = 0
    let rosters = 0
    for (const f of w.net.frames) {
      const s = dec.decode(f.bytes)
      const fr = decodeFrame(f.bytes)
      assert.ok(fr && [T.ROOM_KEY, T.ROSTER, T.GROUP].includes(fr.type))
      for (const needle of ['herons', 'particular', 'sentence']) assert.ok(!s.includes(needle), needle)
      // the roster too is sealed: no frame names a person or shows a key (ADV-1)
      for (const needle of ['Ann', 'Owner']) assert.ok(!s.includes('"' + needle + '"'), 'a frame names people: ' + needle)
      for (const P of [O, A]) for (const key of [P.person.keys.pub, P.person.keys.chat.pub]) assert.ok(!s.includes(key.slice(5, 40)), 'a frame shows a key of ' + P.name)
      if (fr.type === T.GROUP) groups++
      if (fr.type === T.ROSTER) rosters++
    }
    assert.ok(groups >= 1)
    assert.ok(rosters >= 1, 'the roster was on the wire, sealed')
    assert.ok(!w.rdv.raw.join('\n').includes('herons'))
  })

  test('a member the owner has no wire to still gets the roster, its box and every message through the others (a chain)', async () => {
    const w = makeWorld()
    const O = await make(w, 'Owner')
    const [A, B] = [await make(w, 'Ann'), await make(w, 'Bob')]
    // wires only Owner - Ann and Ann - Bob
    w.net.canConnect = (x, y) => [x.name, y.name].sort().join('+') !== 'Bob+Owner'
    const room = await roomUp(w, O, [A, B])
    const [ia, ib] = room.ids
    assert.equal(roomOf(B, ib).status, 'connected')
    await until(() => rec(B, ib).seq === 3, 'the roster relayed to Bob')
    assert.deepEqual(roomOf(B, ib).members.map((m) => m.name), ['Owner', 'Ann', 'Bob'])
    await B.apps.sendRoom(ib, 'from the far end')
    await until(() => texts(O, room.id).length === 1 && texts(A, ia).length === 1, 'the message at the owner and Ann')
    await O.apps.sendRoom(room.id, 'from the owner')
    await until(() => texts(B, ib).length === 2, 'the owner message at Bob')
    await settle(20)
    assert.deepEqual(texts(O, room.id), ['from the far end', 'from the owner'])
    assert.deepEqual(texts(B, ib), ['from the far end', 'from the owner'])
    assert.equal(texts(A, ia).length, 2)
  })

  test('with the owner in the middle (members have no wire to each other) a message still reaches the other member', async () => {
    const w = makeWorld()
    const O = await make(w, 'Owner')
    const [A, B] = [await make(w, 'Ann'), await make(w, 'Bob')]
    w.net.canConnect = (x, y) => x.name === 'Owner' || y.name === 'Owner'
    const room = await roomUp(w, O, [A, B])
    await A.apps.sendRoom(room.ids[0], 'via the owner')
    await until(() => texts(B, room.ids[1]).length === 1, 'the message at Bob')
    await settle(15)
    assert.equal(texts(B, room.ids[1]).length, 1)
    assert.equal(texts(O, room.id).length, 1)
  })

  test('sendRoom: empty, too long, before the key, while waiting, after the room closed', async () => {
    const w = makeWorld()
    const O = await make(w, 'Owner')
    const M = await make(w, 'Mia')
    const r = await O.apps.createRoom()
    const j = await M.apps.joinRoom(r.code)
    assert.deepEqual(await M.apps.sendRoom(j.id, 'hi'), { error: 'waiting' })
    assert.deepEqual(await M.apps.sendRoom('nope', 'hi'), { error: 'no room' })
    await until(() => O.apps.state().requests.length === 1, 'the request')
    assert.deepEqual(await O.apps.sendRoom(r.id, ''), { error: 'empty' })
    assert.deepEqual(await O.apps.sendRoom(r.id, '  \n '), { error: 'empty' })
    assert.deepEqual(await O.apps.sendRoom(r.id, 'x'.repeat(2001)), { error: 'too long' })
    assert.ok((await O.apps.sendRoom(r.id, 'x'.repeat(1900))).id, 'a long text that fits one frame is sent')
    await O.apps.acceptMember(O.apps.state().requests[0].knock)
    await until(() => roomOf(M, j.id).status === 'connected', 'connected')
    assert.ok((await M.apps.sendRoom(j.id, 'now it works')).id)
  })

  test('a text at the limit that does not fit one frame (multi-byte characters) is refused rather than cut', async () => {
    const w = makeWorld()
    const O = await make(w, 'Owner')
    const r = await O.apps.createRoom()
    assert.deepEqual(await O.apps.sendRoom(r.id, '\u{633}'.repeat(2000)), { error: 'too long' })
    assert.equal(roomOf(O, r.id).messages.length, 0)
    assert.ok((await O.apps.sendRoom(r.id, '\u{633}'.repeat(1500))).id)
  })

  test('messages written while no wire is up wait as queued and go out when one comes', async () => {
    const w = makeWorld()
    const O = await make(w, 'Owner')
    const A = await make(w, 'Ann')
    const room = await roomUp(w, O, [A])
    const ia = room.ids[0]
    w.net.canConnect = () => false
    w.net.dropAll()
    await until(() => roomOf(A, ia).peers === 0, 'the wire is gone')
    const s = await A.apps.sendRoom(ia, 'while away')
    await settle(10)
    assert.equal(roomOf(A, ia).messages.find((m) => m.id === s.id).status, 'queued')
    assert.equal(texts(O, room.id).length, 0)
    w.net.canConnect = () => true
    w.net.resume()
    await until(() => texts(O, room.id).length === 1, 'the queued message at the owner')
    await until(() => roomOf(A, ia).messages[0].status === 'sent', 'sent')
  })

  test('the lane allows 60 sent messages a minute: more wait and go out as the allowance comes back', async () => {
    const w = makeWorld()
    const O = await make(w, 'Owner')
    const A = await make(w, 'Ann')
    const room = await roomUp(w, O, [A])
    const ia = room.ids[0]
    for (let i = 0; i < 62; i++) assert.ok((await A.apps.sendRoom(ia, 'm' + i)).id)
    await until(() => texts(O, room.id).length >= 60, 'sixty at the owner', 30000)
    await settle(10)
    assert.equal(texts(O, room.id).length, 60)
    assert.equal(roomOf(A, ia).messages.filter((m) => m.status === 'queued').length, 2)
    w.advance(2100)
    await until(() => texts(O, room.id).length === 62, 'the last two once the allowance is back', 15000)
  })
})

describe('who can write into a room', () => {
  test('a frame sealed under another secret is struck; three strikes close that wire; nothing is shown', async () => {
    const w = makeWorld()
    const O = await make(w, 'Owner')
    const A = await make(w, 'Ann')
    const room = await roomUp(w, O, [A])
    const outsider = await makePerson('Out')
    const lane = [...O.apps.rooms.values()][0].lane
    const wire = [...w.net.wiresOf(lane)][0].wa // the owner's end
    const wireOwner = w.net.wiresOf(lane)[0]
    const ownerWire = wireOwner.wa.label === 'Owner' ? wireOwner.wa : wireOwner.wb
    for (let i = 0; i < 3; i++) {
      const s = await sealGroupBody({ keys: outsider.keys, secret: randomBytes(32), lane, body: { k: 'msg', id: 'AAAAAAAAAAAAAAA' + i, t: 1800000000000, text: 'spam ' + i, fmt: 'md1' }, now: 1800000000000, n: i })
      ownerWire._ext[EXT_NAME].onMessage(encodeFrame(T.GROUP, s.payload))
      await settle(8)
    }
    await until(() => O.tm.ignored.length === 1, 'the wire is closed after three strikes')
    assert.match(O.tm.ignored[0][1], /^mw_apps1:/)
    assert.deepEqual(texts(O, room.id), [])
    assert.ok(wire)
  })

  test('a roster sealed by a member (who holds the secret, but is not the owner) is refused and changes nothing', async () => {
    const w = makeWorld()
    const O = await make(w, 'Owner')
    const [A, B] = [await make(w, 'Ann'), await make(w, 'Bob')]
    const room = await roomUp(w, O, [A, B])
    const [ia, ib] = room.ids
    await until(() => rec(B, ib).seq === 3, 'the roster at Bob')
    const lane = rec(B, ib).lane
    // Ann holds the room secret like every member and may seal whatever she likes with it: only the owner's signature inside makes a roster
    const forged = await sealRoster({
      keys: A.person.keys, secret: rec(A, ia).p.secret, lane, seq: 9,
      members: [{ pub: A.person.keys.pub, name: 'Ann' }, { pub: B.person.keys.pub, name: 'Bob' }], t: 1800000000000
    })
    const pair = w.net.wiresOf(lane).find((p) => [p.wa.label, p.wb.label].sort().join('+') === 'Ann+Bob' || [p.wa.label, p.wb.label].includes('Bob'))
    const bobWire = pair.wa.label === 'Bob' ? pair.wa : pair.wb
    bobWire._ext[EXT_NAME].onMessage(encodeFrame(T.ROSTER, forged.payload))
    await settle(15)
    assert.equal(rec(B, ib).seq, 3)
    assert.deepEqual(roomOf(B, ib).members.map((m) => m.name), ['Owner', 'Ann', 'Bob'])
    assert.ok(ia)
  })

  test('a roster frame that is not a box at all, or is sealed under another secret, is a strike; three close the wire', async () => {
    const w = makeWorld()
    const O = await make(w, 'Owner')
    const A = await make(w, 'Ann')
    const room = await roomUp(w, O, [A])
    const lane = rec(A, room.ids[0]).lane
    const pair = w.net.wiresOf(lane)[0]
    const annWire = pair.wa.label === 'Ann' ? pair.wa : pair.wb
    const other = await sealRoster({ keys: O.person.keys, secret: randomBytes(32), lane, seq: 9, members: [{ pub: O.person.keys.pub, name: 'Owner' }], t: w.clock.now() })
    const junk = [{ ct: 'x' }, other.payload, Object.assign({}, other.payload, { iv: 'AAAA' })]
    for (const payload of junk) {
      annWire._ext[EXT_NAME].onMessage(encodeFrame(T.ROSTER, payload))
      await settle(8)
    }
    await until(() => A.tm.ignored.length === 1, 'the wire is closed after three strikes')
    assert.match(A.tm.ignored[0][1], /^mw_apps1:roster/)
    assert.equal(rec(A, room.ids[0]).seq, 2, 'the roster is as it was')
  })

  test('a room secret sealed by a member (not the owner) is not taken', async () => {
    const w = makeWorld()
    const O = await make(w, 'Owner')
    const [A, B] = [await make(w, 'Ann'), await make(w, 'Bob')]
    const r = await O.apps.createRoom()
    const ja = await A.apps.joinRoom(r.code)
    await until(() => O.apps.state().requests.length === 1, 'the request')
    await O.apps.acceptMember(O.apps.state().requests[0].knock)
    await until(() => roomOf(A, ja.id).status === 'connected', 'Ann connected')
    const lane = rec(A, ja.id).lane
    const jb = await B.apps.joinRoom(r.code)
    // Bob is asked in the room's name but Ann seals a secret to him
    const fake = await sealRoomKey({ keys: A.person.keys, memberEk: B.person.keys.chat.pub, secret: randomBytes(32), lane, ownerPub: O.person.keys.pub })
    await until(() => O.apps.state().requests.length === 1, 'the request from Bob')
    await O.apps.acceptMember(O.apps.state().requests[0].knock)
    await until(() => roomOf(B, jb.id).status === 'connected', 'Bob connected with the real secret')
    const real = Buffer.from(rec(B, jb.id).p.secret).toString('hex')
    const pair = w.net.wiresOf(lane).find((p) => p.wa.label === 'Bob' || p.wb.label === 'Bob')
    const bobWire = pair.wa.label === 'Bob' ? pair.wa : pair.wb
    bobWire._ext[EXT_NAME].onMessage(encodeFrame(T.ROOM_KEY, fake))
    await settle(10)
    assert.equal(Buffer.from(rec(B, jb.id).p.secret).toString('hex'), real)
  })

  test('a person blocked by a member is not shown to that member, but others still see them', async () => {
    const w = makeWorld()
    const O = await make(w, 'Owner')
    const [A, B] = [await make(w, 'Ann'), await make(w, 'Bob')]
    const room = await roomUp(w, O, [A, B])
    const [ia, ib] = room.ids
    await B.apps.block(A.person.keys.pub)
    await A.apps.sendRoom(ia, 'can you hear me')
    await until(() => texts(O, room.id).length === 1, 'the owner hears')
    await settle(20)
    assert.deepEqual(texts(B, ib), [])
  })
})

describe('leaving, closing and the code', () => {
  test('a member leaves: the room goes from the member, the lane is left, the others are not affected', async () => {
    const w = makeWorld()
    const O = await make(w, 'Owner')
    const [A, B] = [await make(w, 'Ann'), await make(w, 'Bob')]
    const room = await roomUp(w, O, [A, B])
    const [ia, ib] = room.ids
    const lane = rec(A, ia).lane
    assert.deepEqual(await A.apps.leaveRoom(ia), { ok: true })
    assert.equal(A.apps.state().rooms.length, 0)
    assert.equal(A.tm.lanes.get(lane), undefined, 'the lane is left')
    await O.apps.sendRoom(room.id, 'still here')
    await until(() => texts(B, ib).length === 1, 'the others still hear the owner')
    assert.deepEqual(await A.apps.leaveRoom(ia), { error: 'no room' })
  })

  test('the owner closes the room: the code is released, members see closed and can write no more', async () => {
    const w = makeWorld()
    const O = await make(w, 'Owner', { limits: { byeGraceMs: 50 } })
    const A = await make(w, 'Ann')
    const room = await roomUp(w, O, [A])
    const ia = room.ids[0]
    assert.deepEqual(await closing(w, O.apps.leaveRoom(room.id)), { ok: true })
    await until(() => roomOf(A, ia).status === 'closed', 'members see the room closed')
    assert.equal(w.rdv.channels.has(channelOf(room.code)), false, 'the code is released at the rendezvous')
    assert.deepEqual(await A.apps.sendRoom(ia, 'anyone'), { error: 'left' })
    assert.equal(O.apps.state().rooms.length, 0)
  })

  test('closing the code stops new requests but not the room; closing the room is the only way a member learns', async () => {
    const w = makeWorld()
    const O = await make(w, 'Owner')
    const M = await make(w, 'Mia')
    const r = await O.apps.createRoom()
    // five knocks nobody can open (a wrong secret) close the code
    const wrong = r.code.slice(0, -1) + (r.code.endsWith('2') ? '3' : '2')
    const people = []
    for (let i = 0; i < 5; i++) people.push(await make(w, 'Bad' + i))
    for (const P of people) assert.ok((await P.apps.joinRoom(wrong)).id)
    await until(() => roomOf(O, r.id).codeClosed === 'bad-knocks', 'the code is closed after five unopenable knocks')
    assert.equal(roomOf(O, r.id).code, null)
    assert.equal(O.apps.state().requests.length, 0)
    assert.deepEqual(await M.apps.joinRoom(r.code), { error: 'unknown code' })
    assert.equal(roomOf(O, r.id).status, 'open', 'the room itself is still there')
    await until(() => people.every((P) => P.apps.state().rooms[0].status === 'rejected'), 'the pending knocks end')
    assert.equal(people[0].apps.state().rooms[0].reason, 'closed')
  })

  test('a code the rendezvous ends after 24 hours: the room keeps going, the code shows as expired', async () => {
    const w = makeWorld()
    const O = await make(w, 'Owner')
    const r = await O.apps.createRoom()
    const conn = w.rdv.channels.get(channelOf(r.code)).conn
    w.rdv._send(conn, { action: 'room-close', channel: channelOf(r.code), reason: 'expired' })
    await until(() => roomOf(O, r.id).codeClosed === 'expired', 'the code is expired')
    assert.equal(roomOf(O, r.id).code, null)
    assert.equal(roomOf(O, r.id).status, 'open')
  })

  test('a lost socket: the owner of an empty room gets its code back on the same channel; with members the closed code stays closed', async () => {
    const w = makeWorld()
    const O = await make(w, 'Owner')
    const A = await make(w, 'Ann')
    const r1 = await O.apps.createRoom()
    w.rdv.dropAll()
    await until(() => O.link.state === 'backoff', 'the link is lost')
    w.advance(1000)
    await until(() => w.rdv.channels.has(channelOf(r1.code)), 'the code is open again')
    assert.equal(roomOf(O, r1.id).code, r1.code)
    assert.ok((await A.apps.joinRoom(r1.code)).id, 'a new member can still ask')
    await until(() => O.apps.state().requests.length === 1, 'the request')
    await O.apps.acceptMember(O.apps.state().requests[0].knock)
    await until(() => onlyRoom(A).status === 'connected', 'Ann is in')
    // now the owner loses the socket with a member inside: the rendezvous mints another lane on re-open, which would split the room
    w.rdv.dropAll()
    await until(() => O.link.state === 'backoff', 'lost again')
    w.advance(1000)
    await until(() => roomOf(O, r1.id).codeClosed === 'lane-changed', 'the code stays closed')
    assert.equal(roomOf(O, r1.id).status, 'open')
    assert.equal(w.rdv.channels.has(channelOf(r1.code)), false)
  })
})

describe('frames that come early', () => {
  const frameBytes = (w, type) => w.net.frames.map((f) => ({ f, fr: decodeFrame(f.bytes) })).filter((x) => x.fr && x.fr.type === type).map((x) => x.f.bytes)
  const wireOf = (w, P, lane) => {
    const p = w.net.wiresOf(lane).find((x) => x.wa.label === P.name || x.wb.label === P.name)
    return p.wa.label === P.name ? p.wa : p.wb
  }

  test('a message that comes before the room secret is kept and shown, once, when the secret arrives', async () => {
    const w = makeWorld()
    const O = await make(w, 'Owner')
    const [A, B] = [await make(w, 'Ann'), await make(w, 'Bob')]
    // Bob's room key never reaches him until the test hands it over: every room key written towards Bob is lost on the wire, whoever
    // sends it (the frame is still recorded in net.frames, where the test takes it from). A copy that is merely late, which is what a
    // fixed number of event loop turns cannot rule out under load, can then never give Bob the secret early.
    w.net.drops = (wire, bytes) => {
      const fr = decodeFrame(bytes)
      return !!fr && fr.type === T.ROOM_KEY && !!wire.peer && wire.peer.label === 'Bob'
    }
    const r = await O.apps.createRoom()
    const ja = await A.apps.joinRoom(r.code)
    await until(() => O.apps.state().requests.length === 1, 'the request of Ann')
    await O.apps.acceptMember(O.apps.state().requests[0].knock)
    const jb = await B.apps.joinRoom(r.code)
    await until(() => O.apps.state().requests.length === 1, 'the request of Bob')
    await O.apps.acceptMember(O.apps.state().requests[0].knock)
    const [ia, ib] = [ja.id, jb.id]
    await until(() => roomOf(A, ia).status === 'connected', 'Ann is in')
    const rb = rec(B, ib)
    const heldOn = () => Array.from(rb.p.wires).filter((x) => x.heldRoster).length
    await until(() => heldOn() > 0 && Array.from(rb.p.wires).filter((x) => x.ready).length === 2, 'both wires of Bob are up and the sealed roster is held')
    assert.equal(rb.p.secret, null, 'Bob has no secret yet')
    assert.notEqual(roomOf(B, ib).status, 'connected')
    assert.equal(rb.seq, 0, 'the roster is sealed under the secret, so it waits for it: Bob cannot read it yet (ADV-1)')
    assert.deepEqual(roomOf(B, ib).members.map((m) => m.name), ['Owner'])
    const keys = frameBytes(w, T.ROOM_KEY)
    assert.ok(keys.length >= 2, 'the owner wrote a box for each member')
    await A.apps.sendRoom(ia, 'early bird')
    await until(() => rb.p.pending.length === 1, 'the frame is held')
    assert.deepEqual(texts(B, ib), [])
    const wire = wireOf(w, B, rb.lane)
    w.net.drops = null
    for (const k of keys) wire._ext[EXT_NAME].onMessage(k)
    await until(() => roomOf(B, ib).status === 'connected' && texts(B, ib).length === 1, 'the held message is shown')
    assert.deepEqual(texts(B, ib), ['early bird'])
    assert.equal(rb.p.pending.length, 0)
    assert.equal(heldOn(), 0, 'the held roster was read when the secret came')
    assert.deepEqual([rb.seq, roomOf(B, ib).members.map((m) => m.name)], [3, ['Owner', 'Ann', 'Bob']])
    for (const k of keys) wire._ext[EXT_NAME].onMessage(k)
    await settle(15)
    assert.deepEqual(texts(B, ib), ['early bird'], 'nothing is shown twice')
  })

  test('a roster held without the secret is kept per wire: junk on one wire does not push out the owner\'s roster from another', async () => {
    const w = makeWorld()
    const O = await make(w, 'Owner')
    const [A, B] = [await make(w, 'Ann'), await make(w, 'Bob')]
    w.net.drops = (wire, bytes) => {
      const fr = decodeFrame(bytes)
      return !!fr && fr.type === T.ROOM_KEY && !!wire.peer && wire.peer.label === 'Bob'
    }
    const r = await O.apps.createRoom()
    const ja = await A.apps.joinRoom(r.code)
    await until(() => O.apps.state().requests.length === 1, 'the request of Ann')
    await O.apps.acceptMember(O.apps.state().requests[0].knock)
    const jb = await B.apps.joinRoom(r.code)
    await until(() => O.apps.state().requests.length === 1, 'the request of Bob')
    await O.apps.acceptMember(O.apps.state().requests[0].knock)
    await until(() => roomOf(A, ja.id).status === 'connected', 'Ann is in')
    const rb = rec(B, jb.id)
    const via = (name) => Array.from(rb.p.wires).find((x) => x.wire.peer && x.wire.peer.label === name)
    await until(() => via('Owner') && via('Ann') && via('Owner').heldRoster && via('Ann').heldRoster, 'both wires of Bob hold the sealed roster')
    assert.equal(rb.p.secret, null)
    // junk that is a box of the right shape, sealed under another secret, arrives on Ann's wire and takes that wire's place
    const junk = await sealRoster({ keys: O.person.keys, secret: randomBytes(32), lane: rb.lane, seq: 50, members: [{ pub: O.person.keys.pub, name: 'Owner' }], t: w.clock.now(), n: 7 })
    via('Ann').wire._ext[EXT_NAME].onMessage(encodeFrame(T.ROSTER, junk.payload))
    await settle(10)
    assert.deepEqual(via('Ann').heldRoster.payload, junk.payload, 'the junk replaced what that wire held')
    assert.notDeepEqual(via('Owner').heldRoster.payload, junk.payload, 'the owner\'s wire still holds the owner\'s roster')
    const keys = w.net.frames.map((f) => ({ f, fr: decodeFrame(f.bytes) })).filter((x) => x.fr && x.fr.type === T.ROOM_KEY).map((x) => x.f.bytes)
    w.net.drops = null
    for (const k of keys) via('Owner').wire._ext[EXT_NAME].onMessage(k)
    await until(() => roomOf(B, jb.id).status === 'connected' && rb.seq === 3, 'the secret came and the real roster was read')
    assert.deepEqual(roomOf(B, jb.id).members.map((m) => m.name), ['Owner', 'Ann', 'Bob'])
  })

  test('a writer who is not on the roster yet is held until the roster lists them, and dropped after 30 seconds', async () => {
    const w = makeWorld()
    const O = await make(w, 'Owner')
    const [A, B] = [await make(w, 'Ann'), await make(w, 'Bob')]
    const room = await roomUp(w, O, [A, B])
    const [ia, ib] = room.ids
    const rb = rec(B, ib)
    await until(() => rb.seq === 3 && Array.from(rb.p.wires).filter((x) => x.ready).length === 2, 'both wires of Bob are up')
    await settle(40)
    const wire = wireOf(w, B, rb.lane)
    const everyone = rb.members.map((m) => ({ pub: m.pub, name: m.name }))
    assert.equal(everyone.length, 3)
    // The rosters the owner would send, sealed by the owner under the room secret and numbered above everything in flight: Bob's number
    // is never put back, so a late relayed copy of roster 3 is ignored and cannot list Ann behind the test's back (the old way,
    // resetting the number to 0, let such a copy through whenever the machine was busy).
    const rosterFrame = async (seq) => encodeFrame(T.ROSTER, (await sealRoster({ keys: O.person.keys, secret: rb.p.secret, lane: rb.lane, seq, members: everyone, t: w.clock.now(), n: 100 + seq })).payload)
    const annOut = () => { rb.members = rb.members.filter((m) => m.pub !== A.person.keys.pub) }

    annOut()
    await A.apps.sendRoom(ia, 'who is this')
    await until(() => rb.p.pending.length === 1, 'held, the writer is unknown')
    assert.deepEqual(texts(B, ib), [])
    wire._ext[EXT_NAME].onMessage(await rosterFrame(4))
    await until(() => texts(B, ib).length === 1, 'shown once the roster names Ann')
    assert.equal(roomOf(B, ib).messages[0].from.name, 'Ann')
    assert.equal(rb.seq, 4)

    annOut()
    await A.apps.sendRoom(ia, 'too late')
    await until(() => rb.p.pending.length === 1, 'held again')
    w.advance(31000)
    wire._ext[EXT_NAME].onMessage(await rosterFrame(5))
    await until(() => rb.seq === 5, 'the roster is taken')
    assert.deepEqual(texts(B, ib), ['who is this'], 'the second one waited too long and is gone')
    assert.equal(rb.p.pending.length, 0)
  })
})

describe('after the adversary review (ADV-n): rooms', () => {
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
  const socket = (w) => new FakeLink(w.rdv, { setTimeoutFn: w.clock.setTimeout, clearTimeoutFn: w.clock.clearTimeout, random: () => 0.5 })

  test('ADV-9: a request to join whose chat key is the owner\'s own is turned away; an owner\'s hello with the joiner\'s own chat key is not taken', async () => {
    const w = makeWorld({ core: true })
    const O = await make(w, 'Owner')
    const M = await make(w, 'Mia')
    const eve = await makePerson('Eve')
    // Eve asks to join Owner's room with Owner's public chat key as hers
    const r = await O.apps.createRoom()
    const sp = splitCode(r.code)
    const kc = await codeKey(sp.secret, sp.channel)
    const forged = await sealHello({ keyCode: kc, channel: sp.channel, role: 'knock', keys: { pub: eve.keys.pub, sign: eve.keys.sign, chat: { pub: O.person.keys.chat.pub } }, name: 'Eve', now: w.clock.now() })
    const link = socket(w)
    assert.equal((await link.knock({ kind: 'room', channel: sp.channel, box: forged.box })).ok, true)
    await sleep(300)
    assert.equal(O.apps.state().requests.length, 0, 'the owner is not asked')
    link.close()
    // Eve owns a room code and her hello carries Mia's own chat key: Mia loads nothing and joins nothing
    const code2 = generateCode()
    const sp2 = splitCode(code2)
    const kc2 = await codeKey(sp2.secret, sp2.channel)
    const hello = await sealHello({ keyCode: kc2, channel: sp2.channel, role: 'owner', keys: { pub: eve.keys.pub, sign: eve.keys.sign, chat: { pub: M.person.keys.chat.pub } }, name: 'Eve', now: w.clock.now() })
    const eveLink = socket(w)
    const requests = []
    eveLink.on('request', (e) => requests.push(e))
    assert.equal((await eveLink.openCode({ kind: 'room', channel: sp2.channel, box: hello.box })).ok, true)
    const j = await M.apps.joinRoom(code2)
    assert.ok(j.knock, JSON.stringify(j))
    await until(() => requests.length === 1, 'the join request at Eve')
    const proof = await signAccept({ keys: eve.keys, channel: sp2.channel, knock: requests[0].knock })
    assert.equal((await eveLink.accept({ kind: 'room', knock: requests[0].knock, proof })).ok, true)
    await until(() => roomOf(M, j.id).status === 'rejected', 'Mia turns the owner down')
    assert.equal(roomOf(M, j.id).reason, 'bad-key')
    assert.deepEqual([M.loadCalls.length, M.tm.joined.length], [0, 0])
    eveLink.close()
  })

  test('ADV-7: a room-accepted without the owner\'s proof, or with a proof the joiner made herself, is not acted on; the real accept then goes through', async () => {
    const w = makeWorld()
    const O = await make(w, 'Owner')
    const M = await make(w, 'Mia')
    const r = await O.apps.createRoom()
    const j = await M.apps.joinRoom(r.code)
    await until(() => O.apps.state().requests.length === 1, 'the request')
    const [channel, rec] = [...w.rdv.channels.entries()][0]
    const pending = w.rdv.knocks.get(j.knock)
    const frame = { action: 'room-accepted', knock: j.knock, lane: rec.lane, channel, box: rec.box }
    w.rdv._send(pending.requester, frame)
    w.rdv._send(pending.requester, Object.assign({ proof: await signAccept({ keys: M.person.keys, channel, knock: j.knock }) }, frame))
    await sleep(400)
    assert.deepEqual([M.loadCalls.length, M.tm.joined.length], [0, 0], 'nothing was loaded and no lane joined')
    assert.equal(roomOf(M, j.id).status, 'waiting')
    await O.apps.acceptMember(O.apps.state().requests[0].knock)
    await until(() => roomOf(M, j.id).status === 'connected', 'the real accept connects her')
    assert.deepEqual([M.loadCalls.length, M.tm.joined.length], [1, 1])
  })

  test('ADV-8: a box the room code already took is turned away at once, so replays cannot fill the places of the code', async () => {
    const w = makeWorld({ core: true })
    const O = await make(w, 'Owner')
    const [M, C] = [await make(w, 'Mia'), await make(w, 'Cara')]
    const r = await O.apps.createRoom()
    await M.apps.joinRoom(r.code)
    await until(() => O.apps.state().requests.length === 1, 'the request')
    await O.apps.rejectMember(O.apps.state().requests[0].knock)
    const first = w.rdv.raw.map((t) => JSON.parse(t)).find((m) => m.action === 'room-knock')
    const links = [socket(w), socket(w)]
    for (const l of links) for (let i = 0; i < 8; i++) assert.equal((await l.knock({ kind: 'room', channel: first.channel, box: first.box })).ok, true)
    await sleep(300)
    assert.equal(O.apps.state().requests.length, 0, 'nothing to answer')
    assert.equal(w.rdv.counts().knocks, 0, 'the replays were turned away, not left pending for ten minutes')
    const j = await C.apps.joinRoom(r.code)
    assert.ok(j.knock, 'an honest joiner still gets in line: ' + JSON.stringify(j))
    await until(() => O.apps.state().requests.length === 1, 'and the owner sees it')
    for (const l of links) l.close()
  })
})

// The hint 'alone' (audit 8.2, lane A, F1; polish decision P2.D4) is for pair conversations: the finding names the pair. The owner of a room is
// alone in its lane until someone joins, which is no stuck state, and a member whose owner is a page of the old build (no join request at all)
// is the same silence as a pair's, but it has its own cases and would need its own tests, so a room carries no hint and tells no alone report.
describe('a room has no hint alone (polish decision P2.D4)', () => {
  const alone = (P) => P.reports.filter((r) => r.name === 'apps.lane' && r.fields.ev === 'alone').length
  const joinedTold = (P) => P.reports.filter((r) => r.name === 'apps.lane' && r.fields.ev === 'joined').length

  test('a member whose owner never joins the relay lane stays connecting and says nothing: no hint field on the room, no alone report on either side, whatever the time, also after its socket was lost and came back', async () => {
    const w = makeWorld()
    const O = await make(w, 'Owner', { reports: true }) // the older door: direct only, no join request
    const M = await make(w, 'Mia', { relay: 'rendezvous', direct: 'off', reports: true })
    const r = await O.apps.createRoom()
    const j = await M.apps.joinRoom(r.code)
    await until(() => O.apps.state().requests.length === 1, 'the join request')
    await O.apps.acceptMember(O.apps.state().requests[0].knock)
    await until(() => joinedTold(M) === 1, 'the member is in the lane, alone')
    await settle(10)
    // The loss and return of the member's socket (finding F1 of the polish verify, round 1). _newConv starts the hint's timer slot of a pair at
    // null and _newRoom leaves it unset, so a room meets the arming test of _aloneWatch (slot === null) only after some earlier call has set the
    // slot to null, and the loss of the socket is such a call. The join that follows is told "nobody else" again: with the two room guards of the
    // hint (_isAlone and _aloneWatch in apps.js) taken out, the member would report alone below.
    M.link.drop()
    await until(() => M.link.state === 'backoff', 'the member lost its socket')
    w.advance(1000)
    await until(() => joinedTold(M) === 2, 'the member joined the lane again, alone')
    await settle(10)
    w.advance(3 * LIMITS.aloneHintMs)
    await settle(10)
    assert.equal(roomOf(M, j.id).status, 'connecting', 'it just does not connect, as before')
    assert.equal(Object.prototype.hasOwnProperty.call(roomOf(M, j.id), 'hint'), false)
    assert.equal(Object.prototype.hasOwnProperty.call(roomOf(O, r.id), 'hint'), false)
    assert.deepEqual([alone(O), alone(M)], [0, 0])
    assert.equal(M.apps.state().conversations.length, 0)
  })

  // (the owner alone in its lane, with a member that never joins it, is the test "a room has no such hint" in loader-apps-lane.test.mjs: finding F3 of the suites verify, round 1)
  test('a room that has members connects as it did and carries no hint, on the owner\'s side and the member\'s, whatever the time', async () => {
    const w = makeWorld()
    const O = await make(w, 'Owner', { relay: 'rendezvous', direct: 'off', reports: true })
    const M = await make(w, 'Mia', { relay: 'rendezvous', direct: 'off', reports: true })
    const r = await O.apps.createRoom()
    const j = await M.apps.joinRoom(r.code)
    await until(() => O.apps.state().requests.length === 1, 'the join request')
    await O.apps.acceptMember(O.apps.state().requests[0].knock)
    await until(() => roomOf(M, j.id).status === 'connected', 'the member holds the key')
    w.advance(3 * LIMITS.aloneHintMs)
    await settle(10)
    assert.deepEqual([alone(O), alone(M)], [0, 0])
    assert.equal(roomOf(O, r.id).hint, undefined)
    assert.equal(Object.prototype.hasOwnProperty.call(roomOf(M, j.id), 'hint'), false)
    assert.deepEqual(roomOf(M, j.id).status, 'connected')
  })
})

// The same client against the rendezvous' own state machine (deploy/rtc-worker/pair.js), when that file is there.
describe('rooms and codes on the real pairing core', { skip: CoreRendezvous ? false : 'deploy/rtc-worker/pair.js is not there' }, () => {
  test('a room end to end: create, two knocks, accept, messages both ways, the owner closes it', async () => {
    const w = makeWorld({ core: true })
    const O = await make(w, 'Owner', { limits: { byeGraceMs: 50 } })
    const [A, B] = [await make(w, 'Ann'), await make(w, 'Bob')]
    const room = await roomUp(w, O, [A, B])
    const [ia, ib] = room.ids
    assert.equal(roomOf(O, room.id).members.length, 3)
    await until(() => roomOf(A, ia).members.length === 3 && roomOf(B, ib).members.length === 3, 'the roster everywhere')
    await A.apps.sendRoom(ia, 'one')
    await B.apps.sendRoom(ib, 'two')
    await until(() => [O, A, B].every((P, i) => texts(P, [room.id, ia, ib][i]).length === 2), 'both messages everywhere')
    assert.deepEqual(await closing(w, O.apps.leaveRoom(room.id)), { ok: true })
    await until(() => roomOf(A, ia).status === 'closed' && roomOf(B, ib).status === 'closed', 'closed for the members')
    assert.deepEqual(await O.apps.joinRoom('abcd-efgh-ijkm'), { error: 'unknown code' })
  })

  test('a rejected knock, a cancelled knock and a code that ran out after 24 hours', async () => {
    const w = makeWorld({ core: true })
    const O = await make(w, 'Owner')
    const [A, B] = [await make(w, 'Ann'), await make(w, 'Bob')]
    const r = await O.apps.createRoom()
    const ja = await A.apps.joinRoom(r.code)
    const jb = await B.apps.joinRoom(r.code)
    await until(() => O.apps.state().requests.length === 2, 'both requests')
    await O.apps.rejectMember(O.apps.state().requests.find((q) => q.from.name === 'Ann').knock)
    await until(() => roomOf(A, ja.id).status === 'rejected', 'Ann is turned away')
    await B.apps.cancelKnock(jb.knock)
    await until(() => O.apps.state().requests.length === 0, 'Bob withdrew')
    w.rdv.expire(25 * 3600 * 1000)
    await until(() => roomOf(O, r.id).codeClosed === 'expired', 'the code ran out')
    assert.equal(roomOf(O, r.id).code, null)
    assert.deepEqual(await A.apps.joinRoom(r.code), { error: 'unknown code' })
  })

  test('a pair code that ran out is replaced by a new one, and the owner is told', async () => {
    const w = makeWorld({ core: true })
    const O = await make(w, 'Owner')
    const first = await O.apps.openCode()
    w.rdv.expire(25 * 3600 * 1000)
    await until(() => O.apps.state().code && O.apps.state().code !== first.code, 'a new code')
    assert.deepEqual([O.apps.state().notice.kind, O.apps.state().notice.why], ['code-replaced', 'expired'])
    const B = await make(w, 'Bob')
    assert.ok((await B.apps.knock(O.apps.state().code)).knock, 'the new code works')
    assert.deepEqual(await B.apps.knock(first.code.replace(/^.{4}/, 'zzzz')), { error: 'unknown code' })
  })
})
