// Adversary tests for the apps on the door page (the protocol and privacy adversary of the review of 2026-11-02).
// Written by the verifier, who changed no source: every test in the groups ADV-1 to ADV-9 was a refutation and failed on the code as
// built (f081737 plus the first build of the apps). The fixer's changes make them pass, and they stay as regression tests. Two edits
// follow from ADV-7 alone: the second ADV-9 test signs the owner's accept (an accept carries a proof now), and control (1) lists
// `proof`, a signature, among the fields the rendezvous may receive. The group "controls" holds what the verifier tried and could not
// refute: those tests must keep passing.
// Run: node tools/run-unit.mjs test/unit/apps-adversary.test.mjs
// Only the blocker and the must-fix tests:  node --test --test-name-pattern="ADV-[12] " test/unit/apps-adversary.test.mjs
//
//   ADV-1  BLOCKER         the room owner sent the roster (names, identity keys, chat keys) in the clear to every wire of the lane,
//                          so a peer that is not a member (the rendezvous minted the lane, so it can be one) read who is in the room
//                          (fixed: the roster is a group box under the room secret)
//   ADV-2  MUST FIX TONIGHT a cfg frame from the other person set the expiry of what I write, with no notice, and a huge t kept it
//                          (fixed: timers are per author, a cfg only says what the other person does, a far t is dropped)
//   ADV-3  LATER           the history cap evicted the oldest message whoever wrote it: a flood from the peer pushed my messages out
//   ADV-4  LATER           wires that never speak the extension filled the wire slots of a lane and kept the real peer out
//   ADV-5  LATER           the edit history of a message was not bounded
//   ADV-6  LATER           a reaction named like an Object.prototype member (toString, valueOf) threw inside the frame handler
//   ADV-7  LATER           the accept the requester got was not authenticated: the rendezvous could make it join a lane unapproved
//                          (fixed: the owner signs the channel and the knock, the requester checks it first)
//   ADV-8  LATER           a repeated box was dropped without a word, so replays filled the 16 pending slots of a code and turned honest requesters away
//   ADV-9  LATER           a hello could carry the receiver's own chat key: K_pair(me, me) lets the sender reflect my frames as presence and receipts
//
// Every party is a fake on this machine (test/unit/fakes/apps-fakes.mjs): no socket leaves it, no real name or host appears.
import { test, describe, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import WebSocket from 'ws'

import { createTracker } from '../../tools/tracker.mjs'
import { createRendezvous } from '../../deploy/rtc-worker/rtc.js'
import {
  T, EXT_NAME, encodeFrame, sealDmBody, codeKey, sealHello, openHello, splitCode, generateCode, signAccept
} from '../../src/loader/apps-crypto.js'
import { FakeLink, makeWorld, makePerson, until } from './fakes/apps-fakes.mjs'

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const dec = new TextDecoder('utf-8')

// ---------------------------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------------------------

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

const st = (X) => X.apps.state()
const conv = (X, i = 0) => st(X).conversations[i]

// What the rendezvous received, as words: every key of every frame and every string value of it, except the values that are random by
// construction (the two parts of a sealed box, the request id, the knock token and the proof: base64url). A short needle such as Bob or sdp
// turns up by chance in about 1,700 random characters once in 40 runs or so, which made a search of the raw text fail now and then, so a
// name or a key is looked for in the keys and in the words, never in a piece of a sealed value. (The raw text still holds the 8-character
// secret check: a chance match there is out of reach.)
const SEALED_KEYS = new Set(['iv', 'ct', 'rid', 'knock', 'proof'])
function wordsIn (frames) {
  const out = []
  const walk = (value, key) => {
    if (typeof value === 'string') {
      if (!SEALED_KEYS.has(key)) out.push(value)
    } else if (value && typeof value === 'object') {
      for (const k of Object.keys(value)) { out.push(k); walk(value[k], k) }
    }
  }
  for (const f of frames) walk(typeof f === 'string' ? JSON.parse(f) : f, '')
  return out
}
const isConnected = (X) => { const c = conv(X); return !!c && c.status === 'connected' }
const roomOf = (X, id) => st(X).rooms.find((r) => r.id === id)

/** A owns a code, B knocks, A accepts; resolves when both show connected. */
async function pairUp (w, { limits } = {}) {
  const A = await make(w, 'Alice', { limits })
  const B = await make(w, 'Bob', { limits })
  const { code } = await A.apps.openCode()
  const k = await B.apps.knock(code)
  assert.ok(k.knock, JSON.stringify(k))
  await until(() => st(A).requests.length === 1, 'the request at Alice')
  const acc = await A.apps.accept(st(A).requests[0].knock)
  assert.ok(acc.id, JSON.stringify(acc))
  await until(() => isConnected(A) && isConnected(B), 'both connected')
  return { A, B, code, a: conv(A).id, b: conv(B).id }
}

/** The FakeWire that person X writes on, on the first live lane of the world. */
function wireOf (w, X) {
  for (const pairs of w.net.pairs.values()) {
    for (const p of pairs.values()) {
      if (p.a.name === X.name && !p.wa.destroyed) return p.wa
      if (p.b.name === X.name && !p.wb.destroyed) return p.wb
    }
  }
  return null
}

/** Seals `body` as person `from` to person `to` and writes it on from's wire (what the other person, or a replayer, can do). */
async function inject (w, from, to, body, { n = 900 } = {}) {
  const sealed = await sealDmBody({ keys: from.person.keys, peerEk: to.person.keys.chat.pub, body, now: w.clock.now(), n })
  const wire = wireOf(w, from)
  assert.ok(wire, 'no wire to write on')
  wire.extended(EXT_NAME, encodeFrame(T.DM, sealed.payload))
  return sealed
}

const pad16 = (prefix, i) => prefix + String(i).padStart(16 - prefix.length, '0')

/**
 * A peer that is not a member of the lane's conversation or room: it knows the lane id (the rendezvous minted it, so the
 * rendezvous can) and speaks the extension like a client. got = every frame the wires gave it.
 */
function strangerOn (w, lane, kind, name = 'Stranger') {
  const tm = w.net.tm(name)
  const got = []
  tm.registerWireExtension(EXT_NAME, {
    onWire (wire) {
      class Ext {
        constructor (x) { this.wire = x }
        onExtendedHandshake () {}
        onMessage (buf) { got.push(new Uint8Array(buf)) }
      }
      Ext.prototype.name = EXT_NAME
      wire.use(Ext)
    }
  }, { swarms: ['chat', 'group'] })
  tm.joinLane({ kind, infoHash: lane, announce: [] })
  return { tm, got }
}

// ---------------------------------------------------------------------------------------------
// ADV-1  BLOCKER
// ---------------------------------------------------------------------------------------------

describe('ADV-1 BLOCKER: a peer on the room lane that is not a member learns who is in the room', () => {
  test('ADV-1 the owner gives the roster to any wire of the lane: a stranger gets every name and key in the clear', async () => {
    const w = makeWorld({ core: true })
    const O = await make(w, 'Owner')
    const M = await make(w, 'Mara')
    const r = await O.apps.createRoom()
    const j = await M.apps.joinRoom(r.code)
    await until(() => st(O).requests.length === 1, 'the join request')
    await O.apps.acceptMember(st(O).requests[0].knock)
    await until(() => roomOf(M, j.id) && roomOf(M, j.id).status === 'connected', 'the member holds the room secret')
    const lane = [...O.apps.rooms.values()][0].lane

    // the rendezvous minted this lane id and serves it, so it can join as a peer like any client; so can anyone it tells
    const S = strangerOn(w, lane, 'group')
    assert.ok(S.tm.wires.size >= 1, 'the harness gave the stranger a wire (otherwise this test proves nothing)')
    await until(() => S.got.length > 0, 'a frame at the stranger', 1500).catch(() => {}) // a fix may give it none: then the wait ends here
    await sleep(200)

    const seen = S.got.map((b) => dec.decode(b)).join('\n')
    const secrets = ['Owner', 'Mara', O.person.keys.pub, M.person.keys.pub, O.person.keys.chat.pub, M.person.keys.chat.pub]
    const leaked = secrets.filter((s) => seen.includes(s))
    assert.deepEqual(leaked, [], 'a peer that was never accepted received ' + S.got.length + ' frames that name: ' + JSON.stringify(leaked.map((s) => s.slice(0, 12))) +
      ' (docs/PRIVACY.md and APPS.md say the rendezvous never learns names or keys; ARCHITECTURE 15.21: "the roster is not sealed under the room secret")')
  })
})

// ---------------------------------------------------------------------------------------------
// ADV-2  MUST FIX TONIGHT
// ---------------------------------------------------------------------------------------------

describe('ADV-2 MUST FIX TONIGHT: the other person sets the expiry of the messages I write', () => {
  test('ADV-2 a cfg frame from the peer makes my next message disappear, and nothing tells me', async () => {
    const w = makeWorld({ core: true })
    const { A, B, a, b } = await pairUp(w)
    assert.equal(conv(A).cfg.exp, null, 'Alice chose no timer')
    await B.apps.setCfg(b, { exp: 60000 }) // Bob: "messages disappear after a minute"
    await until(() => conv(B).pending === 0, 'the cfg frame acknowledged', 1500).catch(() => {})
    await sleep(100)
    const r = await A.apps.send(a, 'a message Alice wrote without choosing any timer')
    const m = conv(A).messages.find((x) => x.id === r.id)
    assert.ok(m, 'Alice has her message')
    assert.equal(m.exp, null, 'Alice\'s own message carries an expiry (' + m.exp + ' ms) that only Bob chose: it will vanish from her own screen')
    assert.equal(m.expAt, null, 'and her client armed its deletion')
    assert.equal(conv(A).cfg.exp, null, 'Alice\'s conversation setting was changed by a frame from the other person')
  })

  test('ADV-2 a cfg frame with a huge t cannot be undone: the peer outranks my own choice for good', async () => {
    const w = makeWorld({ core: true })
    const { A, B, a } = await pairUp(w)
    const HUGE = Number.MAX_SAFE_INTEGER
    await inject(w, B, A, { k: 'cfg', exp: 60000, receipts: true, t: HUGE, o: 'op-cfg-1' })
    await sleep(300)
    await A.apps.setCfg(a, { exp: null }) // Alice turns the timer off
    await sleep(100)
    await inject(w, B, A, { k: 'cfg', exp: 60000, receipts: true, t: HUGE, o: 'op-cfg-2' }) // Bob turns it back on, silently
    await sleep(300)
    assert.equal(conv(A).cfg.exp, null, 'Alice switched the timer off and the peer switched it on again with t = 2^53-1 (t is not checked against any clock)')
  })
})

// ---------------------------------------------------------------------------------------------
// ADV-3 to ADV-7  LATER
// ---------------------------------------------------------------------------------------------

describe('ADV-3 LATER: the other person can push my messages out of my history', () => {
  test('ADV-3 a flood of messages from the peer evicts my own messages from the cap, pinned or not', async () => {
    const w = makeWorld({ core: true })
    const { A, B, a } = await pairUp(w, { limits: { convMessagesMax: 12 } })
    const mine = []
    for (let i = 0; i < 4; i++) {
      const r = await A.apps.send(a, 'alice-kept-' + i)
      mine.push(r.id)
    }
    await A.apps.setMessageFlag(a, mine[0], 'pinned', true)
    w.advance(5)
    for (let i = 0; i < 24; i++) {
      await inject(w, B, A, { k: 'msg', id: pad16('FLOOD', i), t: w.clock.now(), text: 'bob-flood-' + i, fmt: 'md1' }, { n: 1000 + i })
      w.advance(1)
    }
    await sleep(500)
    const texts = conv(A).messages.map((m) => m.text)
    const lost = [0, 1, 2, 3].map((i) => 'alice-kept-' + i).filter((t) => !texts.includes(t))
    assert.deepEqual(lost, [], 'messages Alice wrote (one of them pinned) are gone from her history because Bob sent more than the cap')
  })
})

describe('ADV-4 LATER: wires that never speak the extension keep the real peer out', () => {
  test('ADV-4 four silent wires on a pair lane fill the owner\'s slots, so the real peer never connects', async () => {
    const w = makeWorld({ core: true })
    const A = await make(w, 'Alice')
    const B = await make(w, 'Bob')
    w.net.canConnect = (x, y) => x.name !== 'Bob' && y.name !== 'Bob' // Bob\'s connection comes last
    const { code } = await A.apps.openCode()
    await B.apps.knock(code)
    await until(() => st(A).requests.length === 1, 'the request')
    await A.apps.accept(st(A).requests[0].knock)
    const lane = [...A.apps.lanes.keys()][0]
    for (let i = 0; i < 4; i++) {
      const tm = w.net.tm('Silent' + i)
      tm.registerWireExtension('mw_other', { onWire (wire) { class X { constructor () {} } X.prototype.name = 'mw_other'; wire.use(X) } }, { swarms: ['chat', 'group'] })
      tm.joinLane({ kind: 'chat', infoHash: lane, announce: [] })
    }
    await sleep(100)
    w.advance(120000) // whatever time a fix gives a silent wire to speak, it has had it
    await sleep(50)
    w.net.canConnect = () => true
    w.net.connect(lane)
    const up = await until(() => isConnected(A) && isConnected(B), 'the real peer connects', 1500).then(() => true, () => false)
    assert.equal(up, true, 'Alice and Bob stay at "' + conv(A).status + '" / "' + conv(B).status + '": four wires that sent nothing hold every slot (wiresPerPair)')
  })
})

describe('ADV-5 LATER: the edit history is unbounded', () => {
  test('ADV-5 150 edits of one message from the peer are all kept in memory', async () => {
    const w = makeWorld({ core: true })
    const { A, B, a, b } = await pairUp(w)
    const r = await B.apps.send(b, 'v0')
    await until(() => conv(A).messages.some((m) => !m.mine && m.id === r.id), 'the message at Alice')
    w.advance(100)
    for (let i = 1; i <= 150; i++) {
      w.advance(600)
      await inject(w, B, A, { k: 'edit', id: r.id, text: 'v' + i, t: w.clock.now(), o: 'e' + i }, { n: 2000 + i })
      if (i % 10 === 0) await sleep(20)
    }
    await sleep(500)
    const m = conv(A).messages.find((x) => x.id === r.id)
    assert.equal(m.text, 'v150', 'the harness delivered the edits')
    assert.ok(m.edits.length <= 100, 'Alice keeps ' + m.edits.length + ' earlier texts of one message (3,500 characters each, 120 frames a minute): memory grows without a bound')
  })
})

describe('ADV-6 LATER: a reaction named toString throws inside the frame handler', () => {
  test('ADV-6 isEmoji accepts toString and valueOf, and _setReaction then calls push on a function', async () => {
    const w = makeWorld({ core: true })
    const { A, a } = await pairUp(w)
    const r = await A.apps.send(a, 'hello')
    const c = [...A.apps.convs.values()][0]
    const m = c.messages.find((x) => x.id === r.id)
    for (const emoji of ['toString', 'valueOf']) {
      assert.doesNotThrow(() => A.apps._applyBody(c, { k: 'react', id: m.id, emoji, t: w.clock.now(), o: 'x-' + emoji }, { strikes: 0, dead: false, rec: c }),
        'a reaction "' + emoji + '" from the peer throws before the frame is acknowledged (reactions is a plain object keyed by what the peer sent)')
    }
  })
})

describe('ADV-7 LATER: the requester cannot tell that the owner accepted', () => {
  test('ADV-7 a pair-accepted pushed by the rendezvous alone makes the requester load the manager and join a lane', async () => {
    const w = makeWorld({ core: false })
    const A = await make(w, 'Alice')
    const B = await make(w, 'Bob')
    const { code } = await A.apps.openCode()
    const k = await B.apps.knock(code)
    await until(() => st(A).requests.length === 1, 'the request')
    assert.equal(B.tm.joined.length, 0)
    // the rendezvous holds the owner's box (it stores it at pair-open) and Alice has not decided
    const [channel, rec] = [...w.rdv.channels.entries()][0]
    const pending = w.rdv.knocks.get(k.knock)
    const lane = 'c0'.repeat(20)
    w.rdv.lanes.set(lane, w.clock.now() + 86400000)
    w.rdv._send(pending.requester, { action: 'pair-accepted', knock: k.knock, lane, channel, box: rec.box })
    await sleep(300)
    assert.equal(st(A).requests.length, 1, 'Alice has still not accepted')
    assert.deepEqual([B.loadCalls.length, B.tm.joined.length], [0, 0], 'Bob loaded the torrent manager and joined a lane the owner never approved: the accept carries no proof from the owner')
  })
})

describe('ADV-8 LATER: a code holder can keep an honest requester out with one replayed box', () => {
  test('ADV-8 replays of a box the owner already answered stay pending at the rendezvous (nobody answers them), until the code turns every honest requester away', async () => {
    const w = makeWorld({ core: true })
    const A = await make(w, 'Alice')
    const B = await make(w, 'Bob')
    const C = await make(w, 'Cara')
    const { code } = await A.apps.openCode()
    await B.apps.knock(code)
    await until(() => st(A).requests.length === 1, 'the request')
    await A.apps.reject(st(A).requests[0].knock) // Bob asked once and was turned away (blocking him changes nothing below)
    const first = w.rdv.raw.map((t) => JSON.parse(t)).find((m) => m.action === 'pair-knock')
    // Bob, or anyone who saw his box, sends the same box again from two sockets: the owner's page drops a repeated nonce without a word
    const socket = () => new FakeLink(w.rdv, { setTimeoutFn: w.clock.setTimeout, clearTimeoutFn: w.clock.clearTimeout, random: () => 0.5 })
    const [e1, e2] = [socket(), socket()]
    for (const e of [e1, e2]) for (let i = 0; i < 8; i++) await e.knock({ kind: 'pair', channel: first.channel, box: first.box })
    await sleep(200)
    assert.equal(st(A).requests.length, 0, 'the owner sees nothing to answer')
    // whatever the page does with a repeat (reject it, or replace the code), an honest requester must get through on the code the owner shows
    const current = st(A).code
    assert.ok(current, 'Alice still shows a code')
    const k = await C.apps.knock(current)
    assert.ok(k.knock, 'an honest requester is turned away with "' + k.error + '": 16 pending requests nobody can see or answer fill the code for 10 minutes, and again as they run out (' + JSON.stringify(w.rdv.counts()) + ')')
    e1.close()
    e2.close()
  })
})

describe('ADV-9 LATER: a person can hand you your own chat key as theirs and make you see presence and receipts they cannot earn', () => {
  test('ADV-9 a request whose chat key is the owner\'s own is turned away', async () => {
    // Eve needs only Alice\'s PUBLIC chat key (she has it from an earlier acceptance in the same visit). K_pair(Alice, Alice) opens
    // Alice\'s own frames, so Eve can write nothing but can reflect them: "Connected to you now" and "delivered" for a reader who is not there.
    const w = makeWorld({ core: true })
    const A = await make(w, 'Alice')
    const eve = await makePerson('Eve')
    const { code } = await A.apps.openCode()
    const sp = splitCode(code)
    const kc = await codeKey(sp.secret, sp.channel)
    const keys = { pub: eve.keys.pub, sign: eve.keys.sign, chat: { pub: A.person.keys.chat.pub } }
    const { box } = await sealHello({ keyCode: kc, channel: sp.channel, role: 'knock', keys, name: 'Eve', now: w.clock.now() })
    const link = new FakeLink(w.rdv, { setTimeoutFn: w.clock.setTimeout, clearTimeoutFn: w.clock.clearTimeout, random: () => 0.5 })
    const k = await link.knock({ kind: 'pair', channel: sp.channel, box })
    assert.equal(k.ok, true, JSON.stringify(k))
    await sleep(300)
    assert.equal(st(A).requests.length, 0, 'Alice is asked to accept a person whose chat key is Alice\'s own: ' + JSON.stringify(st(A).requests.map((q) => q.from.name)))
    link.close()
  })

  test('ADV-9 an owner\'s hello that carries the requester\'s own chat key is not taken', async () => {
    const w = makeWorld({ core: true })
    const B = await make(w, 'Bob')
    const eve = await makePerson('Eve')
    const code = generateCode()
    const sp = splitCode(code)
    const kc = await codeKey(sp.secret, sp.channel)
    // Eve owns the code, so she holds the key that opens Bob\'s hello and reads his chat key before she answers
    const keys = { pub: eve.keys.pub, sign: eve.keys.sign, chat: { pub: B.person.keys.chat.pub } }
    const { box } = await sealHello({ keyCode: kc, channel: sp.channel, role: 'owner', keys, name: 'Eve', now: w.clock.now() })
    const link = new FakeLink(w.rdv, { setTimeoutFn: w.clock.setTimeout, clearTimeoutFn: w.clock.clearTimeout, random: () => 0.5 })
    const requests = []
    link.on('request', (e) => requests.push(e))
    const o = await link.openCode({ kind: 'pair', channel: sp.channel, box })
    assert.equal(o.ok, true, JSON.stringify(o))
    const k = await B.apps.knock(code)
    assert.ok(k.knock, JSON.stringify(k))
    await until(() => requests.length === 1, 'the request at Eve')
    // Eve accepts like an owner must since ADV-7: with her signature over the channel and the knock (so this test still reaches the check it is about)
    const proof = await signAccept({ keys, channel: sp.channel, knock: requests[0].knock })
    const acc = await link.accept({ kind: 'pair', knock: requests[0].knock, proof })
    assert.equal(acc.ok, true, JSON.stringify(acc))
    await sleep(300)
    assert.deepEqual([B.loadCalls.length, B.tm.joined.length], [0, 0], 'Bob joined a lane with a peer whose chat key is his own')
    link.close()
  })
})

// ---------------------------------------------------------------------------------------------
// controls: what the verifier tried to refute and could not (these pass today; a fix must not break them)
// ---------------------------------------------------------------------------------------------

describe('controls: promises that held', () => {
  test('control (1): before the owner accepts nothing is loaded or joined on either side, and the rendezvous sees the channel and sealed boxes only', async () => {
    const w = makeWorld({ core: true })
    const A = await make(w, 'Alice')
    const B = await make(w, 'Bob')
    const { code } = await A.apps.openCode()
    const secret = code.replace(/-/g, '').slice(4)
    await B.apps.knock(code)
    await until(() => st(A).requests.length === 1, 'the request')
    for (const X of [A, B]) assert.deepEqual([X.loadCalls.length, X.tm.joined.length], [0, 0], X.name + ' loaded or joined while the knock was pending')
    assert.equal(w.net.frames.length, 0, 'no frame on any wire')
    await A.apps.reject(st(A).requests[0].knock)
    await until(() => conv(B).status === 'rejected', 'the rejection at the requester')
    for (const X of [A, B]) assert.deepEqual([X.loadCalls.length, X.tm.joined.length], [0, 0], X.name + ' loaded or joined after a rejection')
    // a second knock, accepted: now, and only now, each side loads the manager and joins the one lane, of kind chat
    await B.apps.knock(code)
    await until(() => st(A).requests.length === 1, 'the second request')
    await A.apps.accept(st(A).requests[0].knock)
    await until(() => B.tm.joined.length === 1 && A.tm.joined.length === 1, 'both join after the accept')
    assert.equal(A.tm.joined[0].infoHash, B.tm.joined[0].infoHash)
    assert.deepEqual([A.tm.joined[0].kind, B.tm.joined[0].kind], ['chat', 'chat'])
    // what the rendezvous received: protocol fields, boxes of iv and ct, and never the secret, a name or a key
    const all = w.rdv.raw.join('\n')
    for (const f of w.rdv.raw) {
      const m = JSON.parse(f)
      for (const key of Object.keys(m)) assert.ok(['v', 'action', 'channel', 'box', 'knock', 'rid', 'proof'].includes(key), 'a field the rendezvous should not get: ' + key)
      if (m.box) assert.deepEqual(Object.keys(m.box).sort(), ['ct', 'iv'])
      if (m.proof !== undefined) assert.match(m.proof, /^[A-Za-z0-9_-]{86}$/, 'the proof is a signature and nothing else')
    }
    assert.ok(!all.includes(secret), 'the rendezvous received the secret')
    const words = wordsIn(w.rdv.raw)
    for (const needle of ['Alice', 'Bob', 'p256:', 'sdp', 'candidate']) assert.ok(!words.some((x) => x.includes(needle)), 'the rendezvous received ' + needle)
  })

  test('control (1): the search of the frames sees a name or a key sent in the clear, and is not fooled by chance in the sealed parts', () => {
    const needles = ['Alice', 'Bob', 'p256:', 'sdp', 'candidate']
    const clear = [
      { v: 1, action: 'pair-open', Alice: 1 }, // a name as a key
      { v: 1, action: 'pair-open', channel: 'Bob' }, // a name as a value
      { v: 1, action: 'sdp-offer' }, // signalling words
      { v: 1, box: { iv: 'x', ct: 'y', candidate: 'z' } }, // inside a box, as a key
      { v: 1, who: 'p256:abc' }, // a key sent in the clear
      JSON.stringify({ v: 1, action: 'pair-open', note: 'hello Bob' }) // frames come as text
    ]
    for (const f of clear) assert.ok(needles.some((n) => wordsIn([f]).some((x) => x.includes(n))), 'not seen: ' + JSON.stringify(f))
    // the same needles inside the random parts, as chance can put them there: nothing is seen
    const chance = JSON.stringify({ v: 1, action: 'pair-knock', channel: 'abcd', box: { iv: 'xBobxsdpx', ct: 'AliceBobsdpcandidate' }, rid: 'Bob12345', knock: 'sdpsdpsdp', proof: 'BobBobBob' })
    assert.deepEqual(needles.filter((n) => wordsIn([chance]).some((x) => x.includes(n))), [])
  })

  test('control (2)(3): a box opens only under the right secret, channel and role', async () => {
    const alice = await makePerson('Alice')
    const good = await codeKey('2345wxyz', 'abcd')
    const { box } = await sealHello({ keyCode: good, channel: 'abcd', role: 'knock', keys: alice.keys, name: 'Alice' })
    assert.equal((await openHello({ keyCode: good, channel: 'abcd', role: 'knock', box })).ok, true)
    const tries = [
      [await codeKey('2345wxy2', 'abcd'), 'abcd', 'knock'], // a wrong secret
      [await codeKey('2345wxyz', 'abce'), 'abce', 'knock'], // the secret under another channel
      [good, 'abce', 'knock'], // the right key, another channel
      [good, 'abcd', 'owner'] // the right key, the other role
    ]
    for (const [keyCode, channel, role] of tries) {
      const r = await openHello({ keyCode, channel, role, box })
      assert.deepEqual([r.ok, r.reason], [false, 'aead'])
    }
  })

  test('control (2)(3): a party that knows only the channel makes no request appear; five boxes the owner cannot open replace the code; a wrong secret gets no answer', async () => {
    const w = makeWorld({ core: true })
    const A = await make(w, 'Alice')
    const B = await make(w, 'Bob')
    const { code } = await A.apps.openCode()
    const channel = code.slice(0, 4)
    const secret = code.replace(/-/g, '').slice(4)
    // Bob types the right channel and a wrong secret
    const wrong = channel + (secret === 'aaaaaaaa' ? 'bbbbbbbb' : 'aaaaaaaa')
    const k = await B.apps.knock(wrong)
    assert.ok(k.knock, JSON.stringify(k))
    await sleep(50)
    assert.equal(st(A).requests.length, 0, 'a wrong secret made a request appear')
    // Bob heard nothing; after 30 seconds his page says so (it shows "No one has this code right now.")
    assert.equal(conv(B).silent, false)
    w.advance(31000)
    await sleep(50)
    assert.equal(conv(B).silent, true)
    assert.equal(st(A).code, code, 'one box the owner could not open does not replace the code')
    // Eve knows the channel only and sends boxes of the right shape: with Bob's, the fifth box the owner cannot open
    const eve = new FakeLink(w.rdv, { setTimeoutFn: w.clock.setTimeout, clearTimeoutFn: w.clock.clearTimeout, random: () => 0.5 })
    for (let i = 0; i < 4; i++) {
      const r = await eve.knock({ kind: 'pair', channel, box: { iv: 'A'.repeat(16), ct: 'B'.repeat(60 + i) } })
      assert.equal(r.ok, true, JSON.stringify(r))
      await sleep(40)
      assert.equal(st(A).requests.length, 0, 'a request appeared from a box made without the secret')
      if (i < 3) assert.equal(st(A).code, code, 'the code is replaced before the fifth box')
    }
    await until(() => st(A).code !== null && st(A).code !== code, 'the code is replaced after five boxes it could not open')
    assert.equal(st(A).notice.kind, 'code-replaced')
    eve.close()
  })

  test('control (4): a frame made under another key, an oversized frame and a replayed frame are each counted, struck or dropped', async () => {
    const w = makeWorld({ core: true })
    const { A, B, a, b } = await pairUp(w)
    const eve = await makePerson('Eve')
    // a replay: the same sealed frame twice is one message
    const sealed = await sealDmBody({ keys: B.person.keys, peerEk: A.person.keys.chat.pub, body: { k: 'msg', id: pad16('REPLAY', 1), t: w.clock.now(), text: 'once', fmt: 'md1' }, now: w.clock.now(), n: 1 })
    const bytes = encodeFrame(T.DM, sealed.payload)
    const wire = wireOf(w, B)
    wire.extended(EXT_NAME, bytes)
    await sleep(100)
    wire.extended(EXT_NAME, bytes)
    await sleep(100)
    assert.equal(conv(A).messages.filter((m) => m.text === 'once').length, 1)
    // an oversized frame is a strike, and so is a frame under a key the pair does not hold; three close the wire
    wire.extended(EXT_NAME, new Uint8Array(16385).fill(1))
    const forged = await sealDmBody({ keys: eve.keys, peerEk: A.person.keys.chat.pub, body: { k: 'msg', id: pad16('FORGED', 1), t: w.clock.now(), text: 'x', fmt: 'md1' }, now: w.clock.now(), n: 2 })
    wire.extended(EXT_NAME, encodeFrame(T.DM, forged.payload))
    await sleep(100)
    assert.equal(A.tm.ignored.length, 0, 'two strikes do not close the wire')
    const forged2 = await sealDmBody({ keys: eve.keys, peerEk: A.person.keys.chat.pub, body: { k: 'msg', id: pad16('FORGED', 2), t: w.clock.now(), text: 'y', fmt: 'md1' }, now: w.clock.now(), n: 3 })
    wire.extended(EXT_NAME, encodeFrame(T.DM, forged2.payload))
    await until(() => A.tm.ignored.length === 1, 'the third strike closes the wire')
    assert.match(A.tm.ignored[0][1], /^mw_apps1:/)
    assert.deepEqual(conv(A).messages.filter((m) => /^[xy]$/.test(m.text)), [])
    assert.ok(b && a)
  })

  test('control (5): 150 well-formed frames from the other person that name my messages change none of them', async () => {
    const w = makeWorld({ core: true })
    const { A, B, a } = await pairUp(w)
    const mine = []
    for (let i = 0; i < 5; i++) mine.push((await A.apps.send(a, 'mine-' + i, i === 4 ? { exp: 3600000 } : {})).id)
    await sleep(200)
    const keep = () => JSON.stringify(conv(A).messages.filter((m) => m.mine).map((m) => [m.id, m.text, m.deleted, m.edits.length, m.exp, m.expAt, m.pinned, m.saved, m.important, m.scheduled]))
    const before = keep()
    let seed = 7
    const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff }
    const pick = (list) => list[Math.floor(rnd() * list.length)]
    for (let i = 0; i < 150; i++) {
      w.advance(700)
      const target = pick(mine)
      const T0 = w.clock.now()
      const body = pick([
        () => ({ k: 'edit', id: target, text: 'HACKED ' + i, t: T0 + 5000, o: 'o' + i }),
        () => ({ k: 'del', id: target, o: 'o' + i }),
        () => ({ k: 'react', id: target, emoji: '\u{1F44D}', t: T0, o: 'o' + i }),
        () => ({ k: 'msg', id: target, t: T0, text: 'a copy of an id I used', fmt: 'md1', exp: 1000 }),
        () => ({ k: 'ack', id: target }),
        () => ({ k: 'read', upTo: T0 + 1e9 })
      ])()
      await inject(w, B, A, body, { n: 3000 + i })
      if (i % 10 === 0) await sleep(15)
    }
    await sleep(500)
    assert.equal(A.tm.ignored.length, 0, 'every frame was well formed, so none was a strike')
    assert.equal(keep(), before, 'the other person changed a message they did not write')
  })

  test('control (6): the new files call no storage API', () => {
    const files = ['apps.js', 'apps-link.js', 'apps-crypto.js', 'apps-format.js', 'apps-ui.js']
    const banned = /\b(localStorage|sessionStorage|indexedDB|IndexedDB|CacheStorage|caches\.|document\.cookie|navigator\.storage|BroadcastChannel|openDatabase)\b/
    for (const f of files) {
      const text = readFileSync(new URL('../../src/loader/' + f, import.meta.url), 'utf8')
      assert.equal(banned.test(text), false, f + ' names a storage API')
      assert.equal(/history\.(push|replace)State|location\.(hash|search)\s*=[^=]/.test(text), false, f + ' writes the address')
    }
  })

  test('control (7): after hostile and ordinary traffic the Node tracker\'s log and counts hold no client-supplied text', async () => {
    const logs = []
    const t = await createTracker({ port: 0, open: true, quiet: false, log: (line) => logs.push(line) })
    const ws = new WebSocket(t.url)
    const replies = []
    ws.on('message', (d) => replies.push(d.toString('utf8')))
    await new Promise((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject) })
    const MARK = 'MarkerZ9' + 'x'.repeat(6)
    const box = { iv: 'A'.repeat(16), ct: 'B'.repeat(80) }
    const send = (m) => ws.send(JSON.stringify(m))
    send({ v: 1, action: 'pair-open', channel: 'abcd', box, rid: 'r1' })
    send({ v: 1, action: 'pair-knock', channel: 'abcd', box, rid: 'r2' })
    send({ v: 1, action: 'pair-knock', channel: MARK, box, rid: MARK })
    send({ v: 1, action: 'pair-open', channel: 'wxyz', box: { iv: MARK, ct: MARK } })
    send({ v: 2, action: 'pair-' + MARK })
    send({ v: 1, action: 'room-accept', knock: MARK })
    send({ v: 1, action: 'pair-open', channel: 'k3k3', box: { iv: 'A'.repeat(16), ct: 'B'.repeat(9000) } })
    await sleep(400)
    ws.terminate()
    const stats = JSON.stringify(t.stats())
    await t.close()
    assert.equal(logs.filter((l) => l.includes(MARK)).length, 0, 'a client string reached the log: ' + JSON.stringify(logs))
    assert.equal(stats.includes(MARK), false)
    for (const v of Object.values(JSON.parse(stats))) assert.ok(typeof v === 'number' || typeof v === 'boolean' || v === null, 'a count or a flag only')
    // the Worker core the same: its counts are numbers and flags
    const core = createRendezvous({ open: true })
    const conn = { send () {} }
    core.attach(conn, null)
    core.message(conn, JSON.stringify({ v: 1, action: 'pair-open', channel: 'abcd', box }))
    for (const v of Object.values(core.stats())) assert.ok(typeof v === 'number' || typeof v === 'boolean', 'a count or a flag only')
  })
})
