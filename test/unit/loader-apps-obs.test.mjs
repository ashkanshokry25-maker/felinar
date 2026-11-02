// Unit tests for the usage reports of the apps (plan obs-2026-11-02, lane L3). src/loader/apps.js (the service), apps-link.js (the pair socket)
// and apps-ui.js (the view) take an optional report(name, fields) and call it at every transition: the code, the knocks, the requests,
// the conversations and rooms, the wires, the message statuses, the socket, and in the view the views, the cards, the first yes and the
// sign-in. What these tests hold to:
//   - the full ordered list of what two people report when they pair and message, and when they make a room;
//   - what no report may carry: a message, a name, a key, a box, a proof, a knock token, a lane, or more than the 4-character channel of a code
//     (every field value of every report is scanned);
//   - a report that throws, or none at all, changes nothing;
//   - the line on the price card that names the host of the reports, and the first yes.
// Every party is a fake on this machine (test/unit/fakes/apps-fakes.mjs). Run: node --test test/unit/loader-apps-obs.test.mjs
import { test, describe, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { createApps } from '../../src/loader/apps.js';
import { PairLink, reportWord, reasonWord, reasonCode, BACKOFF_MS } from '../../src/loader/apps-link.js';
import { createAppsUi } from '../../src/loader/apps-ui.js';
import { APPS_TEXT, appsText } from '../../src/loader/strings.js';
import { EXT_NAME, codeKey, sealHello, splitCode, shortIdOf } from '../../src/loader/apps-crypto.js';
import { describeTarget } from '../../src/loader/obs.js';
import { FakeDocument } from './dropin-fake-dom.mjs';
import { FakeLink, FakeIdentity, FakeApps, makeWorld, makePerson, until, settle } from './fakes/apps-fakes.mjs';

const URL_OK = 'wss://rendezvous.invalid/';
const clone = (v) => JSON.parse(JSON.stringify(v));

// ---------------------------------------------------------------------------------------------------------------------------------
// The harness: the real service and the real pair socket of each person, on the fake rendezvous, with every report recorded in order. The
// service's names get the prefix 'apps.' and the socket's 'link.', as app.js gives them.
// ---------------------------------------------------------------------------------------------------------------------------------

const made = [];
afterEach(() => {
  for (const X of made.splice(0)) {
    try { X.apps.destroy(); } catch (_) { /* gone */ }
  }
});

/** One word per report for reading a list: its name and, when it has one, its ev, status, state, step, view, action or name. */
const digestOf = (r) => {
  const f = r.fields;
  const w = f.ev || f.status || f.state || f.step || f.view || f.action || f.name;
  return w === undefined ? r.name : r.name + ':' + w;
};

async function person (w, name, { limits = {}, throwing = false, loadTm = null } = {}) {
  const p = await makePerson(name);
  const identity = new FakeIdentity(p);
  const tm = w.net.tm(name);
  const reports = [];
  const into = (prefix) => (n, f) => {
    if (throwing) throw new Error('a report that breaks');
    reports.push({ name: prefix + n, fields: clone(f) });
  };
  const link = new FakeLink(w.rdv, { setTimeoutFn: w.clock.setTimeout, clearTimeoutFn: w.clock.clearTimeout, random: () => 0.5, now: w.clock.now, report: into('link.') });
  const apps = createApps({
    api: { identity }, config: { rendezvous: [URL_OK], stun: [], idp: null }, loadTm: loadTm || (async () => tm), now: w.clock.now, link,
    setTimeoutFn: w.clock.setTimeout, clearTimeoutFn: w.clock.clearTimeout, random: () => 0.5, report: into('apps.'),
    limits: Object.assign({ byeGraceMs: 0, blockedRejectDelayMs: [10, 20] }, limits)
  });
  const X = {
    name, p, identity, tm, link, apps, reports,
    names: () => reports.map((r) => r.name),
    digest: () => reports.map(digestOf),
    only: (name) => reports.filter((r) => r.name === name).map((r) => r.fields),
    clear: () => { reports.length = 0; }
  };
  made.push(X);
  return X;
}

const st = (X) => X.apps.state();
const conv = (X, i = 0) => st(X).conversations[i];
const isConnected = (X) => { const c = conv(X); return !!c && c.status === 'connected'; };

/** The names are what the plan lists for the service ('apps.') and the socket ('link.'): lower case words, dots and hyphens. */
const NAME_RE = /^[a-z][a-z0-9.-]{1,48}$/;

function leaves (v, out = []) {
  if (typeof v === 'string') out.push(v);
  else if (v && typeof v === 'object') for (const x of Object.values(v)) leaves(x, out);
  return out;
}

/** Everything of any length from 8 characters that a client ever wrote to the rendezvous: boxes, proofs, request ids, knock tokens. */
function seenByRendezvous (rdv) {
  const set = new Set();
  for (const text of rdv.raw) for (const s of leaves(JSON.parse(text))) if (s.length >= 8 && !/^(pair|room)-[a-z]+$/.test(s)) set.add(s);
  return Array.from(set);
}

/**
 * The rules of the plan's section 4, applied to every field of every report of these people: a name of the allowed shape, at most 12 fields,
 * each a string of at most 200 characters, a finite number or a boolean; none of `forbidden` inside any string (compared without case); and
 * no run of five characters of `code` (the channel, the first four, is allowed) in any field but the local ids.
 */
function assertClean (people, { forbidden = [], code = null, rdv = null } = {}) {
  const bad = forbidden.concat(rdv ? seenByRendezvous(rdv) : []).filter((x) => typeof x === 'string' && x.length >= 3);
  const flatCode = code ? code.toLowerCase().replace(/[-\s]/g, '') : '';
  let checked = 0;
  for (const X of people) {
    for (const r of X.reports) {
      const where = X.name + ' ' + r.name + ' ' + JSON.stringify(r.fields);
      assert.match(r.name, NAME_RE, where);
      assert.ok(Object.keys(r.fields).length <= 12, where);
      for (const [k, v] of Object.entries(r.fields)) {
        assert.ok(typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean', where + ': ' + k + ' is ' + typeof v);
        if (typeof v === 'number') assert.ok(Number.isFinite(v), where);
        if (typeof v !== 'string') continue;
        checked++;
        assert.ok(v.length <= 200, where);
        const low = v.toLowerCase();
        for (const b of bad) assert.ok(!low.includes(b.toLowerCase()), where + ' carries ' + JSON.stringify(b.slice(0, 12)));
        if (flatCode && k !== 'id' && k !== 'conv') {
          const flat = low.replace(/[-\s]/g, '');
          for (let i = 0; i + 5 <= flatCode.length; i++) assert.ok(!flat.includes(flatCode.slice(i, i + 5)), where + ' carries more than the channel of the code');
        }
      }
    }
  }
  assert.ok(checked > 5, 'the scan looked at something');
}

/** a is a subsequence of list: every item of a is in list, in that order (other items may lie between them). */
function inOrder (list, a) {
  let at = 0;
  for (const item of list) if (item === a[at]) at++;
  return at === a.length;
}

/** A owns a code, B knocks, A accepts; resolves when both show connected. */
async function pairUp (w, { names = ['Zelda Quill', 'Orson Finch'], limits } = {}) {
  const A = await person(w, names[0], { limits });
  const B = await person(w, names[1], { limits });
  const { code } = await A.apps.openCode();
  const k = await B.apps.knock(code);
  assert.ok(k.knock, JSON.stringify(k));
  await until(() => st(A).requests.length === 1, 'the request at the owner');
  const acc = await A.apps.accept(st(A).requests[0].knock);
  assert.ok(acc.id, JSON.stringify(acc));
  await until(() => isConnected(A) && isConnected(B), 'both connected');
  return { A, B, code, k, a: conv(A).id, b: conv(B).id };
}

/** The FakeWire that person X writes on, on the first live lane of the world. */
function wireOf (w, X) {
  for (const pairs of w.net.pairs.values()) {
    for (const p of pairs.values()) {
      if (p.a.name === X.name && !p.wa.destroyed) return p.wa;
      if (p.b.name === X.name && !p.wb.destroyed) return p.wb;
    }
  }
  return null;
}

const TEXT_A = 'meet me at the old mill at noon';
const TEXT_B = 'bring the blue folder please';

// ---------------------------------------------------------------------------------------------------------------------------------
// Two people pair and message
// ---------------------------------------------------------------------------------------------------------------------------------

describe('two people pair and message', () => {
  test('the full ordered list of what each side reports, from the first code to the answer to the first message', async () => {
    const w = makeWorld();
    const { A, B, code, k, a, b } = await pairUp(w);
    await A.apps.send(a, TEXT_A);
    await until(() => conv(B).messages.length === 1 && conv(A).messages[0].status === 'delivered', 'the first message delivered');
    await B.apps.markRead(b);
    await until(() => conv(A).messages[0].status === 'read', 'the first message read');
    await B.apps.send(b, TEXT_B);
    await until(() => conv(A).messages.length === 2 && conv(B).messages.find((m) => m.mine).status === 'delivered', 'the reply delivered');
    await settle(10);

    // the names, in order, on each side
    assert.deepEqual(A.names(), [
      'link.state', 'link.state', 'link.open', 'link.sent', 'link.reply', 'apps.code',
      'link.push', 'apps.request',
      'link.sent', 'link.reply', 'apps.request', 'apps.conv',
      'apps.wire', 'apps.conv',
      'apps.msg', 'apps.msg', 'apps.msg', 'apps.msg', 'apps.msg'
    ]);
    assert.deepEqual(B.names(), [
      'apps.knock', 'link.state', 'link.state', 'link.open', 'link.sent', 'link.reply', 'apps.knock', 'apps.conv',
      'link.push', 'apps.conv', 'apps.wire', 'apps.conv',
      'apps.msg', 'apps.msg', 'apps.msg', 'apps.msg'
    ]);

    // the same lists with what each one says
    assert.deepEqual(A.digest(), [
      'link.state:connecting', 'link.state:open', 'link.open', 'link.sent:pair-open', 'link.reply:pair-open', 'apps.code:opened',
      'link.push:pair-request', 'apps.request:in',
      'link.sent:pair-accept', 'link.reply:pair-accept', 'apps.request:accept', 'apps.conv:connecting',
      'apps.wire:up', 'apps.conv:connected',
      'apps.msg:queued', 'apps.msg:sent', 'apps.msg:delivered', 'apps.msg:read', 'apps.msg:received'
    ]);
    assert.deepEqual(B.digest(), [
      'apps.knock:sent', 'link.state:connecting', 'link.state:open', 'link.open', 'link.sent:pair-knock', 'link.reply:pair-knock', 'apps.knock:ok', 'apps.conv:waiting',
      'link.push:pair-accepted', 'apps.conv:connecting', 'apps.wire:up', 'apps.conv:connected',
      'apps.msg:received', 'apps.msg:queued', 'apps.msg:sent', 'apps.msg:delivered'
    ]);

    // the fields of the ones that matter
    const channel = code.slice(0, 4);
    assert.deepEqual(A.only('apps.code'), [{ ev: 'opened', kind: 'pair', why: 'user', channel }]);
    assert.deepEqual(A.only('apps.request'), [{ ev: 'in', kind: 'pair' }, { ev: 'accept', kind: 'pair' }]);
    assert.deepEqual(B.only('apps.knock'), [{ ev: 'sent', kind: 'pair', channel }, { ev: 'ok', kind: 'pair', channel }]);
    assert.deepEqual(A.only('apps.conv'), [{ id: a, status: 'connecting', incoming: true }, { id: a, status: 'connected', incoming: true }]);
    assert.deepEqual(B.only('apps.conv').map((f) => f.status), ['waiting', 'connecting', 'connected']);
    assert.ok(B.only('apps.conv').every((f) => f.id === b && f.incoming === false));
    assert.deepEqual(A.only('apps.wire'), [{ conv: a, ev: 'up', kind: 'pair' }]);
    assert.deepEqual(A.only('apps.msg'), ['queued', 'sent', 'delivered', 'read', 'received'].map((status) => ({ conv: a, status, count: 1 })));
    assert.deepEqual(A.only('link.state'), [{ state: 'connecting', prev: 'idle' }, { state: 'open', prev: 'connecting' }]);
    assert.deepEqual(A.only('link.open'), [{ attempt: 0 }]);
    for (const f of A.only('link.reply').concat(B.only('link.reply'))) assert.ok(f.ok === true && Number.isFinite(f.ms) && f.ms >= 0, JSON.stringify(f));
    assert.ok(k.knock);

    // and none of it is what was said, who said it, or a secret
    const keys = [A.p.keys, B.p.keys];
    assertClean([A, B], {
      rdv: w.rdv,
      code,
      forbidden: [
        TEXT_A, TEXT_B, 'Zelda', 'Orson', 'Quill', 'Finch', k.knock,
        ...keys.flatMap((x) => [x.pub, x.chat.pub, shortIdOf(x.pub)]),
        ...A.tm.joined.concat(B.tm.joined).map((j) => j.infoHash)
      ]
    });
  });

  test('a message of nothing but sentinels never shows in a report, whatever happens to it: edit, reaction, delete, nickname, a timer', async () => {
    const w = makeWorld();
    const { A, B, code, a, b } = await pairUp(w, { names: ['Mirela Dunmore', 'Tobias Alderwick'] });
    const secrets = ['SENTINEL-first-words', 'SENTINEL-edited-words', 'SENTINEL-nickname', 'SENTINEL-note', 'SENTINEL-draft'];
    const sent = await A.apps.send(a, secrets[0], { exp: 60000 });
    await until(() => conv(B).messages.length === 1, 'the message at the other side');
    w.advance(1000); // an edit counts only when it is later than what it edits
    await A.apps.edit(a, sent.id, secrets[1]);
    await until(() => conv(B).messages[0].text === secrets[1], 'the edit at the other side');
    await B.apps.react(b, conv(B).messages[0].id, '\u{1F44D}');
    await until(() => Object.keys(conv(A).messages[0].reactions).length === 1, 'the reaction at the first side');
    await B.apps.setNickname(b, secrets[2]);
    B.apps.setNote(b, secrets[3]);
    B.apps.setDraft(b, secrets[4]);
    await B.apps.markRead(b);
    await until(() => conv(A).messages[0].status === 'read', 'the read receipt');
    await A.apps.remove(a, sent.id, { both: true });
    await until(() => conv(B).messages[0].deleted === true, 'the deletion at the other side');
    w.advance(61000);
    await settle(20);
    assertClean([A, B], {
      rdv: w.rdv, code, forbidden: secrets.concat(['SENTINEL', 'Mirela', 'Dunmore', 'Tobias', 'Alderwick', A.p.keys.pub, B.p.keys.pub, shortIdOf(A.p.keys.pub), shortIdOf(B.p.keys.pub)])
    });
  });

  test('a message that no ack comes for is told as failed, and a retry as sent and delivered; a scheduled one as scheduled, then queued, then sent', async () => {
    const w = makeWorld();
    const { A, B, a } = await pairUp(w);
    A.clear();
    w.net.drops = () => true; // every frame is lost on the wire
    const lost = await A.apps.send(a, 'goes nowhere');
    await until(() => A.only('apps.msg').some((f) => f.status === 'sent'), 'the message went onto the wire');
    w.advance(20001); // ackTimeoutMs
    await until(() => A.only('apps.msg').some((f) => f.status === 'failed'), 'no ack came');
    assert.deepEqual(A.only('apps.msg').map((f) => f.status), ['queued', 'sent', 'failed']);
    w.net.drops = null;
    await A.apps.retry(a, lost.id);
    await until(() => conv(A).messages[0].status === 'delivered', 'the retry delivered');
    assert.deepEqual(A.only('apps.msg').map((f) => f.status), ['queued', 'sent', 'failed', 'sent', 'delivered']);
    A.clear();
    await A.apps.send(a, 'later', { at: w.clock.now() + 60000 });
    assert.deepEqual(A.only('apps.msg').map((f) => f.status), ['scheduled']);
    w.advance(60001);
    await until(() => conv(B).messages.length === 2, 'the scheduled message at the other side');
    await until(() => A.only('apps.msg').some((f) => f.status === 'delivered'), 'its ack at this side');
    assert.deepEqual(A.only('apps.msg').map((f) => f.status), ['scheduled', 'queued', 'sent', 'delivered']);
    assert.ok(B.names().includes('apps.msg'));
  });

  test('several messages that wait for a wire go out in one flush and are counted once', async () => {
    const w = makeWorld();
    const { A, B, a } = await pairUp(w);
    // the wire goes away, three messages queue, the wire comes back: one flush sends all three
    w.net.pause();
    w.net.dropAll();
    await until(() => conv(A).status === 'connecting', 'the wire is gone');
    A.clear();
    for (const t of ['one', 'two', 'three']) await A.apps.send(a, t);
    assert.deepEqual(A.only('apps.msg').map((f) => f.status + ':' + f.count), ['queued:1', 'queued:1', 'queued:1']);
    w.net.resume();
    await until(() => conv(A).messages.every((m) => m.status === 'delivered'), 'all three delivered');
    await settle(10);
    const sent = A.only('apps.msg').filter((f) => f.status === 'sent');
    assert.equal(sent.reduce((n, f) => n + f.count, 0), 3, JSON.stringify(sent));
    assert.ok(sent.length <= 3);
    assert.equal(A.only('apps.msg').filter((f) => f.status === 'delivered').reduce((n, f) => n + f.count, 0), 3);
    assert.ok(B.only('apps.msg').filter((f) => f.status === 'received').reduce((n, f) => n + f.count, 0) >= 3);
  });
});

// ---------------------------------------------------------------------------------------------------------------------------------
// A room
// ---------------------------------------------------------------------------------------------------------------------------------

describe('a room', () => {
  test('the full ordered list of what the owner and a member report, and none of it is a message, a name or a secret', async () => {
    const w = makeWorld();
    const O = await person(w, 'Isadora Pell');
    const M = await person(w, 'Caspian Rook');
    const room = await O.apps.createRoom();
    const joined = await M.apps.joinRoom(room.code);
    await until(() => st(O).requests.length === 1, 'the join request');
    await O.apps.acceptMember(st(O).requests[0].knock);
    await until(() => st(M).rooms[0] && st(M).rooms[0].status === 'connected' && st(O).rooms[0].members.length === 2, 'the member is in');
    await O.apps.sendRoom(room.id, 'room words from the owner');
    await until(() => st(M).rooms[0].messages.length === 1, 'the owner message at the member');
    await M.apps.sendRoom(joined.id, 'room words from the member');
    await until(() => st(O).rooms[0].messages.length === 2, 'the member message at the owner');
    await settle(10);
    assert.deepEqual(O.digest(), [
      'link.state:connecting', 'link.state:open', 'link.open', 'link.sent:room-open', 'link.reply:room-open', 'apps.code:opened', 'apps.room:open',
      'link.push:room-request', 'apps.request:in', 'link.sent:room-accept', 'link.reply:room-accept', 'apps.request:accept', 'apps.room:open',
      'apps.wire:up', 'apps.msg:queued', 'apps.msg:sent', 'apps.msg:received'
    ]);
    assert.deepEqual(M.digest(), [
      'apps.knock:sent', 'link.state:connecting', 'link.state:open', 'link.open', 'link.sent:room-knock', 'link.reply:room-knock', 'apps.knock:ok', 'apps.room:waiting',
      'link.push:room-accepted', 'apps.room:connecting', 'apps.wire:up', 'apps.room:connecting', 'apps.room:connected',
      'apps.msg:received', 'apps.msg:queued', 'apps.msg:sent'
    ]);
    const channel = room.code.slice(0, 4);
    assert.deepEqual(O.only('apps.code'), [{ ev: 'opened', kind: 'room', why: 'user', channel }]);
    assert.deepEqual(O.only('apps.room'), [{ id: room.id, status: 'open', members: 1 }, { id: room.id, status: 'open', reason: 'member-joined', members: 2 }]);
    assert.deepEqual(M.only('apps.room').map((f) => [f.status, f.reason || null, f.members]), [['waiting', null, 0], ['connecting', null, 1], ['connecting', 'roster', 2], ['connected', null, 2]]);
    assert.deepEqual(M.only('apps.knock'), [{ ev: 'sent', kind: 'room', channel }, { ev: 'ok', kind: 'room', channel }]);
    assert.deepEqual(O.only('apps.wire'), [{ conv: room.id, ev: 'up', kind: 'room' }]);
    assertClean([O, M], {
      rdv: w.rdv,
      code: room.code,
      forbidden: [
        'room words from', 'Isadora', 'Pell', 'Caspian', 'Rook',
        ...[O, M].flatMap((x) => [x.p.keys.pub, x.p.keys.chat.pub, shortIdOf(x.p.keys.pub)]),
        ...O.tm.joined.concat(M.tm.joined).map((j) => j.infoHash)
      ]
    });
  });

  test('leaving: the member says removed, the owner closes the code and then says removed; a room that its owner closes is told closed', async () => {
    const w = makeWorld();
    const O = await person(w, 'Isadora Pell');
    const M = await person(w, 'Caspian Rook');
    const room = await O.apps.createRoom();
    const joined = await M.apps.joinRoom(room.code);
    await until(() => st(O).requests.length === 1);
    await O.apps.acceptMember(st(O).requests[0].knock);
    await until(() => st(M).rooms[0].status === 'connected');
    O.clear();
    M.clear();
    await O.apps.leaveRoom(room.id);
    await until(() => st(M).rooms[0].status === 'closed', 'the member sees the room closed');
    await settle(10);
    assert.deepEqual(O.only('apps.code'), [{ ev: 'closed', kind: 'room', why: 'closed', channel: room.code.slice(0, 4) }]);
    assert.ok(inOrder(O.digest(), ['apps.code:closed', 'apps.room:removed']));
    assert.deepEqual(O.only('apps.room'), [{ id: room.id, status: 'removed', reason: 'left', members: 2 }]);
    assert.deepEqual(M.only('apps.room'), [{ id: joined.id, status: 'closed', reason: 'owner-left', members: 2 }]);
    M.clear();
    await M.apps.leaveRoom(joined.id);
    assert.deepEqual(M.only('apps.room'), [{ id: joined.id, status: 'removed', reason: 'left', members: 2 }]);
  });

  test('a member who knocks again is turned away as a member; a room code that closes drops the requests that waited on it', async () => {
    const w = makeWorld();
    const O = await person(w, 'Isadora Pell');
    const M = await person(w, 'Caspian Rook');
    const room = await O.apps.createRoom();
    await M.apps.joinRoom(room.code);
    await until(() => st(O).requests.length === 1);
    await O.apps.acceptMember(st(O).requests[0].knock);
    await until(() => st(M).rooms[0].status === 'connected');
    O.clear();
    await M.apps.joinRoom(room.code); // the same person asks again
    await until(() => O.only('apps.request').length >= 1, 'the second request is answered');
    assert.deepEqual(O.only('apps.request'), [{ ev: 'turned-away', kind: 'room', reason: 'member' }]);
    const N = await person(w, 'Nadia Holt');
    await N.apps.joinRoom(room.code);
    await until(() => st(O).requests.length === 1, 'a request that waits');
    O.clear();
    await O.apps.leaveRoom(room.id);
    assert.deepEqual(O.only('apps.request'), [{ ev: 'dropped', kind: 'room', reason: 'code-closed' }]);
  });
});

// ---------------------------------------------------------------------------------------------------------------------------------
// The conversation, the requests, the code
// ---------------------------------------------------------------------------------------------------------------------------------

describe('requests, conversations and the code', () => {
  test('leaving: the one who leaves says removed, the other hears the goodbye and says left', async () => {
    const w = makeWorld();
    const { A, B, a, b } = await pairUp(w);
    A.clear();
    B.clear();
    await A.apps.leave(a);
    await until(() => conv(B).status === 'left', 'the other side hears it');
    await settle(10);
    assert.deepEqual(A.only('apps.conv'), [{ id: a, status: 'removed', reason: 'left', incoming: true }]);
    assert.deepEqual(A.only('apps.wire'), [{ conv: a, ev: 'down', kind: 'pair', reason: 'left' }], 'a wire this service closed is a leaving, not a loss');
    assert.ok(B.only('apps.conv').some((f) => f.id === b && f.status === 'left'));
    assert.ok(B.only('apps.wire').every((f) => f.ev === 'down'));
  });

  test('a wire that is lost makes a connected conversation connecting; a person who is blocked and unblocked goes connected, blocked, left', async () => {
    const w = makeWorld();
    const { A, B, a } = await pairUp(w);
    A.clear();
    w.net.pause();
    w.net.dropAll();
    await until(() => conv(A).status === 'connecting', 'the connection is lost');
    assert.deepEqual(A.only('apps.wire'), [{ conv: a, ev: 'down', kind: 'pair' }]);
    assert.deepEqual(A.only('apps.conv'), [{ id: a, status: 'connecting', incoming: true }]);
    w.net.resume();
    await until(() => isConnected(A) && isConnected(B), 'back again');
    A.clear();
    await A.apps.block(B.p.keys.pub);
    await A.apps.unblock(B.p.keys.pub);
    assert.deepEqual(A.only('apps.conv').map((f) => f.status), ['blocked', 'left']);
  });

  test('a knock that is taken back, a knock on a block, a request nobody answers, a request the owner rejects', async () => {
    const w = makeWorld();
    const A = await person(w, 'Zelda Quill');
    const B = await person(w, 'Orson Finch');
    const C = await person(w, 'Nadia Holt');
    const { code } = await A.apps.openCode();
    await B.apps.knock(code);
    await until(() => st(A).requests.length === 1, 'the request');
    A.clear();
    B.clear();
    const bid = conv(B).id;
    await B.apps.cancelKnock(bid);
    await until(() => st(A).requests.length === 0, 'the request is withdrawn');
    assert.deepEqual(A.only('apps.request'), [{ ev: 'dropped', kind: 'pair', reason: 'cancelled' }]);
    assert.deepEqual(B.only('apps.conv'), [{ id: bid, status: 'removed', reason: 'cancelled', incoming: false }]);
    // a person the owner blocked knocks: turned away, and the owner rejects them quietly
    await A.apps.block(C.p.keys.pub);
    A.clear();
    C.clear();
    await C.apps.knock(code);
    await until(() => A.only('apps.request').length >= 1, 'the request of a blocked person');
    assert.deepEqual(A.only('apps.request'), [{ ev: 'turned-away', kind: 'pair', reason: 'blocked' }]);
    w.advance(30); // the rejection of a blocked person waits a few milliseconds (blockedRejectDelayMs)
    await until(() => C.only('apps.conv').length >= 2, 'the blocked person hears a rejection');
    assert.deepEqual(C.only('apps.conv').map((f) => [f.status, f.reason || null]), [['waiting', null], ['rejected', 'rejected']]);
    // a request that nobody answers for ten minutes
    A.clear();
    const D = await person(w, 'Dario Vale');
    await D.apps.knock(code);
    await until(() => st(A).requests.length === 1, 'a request that waits');
    A.clear();
    w.advance(600001); // requestTtlMs
    await settle(10);
    assert.deepEqual(A.only('apps.request'), [{ ev: 'expired', kind: 'pair' }]);
    // and one the owner rejects
    A.clear();
    const E = await person(w, 'Elio Marsh');
    await E.apps.knock(code);
    await until(() => st(A).requests.length === 1, 'another request');
    A.clear();
    E.clear();
    await A.apps.reject(st(A).requests[0].knock);
    await until(() => E.only('apps.conv').length >= 1, 'the rejection reaches the requester');
    assert.deepEqual(A.only('apps.request'), [{ ev: 'reject', kind: 'pair', reason: 'user' }]);
    assert.deepEqual(E.only('apps.conv').map((f) => [f.status, f.reason]), [['rejected', 'rejected']]);
  });

  test('turned away: a replayed box, a hello that carries the owner\'s own key, a box that does not open; five of those replace the code with a notice', async () => {
    const w = makeWorld();
    const A = await person(w, 'Zelda Quill');
    const B = await person(w, 'Orson Finch');
    const { code } = await A.apps.openCode();
    const sp = splitCode(code);
    await B.apps.knock(code);
    await until(() => st(A).requests.length === 1, 'the first request');
    const knockFrame = w.rdv.raw.map((t) => JSON.parse(t)).find((m) => m.action === 'pair-knock');
    const eve = new FakeLink(w.rdv, { setTimeoutFn: w.clock.setTimeout, clearTimeoutFn: w.clock.clearTimeout, random: () => 0.5 });
    A.clear();
    // the same box again is a replay
    assert.equal((await eve.knock({ kind: 'pair', channel: sp.channel, box: knockFrame.box })).ok, true);
    await until(() => A.only('apps.request').length === 1, 'the replay is answered');
    // a hello made with the owner's own keys is not a person
    const keyCode = await codeKey(sp.secret, sp.channel);
    const mine = await sealHello({ keyCode, channel: sp.channel, role: 'knock', keys: A.p.keys, name: 'Zelda Quill', now: w.clock.now() });
    assert.equal((await eve.knock({ kind: 'pair', channel: sp.channel, box: mine.box })).ok, true);
    await until(() => A.only('apps.request').length === 2, 'the hello of the owner is answered');
    assert.deepEqual(A.only('apps.request'), [{ ev: 'turned-away', kind: 'pair', reason: 'replay' }, { ev: 'turned-away', kind: 'pair', reason: 'self' }]);
    // five boxes that do not open (only those are counted: a replay and a hello of the owner are not): the code is replaced
    A.clear();
    for (let i = 0; i < 5; i++) {
      const r = await eve.knock({ kind: 'pair', channel: sp.channel, box: { iv: 'A'.repeat(16), ct: 'B'.repeat(60 + i) } });
      assert.equal(r.ok, true, JSON.stringify(r));
      await until(() => A.only('apps.request').filter((f) => f.ev === 'turned-away').length === i + 1, 'box ' + i + ' is answered');
    }
    await until(() => A.only('apps.notice').length === 1, 'the code is replaced');
    // five turned away, and the request of the first person, which waited on the old code, goes with it
    assert.deepEqual(A.only('apps.request'), [
      ...[0, 1, 2, 3, 4].map(() => ({ ev: 'turned-away', kind: 'pair', reason: 'bad-box' })),
      { ev: 'dropped', kind: 'pair', reason: 'code-closed' }
    ]);
    const tail = A.digest().filter((d) => /^apps\.(code|notice)/.test(d));
    assert.deepEqual(tail, ['apps.code:replaced', 'apps.notice']);
    assert.deepEqual(A.only('apps.code'), [{ ev: 'replaced', kind: 'pair', why: 'bad-knocks', channel: st(A).code.slice(0, 4) }]);
    assert.deepEqual(A.only('apps.notice'), [{ kind: 'code-replaced', why: 'bad-knocks' }]);
    assertClean([A, B], { rdv: w.rdv, code, forbidden: ['Zelda', 'Orson', A.p.keys.pub, B.p.keys.pub] });
  });

  test('the code: asked for another, closed, and one the rendezvous ends; a code that cannot be opened is an error', async () => {
    const w = makeWorld();
    const A = await person(w, 'Zelda Quill');
    const first = await A.apps.openCode();
    A.clear();
    const second = await A.apps.newCode();
    assert.notEqual(first.code, second.code);
    assert.deepEqual(A.only('apps.code'), [{ ev: 'new', kind: 'pair', why: 'user', channel: second.code.slice(0, 4) }]);
    A.clear();
    await A.apps.closeCode();
    assert.deepEqual(A.only('apps.code'), [{ ev: 'closed', kind: 'pair', why: 'user', channel: second.code.slice(0, 4) }]);
    await A.apps.closeCode();
    assert.equal(A.only('apps.code').length, 1, 'closing a code that is not there says nothing');
    // the rendezvous ends the code (it does so after 24 hours): replaced, with a notice
    const third = await A.apps.openCode();
    A.clear();
    const channel = third.code.slice(0, 4);
    for (const conn of w.rdv.conns) w.rdv._send(conn, { action: 'pair-close', channel, reason: 'expired' });
    await until(() => A.only('apps.notice').length === 1, 'the code is replaced');
    assert.deepEqual(A.only('apps.code').map((f) => [f.ev, f.why, f.channel === channel]), [['replaced', 'expired', false]]);
    assert.deepEqual(A.only('apps.notice'), [{ kind: 'code-replaced', why: 'expired' }]);
    assert.ok(A.names().includes('link.push'));
    assert.deepEqual(A.only('link.push'), [{ name: 'pair-close' }]);
    // no rendezvous answers: the opening is an error, and the socket says why
    const Z = await person(w, 'Zed Marrow');
    w.rdv.refuse = true;
    const pending = Z.apps.openCode();
    await until(() => Z.link.state === 'connecting' || Z.link.state === 'backoff', 'the socket tries');
    await settle(5);
    w.advance(10000); // openWaitMs
    assert.deepEqual(await pending, { error: 'link down' });
    assert.deepEqual(Z.only('apps.code'), [{ ev: 'error', kind: 'pair', why: 'link-down' }]);
    assert.ok(Z.only('link.reply').some((f) => f.action === 'pair-open' && f.ok === false && f.reason === 'link-down'));
  });

  test('knocks that do not go through are errors with a reason: a code that is not a code, your own code, a code nobody has, a knock nobody answers (silent, then expired)', async () => {
    const w = makeWorld();
    const A = await person(w, 'Zelda Quill');
    const B = await person(w, 'Orson Finch');
    const { code } = await A.apps.openCode();
    B.clear();
    assert.deepEqual(await B.apps.knock('not a code'), { error: 'bad code' });
    assert.deepEqual(await A.apps.knock(code), { error: 'own code' });
    assert.deepEqual(B.only('apps.knock'), [{ ev: 'error', kind: 'pair', reason: 'bad-code' }], 'the text that was typed is not in it');
    assert.deepEqual(A.only('apps.knock'), [{ ev: 'error', kind: 'pair', channel: code.slice(0, 4), reason: 'own-code' }]);
    assert.deepEqual(await B.apps.knock('abcd-2345-wxyz'), { error: 'unknown code' });
    assert.deepEqual(B.only('apps.knock').slice(1), [{ ev: 'sent', kind: 'pair', channel: 'abcd' }, { ev: 'error', kind: 'pair', channel: 'abcd', reason: 'unknown-code' }]);
    assert.ok(B.only('link.reply').some((f) => f.action === 'pair-knock' && f.ok === false && f.reason === 'unknown-code'));
    // the right channel and a wrong secret: no answer for 30 seconds is silent, ten minutes is expired
    B.clear();
    const wrong = code.slice(0, 4) + (code.replace(/-/g, '').slice(4) === 'aaaaaaaa' ? 'bbbbbbbb' : 'aaaaaaaa');
    const k = await B.apps.knock(wrong);
    assert.ok(k.knock, JSON.stringify(k));
    w.advance(31000);
    await settle(5);
    assert.deepEqual(B.only('apps.knock').map((f) => f.ev + (f.reason ? ':' + f.reason : '')), ['sent', 'ok', 'error:silent']);
    w.advance(600000);
    await settle(5);
    assert.deepEqual(B.only('apps.conv').map((f) => [f.status, f.reason || null]), [['waiting', null], ['rejected', 'expired']]);
  });

  test('a socket that is lost while a knock waits knocks again, and says so', async () => {
    const w = makeWorld();
    const A = await person(w, 'Zelda Quill');
    const B = await person(w, 'Orson Finch');
    const { code } = await A.apps.openCode();
    await B.apps.knock(code);
    await until(() => st(A).requests.length === 1);
    B.clear();
    A.clear();
    B.link.drop();
    await settle(10);
    w.advance(2000);
    await until(() => B.only('apps.knock').some((f) => f.ev === 'ok'), 'the knock is made again');
    assert.deepEqual(B.only('apps.knock'), [{ ev: 'sent', kind: 'pair', channel: code.slice(0, 4), reason: 'again' }, { ev: 'ok', kind: 'pair', channel: code.slice(0, 4), reason: 'again' }]);
    assert.ok(inOrder(B.digest(), ['link.state:backoff', 'link.gone', 'link.backoff', 'link.state:connecting', 'link.state:open', 'link.open', 'apps.knock:sent', 'link.sent:pair-knock', 'link.reply:pair-knock', 'apps.knock:ok']), B.digest().join(' '));
    // the owner saw the first request go with the socket, and then the new one
    await until(() => A.only('apps.request').some((f) => f.ev === 'in'), 'the new request');
    assert.ok(inOrder(A.digest(), ['link.push:pair-cancelled', 'apps.request:dropped', 'link.push:pair-request', 'apps.request:in']), A.digest().join(' '));
    assert.deepEqual(A.only('apps.request')[0], { ev: 'dropped', kind: 'pair', reason: 'cancelled' });
  });

  test('an owner whose socket is lost drops the requests that waited, registers the code again, and says so', async () => {
    const w = makeWorld();
    const A = await person(w, 'Zelda Quill');
    const B = await person(w, 'Orson Finch');
    const { code } = await A.apps.openCode();
    await B.apps.knock(code);
    await until(() => st(A).requests.length === 1);
    A.clear();
    A.link.drop();
    await settle(10);
    w.advance(2000);
    await until(() => A.only('apps.code').length === 1, 'the code is registered again');
    assert.deepEqual(A.only('apps.request'), [{ ev: 'dropped', kind: 'pair', reason: 'link-lost' }]);
    assert.deepEqual(A.only('apps.code'), [{ ev: 'opened', kind: 'pair', why: 'reconnect', channel: code.slice(0, 4) }]);
    assert.deepEqual(A.only('link.gone'), [{ why: 'closed' }]);
    assert.deepEqual(A.only('link.backoff'), [{ attempt: 1, ms: BACKOFF_MS[0], why: 'closed' }], 'with a random of one half the jitter is nothing');
    assert.deepEqual(A.only('link.open'), [{ attempt: 1 }]);
  });

  test('an accept that does not go through is an error with a reason: the manager of the lanes could not be loaded', async () => {
    const w = makeWorld();
    const A = await person(w, 'Zelda Quill', { loadTm: async () => { throw Object.assign(new Error('no webrtc'), { code: 'E_UNSUPPORTED' }); } });
    const B = await person(w, 'Orson Finch');
    const { code } = await A.apps.openCode();
    await B.apps.knock(code);
    await until(() => st(A).requests.length === 1);
    A.clear();
    assert.deepEqual(await A.apps.accept(st(A).requests[0].knock), { error: 'no manager' });
    assert.deepEqual(A.only('apps.request'), [{ ev: 'accept-error', kind: 'pair', reason: 'no-manager' }]);
    assert.equal(A.only('apps.conv').length, 0);
  });

  test('wires that speak badly: three bad frames are three strikes and then a kill, then the wire is down', async () => {
    const w = makeWorld();
    const { A, B, a } = await pairUp(w);
    A.clear();
    const wire = wireOf(w, B);
    assert.ok(wire);
    for (let i = 0; i < 3; i++) wire.extended(EXT_NAME, new Uint8Array(16385).fill(1)); // over the size of a frame
    await until(() => A.only('apps.wire').some((f) => f.ev === 'down'), 'the wire is closed');
    assert.deepEqual(A.only('apps.wire'), [
      { conv: a, ev: 'strike', kind: 'pair', reason: 'size' },
      { conv: a, ev: 'strike', kind: 'pair', reason: 'size' },
      { conv: a, ev: 'strike', kind: 'pair', reason: 'size' },
      { conv: a, ev: 'kill', kind: 'pair', reason: 'size' },
      { conv: a, ev: 'down', kind: 'pair' }
    ]);
    assert.deepEqual(A.only('apps.conv'), [{ id: a, status: 'connecting', incoming: true }], 'losing the last wire is told once, and the kill is not a leaving');
  });
});

// ---------------------------------------------------------------------------------------------------------------------------------
// The pair socket on its own
// ---------------------------------------------------------------------------------------------------------------------------------

function bareLink (w, opts = {}) {
  const got = [];
  const link = new FakeLink(w.rdv, Object.assign({
    setTimeoutFn: w.clock.setTimeout, clearTimeoutFn: w.clock.clearTimeout, random: () => 0.5, now: w.clock.now, report: (n, f) => got.push({ name: n, fields: clone(f) })
  }, opts));
  return { link, got, digest: () => got.map(digestOf) };
}

describe('the pair socket', () => {
  test('state, open, sent, reply and close, in order; a push is told by its name only', async () => {
    const w = makeWorld();
    const { link, got, digest } = bareLink(w);
    assert.equal((await link.openCode({ kind: 'pair', channel: 'abcd', box: { iv: 'iv-secret-sentinel', ct: 'ct-secret-sentinel' } })).ok, true);
    const eve = bareLink(w);
    assert.equal((await eve.link.knock({ kind: 'pair', channel: 'abcd', box: { iv: 'iv-knock-sentinel', ct: 'ct-knock-sentinel' } })).ok, true);
    await until(() => got.some((r) => r.name === 'push'), 'the push');
    link.close();
    eve.link.close();
    assert.deepEqual(digest(), ['state:connecting', 'state:open', 'open', 'sent:pair-open', 'reply:pair-open', 'push:pair-request', 'state:idle', 'gone']);
    assert.deepEqual(got.find((r) => r.name === 'gone').fields, { why: 'stopped' });
    assert.deepEqual(eve.digest().slice(-4), ['sent:pair-knock', 'reply:pair-knock', 'state:idle', 'gone']);
    const text = JSON.stringify(got.concat(eve.got));
    for (const needle of ['abcd', 'iv-secret-sentinel', 'ct-secret-sentinel', 'iv-knock-sentinel', 'ct-knock-sentinel']) assert.ok(!text.includes(needle), needle);
    for (const r of got.concat(eve.got)) assert.ok(/^[a-z]+$/.test(r.name), r.name);
  });

  test('a request that nobody answers is a timeout with the action and the time; a frame that is too big is a reply that says so', async () => {
    const w = makeWorld();
    const { link, got } = bareLink(w);
    w.rdv.handle = () => {}; // the rendezvous reads and says nothing
    const pending = link.request('pair-open', { channel: 'abcd', box: { iv: 'x', ct: 'y' } });
    await until(() => got.some((r) => r.name === 'sent'), 'the frame went');
    w.advance(15000); // requestTimeoutMs
    assert.deepEqual(await pending, { ok: false, reason: 'timeout' });
    assert.deepEqual(got.filter((r) => r.name === 'timeout').map((r) => r.fields), [{ action: 'pair-open', ms: 15000 }]);
    assert.equal(got.filter((r) => r.name === 'reply').length, 0, 'a timeout is not also a reply');
    const big = await link.request('pair-open', { channel: 'abcd', box: { iv: 'x', ct: 'y'.repeat(9000) } });
    assert.deepEqual(big, { ok: false, reason: 'too-big' });
    assert.deepEqual(got.filter((r) => r.name === 'reply').map((r) => r.fields).map((f) => [f.action, f.ok, f.reason]), [['pair-open', false, 'too-big']]);
    assert.equal(got.filter((r) => r.name === 'sent').length, 1, 'the frame that was too big was not sent');
  });

  test('a rendezvous that cannot be reached: states and back off with the time of each wait, then link-down for the request', async () => {
    const w = makeWorld();
    const { link, got } = bareLink(w);
    w.rdv.refuse = true;
    const pending = link.request('pair-open', { channel: 'abcd', box: { iv: 'x', ct: 'y' } });
    await settle(5);
    for (let i = 0; i < 4; i++) {
      w.advance(BACKOFF_MS[Math.min(i, BACKOFF_MS.length - 1)]);
      await settle(5);
    }
    w.advance(10000);
    assert.deepEqual(await pending, { ok: false, reason: 'link-down' });
    const backoff = got.filter((r) => r.name === 'backoff').map((r) => r.fields);
    assert.deepEqual(backoff.slice(0, 4).map((f) => [f.attempt, f.ms]), [[1, 1000], [2, 2000], [3, 4000], [4, 8000]]);
    assert.ok(backoff.every((f) => f.why === 'error' || f.why === 'closed'));
    assert.ok(got.some((r) => r.name === 'state' && r.fields.state === 'backoff'));
    assert.equal(got.filter((r) => r.name === 'open').length, 0);
    assert.deepEqual(got.filter((r) => r.name === 'reply').map((r) => r.fields).map((f) => [f.action, f.ok, f.reason]), [['pair-open', false, 'link-down']]);
  });

  test('the service that makes its own socket hands it the report of the link options and its own clock, and its own url wins over the options', async () => {
    const w = makeWorld();
    const p = await makePerson('Zelda Quill');
    const linkGot = [];
    const appsGot = [];
    const options = [];
    const apps = createApps({
      api: { identity: new FakeIdentity(p) }, config: { rendezvous: [URL_OK] }, WebSocketImpl: w.rdv.socketClass(), now: w.clock.now,
      setTimeoutFn: w.clock.setTimeout, clearTimeoutFn: w.clock.clearTimeout, random: () => 0.5,
      createLink: (opts) => { options.push(opts); return new PairLink(opts); },
      report: (n, f) => appsGot.push([n, clone(f)]),
      linkOptions: { report: (n, f) => linkGot.push([n, clone(f)]), url: 'wss://not-this-one.invalid/' }
    });
    made.push({ apps });
    const r = await apps.openCode();
    assert.ok(r.code);
    assert.equal(options.length, 1);
    assert.equal(options[0].url, URL_OK, 'the rendezvous of the apps block, not the one of the options');
    assert.equal(typeof options[0].report, 'function');
    assert.equal(typeof options[0].now, 'function');
    assert.deepEqual(linkGot.map(([n]) => n), ['state', 'state', 'open', 'sent', 'reply']);
    assert.deepEqual(appsGot.map(([n]) => n), ['code']);
    // without the options the socket reports nothing
    const bare = createApps({
      api: { identity: new FakeIdentity(await makePerson('Orson Finch')) }, config: { rendezvous: [URL_OK] }, WebSocketImpl: w.rdv.socketClass(), now: w.clock.now,
      setTimeoutFn: w.clock.setTimeout, clearTimeoutFn: w.clock.clearTimeout, random: () => 0.5,
      createLink: (opts) => { options.push(opts); return new PairLink(opts); }
    });
    made.push({ apps: bare });
    assert.ok((await bare.openCode()).code);
    assert.equal(options[1].report, undefined);
  });

  test('reportWord keeps a short slug and turns anything else into "other"', () => {
    for (const ok of ['channel-taken', 'unknown-code', 'link-down', 'pair-open', 'a', 'x'.repeat(48), 'room_open', 'E_POPUP_BLOCKED']) assert.equal(reportWord(ok), ok);
    for (const bad of ['', 'x'.repeat(49), 'two words', 'a.b', 'a/b', '192.168.0.1', 'name@host', null, undefined, '\u00e9t\u00e9']) assert.equal(reportWord(bad), 'other', String(bad));
    assert.equal(reportWord(42), '42');
  });

  test('reasonWord keeps the reasons the project\'s rendezvous gives (every one in deploy/rtc-worker/pair.js, rtc.js and tools/tracker.mjs) and the ones the link adds, and turns any other text into "other"', () => {
    const found = new Set();
    for (const rel of ['deploy/rtc-worker/pair.js', 'deploy/rtc-worker/rtc.js', 'tools/tracker.mjs']) {
      const src = readFileSync(new URL('../../' + rel, import.meta.url), 'utf8');
      for (const m of src.matchAll(/fail\((?:[^()']|\([^()]*\))*,\s*'([^']+)'\)/g)) found.add(m[1]);
      for (const m of src.matchAll(/refuse\('([^']+)'\)/g)) found.add(m[1]);
      for (const m of src.matchAll(/(?:MIXED|MIXED_TEXT) = '([^']+)'/g)) found.add(m[1]);
    }
    // the announce failures of rtc.js are the tracker's, never an answer to a pair frame
    const pairReasons = Array.from(found).filter((r) => !/^not allowed/.test(r) && !/maxPerSocket/.test(r));
    assert.ok(pairReasons.length >= 15, 'the scan found the reasons: ' + pairReasons.join(' | '));
    for (const text of pairReasons) assert.equal(reasonWord(reasonCode(text)), reasonCode(text), 'a reason of the rendezvous the report would call "other": ' + text);
    for (const known of ['link-down', 'closed', 'timeout', 'too-big', 'bad-reply', 'failed']) assert.equal(reasonWord(known), known, 'the link\'s own: ' + known);
    for (const text of ['Ferdle Morrow 203.0.113.5 asked', 'maintenance until 5pm', 'no such room for Bea', 'x'.repeat(60), '', null, undefined, 'unknown code!', 'unknown  code']) {
      assert.equal(reasonWord(reasonCode(text)), text === 'unknown code!' || text === 'unknown  code' ? 'unknown-code' : (text === '' || text === null || text === undefined ? 'failed' : 'other'), String(text));
    }
    for (const word of ['ferdle-morrow-203-0-113-5-asked', 'Unknown-Code', 'unknown code', 'a.b', 'two words', 'x'.repeat(49), 42, {}, []]) assert.equal(reasonWord(word), 'other', String(word));
  });
});

// ---------------------------------------------------------------------------------------------------------------------------------
// A report changes nothing
// ---------------------------------------------------------------------------------------------------------------------------------

describe('a report that throws, or none at all, changes nothing', () => {
  test('two people pair and message while every report throws', async () => {
    const w = makeWorld();
    const A = await person(w, 'Zelda Quill', { throwing: true });
    const B = await person(w, 'Orson Finch', { throwing: true });
    const { code } = await A.apps.openCode();
    assert.ok(code);
    assert.ok((await B.apps.knock(code)).knock);
    await until(() => st(A).requests.length === 1, 'the request');
    assert.ok((await A.apps.accept(st(A).requests[0].knock)).id);
    await until(() => isConnected(A) && isConnected(B), 'both connected');
    await A.apps.send(conv(A).id, TEXT_A);
    await until(() => conv(B).messages.length === 1 && conv(A).messages[0].status === 'delivered', 'delivered');
    await A.apps.leave(conv(A).id);
    assert.equal(st(A).conversations.length, 0);
    assert.equal(A.reports.length, 0);
  });

  test('the same two people with no report option behave the same and nothing is recorded', async () => {
    const w = makeWorld();
    const [A, B] = await Promise.all([w.make('Zelda Quill'), w.make('Orson Finch')]);
    made.push({ apps: A.apps }, { apps: B.apps });
    const { code } = await A.apps.openCode();
    assert.ok((await B.apps.knock(code)).knock);
    await until(() => A.apps.state().requests.length === 1);
    assert.ok((await A.apps.accept(A.apps.state().requests[0].knock)).id);
    await until(() => A.apps.state().conversations[0].status === 'connected' && B.apps.state().conversations[0].status === 'connected');
    assert.equal(A.apps._report, null);
    assert.equal(A.link._report, null);
  });
});

// ---------------------------------------------------------------------------------------------------------------------------------
// The view
// ---------------------------------------------------------------------------------------------------------------------------------

const T0 = Date.UTC(2026, 10, 2, 12, 0, 0);
const ME = { pub: 'p256:me-key-sentinel', short: 'ab23cd45', name: 'Zelda Quill' };
const PEER = { pub: 'p256:peer-key-sentinel', short: 'k3f92xq1', name: 'Orson Finch', nick: 'The Finch' };
const CONV = {
  id: 'c1', peer: PEER, status: 'connected', connectedAt: T0, lastSeenAt: T0, unread: 0, muted: false, pinned: false, archived: false, favorite: false,
  cfg: { exp: null, receipts: true, typing: true }, draft: '', typingPeer: false,
  messages: [{ id: 'm1', t: T0, mine: false, text: 'meet me at the old mill at noon', fmt: 'md1', status: null, edits: [], deleted: false, reactions: {}, pinned: false, saved: false, prio: false }]
};
const ROOM = { id: 'r1', owner: true, status: 'open', code: 'abcdefgh2345', members: [{ pub: ME.pub, short: ME.short, name: ME.name, you: true, owner: true }], messages: [], unread: 0, draft: '' };

const views = [];
afterEach(() => { for (const v of views.splice(0)) { try { v.app.destroy(); } catch (_) { /* gone */ } } });

/** A page: a fake document, the view on a stand-in for the service (FakeApps), and what it reported, in order. */
function view (state = {}, { actions = {}, report = true, reportsHost, lang = 'en', service = {} } = {}) {
  const doc = new FakeDocument();
  const root = doc.createElement('div');
  doc.body.appendChild(root);
  const svc = new FakeApps(Object.assign({ signedIn: true, me: ME, ready: true, link: 'open', code: null }, state));
  Object.assign(svc.results, service);
  const reports = [];
  const acts = Object.assign({ signIn: async () => true, signOut: async () => {}, copy: async () => true }, actions);
  const opts = { root, service: svc, lang, actions: acts, now: () => T0 + 60000 };
  if (report) opts.report = (n, f) => reports.push({ name: n, fields: clone(f) });
  if (reportsHost !== undefined) opts.reportsHost = reportsHost;
  const app = createAppsUi(opts);
  const v = { doc, root, svc, app, reports, acts, names: () => reports.map((r) => r.name), digest: () => reports.map((r) => digestOf(r)), only: (n) => reports.filter((r) => r.name === n).map((r) => r.fields) };
  v.set = async (patch) => { svc.set(patch); await settle(3); };
  views.push(v);
  return v;
}

const attr = (n, a) => (n && n.getAttribute ? n.getAttribute(a) : null);
const shown = (n) => { for (let x = n; x; x = x.parentNode) if (x.hidden === true) return false; return true; };
const byRole = (v, role) => v.app.node.findAll((n) => attr(n, 'data-role') === role && shown(n));
const one = (v, role) => { const l = byRole(v, role); assert.ok(l.length >= 1, 'no visible element with data-role ' + role); return l[0]; };
const click = (n) => n.dispatchEvent({ type: 'click', isTrusted: true });
const tile = (v, key) => v.app.node.findAll((n) => attr(n, 'data-app') === key)[0];
const cardParas = (v) => { const c = byRole(v, 'card')[0]; return c ? c.findAll((n) => n.tagName === 'P').map((n) => n.textContent) : null; };
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('the view reports', () => {
  test('views: the home when it is drawn, then each change, with the local id of a conversation or a room and nothing else', async () => {
    const v = view({ conversations: [CONV], rooms: [ROOM] });
    assert.deepEqual(v.reports, [{ name: 'view', fields: { view: 'home' } }]);
    click(tile(v, 'rooms'));
    click(tile(v, 'messages'));
    v.app.show('conversation', 'c1');
    v.app.show('room', 'r1');
    v.app.back();
    v.app.back();
    v.app.show('home');
    assert.deepEqual(v.only('view'), [
      { view: 'home' }, { view: 'rooms' }, { view: 'messages' }, { view: 'conversation', id: 'c1' }, { view: 'room', id: 'r1' }, { view: 'rooms' }, { view: 'home' }
    ]);
    const text = JSON.stringify(v.reports);
    for (const needle of ['Orson', 'Finch', 'old mill', 'Zelda', 'Quill', 'k3f9', 'p256', 'abcdefgh', '2345']) assert.ok(!text.includes(needle), needle);
  });

  test('a conversation that goes away and a sign-out move the view, and each is told once', async () => {
    const v = view({ conversations: [CONV] });
    v.app.show('conversation', 'c1');
    await v.set({ conversations: [] });
    assert.deepEqual(v.only('view').map((f) => f.view), ['home', 'conversation', 'messages']);
    await v.set({ signedIn: false, me: null });
    assert.deepEqual(v.only('view').map((f) => f.view), ['home', 'conversation', 'messages', 'home']);
    await v.set({ signedIn: false, me: null });
    assert.equal(v.only('view').length, 4, 'nothing changed, nothing is told');
  });

  test('cards: show, continue and cancel with the kind; a card that is left behind is a cancel with the reason', async () => {
    const v = view({ conversations: [CONV] });
    click(tile(v, 'messages'));
    assert.deepEqual(v.only('card'), [{ kind: 'start', ev: 'show' }]);
    click(one(v, 'card-cancel'));
    assert.deepEqual(v.only('card').slice(1), [{ kind: 'start', ev: 'cancel', why: 'user' }]);
    // the code card, then a way out by the back button
    click(one(v, 'code-show'));
    assert.deepEqual(v.only('card').slice(2), [{ kind: 'code', ev: 'show' }]);
    v.app.back();
    assert.deepEqual(v.only('card').slice(3), [{ kind: 'code', ev: 'cancel', why: 'nav' }]);
    // Escape closes a card
    click(tile(v, 'messages'));
    click(one(v, 'code-show'));
    byRole(v, 'card')[0].dispatchEvent({ type: 'keydown', key: 'Escape', isTrusted: true, stopPropagation () {} });
    assert.deepEqual(v.only('card').slice(-2), [{ kind: 'code', ev: 'show' }, { kind: 'code', ev: 'cancel', why: 'user' }]);
    // a confirmation card is a card too, and a yes on it is no first yes
    v.app.show('conversation', 'c1');
    await flush();
    const tools = one(v, 'tools-toggle');
    click(tools);
    click(one(v, 'tool-clear'));
    assert.deepEqual(v.only('card').slice(-1), [{ kind: 'clear', ev: 'show' }]);
    click(one(v, 'card-continue'));
    assert.deepEqual(v.only('card').slice(-1), [{ kind: 'clear', ev: 'continue' }]);
    assert.equal(v.only('first-yes').length, 0);
  });

  test('the first yes: Continue on the start card tells it once, to the report and to every listener, and never again', async () => {
    const calls = [];
    const v = view({ conversations: [CONV] }, { actions: { firstYes: (x) => calls.push(['action', x]) } });
    const off = v.app.onFirstYes((x) => calls.push(['listener', x]));
    assert.equal(typeof off, 'function');
    click(tile(v, 'messages'));
    assert.deepEqual(calls, [], 'a card that is only shown is no yes');
    click(one(v, 'card-continue'));
    await flush();
    assert.deepEqual(v.only('first-yes'), [{ via: 'card' }]);
    assert.deepEqual(calls, [['action', { via: 'card' }], ['listener', { via: 'card' }]]);
    assert.deepEqual(v.only('card').map((f) => f.ev), ['show', 'continue']);
    // another price card (the card to accept a request is always asked): the yes was given already
    await v.set({ requests: [{ knock: 'q1', kind: 'pair', from: { pub: 'p256:x', short: 'abcdefgh', name: 'Nadia Holt' }, at: T0 }] });
    click(byRole(v, 'accept')[0]);
    click(one(v, 'card-continue'));
    await flush();
    assert.deepEqual(v.only('card').slice(-2).map((f) => f.kind + ':' + f.ev), ['accept:show', 'accept:continue']);
    assert.equal(v.only('first-yes').length, 1);
    assert.equal(calls.length, 2);
    // a listener that comes later is told at once; one that was taken off is not told; a listener that throws harms nobody
    const late = [];
    v.app.onFirstYes((x) => late.push(x));
    assert.deepEqual(late, [{ via: 'card' }]);
    v.app.onFirstYes(() => { throw new Error('a listener that breaks'); });
    assert.throws(() => v.app.onFirstYes('not a function'), TypeError);
    const w2 = view({});
    const seen = [];
    const off2 = w2.app.onFirstYes((x) => seen.push(x));
    off2();
    click(tile(w2, 'messages'));
    click(one(w2, 'card-continue'));
    assert.deepEqual(seen, []);
    assert.equal(w2.only('first-yes').length, 1);
  });

  test('"Not now" is no yes; the room cards are a yes like the start card; the card that accepts a request is a card, and no first yes', async () => {
    const v = view({ requests: [{ knock: 'q1', kind: 'pair', from: { pub: 'p256:x', short: 'abcdefgh', name: 'Nadia Holt' }, at: T0 }] });
    click(tile(v, 'messages'));
    click(one(v, 'card-cancel'));
    assert.equal(v.only('first-yes').length, 0);
    const accept = v.app.node.findAll((n) => attr(n, 'data-role') === 'accept' && shown(n))[0];
    click(accept);
    assert.deepEqual(v.only('card').slice(-1), [{ kind: 'accept', ev: 'show' }]);
    click(one(v, 'card-continue'));
    await flush();
    assert.deepEqual(v.only('card').slice(-1), [{ kind: 'accept', ev: 'continue' }]);
    assert.equal(v.only('first-yes').length, 0, 'the accept card does not name the host of the reports, so it is no yes to them');
    const r = view({});
    r.app.show('rooms');
    click(one(r, 'room-create'));
    assert.deepEqual(r.only('card'), [{ kind: 'room-create', ev: 'show' }]);
    click(one(r, 'card-continue'));
    assert.deepEqual(r.only('first-yes'), [{ via: 'card' }]);
  });

  test('sign-in: start, then done; an error with its code; a text that is not a code is just "error"; a sign-in that only ends is no first yes', async () => {
    const v = view({ signedIn: false, me: null }, { actions: { signIn: async () => true } });
    const yesCalls = [];
    v.app.onFirstYes((x) => yesCalls.push(x));
    click(one(v, 'signin'));
    await flush();
    assert.deepEqual(v.only('signin'), [{ step: 'start' }, { step: 'done' }]);
    assert.equal(v.only('first-yes').length, 0, 'the sign-in card is the loader\'s: whether it named the host of the reports is not known here');
    assert.deepEqual(yesCalls, []);
    // the person closed the card
    const c = view({ signedIn: false, me: null }, { actions: { signIn: async () => false } });
    click(one(c, 'signin'));
    await flush();
    assert.deepEqual(c.only('signin'), [{ step: 'start' }, { step: 'error', code: 'not-signed-in' }]);
    assert.equal(c.only('first-yes').length, 0);
    // the window was blocked, with the code of the client; a failure with free text keeps the text out
    for (const [err, code] of [[Object.assign(new Error('the window was blocked'), { code: 'E_POPUP_BLOCKED' }), 'E_POPUP_BLOCKED'],
      [Object.assign(new Error('my passphrase is hunter2'), { code: 'my passphrase is hunter2' }), 'error'], [new Error('secret words in a message'), 'error']]) {
      const e = view({ signedIn: false, me: null }, { actions: { signIn: async () => { throw err; } } });
      click(one(e, 'signin'));
      await flush();
      assert.deepEqual(e.only('signin'), [{ step: 'start' }, { step: 'error', code }]);
      assert.ok(!JSON.stringify(e.reports).includes('hunter2'));
      assert.ok(!JSON.stringify(e.reports).includes('secret words'));
      assert.equal(e.only('first-yes').length, 0);
    }
    // a page that says when the window opened: popup, and the first yes at that moment (once, however often it says so), then done
    const p = view({ signedIn: false, me: null }, { actions: { signIn: async (how) => { how.popup(); how.popup(); return true; } } });
    click(one(p, 'signin'));
    await flush();
    assert.deepEqual(p.digest(), ['view:home', 'signin:start', 'signin:popup', 'first-yes', 'signin:done']);
    // the window opened and the sign-in then failed: the first yes was given at the window, the failure is told with its code
    const q = view({ signedIn: false, me: null }, { actions: { signIn: async (how) => { how.popup(); throw Object.assign(new Error('the window was closed'), { code: 'E_USER_CANCELLED' }); } } });
    click(one(q, 'signin'));
    await flush();
    assert.deepEqual(q.digest(), ['view:home', 'signin:start', 'signin:popup', 'first-yes', 'signin:error']);
    assert.deepEqual(q.only('signin').pop(), { step: 'error', code: 'E_USER_CANCELLED' });
    // the service shows a signed-in person afterwards although the page answered nothing
    const n = view({ signedIn: false, me: null }, { actions: { signIn: async () => { n.svc.set({ signedIn: true, me: ME }); } } });
    click(one(n, 'signin'));
    await flush();
    assert.deepEqual(n.only('signin'), [{ step: 'start' }, { step: 'done' }]);
  });

  test('without the sign-in action the view asks the loader\'s sign-in card and reports its answer the same way', async () => {
    const doc = new FakeDocument();
    const root = doc.createElement('div');
    doc.body.appendChild(root);
    const svc = new FakeApps({ signedIn: false });
    const reports = [];
    const prompts = [];
    const app = createAppsUi({ root, service: svc, ui: { showApps: (n) => root.appendChild(n), hideApps () {}, prompt: async (k, d) => { prompts.push([k, d]); return true; } }, report: (n, f) => reports.push([n, clone(f)]) });
    views.push({ app });
    click(app.node.findAll((n) => attr(n, 'data-role') === 'signin')[0]);
    await flush();
    assert.deepEqual(prompts.map((p) => p[0]), ['signin']);
    assert.deepEqual(reports.filter(([n]) => n === 'signin').map(([, f]) => f), [{ step: 'start' }, { step: 'done' }]);
  });

  test('a report that throws, and a view with no report, behave like the view always did', async () => {
    const v = view({}, { report: false });
    click(tile(v, 'messages'));
    click(one(v, 'card-continue'));
    await flush();
    assert.deepEqual(v.svc.calls.map((c) => c[0]), ['openCode']);
    const t = view({});
    const bad = createAppsUi({
      root: t.root, service: t.svc, actions: t.acts, now: () => T0, report: () => { throw new Error('a report that breaks'); }, reportsHost: () => { throw new Error('a host that breaks'); }
    });
    views.push({ app: bad });
    click(tile({ app: bad }, 'messages'));
    click(bad.node.findAll((n) => attr(n, 'data-role') === 'card-continue')[0]);
    await flush();
    assert.deepEqual(t.svc.calls.map((c) => c[0]), ['openCode']);
  });
});

describe('the click report of the loader (describeTarget) over the controls of this view', () => {
  test('no button or link of a busy view reports what a person wrote: names, nicknames, message previews, quotes, links, saved snippets', async () => {
    const NAME = 'Orson Sentinelname';
    const NICK = 'Nicksentinel';
    const OTHER = 'Nadia Sentinelother';
    const peer = { pub: 'p256:peer-key-sentinel', short: 'k3f92xq1', name: NAME, nick: NICK };
    const m = (over) => Object.assign({ id: 'm1', t: T0, mine: false, text: '', fmt: 'md1', status: null, edits: [], deleted: false, reactions: {}, pinned: false, saved: false, prio: false }, over);
    const conv = Object.assign({}, CONV, {
      peer,
      messages: [
        m({ id: 'm0', mine: true, status: 'sent', text: 'MINEWORDS first of mine' }),
        m({ id: 'm1', text: 'THEIRWORDS see https://LNKSENT.example.test/path', reply: 'm0' })
      ]
    });
    const unnamed = Object.assign({}, CONV, { id: 'c2', peer: { pub: 'p256:peer2-key-sentinel', short: 'zzzz9999', name: NAME, nick: '' }, messages: [m({ id: 'n1', text: 'OTHERWORDS in the second one' })] });
    const room = Object.assign({}, ROOM, {
      id: 'r1', owner: false, status: 'connected', code: null,
      members: [{ pub: 'p256:o', short: 'abcdefgh', name: OTHER, owner: true }, { pub: ME.pub, short: ME.short, name: ME.name, you: true }],
      messages: [{ id: 'g1', t: T0, mine: false, from: { pub: 'p256:o', short: 'abcdefgh', name: OTHER }, text: 'ROOMWORDS from the owner', fmt: 'md1', status: null }]
    });
    const v = view({
      conversations: [conv, unnamed], rooms: [room], snippets: [{ id: 's1', text: 'SNIPSENT saved for later' }],
      requests: [{ knock: 'q1', kind: 'pair', from: { pub: 'p256:x', short: 'abcdefgh', name: OTHER }, at: T0 }, { knock: 'q2', kind: 'room', roomId: 'r1', from: { pub: 'p256:y', short: 'abcdefgh', name: OTHER }, at: T0 }]
    });
    // visit every view and open the panels that hold controls
    v.app.show('messages');
    if (byRole(v, 'card-cancel').length) click(one(v, 'card-cancel'));
    v.app.show('conversation', 'c1');
    await flush();
    click(one(v, 'tools-toggle'));
    click(one(v, 'snippets-toggle'));
    click(byRole(v, 'msg-menu')[0]);
    v.app.show('rooms');
    v.app.show('room', 'r1');
    await flush();
    const controls = v.app.node.findAll((n) => n.tagName === 'BUTTON' || n.tagName === 'A');
    assert.ok(controls.length > 30, 'a busy view: ' + controls.length + ' controls');
    // each sentinel stands at the start of what it belongs to, so the 24 characters that a report may carry would hold it
    const sentinels = ['Sentinelname', 'Nicksentinel', 'Sentinelother', 'MINEWORDS', 'THEIRWORDS', 'OTHERWORDS', 'ROOMWORDS', 'SNIPSENT', 'LNKSENT', 'k3f9', 'zzzz', 'abcd-efgh', 'abcdefgh'];
    // the controls do show those words (otherwise this proves nothing) ...
    for (const w of ['Sentinelname', 'Nicksentinel', 'Sentinelother', 'MINEWORDS', 'THEIRWORDS', 'OTHERWORDS', 'SNIPSENT', 'LNKSENT']) assert.ok(controls.some((n) => n.textContent.includes(w)), 'no control shows ' + w);
    // ... and the click report of none of them carries one
    let withText = 0;
    for (const n of controls) {
      const d = describeTarget(n);
      const text = JSON.stringify(d);
      for (const w of sentinels) assert.ok(!text.includes(w), JSON.stringify(d) + ' for a control that says ' + JSON.stringify(n.textContent.slice(0, 50)));
      if (d.text) withText++;
    }
    assert.ok(withText > 10, 'the buttons that say only what the page says still report their words: ' + withText);
  });
});

describe('the view and the service together, as app.js wires them', () => {
  test('one recorder for both: the card, the first yes, and only then the socket and the code; the first yes is told before anything touches the network', async () => {
    const w = makeWorld();
    const A = await person(w, 'Zelda Quill');
    const doc = new FakeDocument();
    const root = doc.createElement('div');
    doc.body.appendChild(root);
    const atYes = [];
    const app = createAppsUi({
      root, service: A.apps, lang: 'en', now: w.clock.now, reportsHost: 'reports.example.test',
      report: (n, f) => A.reports.push({ name: 'apps.' + n, fields: clone(f) }),
      actions: { copy: async () => true, firstYes: () => atYes.push(A.names().filter((n) => n.startsWith('link.')).length) }
    });
    views.push({ app });
    const v = { app };
    assert.equal(A.link.state, 'idle');
    click(tile(v, 'messages'));
    assert.deepEqual(A.digest(), ['apps.view:home', 'apps.view:messages', 'apps.card:show']);
    assert.ok(cardParas(v).some((t) => t.includes('reports.example.test')), 'the card that is shown before the yes names the host');
    assert.equal(A.link.state, 'idle', 'a card that is only shown opens nothing');
    click(one(v, 'card-continue'));
    await until(() => A.only('apps.code').length === 1, 'the code');
    const d = A.digest();
    assert.deepEqual(d.slice(0, 5), ['apps.view:home', 'apps.view:messages', 'apps.card:show', 'apps.card:continue', 'apps.first-yes']);
    assert.ok(d.indexOf('apps.first-yes') < d.indexOf('link.state:connecting'), d.join(' '));
    assert.deepEqual(atYes, [0], 'when the listener was told the socket had reported nothing');
    assert.deepEqual(A.only('apps.first-yes'), [{ via: 'card' }]);
    assertClean([A], { rdv: w.rdv, forbidden: ['Zelda', 'Quill', A.p.keys.pub, shortIdOf(A.p.keys.pub)] });
  });
});

describe('the line that names the host of the reports', () => {
  const HOST = 'reports.example.test';
  const LINE = (host, lang = 'en') => appsText('apps.price.reports', lang, { host });

  test('the start card shows it, once, after the price and before the buttons, when there is a host', async () => {
    const v = view({}, { reportsHost: HOST });
    click(tile(v, 'messages'));
    const paras = cardParas(v);
    assert.equal(paras.length, 2);
    assert.equal(paras[0], appsText('apps.price.text', 'en'));
    assert.equal(paras[1], LINE(HOST));
    assert.ok(paras[1].includes(HOST));
    assert.deepEqual(v.only('card'), [{ kind: 'start', ev: 'show' }]);
  });

  test('without a host the card is the card it was, in every kind of price card', async () => {
    for (const hostOpt of [undefined, '', '   ', null, () => '', () => null, () => { throw new Error('x'); }, 42]) {
      const v = view({}, { reportsHost: hostOpt });
      click(tile(v, 'messages'));
      assert.deepEqual(cardParas(v), [appsText('apps.price.text', 'en')], String(hostOpt));
    }
    const r = view({}, { reportsHost: undefined });
    r.app.show('rooms');
    click(one(r, 'room-create'));
    assert.deepEqual(cardParas(r), [appsText('apps.price.room', 'en')]);
  });

  test('the host can be a function, asked each time a card opens: a visitor who turned the reports off gets no line', async () => {
    let host = HOST;
    const v = view({}, { reportsHost: () => host });
    click(tile(v, 'messages'));
    assert.equal(cardParas(v).length, 2);
    click(one(v, 'card-cancel'));
    host = '';
    click(one(v, 'code-show'));
    assert.deepEqual(cardParas(v), [appsText('apps.price.text', 'en')]);
  });

  test('the other price cards that can start something carry it; the card for accepting a request does not', async () => {
    const v = view({ requests: [{ knock: 'q1', kind: 'pair', from: { pub: 'p256:x', short: 'abcdefgh', name: 'Nadia Holt' }, at: T0 }] }, { reportsHost: HOST });
    v.app.show('rooms');
    click(one(v, 'room-create'));
    assert.ok(cardParas(v).includes(LINE(HOST)), 'the room card');
    click(one(v, 'card-cancel'));
    v.app.show('messages');
    click(one(v, 'card-cancel'));
    v.app.node.findAll((n) => attr(n, 'data-role') === 'accept' && shown(n)).forEach((b) => click(b));
    const paras = cardParas(v);
    assert.ok(!paras.includes(LINE(HOST)), 'the accept card');
    assert.equal(paras.length, 2, 'the price and the check');
    const k = view({}, { reportsHost: HOST });
    k.app.show('messages');
    click(one(k, 'card-cancel'));
    k.app.node.findAll((n) => attr(n, 'data-role') === 'knock-input')[0].value = 'abcd-efgh-2345';
    click(one(k, 'knock-button'));
    assert.ok(cardParas(k).includes(LINE(HOST)), 'the knock card');
  });

  test('French has the line too, and it names the host', async () => {
    const v = view({}, { reportsHost: HOST, lang: 'fr' });
    click(tile(v, 'messages'));
    const paras = cardParas(v);
    assert.equal(paras[1], LINE(HOST, 'fr'));
    assert.ok(paras[1].includes(HOST));
    assert.notEqual(LINE(HOST, 'fr'), LINE(HOST, 'en'));
  });

  test('the text: usage reports, the host, what is sent and what never is, and that Settings turns it off; both languages, the same placeholder', () => {
    const en = APPS_TEXT.en['apps.price.reports'];
    const fr = APPS_TEXT.fr['apps.price.reports'];
    assert.ok(en && fr);
    assert.deepEqual(en.match(/\{[A-Za-z]+\}/g), ['{host}']);
    assert.deepEqual(fr.match(/\{[A-Za-z]+\}/g), ['{host}']);
    assert.match(en, /usage reports/);
    assert.match(en, /steps, taps and errors/);
    assert.match(en, /never network addresses, names or messages/);
    assert.match(en, /Settings turns them off/);
    assert.match(fr, /rapports d'utilisation/);
    assert.match(fr, /R\u00e9glages/);
    assert.ok(/^[\x00-\x7f]*$/.test(en), 'English is ASCII');
    assert.ok(!/[\u2013\u2014\u2018\u2019\u201c\u201d]/.test(en + fr), 'no dash and no curly quote');
  });
});

// ---------------------------------------------------------------------------------------------------------------------------------
// The sources
// ---------------------------------------------------------------------------------------------------------------------------------

const read = (rel) => readFileSync(new URL('../../' + rel, import.meta.url), 'utf8');

/** Every `_rep('name', { ... })` and `rep('name', { ... })` of a source: the name, the keys of the object and the text of its values. */
function reportCalls (src) {
  const out = [];
  const re = /\b(?:this\._rep|rep)\(\s*'([a-z-]+)'\s*,\s*\{/g;
  let m;
  while ((m = re.exec(src))) {
    let depth = 1;
    let i = re.lastIndex;
    while (i < src.length && depth > 0) {
      if (src[i] === '{') depth++;
      else if (src[i] === '}') depth--;
      i++;
    }
    const body = src.slice(re.lastIndex, i - 1);
    let flat = body.replace(/'(?:[^'\\]|\\.)*'/g, "''");
    for (let prev = null; prev !== flat;) {
      prev = flat;
      flat = flat.replace(/\([^()]*\)|\[[^[\]]*\]|\{[^{}]*\}/g, '');
    }
    out.push({ name: m[1], body, keys: flat.split(',').map((p) => p.split(':')[0].trim()).filter(Boolean) });
  }
  return out;
}

describe('the sources', () => {
  // the fields each report may have: a new one has to be added here on purpose, after asking what it could carry
  const ALLOWED = {
    'src/loader/apps.js': {
      code: 'ev kind why channel', knock: 'ev kind channel reason', request: 'ev kind reason', conv: 'id status reason incoming', room: 'id status reason members',
      wire: 'conv ev kind reason', msg: 'conv status count', notice: 'kind why'
    },
    'src/loader/apps-link.js': {
      state: 'state prev', open: 'attempt', gone: 'why', backoff: 'attempt ms why', sent: 'action', reply: 'action ok reason ms', timeout: 'action ms', push: 'name'
    },
    'src/loader/apps-ui.js': { view: 'view id', card: 'kind ev why', 'first-yes': 'via', signin: 'step code' }
  };
  // what a value must never read from: a text, a nickname, a box, a proof, a key, a secret, a lane, a knock token, a hello, a draft
  const NEVER = /\.(?:text|nick|box|proof|pub|ek|secret|keyCode|codeText|knock|lane|hello|messages|draft|note|iv|ct)\b/;

  for (const [file, names] of Object.entries(ALLOWED)) {
    test(file + ': every report is one of the listed names with only the listed fields, and no value reads a text, a key, a box or a secret', () => {
      const calls = reportCalls(read(file));
      assert.ok(calls.length >= Object.keys(names).length, 'the scan found the calls: ' + calls.length);
      const seen = new Set();
      for (const c of calls) {
        assert.ok(Object.prototype.hasOwnProperty.call(names, c.name), file + ' reports an unlisted name: ' + c.name);
        const allowed = names[c.name].split(' ');
        for (const k of c.keys) assert.ok(allowed.includes(k), file + ' ' + c.name + ' has an unlisted field: ' + k);
        assert.doesNotMatch(c.body, NEVER, file + ' ' + c.name + ': ' + c.body);
        seen.add(c.name);
      }
      for (const n of Object.keys(names)) assert.ok(seen.has(n), file + ' never reports ' + n);
    });
  }

  // the banned words are scanned for in these files by loader-apps.test.mjs (the service and the socket) and loader-apps-ui.test.mjs (the view and the texts)
  test('the three files and this one: no dash and no curly quote, ASCII in the service, the socket and this file, semicolon-free in src/loader', () => {
    for (const file of ['src/loader/apps.js', 'src/loader/apps-link.js', 'src/loader/apps-ui.js']) {
      const src = read(file);
      assert.doesNotMatch(src, /[\u2013\u2014\u2018\u2019\u201c\u201d]/, file);
      assert.deepEqual(src.split('\n').filter((l) => l.trimEnd().endsWith(';')), [], file + ' is semicolon-free');
    }
    for (const file of ['src/loader/apps.js', 'src/loader/apps-link.js']) assert.equal(/[^\x00-\x7f]/.test(read(file)), false, file + ' is ASCII');
    const me = read('test/unit/loader-apps-obs.test.mjs');
    assert.doesNotMatch(me, /[\u2013\u2014\u2018\u2019\u201c\u201d]/, 'this file');
    assert.equal(/[^\x00-\x7f]/.test(me), false, 'this file is ASCII');
  });

  test('the service and the socket never reach for the address, the clock of the machine or a storage API for a report', () => {
    for (const file of ['src/loader/apps.js', 'src/loader/apps-link.js', 'src/loader/apps-ui.js']) {
      const code = read(file).replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '').replace(/\s\/\/ .*$/gm, '');
      assert.doesNotMatch(code, /\b(?:localStorage|sessionStorage|indexedDB|sendBeacon|XMLHttpRequest)\b|\bfetch\(|navigator\.|location\./, file);
    }
  });
});
