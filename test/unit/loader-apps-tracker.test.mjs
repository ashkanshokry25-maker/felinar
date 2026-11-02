// The apps client against the real rendezvous (ARCHITECTURE 15.21): src/loader/apps-link.js, apps-crypto.js and
// apps.js talk over real WebSockets on 127.0.0.1 to tools/tracker.mjs, which runs the pairing core of the Worker
// (deploy/rtc-worker/pair.js). The unit tests of the lanes each had one side real and the other a fake (a fake rendezvous with the
// real client; the real core behind a fake socket); this file puts the two real halves together: the browser's WebSocket API (the
// WebSocket of Node, as a page uses it), real PBKDF2 and sealed hellos, the tracker's raw-frame wrapper, and the lanes it allows.
// The torrent managers stay fakes (test/unit/fakes/apps-fakes.mjs): WebRTC is the e2e suite's. Nothing leaves the machine.
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import WebSocket from 'ws'

import { createTracker } from '../../tools/tracker.mjs'
import { createLink } from '../../src/loader/apps-link.js'
import { generateCode, splitCode, codeKey, sealHello, openHello, signAccept, verifyAccept, CODE_LENGTH } from '../../src/loader/apps-crypto.js'
import { createApps } from '../../src/loader/apps.js'
import { makePerson, FakeIdentity, FakeNetwork, until } from './fakes/apps-fakes.mjs'

const LISTED = 'aa'.repeat(20) // the one infohash this tracker serves besides the lanes it mints
const OTHER = 'bb'.repeat(20)
const CODE_RE = /^[a-km-np-z2-9]{4}-[a-km-np-z2-9]{4}-[a-km-np-z2-9]{4}$/
const HEX40 = /^[0-9a-f]{40}$/

const cleanup = []
after(async () => {
  for (const fn of cleanup.splice(0).reverse()) {
    try { await fn() } catch (_) { /* gone */ }
  }
})

async function startTracker () {
  const t = await createTracker({ port: 0, allow: [LISTED], quiet: true })
  cleanup.push(() => t.close())
  assert.equal(t.pairing, true, 'the pairing core is part of this checkout')
  return t
}

const bin = (hex) => Buffer.from(hex, 'hex').toString('binary')
const announce = (hex) => ({ action: 'announce', info_hash: bin(hex), peer_id: 'p'.repeat(20), uploaded: 0, downloaded: 0, left: 0, event: 'started', numwant: 0, offers: [] })

/** converse(url, messages) -> the replies, one per message, on ONE socket (a message is sent after the reply to the one before). */
function converse (url, messages) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url)
    const got = []
    const timer = setTimeout(() => { ws.terminate(); reject(new Error('no reply; got ' + JSON.stringify(got))) }, 5000)
    ws.once('error', (err) => { clearTimeout(timer); reject(err) })
    ws.on('message', (data) => {
      got.push(JSON.parse(data.toString('utf8')))
      if (got.length < messages.length) ws.send(JSON.stringify(messages[got.length]))
      else { clearTimeout(timer); ws.close(); resolve(got) }
    })
    ws.once('open', () => ws.send(JSON.stringify(messages[0])))
  })
}
const ask = async (url, msg) => (await converse(url, [msg]))[0]
const served = async (url, hex) => !('failure reason' in await ask(url, announce(hex)))

test('open, knock, request, accept with the real client, real hellos and the Node tracker: the lane exists only after the accept', async () => {
  assert.equal(typeof WebSocket, 'function')
  assert.equal(typeof globalThis.WebSocket, 'function', 'the page API (Node has it built in) is what the client uses')
  const t = await startTracker()
  const [alice, bob] = [await makePerson('Alice'), await makePerson('Bob')]
  const code = generateCode()
  const sp = splitCode(code)
  const kc = await codeKey(sp.secret, sp.channel)
  const mk = () => {
    const link = createLink({ url: t.url })
    cleanup.push(() => link.close())
    return link
  }
  const [ownerLink, knockLink] = [mk(), mk()]
  const requests = []
  const accepted = []
  ownerLink.on('request', (e) => requests.push(e))
  knockLink.on('accepted', (e) => accepted.push(e))

  const ownerHello = await sealHello({ keyCode: kc, channel: sp.channel, role: 'owner', keys: alice.keys, name: 'Alice' })
  const opened = await ownerLink.openCode({ kind: 'pair', channel: sp.channel, box: ownerHello.box })
  assert.deepEqual(opened, { ok: true, lane: null })
  assert.deepEqual([t.stats().codes, t.stats().knocks, t.stats().lanes], [1, 0, 0])

  const knockHello = await sealHello({ keyCode: kc, channel: sp.channel, role: 'knock', keys: bob.keys, name: 'Bob' })
  const k = await knockLink.knock({ kind: 'pair', channel: sp.channel, box: knockHello.box })
  assert.equal(k.ok, true, JSON.stringify(k))
  await until(() => requests.length === 1, 'the request at the owner')
  assert.deepEqual(requests[0].box, knockHello.box, 'the rendezvous passed on the box and nothing else')
  assert.equal(requests[0].knock, k.knock)
  assert.equal(requests[0].channel, sp.channel)
  const seen = await openHello({ keyCode: kc, channel: sp.channel, role: 'knock', box: requests[0].box })
  assert.equal(seen.ok, true, JSON.stringify(seen))
  assert.equal(seen.hello.pub, bob.keys.pub)
  assert.equal(seen.hello.ek, bob.keys.chat.pub)
  assert.equal(seen.hello.name, 'Bob')

  // before the accept there is no lane: no offer or answer can move, and the tracker has seen no swarm
  assert.deepEqual([t.stats().codes, t.stats().knocks, t.stats().lanes, t.stats().torrents], [1, 1, 0, 0])
  assert.equal(await served(t.url, LISTED), true)
  assert.equal(await served(t.url, OTHER), false)

  // an accept without the owner's proof is refused and leaves the request where it was (ADV-7)
  assert.deepEqual(await ownerLink.accept({ kind: 'pair', knock: requests[0].knock }), { ok: false, reason: 'proof-invalid' })
  assert.deepEqual([t.stats().knocks, t.stats().lanes], [1, 0])
  const proof = await signAccept({ keys: alice.keys, channel: sp.channel, knock: requests[0].knock })
  const acc = await ownerLink.accept({ kind: 'pair', knock: requests[0].knock, proof })
  assert.equal(acc.ok, true, JSON.stringify(acc))
  assert.match(acc.lane, HEX40)
  await until(() => accepted.length === 1, 'the accept at the requester')
  assert.equal(accepted[0].lane, acc.lane)
  assert.equal(accepted[0].channel, sp.channel)
  assert.equal(accepted[0].knock, k.knock)
  assert.equal(accepted[0].proof, proof, 'the rendezvous passed the proof on unchanged')
  const theirs = await openHello({ keyCode: kc, channel: sp.channel, role: 'owner', box: accepted[0].box, pastMs: 86400000 })
  assert.equal(theirs.ok, true, JSON.stringify(theirs))
  assert.equal(theirs.hello.pub, alice.keys.pub)
  assert.equal(await verifyAccept({ ownerPub: theirs.hello.pub, channel: sp.channel, knock: k.knock, proof: accepted[0].proof }), true, 'it is the owner\'s own signature')
  assert.deepEqual([t.stats().codes, t.stats().knocks, t.stats().lanes], [1, 0, 1])
  assert.equal(await served(t.url, acc.lane), true, 'the lane is served after the accept')
  assert.equal(await served(t.url, OTHER), false, 'and nothing else is')

  // the other half of the protocol: reject and close, and a code that is not there
  const k2 = await knockLink.knock({ kind: 'pair', channel: sp.channel, box: knockHello.box })
  assert.equal(k2.ok, true)
  await until(() => requests.length === 2, 'the second request')
  const rejected = []
  knockLink.on('rejected', (e) => rejected.push(e))
  assert.deepEqual(await ownerLink.reject({ kind: 'pair', knock: requests[1].knock }), { ok: true })
  await until(() => rejected.length === 1, 'the rejection at the requester')
  assert.equal(rejected[0].reason, 'rejected')
  assert.deepEqual(await ownerLink.closeCode({ kind: 'pair', channel: sp.channel }), { ok: true, reason: undefined })
  assert.equal(t.stats().codes, 0)
  const gone = await knockLink.knock({ kind: 'pair', channel: sp.channel, box: knockHello.box })
  assert.deepEqual(gone, { ok: false, reason: 'unknown-code' })
})

test('the two kinds of socket: the first frame decides, the other protocol is refused with a text the client turns into a reason', async () => {
  const t = await startTracker()
  const knock = { v: 1, action: 'pair-knock', channel: 'abcd', box: { iv: 'A'.repeat(16), ct: 'B'.repeat(40) }, rid: 'm1' }
  // a socket that announced is a tracker socket for life
  const [first, second] = await converse(t.url, [announce(LISTED), knock])
  assert.equal('failure reason' in first, false)
  assert.equal(second.rid, 'm1')
  assert.match(second['failure reason'], /another protocol/)
  // a socket that spoke the pair protocol is a pair socket for life
  const [one, two] = await converse(t.url, [knock, announce(LISTED)])
  assert.equal(one['failure reason'], 'unknown code')
  assert.match(two['failure reason'], /another protocol/)
  // the client reads the failure text of a request as a reason
  const link = createLink({ url: t.url })
  cleanup.push(() => link.close())
  const r = await link.request('pair-knock', { channel: 'abcd', box: knock.box })
  assert.deepEqual([r.ok, r.reason], [false, 'unknown-code'])
})

/** Two people with the real service on the real tracker; the torrent managers are fakes on one fake network. */
async function people (t, names) {
  const net = new FakeNetwork()
  const out = []
  for (const name of names) {
    const person = await makePerson(name)
    const identity = new FakeIdentity(person)
    const tm = net.tm(name)
    const loads = []
    const apps = createApps({
      api: { identity }, config: { rendezvous: [t.url], stun: [], idp: null },
      loadTm: async () => { loads.push(Date.now()); return tm }
    })
    cleanup.push(() => apps.destroy())
    out.push({ name, person, identity, tm, loads, apps })
  }
  return { net, people: out }
}
const st = (P) => P.apps.state()
const convOf = (P) => st(P).conversations[0]
const roomOf = (P, id) => st(P).rooms.find((r) => r.id === id)

test('the service on the Node tracker: a code, a knock, the approval, then sealed messages both ways over the lane the tracker minted', async () => {
  const t = await startTracker()
  const { people: [A, B] } = await people(t, ['Alice', 'Bob'])
  const opened = await A.apps.openCode()
  assert.match(opened.code, CODE_RE)
  assert.equal(opened.code.replace(/-/g, '').length, CODE_LENGTH)
  assert.equal(t.stats().codes, 1)
  const k = await B.apps.knock(opened.code)
  assert.ok(k.knock, JSON.stringify(k))
  await until(() => st(A).requests.length === 1, 'the request')
  assert.equal(st(A).requests[0].from.name, 'Bob')
  // nothing moved before the approval: no manager, no lane, no swarm at the tracker
  assert.deepEqual([A.loads.length, B.loads.length, A.tm.joined.length, B.tm.joined.length], [0, 0, 0, 0])
  assert.deepEqual([t.stats().torrents, t.stats().lanes, t.stats().knocks], [0, 0, 1])

  const acc = await A.apps.accept(st(A).requests[0].knock)
  assert.ok(acc.id, JSON.stringify(acc))
  await until(() => convOf(A) && convOf(B) && convOf(A).status === 'connected' && convOf(B).status === 'connected', 'both connected')
  assert.deepEqual([A.loads.length, B.loads.length], [1, 1])
  const lane = A.tm.joined[0].infoHash
  assert.match(lane, HEX40)
  assert.equal(B.tm.joined[0].infoHash, lane)
  assert.equal(A.tm.joined[0].kind, 'chat')
  assert.equal(B.tm.joined[0].kind, 'chat')
  assert.deepEqual(A.tm.joined[0].announce.map((u) => new URL(u).host), [new URL(t.url).host], 'announced to the door\'s own rendezvous only')
  assert.equal(t.stats().lanes, 1)
  assert.equal(await served(t.url, lane), true, 'the tracker serves the lane the service joined')

  await B.apps.send(convOf(B).id, 'hello *there* https://example.test/p')
  await until(() => convOf(A).messages.length === 1, 'the message')
  assert.equal(convOf(A).messages[0].text, 'hello *there* https://example.test/p')
  await A.apps.send(convOf(A).id, 'and back')
  await until(() => convOf(B).messages.length === 2, 'the reply')
  await until(() => convOf(B).messages.find((m) => m.mine).status === 'delivered' || convOf(B).messages.find((m) => m.mine).status === 'read', 'delivered')
})

test('rooms on the Node tracker: the lane is minted when the code opens, a rejected knock never gets it, accepted members read each other', async () => {
  const t = await startTracker()
  const { people: [O, M1, M2, X] } = await people(t, ['Olive', 'Mia', 'Max', 'Xavier'])
  const room = await O.apps.createRoom()
  assert.match(room.code, CODE_RE)
  assert.equal(t.stats().lanes, 1, 'a room lane is minted at open')
  assert.equal(O.loads.length, 0)
  const j1 = await M1.apps.joinRoom(room.code)
  const j2 = await M2.apps.joinRoom(room.code)
  const jx = await X.apps.joinRoom(room.code)
  await until(() => st(O).requests.length === 3, 'three requests')
  assert.deepEqual([M1.loads.length, M2.loads.length, X.loads.length, O.tm.joined.length], [0, 0, 0, 0], 'nothing joined before the owner decides')
  const ask1 = (name) => st(O).requests.find((q) => q.from.name === name)
  await O.apps.acceptMember(ask1('Mia').knock)
  await O.apps.acceptMember(ask1('Max').knock)
  await O.apps.rejectMember(ask1('Xavier').knock)
  await until(() => roomOf(M1, j1.id).status === 'connected' && roomOf(M2, j2.id).status === 'connected', 'both members hold the key')
  await until(() => roomOf(X, jx.id).status === 'rejected', 'Xavier is turned away')
  assert.deepEqual([X.loads.length, X.tm.joined.length], [0, 0], 'the rejected person loaded nothing and joined nothing')
  const lane = O.tm.joined[0].infoHash
  assert.equal(O.tm.joined[0].kind, 'group')
  assert.equal(M1.tm.joined[0].infoHash, lane)
  assert.equal(M2.tm.joined[0].infoHash, lane)
  assert.equal(await served(t.url, lane), true)
  await until(() => [[O, room.id], [M1, j1.id], [M2, j2.id]].every(([P, id]) => roomOf(P, id).members.length === 3), 'the roster reached everyone')
  await M1.apps.sendRoom(j1.id, 'hello room')
  await O.apps.sendRoom(room.id, 'welcome')
  await until(() => [[O, room.id], [M1, j1.id], [M2, j2.id]].every(([P, id]) => roomOf(P, id).messages.length === 2), 'both messages everywhere')
  assert.deepEqual(roomOf(X, jx.id).messages, [])
})
