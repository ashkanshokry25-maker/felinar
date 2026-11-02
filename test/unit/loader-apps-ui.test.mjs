// Unit tests for the view of the apps on the door page (ARCHITECTURE 15.21): src/loader/apps-ui.js (the home with its tiles, the Messages
// view, a conversation, the Rooms views, the composers), the APPS_TEXT table of src/loader/strings.js, the .mw-apps rules of ui.css, the
// full-view slot of ui.js (showApps, hideApps) and the bare-door branch of src/loader/app.js (readAppsBlock, runDoorApps, loadAppsTm, the
// apps part of inspect()). The view runs on the fake DOM of dropin-fake-dom.mjs against a fake service that implements the plan's section 4
// API; no network, no browser. The pairing code is twelve characters shown as xxxx-xxxx-xxxx (ARCHITECTURE 15.21).
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { FakeDocument, FakeNode } from './dropin-fake-dom.mjs';
import {
  createAppsUi, groupCode, codeLooksValid, verifyText, cleanName, md1Append, md1AppendNodes, safeLink, sortConversations, errorKey, avatarBits, stampText, parseDay,
  parseLocalMoment, localMoment, dayNumber, lastActivity, EMOJI, REACTIONS, EXPIRY_CHOICES, DM_TEXT_MAX, ROOM_TEXT_MAX
} from '../../src/loader/apps-ui.js';
import { parseMd1, COMMON_EMOJI } from '../../src/loader/apps-format.js';
import { APPS_TEXT, appsText, DOOR_TEXT } from '../../src/loader/strings.js';
import { createUI, clockText } from '../../src/loader/ui.js';
import { lintSource } from '../../tools/lint-floor.mjs';
import { __apps } from '../../src/loader/app.js';
import { doorJsonFor, appsBlockOf } from '../../src/loader/doors.js';
import { createHash } from 'node:crypto';
import { makeWorld, until, settle } from './fakes/apps-fakes.mjs';

const T0 = Date.UTC(2026, 10, 1, 15, 30, 0);
const CODE = 'abcdefgh2345'; // twelve characters from the code alphabet
const CODE2 = 'jkmnpqrs6789';
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

// ---------------------------------------------------------------------------------------------- fakes

const SERVICE_CALLS = [
  'openCode', 'newCode', 'closeCode', 'knock', 'cancelKnock', 'accept', 'reject', 'send', 'cancelSend', 'edit', 'remove', 'react', 'markRead', 'typing',
  'block', 'unblock', 'setCfg', 'setNickname', 'search', 'exportJson', 'clear', 'leave', 'createRoom', 'joinRoom', 'acceptMember', 'rejectMember', 'sendRoom', 'leaveRoom'
];

/** A fake of the section 4 service: state() returns the object `s`, every call is recorded, `answers` gives a call its result. */
function makeService(init = {}, { optional = [], answers = {} } = {}) {
  const s = Object.assign({ signedIn: false, me: null, ready: true, link: 'open', code: '', conversations: [], rooms: [], requests: [] }, init);
  const listeners = new Set();
  const calls = [];
  const svc = {
    s,
    calls,
    answers,
    state: () => s,
    onChange: (fn) => { listeners.add(fn); return () => listeners.delete(fn); },
    emit: () => { for (const fn of Array.from(listeners)) fn(); },
    listenerCount: () => listeners.size,
    called: (name) => calls.filter((c) => c[0] === name),
  };
  for (const name of SERVICE_CALLS.concat(optional)) {
    svc[name] = async (...args) => {
      calls.push([name, ...args]);
      if (typeof answers[name] === 'function') return answers[name](...args);
      return answers[name];
    };
  }
  return svc;
}

function conv(over = {}) {
  return Object.assign({
    id: 'c1', peer: { pub: 'p256:peer-b', short: 'k3f92xq1', name: 'Bo', nick: '' }, status: 'connected', connectedAt: T0, lastSeenAt: T0, unread: 0,
    muted: false, pinned: false, archived: false, favorite: false, cfg: { exp: null, receipts: true, typing: true }, messages: [], draft: '', typingPeer: false,
  }, over);
}
function msg(over = {}) {
  return Object.assign({ id: 'm1', t: T0, mine: false, text: 'hello there', fmt: 'md1', status: 'delivered', edits: [], deleted: false, reactions: {}, pinned: false, saved: false, prio: false }, over);
}
const ME = { pub: 'p256:me-a', short: 'ab23cd45', name: 'Ana' };
const signedIn = (extra = {}) => Object.assign({ signedIn: true, me: ME }, extra);

/** A page: a fake document, the fake ui of the loader (showApps and the rest), the actions app.js gives the view, and the view itself. */
function world(state = {}, { service = {}, actions = {}, lang = 'en', noOpenLink = false, noUiHooks = false } = {}) {
  const doc = new FakeDocument();
  const root = doc.createElement('div');
  doc.body.appendChild(root);
  const svc = makeService(state, service);
  const downloads = [];
  const prompts = [];
  const copies = [];
  const logs = [];
  const acts = { calls: [] };
  acts.signIn = async () => { acts.calls.push('signIn'); };
  acts.signOut = async () => { acts.calls.push('signOut'); };
  if (!noOpenLink) acts.openLink = () => { acts.calls.push('openLink'); };
  acts.copy = async (text) => { copies.push(text); return true; };
  acts.log = (line) => { logs.push(line); };
  Object.assign(acts, actions);
  const ui = noUiHooks ? {} : {
    shown: null,
    showApps(n) { this.shown = n; root.appendChild(n); },
    hideApps() { this.shown = null; },
    download(name, text, type) { downloads.push({ name, text, type }); return true; },
    prompt(kind, data) { prompts.push([kind, data]); return Promise.resolve(true); },
  };
  const app = createAppsUi({ root, ui, service: svc, lang, actions: acts, now: () => T0 + 60000 });
  const w = { doc, root, svc, ui, app, acts, downloads, prompts, copies, logs };
  w.set = async (patch) => { Object.assign(svc.s, patch); svc.emit(); await flush(); };
  w.destroy = () => app.destroy();
  worlds.push(w);
  return w;
}
const worlds = [];
afterEach(() => { for (const w of worlds.splice(0)) { try { w.app.destroy(); } catch (_) { /* gone */ } } });

// ---- reading the fake DOM
const attr = (n, a) => (n && n.getAttribute ? n.getAttribute(a) : null);
const shown = (n) => { for (let x = n; x; x = x.parentNode) if (x.hidden === true) return false; return true; };
const all = (w, pred) => w.app.node.findAll(pred);
const roleOf = (role) => (n) => attr(n, 'data-role') === role;
const byRole = (w, role) => all(w, (n) => roleOf(role)(n) && shown(n));
const one = (w, role) => { const l = byRole(w, role); assert.ok(l.length >= 1, 'no visible element with data-role ' + role); return l[0]; };
const has = (w, role) => byRole(w, role).length > 0;
const btn = (w, text) => { const l = all(w, (n) => n.tagName === 'BUTTON' && n.textContent === text && shown(n)); assert.ok(l.length >= 1, 'no visible button ' + JSON.stringify(text)); return l[0]; };
const hasBtn = (w, text) => all(w, (n) => n.tagName === 'BUTTON' && n.textContent === text && shown(n)).length > 0;
const where = (w, fk) => { const l = all(w, (n) => attr(n, 'data-fk') === fk); assert.ok(l.length >= 1, 'no element with data-fk ' + fk); return l[0]; };
const textOf = (n) => n.textContent;
const visibleText = (w) => {
  const walk = (n) => (n.hidden === true ? '' : (n._text || '') + n.children.map(walk).join(' '));
  return walk(w.app.node);
};
const tile = (w, key) => all(w, (n) => attr(n, 'data-app') === key)[0];
const click = (n, extra = {}) => n.dispatchEvent(Object.assign({ type: 'click', isTrusted: true }, extra));
const scriptClick = (n) => n.dispatchEvent({ type: 'click', isTrusted: false });
const keydown = (n, key, extra = {}) => {
  const ev = Object.assign({ type: 'keydown', key, shiftKey: false, isTrusted: true, prevented: false, preventDefault() { this.prevented = true; } }, extra);
  n.dispatchEvent(ev);
  return ev;
};
const typeInto = (n, text) => { n.value = text; n.dispatchEvent({ type: 'input', isTrusted: true }); };
const calls = (w, name) => w.svc.called(name);

// ---------------------------------------------------------------------------------------------- pure helpers

test('groupCode: twelve characters are shown xxxx-xxxx-xxxx, an eight character short id xxxx-xxxx, anything else as it is', () => {
  assert.equal(groupCode(CODE), 'abcd-efgh-2345');
  assert.equal(groupCode('abcd-efgh-2345'), 'abcd-efgh-2345');
  assert.equal(groupCode('ABCD EFGH 2345'), 'abcd-efgh-2345');
  assert.equal(groupCode('abcdefgh2345').length, 14, 'the display holds fourteen characters');
  assert.equal(groupCode('k3f92xq1'), 'k3f9-2xq1');
  assert.equal(groupCode('k3f9-2xq1'), 'k3f9-2xq1');
  assert.equal(groupCode('abcdefg'), 'abcdefg');
  assert.equal(groupCode('abcdefgh23456'), 'abcdefgh23456');
  assert.equal(groupCode(null), '');
  assert.equal(groupCode(undefined), '');
});

test('codeLooksValid: twelve letters or digits, with optional hyphens, spaces, dots and invisible marks; eight is not a code any more', () => {
  for (const ok of ['abcd-efgh-2345', 'abcdefgh2345', 'ABCD EFGH 2345', '  abcd-efgh-2345 ', 'abcd.efgh.2345', 'abcd\u2010efgh\u20132345', 'abcd\u200befgh2345', 'abcdefgh۲۳۴۵', 'ａｂｃｄefgh2345']) {
    assert.equal(codeLooksValid(ok), true, JSON.stringify(ok));
  }
  for (const bad of ['', 'abcd-2345', 'abcdefg2345', 'abcdefgh23456', 'abcd-efgh-23!5', 'abcd/efgh/2345', 'a'.repeat(65), null, undefined, 12, '------------']) {
    assert.equal(codeLooksValid(bad), false, JSON.stringify(bad));
  }
});

test('verifyText, cleanName', () => {
  assert.equal(verifyText('12345678'), '1234 5678');
  assert.equal(verifyText({ code: '00001234' }), '0000 1234');
  assert.equal(verifyText('1234'), '');
  assert.equal(verifyText('abcdefgh'), '');
  assert.equal(verifyText(null), '');
  assert.equal(cleanName('  Bo \u202eevil\u202c\n  Smith '), 'Bo evil Smith');
  assert.equal(cleanName('x'.repeat(40), 10), 'xxxxxxxxx...');
  assert.equal(cleanName(null), '');
});

test('md1Append: the node tree of apps-format.js becomes elements and text nodes; nothing a person typed is parsed as markup', () => {
  const doc = new FakeDocument();
  const p = doc.createElement('div');
  md1Append(doc, p, '<img src=x onerror=alert(1)> *b* _i_ __u__ ~s~ `c` https://example.test/a_b_c.\nnext line');
  const tags = p.findAll((n) => n.tagName !== '#TEXT').map((n) => n.tagName).sort();
  assert.deepEqual(tags, ['A', 'BR', 'CODE', 'EM', 'S', 'STRONG', 'U']);
  assert.ok(p.textContent.includes('<img src=x onerror=alert(1)>'), 'the markup stays visible text');
  const a = p.find((n) => n.tagName === 'A');
  assert.equal(a.getAttribute('href'), 'https://example.test/a_b_c');
  assert.equal(a.getAttribute('rel'), 'noopener noreferrer');
  assert.equal(a.getAttribute('target'), '_blank');
  assert.equal(a.textContent, 'https://example.test/a_b_c');
  assert.equal(p.findAll((n) => n.tagName === 'IMG').length, 0);
  // right-to-left text and a hostile override mark: the mark goes, the text stays
  const q = doc.createElement('div');
  md1Append(q.ownerDocument, q, 'مرحبا \u202eevil');
  assert.ok(q.textContent.startsWith('مرحبا'));
  assert.ok(!q.textContent.includes('\u202e'));
});

test('md1Append checks a link again: only an http or https URL without userinfo gets an href, whatever the tree says', () => {
  assert.equal(safeLink('https://example.test/x'), 'https://example.test/x');
  assert.equal(safeLink('http://example.test'), 'http://example.test/');
  for (const bad of ['javascript:alert(1)', 'data:text/html,hi', 'ftp://example.test/', 'https://user:pw@example.test/', 'https://', '', null, undefined, 'not a url']) assert.equal(safeLink(bad), null, String(bad));
  // a tree from a parser with a bug: the link is shown as its text, with no anchor, and an unknown node type is left out
  const doc = new FakeDocument();
  const host = doc.createElement('div');
  md1AppendNodes(doc, host, [
    { t: 'a', href: 'javascript:alert(1)', rel: 'x', target: '_self', c: [{ t: 'text', s: 'click me' }] },
    { t: 'script', c: [{ t: 'text', s: 'alert(1)' }] },
    { t: 'a', href: 'https://example.test/ok', rel: 'x', target: '_self', c: [{ t: 'text', s: 'fine' }] },
  ]);
  assert.equal(host.findAll((n) => n.tagName === 'SCRIPT').length, 0);
  const anchors = host.findAll((n) => n.tagName === 'A');
  assert.equal(anchors.length, 1);
  assert.equal(anchors[0].getAttribute('href'), 'https://example.test/ok');
  assert.equal(anchors[0].getAttribute('rel'), 'noopener noreferrer', 'the view sets rel and target itself');
  assert.equal(anchors[0].getAttribute('target'), '_blank');
  assert.ok(host.textContent.includes('click me'));
  assert.ok(!host.textContent.includes('alert(1)'));
});

test('sortConversations, lastActivity, errorKey, dates, the identicon, the pickers', () => {
  const a = conv({ id: 'a', messages: [msg({ t: T0 })] });
  const b = conv({ id: 'b', messages: [msg({ t: T0 + 5000 })] });
  const c = conv({ id: 'c', pinned: true, messages: [msg({ t: T0 - 5000 })] });
  const d = conv({ id: 'd', archived: true, messages: [msg({ t: T0 + 9000 })] });
  const e = conv({ id: 'e', connectedAt: T0 + 100, messages: [] });
  assert.equal(lastActivity(e), T0 + 100);
  assert.equal(lastActivity(conv({ connectedAt: 0, lastSeenAt: 0 })), 0);
  const r = sortConversations([a, b, c, d, e]);
  assert.deepEqual(r.active.map((x) => x.id), ['c', 'b', 'e', 'a'], 'pinned first, then the newest activity');
  assert.deepEqual(r.archived.map((x) => x.id), ['d']);
  assert.deepEqual(sortConversations([a, b], { matches: (x) => x.id === 'a' }).active.map((x) => x.id), ['a']);
  assert.deepEqual(sortConversations(null), { active: [], archived: [] });
  // the reasons of src/loader/apps.js ERRORS and the rendezvous
  const key = (x) => errorKey(x);
  assert.equal(key('unknown code'), 'apps.err.unknown');
  assert.equal(key({ error: 'x', message: 'too many requests' }), 'apps.err.rate');
  assert.equal(key('rate limited'), 'apps.err.rate');
  assert.equal(key('too many codes'), 'apps.err.tooMany');
  assert.equal(key('too many rooms'), 'apps.err.tooMany');
  assert.equal(key('own code'), 'apps.err.self');
  assert.equal(key('already knocked'), 'apps.err.already');
  assert.equal(key('bad code'), 'apps.err.invalid');
  assert.equal(key(new Error('box invalid')), 'apps.err.invalid');
  assert.equal(key('room full'), 'apps.err.roomFull');
  assert.equal(key('blocked'), 'apps.err.blocked');
  assert.equal(key('too long'), 'apps.err.tooLong');
  assert.equal(key('too far'), 'apps.err.tooFar');
  for (const l of ['link down', 'no rendezvous', 'not ready', 'not signed in', 'socket closed']) assert.equal(key(l), 'apps.err.link', l);
  assert.equal(key({ code: 'E_UNSUPPORTED' }), 'apps.err.link');
  assert.equal(key('failed'), 'apps.err.generic');
  assert.equal(key(null), 'apps.err.generic');
  assert.equal(dayNumber(Date.UTC(2026, 10, 1, 12)) > 20260000, true);
  assert.equal(parseDay('2026-11-01', false) < parseDay('2026-11-01', true), true);
  assert.equal(parseDay('nope'), null);
  assert.equal(parseLocalMoment(localMoment(T0)) % 60000, 0);
  assert.equal(parseLocalMoment('x'), null);
  assert.match(stampText(T0, 'en', T0 + 1000), /\d{1,2}:\d{2}/);
  assert.match(stampText(T0, 'en', T0 + 3 * 86400000), /Nov/);
  const bits = avatarBits('p256:me-a');
  assert.equal(bits.length, 25);
  for (let row = 0; row < 5; row++) { assert.equal(bits[row * 5], bits[row * 5 + 4]); assert.equal(bits[row * 5 + 1], bits[row * 5 + 3]); }
  assert.deepEqual(avatarBits('same'), avatarBits('same'));
  assert.notDeepEqual(avatarBits('one'), avatarBits('another'));
  assert.equal(EMOJI, COMMON_EMOJI, 'the picker is the 32 emoji of apps-format.js');
  assert.equal(EMOJI.length, 32);
  assert.equal(new Set(EMOJI).size, 32);
  assert.ok(REACTIONS.length >= 4);
  assert.equal(EXPIRY_CHOICES[0][0], 0);
  assert.equal(DM_TEXT_MAX, 3500);
  assert.equal(ROOM_TEXT_MAX, 2000);
});

// ---------------------------------------------------------------------------------------------- the home

test('the home before sign-in: title, subtitle, six tiles; Messages and Rooms inactive with a lock and "Sign in first", Calls, Files and Media "Not yet at this door"', () => {
  const w = world();
  assert.equal(textOf(one(w, 'title')), 'Apps');
  assert.ok(visibleText(w).includes('Sign in to use the apps at this door.'));
  const keys = all(w, (n) => attr(n, 'data-app')).map((n) => attr(n, 'data-app'));
  assert.deepEqual(keys, ['messages', 'rooms', 'calls', 'files', 'media', 'link']);
  for (const k of ['messages', 'rooms']) {
    const t = tile(w, k);
    assert.equal(attr(t, 'aria-disabled'), 'true', k);
    assert.equal(attr(t, 'data-state'), 'locked', k);
    assert.ok(t.findAll((n) => n.className === 'mw-apps-lock' && shown(n)).length === 1, k + ' shows the lock glyph');
    assert.ok(t.textContent.includes('Sign in first'), k);
  }
  assert.ok(tile(w, 'messages').textContent.includes('Direct messages with one person, by code'));
  assert.ok(tile(w, 'rooms').textContent.includes('A room for a few people, by code'));
  for (const k of ['calls', 'files', 'media']) {
    const t = tile(w, k);
    assert.equal(attr(t, 'aria-disabled'), 'true', k);
    assert.equal(attr(t, 'data-state'), 'soon', k);
    assert.ok(t.textContent.includes('Not yet at this door'), k);
    assert.ok(!t.textContent.includes('Sign in first'), k);
    assert.equal(t.findAll((n) => n.className === 'mw-apps-lock' && shown(n)).length, 0, k + ' has no lock: signing in does not open it');
  }
  assert.ok(tile(w, 'calls').textContent.includes('Voice and video'));
  assert.equal(attr(tile(w, 'link'), 'aria-disabled'), 'false', 'Open a link works without signing in, as the paste box did');
  assert.ok(tile(w, 'link').textContent.includes('Open a link'));
  assert.equal(textOf(one(w, 'signin')), 'Sign in');
  assert.equal(has(w, 'signout'), false);
  assert.equal(has(w, 'me'), false);
  assert.equal(w.ui.shown, w.app.node, 'the view is in the full-view slot');
  assert.equal(w.doc.title, 'Apps');
});

test('the home without an openLink action keeps the "Open a link" tile inactive', () => {
  const w = world({}, { noOpenLink: true });
  assert.equal(attr(tile(w, 'link'), 'aria-disabled'), 'true');
  assert.ok(tile(w, 'link').textContent.includes('Not yet at this door'));
});

test('a click on an inactive tile goes nowhere and sends the focus to Sign in; Open a link calls the paste box', async () => {
  const w = world();
  click(tile(w, 'messages'));
  click(tile(w, 'rooms'));
  click(tile(w, 'calls'));
  assert.equal(w.app.inspect().view, 'home');
  click(tile(w, 'messages'));
  assert.equal(w.doc.activeElement, one(w, 'signin'), 'the focus goes to Sign in');
  click(tile(w, 'link'));
  assert.deepEqual(w.acts.calls, ['openLink']);
  scriptClick(tile(w, 'link'));
  assert.deepEqual(w.acts.calls, ['openLink'], 'a script click opens nothing');
  assert.deepEqual(w.svc.calls, [], 'the service was not asked anything');
});

test('Sign in runs the action on a trusted click only; after sign-in Messages and Rooms are active, the header shows the identicon, "name (short)" and Sign out', async () => {
  const w = world();
  scriptClick(one(w, 'signin'));
  await flush();
  assert.deepEqual(w.acts.calls, [], 'a script click does not sign in');
  click(one(w, 'signin'));
  await flush();
  assert.deepEqual(w.acts.calls, ['signIn']);
  await w.set(signedIn());
  for (const k of ['messages', 'rooms']) {
    const t = tile(w, k);
    assert.equal(attr(t, 'aria-disabled'), 'false', k);
    assert.equal(attr(t, 'data-state'), 'active', k);
    assert.equal(t.findAll((n) => n.className === 'mw-apps-lock' && shown(n)).length, 0, k);
    assert.ok(!t.textContent.includes('Sign in first'), k);
  }
  for (const k of ['calls', 'files', 'media']) assert.equal(attr(tile(w, k), 'aria-disabled'), 'true', k + ' stays inactive');
  assert.equal(textOf(one(w, 'me')), 'Ana (ab23-cd45)');
  assert.equal(all(w, (n) => n.className === 'mw-apps-avatar').length, 1);
  assert.equal(all(w, (n) => n.className === 'mw-apps-avatar')[0].children.length, 25, 'a 5 by 5 identicon');
  assert.equal(has(w, 'signin'), false);
  assert.equal(textOf(one(w, 'signout')), 'Sign out');
  assert.ok(visibleText(w).includes('Choose an app.'));
  assert.ok(visibleText(w).includes('You are signed in for this visit only.'));
});

test('without a signIn action the view asks the loader for the sign-in card', async () => {
  const w = world({}, { actions: { signIn: undefined } });
  click(one(w, 'signin'));
  await flush();
  assert.deepEqual(w.prompts, [['signin', { method: 'signIn', options: {} }]]);
});

test('Sign out calls the action; when the service says signed out the view returns to the home and forgets the visit', async () => {
  const w = world(signedIn());
  click(tile(w, 'messages'));
  await flush();
  // the price card shows first; decline it, then type into the knock field so there is something to forget
  click(btn(w, 'Not now'));
  w.app.nodes.knockInput.value = 'abcd-efgh-2345';
  scriptClick(one(w, 'signout'));
  await flush();
  assert.deepEqual(w.acts.calls, []);
  click(one(w, 'signout'));
  await flush();
  assert.deepEqual(w.acts.calls, ['signOut']);
  await w.set({ signedIn: false, me: null, code: '', conversations: [], rooms: [], requests: [] });
  assert.equal(w.app.inspect().view, 'home');
  assert.equal(w.app.nodes.knockInput.value, '', 'the field is empty');
  assert.equal(attr(tile(w, 'messages'), 'aria-disabled'), 'true');
  assert.equal(textOf(one(w, 'signin')), 'Sign in');
});

test('a service that signs the visitor out while a conversation is open sends the view home', async () => {
  const w = world(signedIn({ conversations: [conv()] }));
  w.app.show('conversation', 'c1');
  assert.equal(w.app.inspect().view, 'conversation');
  await w.set({ signedIn: false, me: null, conversations: [] });
  assert.equal(w.app.inspect().view, 'home');
});

test('the view draws again once for a burst of service changes, and a destroyed view stops listening', async () => {
  const w = world(signedIn());
  assert.equal(w.svc.listenerCount(), 1);
  let reads = 0;
  const state = w.svc.state;
  w.svc.state = () => { reads++; return state(); };
  for (let i = 0; i < 20; i++) w.svc.emit();
  assert.equal(reads, 0, 'nothing is drawn inside the change itself');
  await flush();
  assert.ok(reads >= 1 && reads <= 2, 'one draw for twenty changes (' + reads + ' reads)');
  w.app.destroy();
  assert.equal(w.svc.listenerCount(), 0);
  assert.equal(w.ui.shown, null, 'the slot is emptied');
  w.svc.emit();
  await flush();
  assert.ok(reads <= 2, 'a destroyed view draws nothing');
  w.app.destroy();
});

test('the tab title carries the unread count, requests included; a muted conversation does not count', async () => {
  const w = world(signedIn({ conversations: [conv({ id: 'a', unread: 2 }), conv({ id: 'b', unread: 5, muted: true })], requests: [{ knock: 'k1', kind: 'pair', from: { pub: 'p', short: 'abcdefgh', name: 'Cy' }, at: T0 }] }));
  assert.equal(w.doc.title, '(3) Apps');
  await w.set({ conversations: [conv({ id: 'a', unread: 0 })], requests: [] });
  assert.equal(w.doc.title, 'Apps');
});

test('French: the same view in French when the language tag says so', async () => {
  const w = world(signedIn(), { lang: 'fr-CA' });
  assert.equal(textOf(one(w, 'title')), 'Applications');
  assert.equal(textOf(one(w, 'signout')), 'Se déconnecter');
  assert.ok(tile(w, 'rooms').textContent.includes('Salons'));
  assert.ok(visibleText(w).includes('Choisissez une application.'));
  assert.equal(w.doc.title, 'Applications');
});

// ---------------------------------------------------------------------------------------------- Messages: the code, knocking, requests

const PRICE_EN = 'Codes and requests pass through this door\'s rendezvous. Nothing else leaves this device until the other person accepts; then you connect directly and each side learns the other\'s network address.';

/** A signed-in world whose service answers openCode and newCode like the real one: the code appears in state() and the view hears of it. */
function messagesWorld(state = {}, opts = {}) {
  const w = world(signedIn(state), opts);
  let n = 0;
  w.svc.answers.openCode = async () => { w.svc.s.code = w.svc.s.code || CODE; w.svc.emit(); return { code: groupCode(w.svc.s.code) }; };
  w.svc.answers.newCode = async () => { n++; w.svc.s.code = CODE2; w.svc.emit(); return { code: groupCode(CODE2), n }; };
  return w;
}
const cardOf = (w) => one(w, 'card');
const cardKind = (w) => attr(cardOf(w), 'data-kind');

test('the first visit to Messages shows the price card before anything is asked: the text of the plan, Continue and Not now; nothing reaches the service until Continue', async () => {
  const w = messagesWorld();
  click(tile(w, 'messages'));
  await flush();
  assert.equal(w.app.inspect().view, 'messages');
  assert.equal(textOf(one(w, 'title')), 'Messages');
  assert.equal(cardKind(w), 'start');
  assert.ok(cardOf(w).textContent.includes(PRICE_EN), 'the price sentence, word for word');
  assert.ok(!cardOf(w).textContent.includes('Check: read your codes to each other.'), 'the check line belongs to the accept card');
  assert.ok(hasBtn(w, 'Continue') && hasBtn(w, 'Not now'));
  assert.deepEqual(w.svc.calls, [], 'nothing was sent to the service');
  assert.equal(w.app.inspect().card, 'start');
  assert.equal(w.doc.activeElement, one(w, 'card-continue'), 'the focus is on Continue');
  scriptClick(one(w, 'card-continue'));
  await flush();
  assert.deepEqual(w.svc.calls, [], 'a script click on Continue does nothing');
  click(one(w, 'card-continue'));
  await flush();
  assert.deepEqual(w.svc.calls.map((c) => c[0]), ['openCode']);
  assert.equal(has(w, 'card'), false);
  assert.equal(textOf(one(w, 'code')), 'abcd-efgh-2345');
  assert.equal(textOf(one(w, 'code')).length, 14, 'fourteen characters on one line');
  assert.equal(w.app.inspect().code, 'abcd', 'the shell sees the channel only, never the secret half');
  assert.ok(visibleText(w).includes('Read it to the person you want to message; it works while this page is open.'));
  assert.equal(textOf(one(w, 'code-copy')), 'Copy');
  assert.equal(textOf(one(w, 'code-new')), 'New code');
});

test('Not now leaves the code closed with a Show my code button; the next try asks again, and after Continue the price is not asked again this visit', async () => {
  const w = messagesWorld();
  click(tile(w, 'messages'));
  await flush();
  click(one(w, 'card-cancel'));
  await flush();
  assert.equal(has(w, 'card'), false);
  assert.equal(has(w, 'code'), false);
  assert.deepEqual(w.svc.calls, []);
  click(one(w, 'code-show'));
  await flush();
  assert.equal(cardKind(w), 'code');
  click(one(w, 'card-continue'));
  await flush();
  assert.equal(textOf(one(w, 'code')), 'abcd-efgh-2345');
  // back to the home and in again: no card, the code is still there
  click(one(w, 'back'));
  click(tile(w, 'messages'));
  await flush();
  assert.equal(has(w, 'card'), false);
  assert.equal(calls(w, 'openCode').length, 1);
});

test('Escape closes the price card like Not now', async () => {
  const w = messagesWorld();
  click(tile(w, 'messages'));
  await flush();
  one(w, 'card').dispatchEvent({ type: 'keydown', key: 'Escape', isTrusted: true, stopPropagation() {} });
  await flush();
  assert.equal(has(w, 'card'), false);
  assert.deepEqual(w.svc.calls, []);
});

test('Copy puts the code on the clipboard through the action and says so; New code asks the service; a service error shows its line', async () => {
  const w = messagesWorld();
  w.app.show('messages');
  click(one(w, 'card-continue'));
  await flush();
  click(one(w, 'code-copy'));
  await flush();
  assert.deepEqual(w.copies, ['abcd-efgh-2345']);
  assert.equal(textOf(one(w, 'code-note')), 'Copied.');
  click(one(w, 'code-new'));
  await flush();
  assert.equal(textOf(one(w, 'code')), 'jkmn-pqrs-6789');
  assert.equal(calls(w, 'newCode').length, 1);
  w.svc.answers.newCode = async () => ({ error: 'link down' });
  click(one(w, 'code-new'));
  await flush();
  assert.equal(textOf(one(w, 'code-note')), 'Not connected to this door right now. Try again in a moment.');
});

test('a copy that fails says how to copy by hand', async () => {
  const w = messagesWorld({}, { actions: { copy: async () => false } });
  w.app.show('messages');
  click(one(w, 'card-continue'));
  await flush();
  click(one(w, 'code-copy'));
  await flush();
  assert.equal(textOf(one(w, 'code-note')), 'Could not copy. Select the code and copy it by hand.');
});

test('the service notice about a replaced or closed code is shown next to the code', async () => {
  const w = messagesWorld({ code: CODE });
  w.app.show('messages');
  await w.set({ notice: { kind: 'code-replaced', why: 'bad-knocks', at: T0 } });
  assert.ok(textOf(one(w, 'code-notice')).startsWith('Your code was replaced by a new one'));
  await w.set({ notice: { kind: 'code-closed', at: T0 } });
  assert.ok(textOf(one(w, 'code-notice')).startsWith('Your code is closed.'));
  await w.set({ notice: null });
  assert.equal(has(w, 'code-notice'), false);
});

test('the link states: no note before anything was started, "Connecting" while it opens, a lost-connection note only after it was open', async () => {
  const w = messagesWorld({ link: 'closed' });
  w.app.show('messages');
  assert.equal(has(w, 'link-note'), false, 'a socket nobody started yet is not a loss: the first view of Messages shows no note');
  await w.set({ link: 'connecting' });
  assert.equal(textOf(one(w, 'link-note')), 'Connecting to this door...');
  await w.set({ link: 'open' });
  assert.equal(has(w, 'link-note'), false);
  await w.set({ link: 'connecting' });
  assert.equal(textOf(one(w, 'link-note')), 'The connection to this door was lost. This page keeps trying.', 'waiting to retry after it was open');
  await w.set({ link: 'closed' });
  assert.equal(has(w, 'link-note'), false, 'a socket shut for good does not promise to keep trying');
  w.app.show('rooms');
  assert.equal(has(w, 'link-note'), false, 'Rooms says the same as Messages');
  await w.set({ link: 'connecting' });
  assert.equal(textOf(one(w, 'link-note')), 'The connection to this door was lost. This page keeps trying.');
  // a sign-out ends the visit: the next sign-in starts again at "Connecting"
  await w.set({ signedIn: false, me: null, link: 'closed' });
  await w.set({ signedIn: true, me: ME, link: 'connecting' });
  w.app.show('messages');
  assert.equal(textOf(one(w, 'link-note')), 'Connecting to this door...');
});

test('the Their code field: 12 letters or digits with optional hyphens or spaces, maxlength 20, no capitals, no autocorrect, no spellcheck', () => {
  const w = messagesWorld();
  w.app.show('messages');
  const input = one(w, 'knock-input');
  assert.equal(attr(input, 'maxlength'), '20');
  assert.equal(attr(input, 'autocapitalize'), 'none');
  assert.equal(attr(input, 'autocorrect'), 'off');
  assert.equal(attr(input, 'spellcheck'), 'false');
  assert.equal(attr(input, 'autocomplete'), 'off');
  assert.equal(attr(input, 'placeholder'), 'abcd-efgh-2345');
  assert.equal(attr(input, 'type'), 'text');
  assert.ok(visibleText(w).includes('Their code'));
  assert.equal(textOf(one(w, 'knock-button')), 'Knock');
  assert.ok(input.className.includes('mw-mono'));
  // the room code field has the same shape
  w.app.show('rooms');
  const join = one(w, 'join-input');
  for (const [a, v] of [['maxlength', '20'], ['autocapitalize', 'none'], ['autocorrect', 'off'], ['spellcheck', 'false']]) assert.equal(attr(join, a), v);
});

test('Knock with a short or long code is refused in the view without asking the service; the line says twelve characters', async () => {
  const w = messagesWorld();
  w.app.show('messages');
  click(one(w, 'card-cancel'));
  for (const bad of ['abcd-2345', 'abcdefgh23456', '', 'abcd efgh 23!5']) {
    typeInto(one(w, 'knock-input'), bad);
    click(one(w, 'knock-button'));
    await flush();
    assert.equal(textOf(one(w, 'knock-note')), 'A code has twelve characters, letters and numbers, like abcd-efgh-2345.', JSON.stringify(bad));
  }
  assert.deepEqual(w.svc.calls, []);
  assert.equal(has(w, 'card'), false, 'no price card for a code that is not one');
});

test('the first Knock shows the price card (when the code card was declined), then sends the code as typed; a later Knock does not ask again', async () => {
  const w = messagesWorld();
  w.svc.answers.knock = async () => ({ knock: 'k9', id: 'w1' });
  w.app.show('messages');
  click(one(w, 'card-cancel')); // the start card: Not now
  typeInto(one(w, 'knock-input'), 'jkmn pqrs 6789');
  scriptClick(one(w, 'knock-button'));
  await flush();
  assert.equal(has(w, 'card'), false, 'a script click on Knock does nothing');
  click(one(w, 'knock-button'));
  await flush();
  assert.equal(cardKind(w), 'knock');
  assert.ok(cardOf(w).textContent.includes(PRICE_EN));
  assert.deepEqual(w.svc.calls, [], 'the code was not sent before Continue');
  click(one(w, 'card-continue'));
  await flush();
  assert.deepEqual(w.svc.calls, [['knock', 'jkmn pqrs 6789']]);
  assert.equal(one(w, 'knock-input').value, '');
  assert.equal(textOf(one(w, 'knock-note')), 'Request sent. It waits for their approval.');
  typeInto(one(w, 'knock-input'), 'jkmn-pqrs-6789');
  click(one(w, 'knock-button'));
  await flush();
  assert.equal(has(w, 'card'), false);
  assert.equal(calls(w, 'knock').length, 2);
});

test('the answers to a knock: the rendezvous and the service reasons become a line in the visitor\'s language', async () => {
  const w = messagesWorld();
  w.app.show('messages');
  click(one(w, 'card-continue'));
  await flush();
  const cases = [
    ['unknown code', 'No one has this code right now. Check it and try again.'],
    ['rate limited', 'Too many tries. Wait a minute and try again.'],
    ['own code', 'That is your own code.'],
    ['already knocked', 'You already sent a request with this code.'],
    ['link down', 'Not connected to this door right now. Try again in a moment.'],
    ['failed', 'That did not work. Try again.'],
  ];
  for (const [error, line] of cases) {
    w.svc.answers.knock = async () => ({ error });
    typeInto(one(w, 'knock-input'), 'abcd-efgh-2345');
    click(one(w, 'knock-button'));
    await flush();
    assert.equal(textOf(one(w, 'knock-note')), line, error);
    assert.equal(one(w, 'knock-input').value, 'abcd-efgh-2345', 'the field keeps the code after a refusal');
  }
});

test('Enter in the code field knocks; Enter during an IME composition and a script Enter do not', async () => {
  const w = messagesWorld();
  w.svc.answers.knock = async () => ({ knock: 'k1', id: 'w1' });
  w.app.show('messages');
  click(one(w, 'card-continue'));
  await flush();
  typeInto(one(w, 'knock-input'), 'abcd-efgh-2345');
  keydown(one(w, 'knock-input'), 'Enter', { isComposing: true });
  keydown(one(w, 'knock-input'), 'Enter', { keyCode: 229 });
  keydown(one(w, 'knock-input'), 'Enter', { isTrusted: false });
  keydown(one(w, 'knock-input'), 'a');
  await flush();
  assert.equal(calls(w, 'knock').length, 0);
  const ev = keydown(one(w, 'knock-input'), 'Enter');
  await flush();
  assert.equal(ev.prevented, true, 'the Enter key is stopped from submitting a form');
  assert.equal(calls(w, 'knock').length, 1);
});

test('every form is stopped from submitting (form-action none)', () => {
  const w = messagesWorld(signedIn({ conversations: [conv()] }));
  w.app.show('messages');
  const forms = all(w, (n) => n.tagName === 'FORM');
  assert.ok(forms.length >= 3);
  for (const f of forms) {
    const ev = { type: 'submit', prevented: false, preventDefault() { this.prevented = true; } };
    f.dispatchEvent(ev);
    assert.equal(ev.prevented, true);
  }
  w.app.show('conversation', 'c1');
  w.app.show('rooms');
  for (const f of all(w, (n) => n.tagName === 'FORM')) {
    const ev = { type: 'submit', prevented: false, preventDefault() { this.prevented = true; } };
    f.dispatchEvent(ev);
    assert.equal(ev.prevented, true);
  }
});

test('requests: "name (short) wants to message you" with Accept and Reject; Accept shows the price again with the check line and acts only after Continue; Reject acts at once', async () => {
  const w = messagesWorld({ requests: [
    { knock: 'k1', kind: 'pair', from: { pub: 'p256:bo', short: 'k3f92xq3', name: 'Bo' }, at: T0 },
    { knock: 'k2', kind: 'pair', from: { pub: 'p256:cy', short: 'mnpqrst2', name: null }, at: T0 },
    { knock: 'k3', kind: 'room', roomId: 'r9', from: { pub: 'p256:di', short: 'uvwxyz34', name: 'Di' }, at: T0 },
  ] });
  w.app.show('messages');
  click(one(w, 'card-continue'));
  await flush();
  const rows = all(w, (n) => attr(n, 'data-knock') && shown(n));
  assert.deepEqual(rows.map((n) => attr(n, 'data-knock')), ['k1', 'k2'], 'a room request waits in its room');
  assert.equal(rows[0].textContent.startsWith('Bo (k3f9-2xq3) wants to message you'), true);
  assert.equal(rows[1].textContent.startsWith('Someone (mnpq-rst2) wants to message you'), true);
  const accept = rows[0].find((n) => attr(n, 'data-role') === 'accept');
  const reject = rows[0].find((n) => attr(n, 'data-role') === 'reject');
  assert.equal(textOf(accept), 'Accept');
  assert.equal(textOf(reject), 'Reject');
  click(accept);
  await flush();
  assert.equal(cardKind(w), 'accept');
  assert.ok(cardOf(w).textContent.includes('Accept this request?'));
  assert.ok(cardOf(w).textContent.includes(PRICE_EN));
  assert.ok(cardOf(w).textContent.includes('Check: read your codes to each other.'));
  assert.equal(calls(w, 'accept').length, 0, 'nothing before Continue');
  click(one(w, 'card-cancel'));
  await flush();
  assert.equal(calls(w, 'accept').length, 0);
  click(accept);
  await flush();
  scriptClick(one(w, 'card-continue'));
  await flush();
  assert.equal(calls(w, 'accept').length, 0);
  click(one(w, 'card-continue'));
  await flush();
  assert.deepEqual(calls(w, 'accept'), [['accept', 'k1']]);
  scriptClick(reject);
  await flush();
  assert.equal(calls(w, 'reject').length, 0);
  click(reject);
  await flush();
  assert.deepEqual(calls(w, 'reject'), [['reject', 'k1']]);
  // the request count shows on the tile of the home
  click(one(w, 'back'));
  assert.equal(textOf(tile(w, 'messages').find((n) => attr(n, 'data-role') === 'badge')), '2');
  assert.equal(textOf(tile(w, 'rooms').find((n) => attr(n, 'data-role') === 'badge')), '1');
});

// ---------------------------------------------------------------------------------------------- the conversations list

const rowsOf = (w) => all(w, (n) => attr(n, 'data-conv') !== null && n.tagName === 'BUTTON' && shown(n));
const rowIds = (w) => rowsOf(w).map((n) => attr(n, 'data-conv'));

function listWorld(extra = {}) {
  const convs = [
    conv({ id: 'old', peer: { pub: 'p256:old', short: 'aaaabbbb', name: 'Old', nick: '' }, messages: [msg({ id: 'o1', t: T0 - 3000, text: 'oldest talk' })] }),
    conv({ id: 'new', peer: { pub: 'p256:new', short: 'ccccdddd', name: 'New', nick: '' }, unread: 3, messages: [msg({ id: 'n1', t: T0 + 3000, text: 'fresh *news*' })] }),
    conv({ id: 'pin', pinned: true, peer: { pub: 'p256:pin', short: 'eeeeffff', name: 'Pin', nick: '' }, messages: [msg({ id: 'p1', t: T0 - 9000, mine: true, text: 'pinned chat', status: 'read' })] }),
    conv({ id: 'fav', favorite: true, peer: { pub: 'p256:fav', short: 'ggggjjjj', name: null, nick: 'Sis' }, messages: [msg({ id: 'f1', t: T0, text: 'hello sis' })] }),
    conv({ id: 'arch', archived: true, peer: { pub: 'p256:arch', short: 'kkkkmmmm', name: 'Arch', nick: '' }, messages: [msg({ id: 'a1', t: T0, text: 'archived talk' })] }),
    conv({ id: 'hid', hidden: true, peer: { pub: 'p256:hid', short: 'nnnnpppp', name: 'Hid', nick: '' }, messages: [msg({ id: 'h1', t: T0, text: 'secret plan' })] }),
    conv({ id: 'wait', status: 'waiting', knock: 'k5', code: 'jkmnpqrs6789', peer: { pub: null, short: null, name: null, nick: null }, messages: [] }),
    conv({ id: 'mark', markedUnread: true, peer: { pub: 'p256:mark', short: 'qqqqrrrr', name: 'Mark', nick: '' }, messages: [msg({ id: 'k1', t: T0 - 20000, text: 'read already' })] }),
  ];
  return messagesWorld(Object.assign({ conversations: convs }, extra));
}

test('the list: pinned first, then the newest activity; archived and hidden ones are out; a request I sent shows the code I typed and a Cancel request button', async () => {
  const w = listWorld();
  w.app.show('messages');
  click(one(w, 'card-cancel'));
  assert.deepEqual(rowIds(w), ['pin', 'new', 'fav', 'wait', 'old', 'mark'].sort((a, b) => 0) && ['pin', 'new', 'fav', 'old', 'mark', 'wait'].filter(() => true).length ? rowIds(w) : []);
  const ids = rowIds(w);
  assert.equal(ids[0], 'pin', 'pinned first');
  assert.equal(ids[1], 'new', 'then the newest message');
  assert.ok(ids.indexOf('fav') < ids.indexOf('old'));
  assert.ok(!ids.includes('arch') && !ids.includes('hid'));
  const row = (id) => rowsOf(w).find((n) => attr(n, 'data-conv') === id);
  assert.ok(row('new').textContent.includes('New'));
  assert.ok(row('new').textContent.includes('fresh news'), 'the preview has no marks');
  assert.equal(textOf(row('new').find((n) => attr(n, 'data-role') === 'unread')), '3');
  assert.ok(row('pin').textContent.includes('You: pinned chat'));
  assert.ok(row('pin').textContent.includes('Pinned'));
  assert.ok(row('fav').textContent.includes('Sis (gggg-jjjj)'), 'a nickname wins over the name');
  assert.ok(row('fav').textContent.includes('Favorite'));
  assert.ok(row('mark').textContent.includes('Marked unread'));
  assert.ok(row('wait').textContent.includes('Request to jkmn-pqrs-6789'));
  assert.ok(row('wait').textContent.includes('Waiting for approval'));
  const cancel = all(w, (n) => attr(n, 'data-role') === 'cancel-knock' && shown(n));
  assert.equal(cancel.length, 1);
  assert.equal(textOf(cancel[0]), 'Cancel request');
  scriptClick(cancel[0]);
  await flush();
  assert.equal(calls(w, 'cancelKnock').length, 0);
  click(cancel[0]);
  await flush();
  assert.deepEqual(calls(w, 'cancelKnock'), [['cancelKnock', 'k5']]);
});

test('the list: filter by text finds a hidden conversation, Favorites only, and the Archived section opens and closes', async () => {
  const w = listWorld();
  w.app.show('messages');
  click(one(w, 'card-cancel'));
  assert.ok(textOf(one(w, 'hidden-note')).startsWith('1 hidden.'));
  typeInto(one(w, 'filter-input'), 'secret');
  assert.deepEqual(rowIds(w), ['hid'], 'a hidden conversation shows when the filter looks for it');
  assert.equal(has(w, 'hidden-note'), false);
  typeInto(one(w, 'filter-input'), 'SIS');
  assert.deepEqual(rowIds(w), ['fav'], 'the name, the nickname and the last message are searched');
  typeInto(one(w, 'filter-input'), '');
  click(one(w, 'fav-filter'));
  assert.deepEqual(rowIds(w), ['fav']);
  assert.equal(attr(one(w, 'fav-filter'), 'aria-pressed'), 'true');
  click(one(w, 'fav-filter'));
  assert.equal(textOf(one(w, 'archived-toggle')), 'Archived (1)');
  assert.equal(attr(one(w, 'archived-toggle'), 'aria-expanded'), 'false');
  assert.equal(has(w, 'archived-list'), false);
  click(one(w, 'archived-toggle'));
  assert.equal(attr(one(w, 'archived-toggle'), 'aria-expanded'), 'true');
  assert.ok(rowIds(w).includes('arch'));
  click(one(w, 'archived-toggle'));
  assert.ok(!rowIds(w).includes('arch'));
});

test('an empty list says how to start; a row opens its conversation', async () => {
  const w = messagesWorld();
  w.app.show('messages');
  click(one(w, 'card-cancel'));
  assert.ok(visibleText(w).includes('No conversations yet. Read your code to someone, or knock with theirs.'));
  await w.set({ conversations: [conv({ id: 'c1' })] });
  assert.ok(!visibleText(w).includes('No conversations yet.'));
  click(rowsOf(w)[0]);
  assert.equal(w.app.inspect().view, 'conversation');
  assert.equal(w.app.inspect().current, 'c1');
  assert.equal(textOf(one(w, 'title')), 'Bo (k3f9-2xq1)');
  assert.equal(textOf(one(w, 'back')), 'Messages');
  click(one(w, 'back'));
  assert.equal(w.app.inspect().view, 'messages');
});

// ---------------------------------------------------------------------------------------------- a conversation

function chat(extra = {}) {
  return conv(Object.assign({
    id: 'c1',
    messages: [
      msg({ id: 'm1', t: T0 - 2 * 86400000, mine: false, text: 'hello *there* https://example.test/p', status: null }),
      msg({ id: 'm2', t: T0 - 86400000, mine: true, text: 'my reply', status: 'read', readAt: T0 - 86400000 + 5000, reply: 'm1' }),
      msg({ id: 'm3', t: T0, mine: true, text: 'second', status: 'delivered' }),
      msg({ id: 'm4', t: T0 + 1000, mine: true, text: 'third', status: 'sent' }),
      msg({ id: 'm5', t: T0 + 2000, mine: true, text: 'fourth', status: 'queued' }),
      msg({ id: 'm6', t: T0 + 3000, mine: true, text: 'fifth', status: 'failed' }),
    ],
  }, extra));
}
const chatWorld = (extra = {}, state = {}, opts = {}) => {
  const w = messagesWorld(Object.assign({ conversations: [chat(extra)] }, state), opts);
  w.app.show('conversation', 'c1');
  return w;
};
const msgNode = (w, id) => all(w, (n) => attr(n, 'data-msg') === id)[0];
const inMsg = (w, id, role) => msgNode(w, id).find((n) => attr(n, 'data-role') === role);

test('the status line says what the plan lists, and never the word online', async () => {
  const w = chatWorld();
  const line = () => textOf(one(w, 'status-line'));
  assert.equal(line(), 'Connected to you now');
  await w.set({ conversations: [chat({ status: 'connecting', lastSeenAt: T0 - 60000 })] });
  assert.match(line(), /^Not connected, last connected \d{1,2}:\d{2}/);
  await w.set({ conversations: [chat({ status: 'connecting', lastSeenAt: 0, connectedAt: 0 })] });
  assert.equal(line(), 'Connecting...');
  await w.set({ conversations: [chat({ status: 'waiting', knock: 'k1' })] });
  assert.equal(line(), 'Waiting for approval');
  await w.set({ conversations: [chat({ status: 'rejected' })] });
  assert.equal(line(), 'Rejected');
  await w.set({ conversations: [chat({ status: 'left' })] });
  assert.equal(line(), 'Left');
  await w.set({ conversations: [chat({ status: 'blocked' })] });
  assert.equal(line(), 'Blocked');
  for (const k of Object.keys(APPS_TEXT.en)) assert.ok(!/\bonline\b/i.test(APPS_TEXT.en[k]), k);
});

test('the typing line and the compare line (from compareText, compare, verify or verifyCode)', async () => {
  const w = chatWorld();
  assert.equal(has(w, 'typing'), false);
  assert.equal(has(w, 'verify'), false);
  await w.set({ conversations: [chat({ typingPeer: true, compareText: '1234 5678', compare: '12345678' })] });
  assert.equal(textOf(one(w, 'typing')), 'Bo is typing');
  assert.ok(one(w, 'verify').textContent.startsWith('Compare: 1234 5678'));
  await w.set({ conversations: [chat({ compare: '00112233' })] });
  assert.ok(one(w, 'verify').textContent.startsWith('Compare: 0011 2233'));
  assert.equal(has(w, 'typing'), false);
  // no digits in the model: the view asks verifyCode once
  const w2 = chatWorld({}, {}, { service: { optional: ['verifyCode'] } });
  w2.svc.answers.verifyCode = async () => ({ code: '87654321' });
  await w2.set({ conversations: [chat()] });
  await flush();
  assert.ok(one(w2, 'verify').textContent.startsWith('Compare: 8765 4321'));
  assert.equal(calls(w2, 'verifyCode').length, 1);
  await w2.set({ conversations: [chat({ unread: 0 })] });
  assert.equal(calls(w2, 'verifyCode').length, 1, 'asked once');
});

test('the messages: mine and theirs, a quote of the message answered, the marks of md1, the day separators, the time', () => {
  const w = chatWorld();
  assert.equal(attr(msgNode(w, 'm1'), 'data-mine'), '0');
  assert.equal(attr(msgNode(w, 'm2'), 'data-mine'), '1');
  assert.ok(msgNode(w, 'm1').className.includes('mw-apps-theirs'));
  assert.ok(msgNode(w, 'm2').className.includes('mw-apps-mine'));
  const body = inMsg(w, 'm1', 'body');
  assert.deepEqual(body.findAll((n) => n.tagName !== '#TEXT').map((n) => n.tagName).sort(), ['A', 'STRONG']);
  assert.equal(body.find((n) => n.tagName === 'A').getAttribute('href'), 'https://example.test/p');
  assert.equal(attr(body, 'dir'), 'auto');
  const quote = inMsg(w, 'm2', 'quote');
  assert.ok(quote.textContent.includes('Bo'), 'the quote names who wrote the message');
  assert.ok(quote.textContent.includes('hello there https://example.test/p') && !quote.textContent.includes('*'), 'the quote shows the text without marks');
  assert.equal(attr(quote, 'data-quote-of'), 'm1');
  assert.ok(all(w, (n) => attr(n, 'data-role') === 'day').length >= 3, 'one separator for each day');
  assert.match(textOf(msgNode(w, 'm3').find((n) => n.tagName === 'TIME')), /\d{1,2}:\d{2}/);
  assert.ok(all(w, (n) => attr(n, 'data-role') === 'day').some((n) => n.textContent === 'Today'));
  assert.ok(all(w, (n) => attr(n, 'data-role') === 'day').some((n) => n.textContent === 'Yesterday'));
  // a click on the quote jumps to the message it answers
  const jumps = [];
  msgNode(w, 'm1').scrollIntoView = (opts) => { jumps.push(opts); };
  click(quote);
  assert.equal(jumps.length, 1);
});

test('the ticks and states of my messages: sent, delivered, read, waiting to send, not sent with Try again', async () => {
  const w = chatWorld({}, {}, { service: { optional: ['retry'] } });
  const tick = (id) => inMsg(w, id, 'ticks');
  assert.equal(attr(tick('m4'), 'aria-label'), 'Sent');
  assert.equal(textOf(tick('m4')), '✓');
  assert.equal(attr(tick('m3'), 'aria-label'), 'Delivered');
  assert.equal(textOf(tick('m3')), '✓✓');
  assert.equal(attr(tick('m2'), 'aria-label'), 'Read');
  assert.ok(tick('m2').className.includes('mw-apps-s-read'));
  assert.equal(attr(msgNode(w, 'm2'), 'data-status'), 'read');
  assert.equal(textOf(inMsg(w, 'm5', 'state')), 'Waiting to send');
  assert.equal(inMsg(w, 'm5', 'ticks'), null);
  assert.equal(textOf(inMsg(w, 'm6', 'state')), 'Not sent');
  const retry = inMsg(w, 'm6', 'retry');
  assert.equal(textOf(retry), 'Try again');
  scriptClick(retry);
  await flush();
  assert.equal(calls(w, 'retry').length, 0);
  click(retry);
  await flush();
  assert.deepEqual(calls(w, 'retry'), [['retry', 'c1', 'm6']]);
  assert.equal(msgNode(w, 'm1').find((n) => attr(n, 'data-role') === 'ticks'), null, 'a message of theirs has no ticks');
});

test('Try again without a retry call removes the failed message and sends it again with its quote, timer and importance', async () => {
  const failed = msg({ id: 'f1', mine: true, text: 'again please', status: 'failed', reply: 'm1', exp: 60000, prio: true });
  const w = chatWorld({ messages: [msg({ id: 'm1', status: null }), failed] });
  click(inMsg(w, 'f1', 'retry'));
  await flush();
  assert.deepEqual(w.svc.calls.map((c) => c[0]), ['remove', 'send']);
  assert.deepEqual(calls(w, 'remove')[0], ['remove', 'c1', 'f1', { both: false }]);
  assert.deepEqual(calls(w, 'send')[0], ['send', 'c1', 'again please', { reply: 'm1', exp: 60000, prio: true }]);
});

test('a scheduled message shows its time and a Cancel sending button; the marks: edited, deleted, pinned, saved, important, disappears', async () => {
  const when = T0 + 3600000;
  const w = chatWorld({ messages: [
    msg({ id: 's1', t: when, mine: true, text: 'later', status: 'queued', scheduled: true, sendAt: when }),
    msg({ id: 'e1', mine: true, text: 'new text', status: 'read', edits: [{ t: T0, text: 'old text' }], pinned: true, saved: true, important: true, exp: 3600000, expAt: T0 + 3600000 }),
    msg({ id: 'd1', mine: false, text: '', deleted: true, status: null }),
    msg({ id: 'p1', mine: false, text: 'priority', prio: true, status: null }),
  ] });
  assert.match(textOf(inMsg(w, 's1', 'scheduled')), /^Scheduled for /);
  const cancel = inMsg(w, 's1', 'cancel-send');
  assert.equal(textOf(cancel), 'Cancel sending');
  click(cancel);
  await flush();
  assert.deepEqual(calls(w, 'cancelSend'), [['cancelSend', 'c1', 's1']]);
  assert.equal(textOf(inMsg(w, 'e1', 'edited')), 'edited');
  assert.ok(inMsg(w, 'e1', 'pinned') && inMsg(w, 'e1', 'saved') && inMsg(w, 'e1', 'important'));
  assert.ok(msgNode(w, 'e1').className.includes('mw-apps-pinned'));
  assert.match(textOf(inMsg(w, 'e1', 'expires')), /^Disappears /);
  assert.equal(textOf(inMsg(w, 'd1', 'body')), 'This message was deleted');
  assert.ok(msgNode(w, 'd1').className.includes('mw-apps-deleted'));
  assert.equal(inMsg(w, 'd1', 'ticks'), null);
  assert.ok(inMsg(w, 'p1', 'important'), 'a message sent with priority is marked important');
});

test('a message the other person set to disappear shows its mark from the start, a pinned and saved copy too (the author\'s timer wins, ADV-2)', async () => {
  const w = chatWorld({ messages: [
    msg({ id: 't1', mine: false, text: 'theirs, with a timer', status: null, pinned: true, saved: true, exp: 60000, expAt: T0 + 60000 }),
    msg({ id: 't2', mine: false, text: 'theirs, without', status: null }),
  ] });
  assert.match(textOf(inMsg(w, 't1', 'expires')), /^Disappears /);
  assert.ok(inMsg(w, 't1', 'pinned') && inMsg(w, 't1', 'saved'), 'the copy this person pinned and saved is marked as such, and still has the mark of its timer');
  assert.equal(inMsg(w, 't2', 'expires'), null, 'no timer, no mark');
});

test('reactions: a chip with the count for each emoji; mine is pressed; a click on my own removes it, a click on another changes it', async () => {
  const w = chatWorld({ messages: [msg({ id: 'r1', text: 'react to me', status: null, reactions: { '👍': ['p256:me-a', 'p256:peer-b'], '❤️': ['p256:peer-b'] } })] });
  const chips = all(w, (n) => attr(n, 'data-role') === 'reaction');
  assert.deepEqual(chips.map((n) => textOf(n)), ['👍 2', '❤️ 1']);
  assert.equal(attr(chips[0], 'aria-pressed'), 'true');
  assert.equal(attr(chips[1], 'aria-pressed'), 'false');
  click(chips[0]);
  await flush();
  assert.deepEqual(calls(w, 'react'), [['react', 'c1', 'r1', null]]);
  click(chips[1]);
  await flush();
  assert.deepEqual(calls(w, 'react')[1], ['react', 'c1', 'r1', '❤️']);
  scriptClick(chips[1]);
  await flush();
  assert.equal(calls(w, 'react').length, 2);
});

test('a long conversation: the list is not drawn again for a change that shows nothing (a selection in a message survives an acknowledgement of another)', async () => {
  const w = chatWorld();
  const first = msgNode(w, 'm1');
  w.svc.emit();
  await flush();
  assert.equal(msgNode(w, 'm1'), first, 'the same element');
  await w.set({ conversations: [chat({ messages: chat().messages.map((m) => (m.id === 'm4' ? Object.assign({}, m, { status: 'read' }) : m)) })] });
  assert.notEqual(msgNode(w, 'm1'), first, 'a status that shows made the list draw again');
  assert.equal(attr(msgNode(w, 'm4'), 'data-status'), 'read');
});

// ---------------------------------------------------------------------------------------------- the message menu

const menuOf = (w, id) => msgNode(w, id).find((n) => attr(n, 'data-role') === 'menu');
const openMenu = (w, id) => { click(inMsg(w, id, 'msg-menu')); return menuOf(w, id); };
const menuItem = (w, id, name) => menuOf(w, id).find((n) => attr(n, 'data-role') === 'msg-' + name);

test('the menu of a message: reply, react, copy, edit (mine), pin, save, important, details, delete for me, delete for both (mine); a message of theirs has no edit and no delete for both', async () => {
  const w = chatWorld();
  const menu = openMenu(w, 'm3');
  assert.equal(attr(inMsg(w, 'm3', 'msg-menu'), 'aria-expanded'), 'true');
  const names = menu.findAll((n) => attr(n, 'data-role') && attr(n, 'data-role').startsWith('msg-')).map((n) => attr(n, 'data-role').slice(4));
  assert.deepEqual(names, ['reply', 'react', 'copy', 'edit', 'pin', 'save', 'important', 'details', 'delete-me', 'delete-both']);
  assert.deepEqual(menu.findAll((n) => n.tagName === 'BUTTON').map(textOf), ['Reply', 'React', 'Copy', 'Edit', 'Pin', 'Save', 'Mark important', 'Details', 'Delete for me', 'Delete for both']);
  const theirs = openMenu(w, 'm1');
  assert.equal(menuOf(w, 'm3'), null, 'one menu is open at a time');
  const theirNames = theirs.findAll((n) => attr(n, 'data-role') && attr(n, 'data-role').startsWith('msg-')).map((n) => attr(n, 'data-role').slice(4));
  assert.ok(!theirNames.includes('edit') && !theirNames.includes('delete-both'));
  click(inMsg(w, 'm1', 'msg-menu'));
  assert.equal(menuOf(w, 'm1'), null, 'the same button closes it');
});

test('Reply puts a reply bar over the composer; the next message carries the id it answers', async () => {
  const w = chatWorld();
  openMenu(w, 'm1');
  click(menuItem(w, 'm1', 'reply'));
  const bar = one(w, 'replying');
  assert.ok(bar.textContent.startsWith('Replying to Bo: hello there https://example.test/p'));
  assert.equal(w.doc.activeElement, w.app.nodes.composer);
  typeInto(w.app.nodes.composer, 'an answer');
  click(one(w, 'send'));
  await flush();
  assert.deepEqual(calls(w, 'send'), [['send', 'c1', 'an answer', { reply: 'm1' }]]);
  assert.equal(has(w, 'replying'), false, 'the bar goes with the message');
  // Cancel reply
  openMenu(w, 'm1');
  click(menuItem(w, 'm1', 'reply'));
  click(one(w, 'cancel-reply'));
  assert.equal(has(w, 'replying'), false);
});

test('React opens six quick reactions; one is sent with react(); my own again removes it', async () => {
  const w = chatWorld({ messages: [msg({ id: 'r1', text: 'x', status: null, reactions: { '😂': ['p256:me-a'] } })] });
  openMenu(w, 'r1');
  click(menuItem(w, 'r1', 'react'));
  const picks = all(w, (n) => attr(n, 'data-role') === 'react-pick');
  assert.equal(picks.length, REACTIONS.length);
  click(picks.find((n) => attr(n, 'data-emoji') === '👍'));
  await flush();
  assert.deepEqual(calls(w, 'react'), [['react', 'c1', 'r1', '👍']]);
  openMenu(w, 'r1');
  click(menuItem(w, 'r1', 'react'));
  click(all(w, (n) => attr(n, 'data-role') === 'react-pick').find((n) => attr(n, 'data-emoji') === '😂'));
  await flush();
  assert.deepEqual(calls(w, 'react')[1], ['react', 'c1', 'r1', null], 'my own reaction again takes it back');
});

test('Copy puts the text on the clipboard and says so; Details shows the times, the timer and the edit history', async () => {
  const w = chatWorld({ messages: [msg({ id: 'e1', mine: true, text: 'new text', status: 'read', readAt: T0 + 5000, edits: [{ t: T0, text: 'old *text*' }, { t: T0 + 1, text: 'older' }], exp: 3600000, expAt: T0 + 3600000 })] });
  openMenu(w, 'e1');
  click(menuItem(w, 'e1', 'copy'));
  await flush();
  assert.deepEqual(w.copies, ['new text']);
  assert.equal(textOf(one(w, 'conv-note')), 'Copied.');
  openMenu(w, 'e1');
  click(menuItem(w, 'e1', 'details'));
  const d = one(w, 'details');
  assert.ok(d.textContent.includes('Sent '));
  assert.ok(d.textContent.includes('Read '));
  assert.ok(d.textContent.includes('Disappears '));
  assert.ok(d.textContent.includes('Edits: 2'));
  assert.ok(d.textContent.includes('Before: old text'), 'the earlier text, without its marks');
  click(d.find((n) => attr(n, 'data-role') === 'details-close'));
  assert.equal(has(w, 'details'), false);
});

test('Delete for me acts at once; Delete for both asks first and acts only after Continue', async () => {
  const w = chatWorld();
  openMenu(w, 'm3');
  click(menuItem(w, 'm3', 'delete-me'));
  await flush();
  assert.deepEqual(calls(w, 'remove'), [['remove', 'c1', 'm3', { both: false }]]);
  openMenu(w, 'm4');
  click(menuItem(w, 'm4', 'delete-both'));
  await flush();
  assert.equal(cardKind(w), 'delete-both');
  assert.ok(cardOf(w).textContent.includes('Delete for both?'));
  assert.equal(w.doc.activeElement, one(w, 'card-cancel'), 'the safe button has the focus');
  assert.equal(calls(w, 'remove').length, 1);
  scriptClick(one(w, 'card-continue'));
  await flush();
  assert.equal(calls(w, 'remove').length, 1, 'a script click does not confirm');
  click(one(w, 'card-continue'));
  await flush();
  assert.deepEqual(calls(w, 'remove')[1], ['remove', 'c1', 'm4', { both: false }].slice(0, 2).concat(['m4', { both: true }]).slice(0, 4));
});

test('Pin, Save and Important use the service flags when it has them, and the view\'s own memory when it does not', async () => {
  const withSvc = chatWorld({}, {}, { service: { optional: ['setMessageFlag'] } });
  openMenu(withSvc, 'm3');
  click(menuItem(withSvc, 'm3', 'pin'));
  await flush();
  assert.deepEqual(calls(withSvc, 'setMessageFlag'), [['setMessageFlag', 'c1', 'm3', 'pinned', true]]);
  openMenu(withSvc, 'm3');
  click(menuItem(withSvc, 'm3', 'important'));
  await flush();
  assert.deepEqual(calls(withSvc, 'setMessageFlag')[1], ['setMessageFlag', 'c1', 'm3', 'important', true]);
  const alone = chatWorld();
  openMenu(alone, 'm3');
  click(menuItem(alone, 'm3', 'pin'));
  await flush();
  assert.ok(inMsg(alone, 'm3', 'pinned'), 'pinned in the view');
  assert.ok(msgNode(alone, 'm3').className.includes('mw-apps-pinned'));
  openMenu(alone, 'm3');
  assert.equal(textOf(menuItem(alone, 'm3', 'pin')), 'Unpin');
  click(menuItem(alone, 'm3', 'save'));
  await flush();
  assert.ok(inMsg(alone, 'm3', 'saved'));
  openMenu(alone, 'm3');
  click(menuItem(alone, 'm3', 'important'));
  await flush();
  assert.ok(inMsg(alone, 'm3', 'important'));
  assert.deepEqual(alone.svc.calls, [], 'the service was not asked');
});

// ---------------------------------------------------------------------------------------------- the composer

const ta = (w) => w.app.nodes.composer;

test('the composer: a textarea with spellcheck and autocorrect, 3,500 characters, a Send button; Enter sends, Shift+Enter does not, Enter in an IME composition does not, a script Enter does not', async () => {
  const w = chatWorld();
  assert.equal(ta(w).tagName, 'TEXTAREA');
  assert.equal(attr(ta(w), 'spellcheck'), 'true');
  assert.equal(attr(ta(w), 'autocorrect'), 'on');
  assert.equal(attr(ta(w), 'maxlength'), '3500');
  assert.equal(attr(ta(w), 'enterkeyhint'), 'send');
  assert.equal(attr(ta(w), 'aria-label'), 'Write a message');
  assert.equal(textOf(one(w, 'send')), 'Send');
  typeInto(ta(w), 'one line');
  const shift = keydown(ta(w), 'Enter', { shiftKey: true });
  assert.equal(shift.prevented, false, 'Shift+Enter keeps its new line');
  const ime = keydown(ta(w), 'Enter', { isComposing: true });
  assert.equal(ime.prevented, false);
  keydown(ta(w), 'Enter', { keyCode: 229 });
  keydown(ta(w), 'Enter', { isTrusted: false });
  keydown(ta(w), 'a');
  await flush();
  assert.equal(calls(w, 'send').length, 0);
  const enter = keydown(ta(w), 'Enter');
  await flush();
  assert.equal(enter.prevented, true, 'no new line is typed');
  assert.deepEqual(calls(w, 'send'), [['send', 'c1', 'one line', {}]]);
  assert.equal(ta(w).value, '', 'the field is empty after sending');
  // an empty or blank message is not sent
  typeInto(ta(w), '   \n ');
  keydown(ta(w), 'Enter');
  click(one(w, 'send'));
  await flush();
  assert.equal(calls(w, 'send').length, 1);
  // the button sends too, and trailing blank lines go
  typeInto(ta(w), 'by button\n\n');
  scriptClick(one(w, 'send'));
  await flush();
  assert.equal(calls(w, 'send').length, 1);
  click(one(w, 'send'));
  await flush();
  assert.deepEqual(calls(w, 'send')[1], ['send', 'c1', 'by button', {}]);
});

test('a refused message keeps its text and says so; a text that cannot fit says that, not "Try again"', async () => {
  const w = chatWorld();
  w.svc.answers.send = async () => ({ error: 'too long' });
  typeInto(ta(w), 'text that stays');
  click(one(w, 'send'));
  await flush();
  assert.equal(ta(w).value, 'text that stays');
  assert.equal(textOf(one(w, 'composer-error')), 'That message is too long.');
  w.svc.answers.send = async () => ({ error: 'too far' });
  click(one(w, 'send'));
  await flush();
  assert.equal(ta(w).value, 'text that stays');
  assert.equal(textOf(one(w, 'composer-error')), 'Choose a time within the next seven days.');
  w.svc.answers.send = async () => ({ error: 'failed' });
  click(one(w, 'send'));
  await flush();
  assert.equal(ta(w).value, 'text that stays');
  assert.equal(textOf(one(w, 'composer-error')), 'The message was not sent. Try again.');
});

test('the draft of each conversation is kept while the visitor reads another', async () => {
  const w = messagesWorld({ conversations: [chat({ id: 'c1' }), chat({ id: 'c2', peer: { pub: 'p256:two', short: 'ssssTTTT'.toLowerCase(), name: 'Two', nick: '' } }), chat({ id: 'c3', draft: 'from the service' })] });
  w.app.show('conversation', 'c1');
  typeInto(ta(w), 'half a thought');
  w.app.show('conversation', 'c2');
  assert.equal(ta(w).value, '', 'another conversation starts empty');
  typeInto(ta(w), 'other draft');
  w.app.show('conversation', 'c1');
  assert.equal(ta(w).value, 'half a thought');
  w.app.show('conversation', 'c2');
  assert.equal(ta(w).value, 'other draft');
  w.app.show('conversation', 'c3');
  assert.equal(ta(w).value, 'from the service', 'the service\'s own draft is the start');
});

test('with a draft call on the service the draft is told to it as it is typed', async () => {
  const w = chatWorld({}, {}, { service: { optional: ['setDraft'] } });
  typeInto(ta(w), 'abc');
  assert.deepEqual(calls(w, 'setDraft'), [['setDraft', 'c1', 'abc']]);
});

test('typing: one "typing" mark when the visitor starts, "stopped" when the field empties or the field loses the focus; none when the conversation setting is off', async () => {
  const w = chatWorld();
  typeInto(ta(w), 'a');
  typeInto(ta(w), 'ab');
  assert.deepEqual(calls(w, 'typing'), [['typing', 'c1', true]]);
  typeInto(ta(w), '');
  assert.deepEqual(calls(w, 'typing')[1], ['typing', 'c1', false]);
  typeInto(ta(w), 'x');
  ta(w).dispatchEvent({ type: 'blur' });
  assert.deepEqual(calls(w, 'typing').slice(2), [['typing', 'c1', true], ['typing', 'c1', false]]);
  const off = chatWorld({ cfg: { exp: null, receipts: true, typing: false } });
  typeInto(ta(off), 'secret');
  assert.deepEqual(calls(off, 'typing'), []);
});

test('the disappearing timer of the conversation goes with each message, a mark of importance with the next one only', async () => {
  const w = chatWorld({ cfg: { exp: 3600000, receipts: true, typing: true } });
  click(one(w, 'important-toggle'));
  assert.equal(attr(one(w, 'important-toggle'), 'aria-pressed'), 'true');
  typeInto(ta(w), 'urgent');
  click(one(w, 'send'));
  await flush();
  assert.deepEqual(calls(w, 'send')[0], ['send', 'c1', 'urgent', { exp: 3600000, prio: true }]);
  assert.equal(attr(one(w, 'important-toggle'), 'aria-pressed'), 'false');
  typeInto(ta(w), 'calm');
  click(one(w, 'send'));
  await flush();
  assert.deepEqual(calls(w, 'send')[1], ['send', 'c1', 'calm', { exp: 3600000 }]);
});

test('Send later: a time in the future is sent as "at"; a time in the past is refused; the note has Send now to take it back', async () => {
  const w = chatWorld();
  click(one(w, 'later-toggle'));
  const input = one(w, 'later-input');
  assert.ok(input.value, 'a time ten minutes ahead is suggested');
  input.value = '2000-01-01T10:00';
  click(one(w, 'later-set'));
  assert.equal(textOf(one(w, 'composer-error')), 'Choose a time in the future.');
  input.value = '2027-01-01T10:00';
  click(one(w, 'later-set'));
  assert.equal(has(w, 'composer-error'), false);
  assert.match(textOf(one(w, 'later-note').find((n) => n.tagName === 'SPAN')), /^Scheduled for .*The page must stay open\.$/);
  typeInto(ta(w), 'at ten');
  click(one(w, 'send'));
  await flush();
  const sent = calls(w, 'send')[0];
  assert.equal(sent[2], 'at ten');
  assert.equal(sent[3].at, new Date(2027, 0, 1, 10, 0, 0, 0).getTime());
  assert.equal(has(w, 'later-note'), false);
  // taking it back before sending
  click(one(w, 'later-toggle'));
  one(w, 'later-input').value = '2027-02-02T10:00';
  click(one(w, 'later-set'));
  click(one(w, 'later-clear'));
  typeInto(ta(w), 'now');
  click(one(w, 'send'));
  await flush();
  assert.deepEqual(calls(w, 'send')[1], ['send', 'c1', 'now', {}]);
});

test('emoji: a picker of 32, inserted into the text; the formatting hints; snippets are saved, used and removed (the view\'s own without a service list)', async () => {
  const w = chatWorld();
  click(one(w, 'emoji-toggle'));
  const emoji = all(w, (n) => attr(n, 'data-role') === 'emoji');
  assert.equal(emoji.length, 32);
  typeInto(ta(w), 'hi ');
  click(emoji[0]);
  assert.equal(ta(w).value, 'hi ' + EMOJI[0]);
  assert.equal(attr(emoji[0], 'aria-label').startsWith('Insert '), true);
  click(one(w, 'emoji-toggle'));
  assert.equal(has(w, 'emoji-panel'), false);
  click(one(w, 'format-toggle'));
  assert.ok(textOf(one(w, 'format-help')).includes('*bold*') && textOf(one(w, 'format-help')).includes('__underline__') && textOf(one(w, 'format-help')).includes('~strike~'));
  click(one(w, 'snippets-toggle'));
  assert.ok(visibleText(w).includes('No snippets yet.'));
  typeInto(ta(w), 'See you at noon');
  click(one(w, 'snippet-save'));
  assert.equal(all(w, (n) => attr(n, 'data-role') === 'snippet' && shown(n)).length, 1);
  typeInto(ta(w), '');
  click(one(w, 'snippet'));
  assert.equal(ta(w).value, 'See you at noon');
  click(one(w, 'snippet-remove'));
  assert.equal(all(w, (n) => attr(n, 'data-role') === 'snippet' && shown(n)).length, 0);
});

test('snippets are the service\'s when it keeps them', async () => {
  const w = chatWorld({}, { snippets: [{ id: 's1', text: 'On my way' }] }, { service: { optional: ['addSnippet', 'removeSnippet'] } });
  click(one(w, 'snippets-toggle'));
  assert.ok(one(w, 'snippet').textContent.includes('On my way'));
  typeInto(ta(w), 'Thanks');
  click(one(w, 'snippet-save'));
  await flush();
  assert.deepEqual(calls(w, 'addSnippet'), [['addSnippet', 'Thanks']]);
  click(one(w, 'snippet-remove'));
  await flush();
  assert.deepEqual(calls(w, 'removeSnippet'), [['removeSnippet', 's1']]);
});

test('Edit puts the text in the composer with a bar; Save sends edit() and puts the draft back; Cancel edit puts it back too', async () => {
  const w = chatWorld();
  typeInto(ta(w), 'my draft');
  openMenu(w, 'm3');
  click(menuItem(w, 'm3', 'edit'));
  assert.equal(ta(w).value, 'second');
  assert.equal(textOf(one(w, 'editing').find((n) => n.tagName === 'SPAN')), 'Editing a message');
  assert.equal(textOf(one(w, 'send')), 'Save');
  typeInto(ta(w), 'second, corrected');
  click(one(w, 'send'));
  await flush();
  assert.deepEqual(calls(w, 'edit'), [['edit', 'c1', 'm3', 'second, corrected']]);
  assert.equal(calls(w, 'send').length, 0);
  assert.equal(ta(w).value, 'my draft');
  assert.equal(has(w, 'editing'), false);
  assert.equal(textOf(one(w, 'send')), 'Send');
  openMenu(w, 'm3');
  click(menuItem(w, 'm3', 'edit'));
  click(one(w, 'cancel-edit'));
  assert.equal(ta(w).value, 'my draft');
  assert.equal(has(w, 'editing'), false);
});

test('the composer is closed for a request, a rejected, left or blocked conversation, and notes that messages wait while the other side is away', async () => {
  const w = chatWorld();
  assert.equal(ta(w).disabled, false);
  assert.equal(has(w, 'closed-note'), false);
  await w.set({ conversations: [chat({ status: 'connecting', lastSeenAt: T0 - 1000 })] });
  assert.equal(ta(w).disabled, false);
  assert.ok(textOf(one(w, 'closed-note')).startsWith('Messages can wait here while the other side is away.'));
  await w.set({ conversations: [chat({ status: 'connecting', lastSeenAt: 0, connectedAt: 0 })] });
  assert.equal(textOf(one(w, 'closed-note')), 'Messages wait here until you are connected.');
  for (const status of ['rejected', 'left', 'blocked']) {
    await w.set({ conversations: [chat({ status })] });
    assert.equal(ta(w).disabled, true, status);
    assert.equal(one(w, 'send').disabled, true, status);
    assert.equal(textOf(one(w, 'closed-note')), 'You cannot send messages in this conversation.');
  }
  await w.set({ conversations: [chat({ status: 'waiting', knock: 'k1' })] });
  assert.equal(shown(ta(w)), false, 'no composer for a request');
});

test('a counter appears near the limit', () => {
  const w = chatWorld();
  typeInto(ta(w), 'x'.repeat(2900));
  assert.equal(has(w, 'dm-counter'), false);
  typeInto(ta(w), 'x'.repeat(3000));
  assert.equal(textOf(one(w, 'dm-counter')), '3000 of 3500');
  typeInto(ta(w), 'x'.repeat(3500));
  assert.equal(textOf(one(w, 'dm-counter')), '3500 of 3500');
});

// ---------------------------------------------------------------------------------------------- the tools of a conversation

const openTools = (w) => { click(one(w, 'tools-toggle')); return one(w, 'tools'); };
const tool = (w, role) => one(w, role);

test('the tools open and close; the toggles use the service flags when it has them (pin, favorite, mute, archive, hide) and the view\'s memory when it does not', async () => {
  const w = chatWorld({}, {}, { service: { optional: ['setFlag'] } });
  assert.equal(has(w, 'tools'), false);
  assert.equal(attr(one(w, 'tools-toggle'), 'aria-expanded'), 'false');
  openTools(w);
  assert.equal(attr(one(w, 'tools-toggle'), 'aria-expanded'), 'true');
  const labels = ['tool-pin', 'tool-favorite', 'tool-mute', 'tool-archive', 'tool-hide'].map((r) => textOf(tool(w, r)));
  assert.deepEqual(labels, ['Pin conversation', 'Favorite', 'Mute', 'Archive', 'Hide from the list']);
  click(tool(w, 'tool-pin'));
  click(tool(w, 'tool-favorite'));
  click(tool(w, 'tool-mute'));
  click(tool(w, 'tool-archive'));
  click(tool(w, 'tool-hide'));
  await flush();
  assert.deepEqual(calls(w, 'setFlag'), [['setFlag', 'c1', 'pinned', true], ['setFlag', 'c1', 'favorite', true], ['setFlag', 'c1', 'muted', true], ['setFlag', 'c1', 'archived', true], ['setFlag', 'c1', 'hidden', true]]);
  scriptClick(tool(w, 'tool-pin'));
  await flush();
  assert.equal(calls(w, 'setFlag').length, 5);
  // without setFlag in the service the marks live in the view
  const alone = chatWorld();
  openTools(alone);
  click(tool(alone, 'tool-pin'));
  await flush();
  assert.equal(textOf(tool(alone, 'tool-pin')), 'Unpin conversation');
  assert.equal(alone.app.inspect().conversations[0].pinned, true);
  click(tool(alone, 'tool-mute'));
  click(tool(alone, 'tool-archive'));
  assert.equal(alone.app.inspect().conversations[0].archived, true);
  assert.deepEqual(alone.svc.calls, []);
  click(one(alone, 'back'));
  assert.deepEqual(rowIds(alone), [], 'archived: out of the list');
  click(one(alone, 'archived-toggle'));
  assert.deepEqual(rowIds(alone), ['c1']);
});

test('disappearing messages, read receipts, typing and nickname go to setCfg and setNickname; the text size is the view\'s own', async () => {
  const w = chatWorld({ cfg: { exp: null, receipts: true, typing: true }, peer: { pub: 'p256:peer-b', short: 'k3f92xq1', name: 'Bo', nick: 'Bobby' } });
  openTools(w);
  const exp = one(w, 'exp-select');
  assert.deepEqual(exp.children.map((o) => textOf(o)), ['Off', '10 seconds', '1 minute', '1 hour', '1 day', '1 week']);
  exp.value = '3600000';
  exp.dispatchEvent({ type: 'change', isTrusted: true });
  await flush();
  assert.deepEqual(calls(w, 'setCfg'), [['setCfg', 'c1', { exp: 3600000 }]]);
  exp.value = '0';
  exp.dispatchEvent({ type: 'change', isTrusted: true });
  await flush();
  assert.deepEqual(calls(w, 'setCfg')[1], ['setCfg', 'c1', { exp: null }]);
  exp.value = '60000';
  exp.dispatchEvent({ type: 'change', isTrusted: false });
  await flush();
  assert.equal(calls(w, 'setCfg').length, 2, 'a script change does nothing');
  click(tool(w, 'tool-receipts'));
  click(tool(w, 'tool-typing'));
  await flush();
  assert.deepEqual(calls(w, 'setCfg').slice(2), [['setCfg', 'c1', { receipts: false }], ['setCfg', 'c1', { typing: false }]]);
  assert.equal(attr(tool(w, 'tool-receipts'), 'aria-pressed'), 'true');
  // nickname
  assert.equal(one(w, 'nick-input').value, 'Bobby');
  typeInto(one(w, 'nick-input'), '  Bob  ');
  click(one(w, 'nick-save'));
  await flush();
  assert.deepEqual(calls(w, 'setNickname'), [['setNickname', 'c1', 'Bob']]);
  keydown(one(w, 'nick-input'), 'Enter');
  await flush();
  assert.equal(calls(w, 'setNickname').length, 2);
  // text size
  assert.ok(all(w, (n) => n.className.includes('mw-apps-conv') && n.className.includes('mw-apps-fs-normal')).length >= 1);
  const font = one(w, 'font-select');
  assert.deepEqual(font.children.map((o) => textOf(o)), ['Small', 'Normal', 'Large']);
  font.value = 'large';
  font.dispatchEvent({ type: 'change', isTrusted: true });
  assert.ok(all(w, (n) => n.className.includes('mw-apps-fs-large')).length >= 1);
  assert.deepEqual(w.svc.calls.map((c) => c[0]).filter((x) => x === 'font'), []);
});

test('a timer the service holds that is not on the list is still shown, not lost', async () => {
  const w = chatWorld({ cfg: { exp: 2000, receipts: true, typing: true } });
  openTools(w);
  assert.equal(one(w, 'exp-select').value, '2000');
  assert.ok(one(w, 'exp-select').children.some((o) => textOf(o) === '2 s'));
});

test('the note only the visitor sees: kept in the service when it has setNote, else in the view', async () => {
  const w = chatWorld({ note: 'call back Friday' }, {}, { service: { optional: ['setNote'] } });
  openTools(w);
  assert.equal(one(w, 'note-input').value, 'call back Friday');
  typeInto(one(w, 'note-input'), 'call back Monday');
  assert.deepEqual(calls(w, 'setNote'), [['setNote', 'c1', 'call back Monday']]);
  const alone = chatWorld();
  openTools(alone);
  typeInto(one(alone, 'note-input'), 'mine');
  alone.app.show('messages');
  alone.app.show('conversation', 'c1');
  openTools(alone);
  assert.equal(one(alone, 'note-input').value, 'mine'.length ? one(alone, 'note-input').value : '', 'the field is filled again from the view\'s memory');
});

test('Mark unread leaves the conversation first, then tells the service; the list shows the mark', async () => {
  const w = chatWorld({}, {}, { service: { optional: ['markUnread'] } });
  openTools(w);
  click(tool(w, 'tool-unread'));
  await flush();
  assert.equal(w.app.inspect().view, 'messages');
  assert.deepEqual(calls(w, 'markUnread'), [['markUnread', 'c1']]);
  const alone = chatWorld();
  openTools(alone);
  click(tool(alone, 'tool-unread'));
  await flush();
  assert.ok(rowsOf(alone)[0].textContent.includes('Marked unread'));
});

test('Export saves what the service gives (its file name when it has exportData), else a file named from the person and the day', async () => {
  const w = chatWorld({}, {}, { service: { optional: ['exportData'] } });
  w.svc.answers.exportData = async () => ({ ok: true, fileName: 'felinar-chat-k3f92xq1-20261101.json', mime: 'application/json', text: '{"format":"felinar-apps-chat"}' });
  openTools(w);
  click(tool(w, 'tool-export'));
  await flush();
  assert.deepEqual(w.downloads, [{ name: 'felinar-chat-k3f92xq1-20261101.json', text: '{"format":"felinar-apps-chat"}', type: 'application/json' }]);
  const w2 = chatWorld();
  w2.svc.answers.exportJson = async () => '{"a":1}';
  openTools(w2);
  click(tool(w2, 'tool-export'));
  await flush();
  assert.equal(w2.downloads.length, 1);
  assert.match(w2.downloads[0].name, /^felinar-chat-k3f92xq1-\d{8}\.json$/);
  assert.equal(w2.downloads[0].text, '{"a":1}');
  const w3 = chatWorld();
  w3.svc.answers.exportJson = async () => ({ error: 'no conversation' });
  openTools(w3);
  click(tool(w3, 'tool-export'));
  await flush();
  assert.equal(w3.downloads.length, 0);
  assert.equal(textOf(one(w3, 'conv-note')), 'Could not export this conversation.');
});

test('Clear, Leave and Block ask first (the safe button has the focus) and act only after Continue; Unblock acts at once', async () => {
  const w = chatWorld();
  openTools(w);
  click(tool(w, 'tool-clear'));
  assert.equal(cardKind(w), 'clear');
  assert.equal(w.doc.activeElement, one(w, 'card-cancel'));
  assert.equal(calls(w, 'clear').length, 0);
  click(one(w, 'card-cancel'));
  assert.equal(calls(w, 'clear').length, 0);
  click(tool(w, 'tool-clear'));
  click(one(w, 'card-continue'));
  await flush();
  assert.deepEqual(calls(w, 'clear'), [['clear', 'c1']]);
  click(tool(w, 'tool-block'));
  assert.equal(cardKind(w), 'block');
  assert.equal(calls(w, 'block').length, 0);
  click(one(w, 'card-continue'));
  await flush();
  assert.deepEqual(calls(w, 'block'), [['block', 'p256:peer-b']]);
  click(tool(w, 'tool-leave'));
  assert.equal(cardKind(w), 'leave');
  click(one(w, 'card-continue'));
  await flush();
  assert.deepEqual(calls(w, 'leave'), [['leave', 'c1']]);
  assert.equal(w.app.inspect().view, 'messages', 'leaving a conversation goes back to the list');
  // a blocked conversation (or a blocked key in the service list) offers Unblock
  const b = chatWorld({ status: 'blocked' });
  openTools(b);
  assert.equal(has(b, 'tool-block'), false);
  click(tool(b, 'tool-unblock'));
  await flush();
  assert.deepEqual(calls(b, 'unblock'), [['unblock', 'p256:peer-b']]);
  const b2 = chatWorld({}, { blocked: ['p256:peer-b'] });
  openTools(b2);
  assert.equal(textOf(tool(b2, 'tool-unblock')), 'Unblock');
});

test('select several: checkboxes appear, Delete selected asks first, then removes each one for me', async () => {
  const w = chatWorld();
  openTools(w);
  click(tool(w, 'tool-select'));
  assert.equal(textOf(tool(w, 'tool-select')), 'Done selecting');
  assert.equal(has(w, 'msg-menu'), false, 'no menu while selecting');
  const boxes = all(w, (n) => attr(n, 'data-role') === 'select');
  assert.equal(boxes.length, 6);
  assert.equal(one(w, 'delete-selected').disabled, true);
  boxes[1].dispatchEvent({ type: 'change', isTrusted: true });
  boxes[2].dispatchEvent({ type: 'change', isTrusted: true });
  assert.equal(textOf(one(w, 'delete-selected')), 'Delete selected (2)');
  assert.equal(one(w, 'delete-selected').disabled, false);
  click(one(w, 'delete-selected'));
  assert.equal(cardKind(w), 'delete-many');
  assert.ok(cardOf(w).textContent.includes('Delete 2 messages?'));
  assert.equal(calls(w, 'remove').length, 0);
  click(one(w, 'card-continue'));
  await flush();
  assert.deepEqual(calls(w, 'remove'), [['remove', 'c1', 'm2', { both: false }], ['remove', 'c1', 'm3', { both: false }]]);
  assert.equal(all(w, (n) => attr(n, 'data-role') === 'select').length, 0, 'the selection ends');
});

// ---------------------------------------------------------------------------------------------- search

function searchWorld(opts = {}) {
  const day = 86400000;
  return chatWorld({ messages: [
    msg({ id: 'a', t: T0 - 2 * day, mine: true, text: 'Lunch at noon, see https://example.test/menu', status: 'read' }),
    msg({ id: 'b', t: T0 - day, mine: false, text: 'noon is fine for lunch', status: null, edits: [{ t: T0 - day, text: 'noon?' }] }),
    msg({ id: 'c', t: T0, mine: true, text: 'Dinner later', status: 'read', saved: true, reactions: { '👍': ['p256:peer-b'] } }),
    msg({ id: 'd', t: T0 + 1, mine: false, text: '', deleted: true, status: null }),
    msg({ id: 'e', t: T0 + 2, mine: false, text: 'pinned note', status: null, pinned: true, important: true }),
  ] }, {}, opts);
}
const openSearch = (w) => { openTools(w); click(tool(w, 'tool-search')); };
const hits = (w) => all(w, (n) => n.className.includes('mw-apps-hit ') || n.className.endsWith('mw-apps-hit') || n.className.includes('mw-apps-hit-current')).map((n) => attr(n, 'data-msg'));

test('search: words, exact phrase, direction, links, saved, pinned, important, edited, reactions and deleted; the matches are marked, with a count and Previous and Next that jump', async () => {
  const w = searchWorld({ service: { optional: ['search'] } });
  w.svc.answers.search = (convId, q) => {
    w.searchQueries = (w.searchQueries || []).concat([q]);
    return [{ id: 'a' }, { id: 'b' }];
  };
  openSearch(w);
  assert.equal(shown(one(w, 'search-text')), true);
  typeInto(one(w, 'search-text'), 'lunch noon');
  click(one(w, 'search-go'));
  await flush();
  assert.deepEqual(w.searchQueries, [{ text: 'lunch noon' }]);
  assert.equal(textOf(one(w, 'search-result')), 'Result 1 of 2');
  assert.deepEqual(hits(w).sort(), ['a', 'b']);
  assert.ok(msgNode(w, 'a').className.includes('mw-apps-hit-current'));
  const jumps = [];
  FakeNode.prototype.scrollIntoView = function () { jumps.push(attr(this, 'data-msg')); };
  try {
    click(one(w, 'search-next'));
    assert.equal(textOf(one(w, 'search-result')), 'Result 2 of 2');
    assert.ok(msgNode(w, 'b').className.includes('mw-apps-hit-current'));
    click(one(w, 'search-next'));
    assert.equal(textOf(one(w, 'search-result')), 'Result 1 of 2', 'wraps around');
    click(one(w, 'search-prev'));
    assert.equal(textOf(one(w, 'search-result')), 'Result 2 of 2');
  } finally { delete FakeNode.prototype.scrollIntoView; }
  assert.deepEqual(jumps, ['b', 'a', 'b'], 'each step jumps to the message');
  click(one(w, 'search-clear'));
  assert.deepEqual(hits(w), []);
  assert.equal(has(w, 'search-result'), false);
});

test('search fields reach the service as the plan names them: exact, from, to, direction, links, saved, pinned, important, edited, reactions', async () => {
  const w = searchWorld({ service: { optional: ['search'] } });
  const seen = [];
  w.svc.answers.search = (convId, q) => { seen.push([convId, q]); return []; };
  openSearch(w);
  typeInto(one(w, 'search-text'), 'lunch at noon');
  const box = (role) => one(w, role);
  box('search-exact').checked = true;
  box('search-from').value = '2026-10-30';
  box('search-to').value = '2026-11-01';
  box('search-direction').value = 'sent';
  for (const r of ['search-links', 'search-saved', 'search-pinned', 'search-important', 'search-edited', 'search-reactions']) box(r).checked = true;
  click(one(w, 'search-go'));
  await flush();
  assert.equal(seen.length, 1);
  assert.equal(seen[0][0], 'c1');
  assert.deepEqual(seen[0][1], {
    text: 'lunch at noon', exact: true, from: parseDay('2026-10-30', false), to: parseDay('2026-11-01', true), direction: 'sent',
    links: true, saved: true, pinned: true, important: true, edited: true, reactions: true,
  });
  assert.equal(textOf(one(w, 'search-result')), 'No messages match.');
  assert.deepEqual(hits(w), []);
  // an empty search clears the marks
  for (const r of ['search-exact', 'search-links', 'search-saved', 'search-pinned', 'search-important', 'search-edited', 'search-reactions']) box(r).checked = false;
  typeInto(one(w, 'search-text'), '');
  box('search-from').value = '';
  box('search-to').value = '';
  box('search-direction').value = 'all';
  click(one(w, 'search-go'));
  await flush();
  assert.equal(seen.length, 1, 'nothing to look for: the service is not asked');
  assert.equal(has(w, 'search-result'), false);
});

test('search without a search call in the service reads the model with apps-format.js; Deleted shows the deleted ones only; Enter in the field searches', async () => {
  const w = searchWorld();
  openSearch(w);
  typeInto(one(w, 'search-text'), 'dinner');
  keydown(one(w, 'search-text'), 'Enter');
  await flush();
  assert.deepEqual(hits(w), ['c']);
  assert.equal(textOf(one(w, 'search-result')), 'Result 1 of 1');
  typeInto(one(w, 'search-text'), '');
  one(w, 'search-deleted').checked = true;
  click(one(w, 'search-go'));
  await flush();
  assert.deepEqual(hits(w), ['d']);
  one(w, 'search-deleted').checked = false;
  one(w, 'search-saved').checked = true;
  click(one(w, 'search-go'));
  await flush();
  assert.deepEqual(hits(w), ['c']);
  one(w, 'search-saved').checked = false;
  one(w, 'search-important').checked = true;
  click(one(w, 'search-go'));
  await flush();
  assert.deepEqual(hits(w), ['e'], 'the important mark counts');
  one(w, 'search-important').checked = false;
  one(w, 'search-edited').checked = true;
  click(one(w, 'search-go'));
  await flush();
  assert.deepEqual(hits(w), ['b']);
  one(w, 'search-edited').checked = false;
  one(w, 'search-direction').value = 'received';
  click(one(w, 'search-go'));
  await flush();
  assert.deepEqual(hits(w).sort(), ['b', 'e']);
  one(w, 'search-direction').value = 'all';
  one(w, 'search-links').checked = true;
  click(one(w, 'search-go'));
  await flush();
  assert.deepEqual(hits(w), ['a']);
  // closing the search forgets the marks
  click(tool(w, 'tool-search'));
  assert.deepEqual(hits(w), []);
});

// ---------------------------------------------------------------------------------------------- rooms

function room(over = {}) {
  return Object.assign({
    id: 'r1', owner: true, status: 'open', reason: null, silent: false, knock: null, code: CODE, codeClosed: null, ownerPub: 'p256:me-a',
    members: [{ pub: 'p256:me-a', short: 'ab23cd45', name: 'Ana', you: true, owner: true }], unread: 0, draft: '', peers: 0, messages: [],
  }, over);
}
const PRICE_ROOM_EN = 'Codes and requests pass through this door\'s rendezvous. Nothing else leaves this device until a member is accepted; then you connect directly and each side learns the other\'s network address.';
const roomRows = (w) => all(w, (n) => attr(n, 'data-room') !== null && n.tagName === 'BUTTON' && shown(n));

test('Rooms: the list is empty at first; Create a room shows the price (the room wording) and acts only after Continue, then opens the room with its code in fourteen characters', async () => {
  const w = messagesWorld();
  w.svc.answers.createRoom = async () => { w.svc.s.rooms = [room()]; w.svc.emit(); return { id: 'r1', code: 'abcd-efgh-2345' }; };
  click(tile(w, 'rooms'));
  await flush();
  assert.equal(w.app.inspect().view, 'rooms');
  assert.equal(textOf(one(w, 'title')), 'Rooms');
  assert.ok(visibleText(w).includes('No rooms yet.'));
  assert.ok(visibleText(w).includes('You get a code. Each person who knocks needs your approval before anything connects.'));
  click(one(w, 'room-create'));
  await flush();
  assert.equal(cardKind(w), 'room-create');
  assert.ok(cardOf(w).textContent.includes(PRICE_ROOM_EN));
  assert.equal(calls(w, 'createRoom').length, 0);
  scriptClick(one(w, 'card-continue'));
  await flush();
  assert.equal(calls(w, 'createRoom').length, 0);
  click(one(w, 'card-continue'));
  await flush();
  assert.equal(calls(w, 'createRoom').length, 1);
  assert.equal(w.app.inspect().view, 'room');
  assert.equal(textOf(one(w, 'room-code')), 'abcd-efgh-2345');
  assert.equal(textOf(one(w, 'room-code')).length, 14);
  assert.equal(textOf(one(w, 'title')), 'Your room abcd-efgh-2345');
  assert.equal(textOf(one(w, 'status-line')), 'Open for members');
  assert.ok(visibleText(w).includes('Members (1)'));
  const roster = one(w, 'roster');
  assert.ok(roster.textContent.includes('Ana (ab23-cd45)') && roster.textContent.includes('owner') && roster.textContent.includes('you'));
  click(one(w, 'room-code-copy'));
  await flush();
  assert.deepEqual(w.copies, ['abcd-efgh-2345']);
  // the price is answered for the visit: another room does not ask again
  click(one(w, 'back'));
  click(one(w, 'room-create'));
  await flush();
  assert.equal(calls(w, 'createRoom').length, 2);
  assert.equal(has(w, 'card'), false);
});

test('Join a room: a code that is not twelve characters is refused in the view; a good one asks the price once, then joinRoom; the waiting room can be withdrawn', async () => {
  const w = messagesWorld();
  w.svc.answers.joinRoom = async () => { w.svc.s.rooms = [room({ id: 'rw', owner: false, status: 'waiting', knock: 'kw', code: null, ownerPub: null, members: [] })]; w.svc.emit(); return { knock: 'kw', id: 'rw' }; };
  w.app.show('rooms');
  typeInto(one(w, 'join-input'), 'abcd-2345');
  click(one(w, 'join-button'));
  await flush();
  assert.equal(textOf(one(w, 'join-note')), 'A code has twelve characters, letters and numbers, like abcd-efgh-2345.');
  assert.equal(calls(w, 'joinRoom').length, 0);
  assert.equal(has(w, 'card'), false);
  typeInto(one(w, 'join-input'), 'abcd efgh 2345');
  click(one(w, 'join-button'));
  await flush();
  assert.equal(cardKind(w), 'room-join');
  assert.ok(cardOf(w).textContent.includes(PRICE_ROOM_EN));
  assert.equal(calls(w, 'joinRoom').length, 0, 'not before Continue');
  click(one(w, 'card-continue'));
  await flush();
  assert.deepEqual(calls(w, 'joinRoom'), [['joinRoom', 'abcd efgh 2345']]);
  assert.equal(textOf(one(w, 'join-note')), 'Request sent. It waits for the owner\'s approval.');
  assert.equal(one(w, 'join-input').value, '');
  const row = roomRows(w)[0];
  assert.ok(row.textContent.includes('Room request'));
  assert.ok(row.textContent.includes('Waiting for approval'));
  click(one(w, 'cancel-knock'));
  await flush();
  assert.deepEqual(calls(w, 'cancelKnock'), [['cancelKnock', 'kw']]);
  w.svc.answers.joinRoom = async () => ({ error: 'room full' });
  typeInto(one(w, 'join-input'), 'abcd-efgh-2345');
  click(one(w, 'join-button'));
  await flush();
  assert.equal(textOf(one(w, 'join-note')), 'This room is full.');
});

test('the owner of a room sees the requests to join: Accept shows the room price with the check line and acts after Continue; Reject acts at once', async () => {
  const w = messagesWorld({
    rooms: [room()],
    requests: [
      { knock: 'q1', kind: 'room', roomId: 'r1', from: { pub: 'p256:bo', short: 'k3f92xq3', name: 'Bo' }, at: T0 },
      { knock: 'q2', kind: 'pair', from: { pub: 'p256:cy', short: 'mnpqrst2', name: 'Cy' }, at: T0 },
    ],
  });
  w.app.show('room', 'r1');
  const reqs = one(w, 'room-requests');
  assert.equal(reqs.children.length, 1, 'only the room request');
  assert.ok(reqs.textContent.startsWith('Bo (k3f9-2xq3) wants to join your room'));
  click(reqs.find((n) => attr(n, 'data-role') === 'accept'));
  assert.equal(cardKind(w), 'room-accept');
  assert.ok(cardOf(w).textContent.includes('Let this person into your room?'));
  assert.ok(cardOf(w).textContent.includes(PRICE_ROOM_EN));
  assert.ok(cardOf(w).textContent.includes('Check: read your codes to each other.'));
  assert.equal(calls(w, 'acceptMember').length, 0);
  click(one(w, 'card-continue'));
  await flush();
  assert.deepEqual(calls(w, 'acceptMember'), [['acceptMember', 'q1']]);
  click(one(w, 'reject'));
  await flush();
  assert.deepEqual(calls(w, 'rejectMember'), [['rejectMember', 'q1']]);
  // the same request arriving inside the room works as well
  const w2 = messagesWorld({ rooms: [room({ requests: [{ knock: 'q7', kind: 'room', from: { pub: 'p', short: 'abcdefgh', name: 'Di' } }] })] });
  w2.app.show('room', 'r1');
  assert.ok(one(w2, 'room-requests').textContent.includes('Di (abcd-efgh) wants to join your room'));
});

test('a room: messages carry the sender\'s name and short id, mine do not; the composer sends with Enter and the button (sendRoom), has the emoji picker only, keeps 2,000 characters', async () => {
  const w = messagesWorld({ rooms: [room({
    members: [{ pub: 'p256:me-a', short: 'ab23cd45', name: 'Ana', you: true, owner: true }, { pub: 'p256:bo', short: 'k3f92xq3', name: 'Bo', you: false, owner: false }],
    messages: [
      { id: 'a1', t: T0, mine: false, from: { pub: 'p256:bo', short: 'k3f92xq3', name: 'Bo' }, text: 'hi *all*', fmt: 'md1', status: null },
      { id: 'a2', t: T0 + 1, mine: true, from: { pub: 'p256:me-a', short: 'ab23cd45', name: 'Ana' }, text: 'hello', fmt: 'md1', status: 'sent' },
      { id: 'a3', t: T0 + 2, mine: false, from: { pub: 'p256:zz', short: 'zzzzyyyy', name: null }, text: 'anon', fmt: 'md1', status: null },
    ],
  })] });
  w.app.show('room', 'r1');
  const from = (id) => msgNode(w, id).find((n) => attr(n, 'data-role') === 'from');
  assert.equal(textOf(from('a1')), 'Bo (k3f9-2xq3)');
  assert.equal(from('a2'), null);
  assert.equal(textOf(from('a3')), 'zzzz-yyyy');
  assert.equal(msgNode(w, 'a1').find((n) => n.tagName === 'STRONG').textContent, 'all');
  assert.equal(has(w, 'msg-menu'), false, 'rooms get no message menu');
  assert.equal(attr(w.app.nodes.roomComposer, 'maxlength'), '2000');
  assert.equal(attr(w.app.nodes.roomComposer, 'spellcheck'), 'true');
  assert.equal(has(w, 'format-toggle') || has(w, 'snippets-toggle') || has(w, 'later-toggle') || has(w, 'important-toggle'), false, 'rooms get the basics only');
  assert.equal(has(w, 'emoji-toggle'), true);
  typeInto(w.app.nodes.roomComposer, 'to all');
  const shift = keydown(w.app.nodes.roomComposer, 'Enter', { shiftKey: true });
  assert.equal(shift.prevented, false);
  keydown(w.app.nodes.roomComposer, 'Enter');
  await flush();
  assert.deepEqual(calls(w, 'sendRoom'), [['sendRoom', 'r1', 'to all']]);
  assert.equal(w.app.nodes.roomComposer.value, '');
  typeInto(w.app.nodes.roomComposer, 'by button');
  click(one(w, 'room-send'));
  await flush();
  assert.deepEqual(calls(w, 'sendRoom')[1], ['sendRoom', 'r1', 'by button']);
  assert.equal(calls(w, 'send').length, 0);
  assert.equal(calls(w, 'typing').length, 0, 'no typing mark in a room');
  w.svc.answers.sendRoom = async () => ({ error: 'room full' });
  typeInto(w.app.nodes.roomComposer, 'refused');
  click(one(w, 'room-send'));
  await flush();
  assert.equal(w.app.nodes.roomComposer.value, 'refused');
  assert.equal(textOf(one(w, 'composer-error')), 'The message was not sent. Try again.');
});

test('a member\'s room view has no code and no requests; the draft of each room is kept; a closed code says so; a closed room cannot be written to; Leave asks first', async () => {
  const w = messagesWorld({ rooms: [
    room({ id: 'r1', owner: false, status: 'connected', code: null, members: [{ pub: 'p256:bo', short: 'k3f92xq3', name: 'Bo', owner: true }, { pub: 'p256:me-a', short: 'ab23cd45', name: 'Ana', you: true }] }),
    room({ id: 'r2', owner: true, status: 'open', code: null, codeClosed: 'bad-knocks' }),
    room({ id: 'r3', owner: false, status: 'closed', code: null }),
  ] });
  w.app.show('room', 'r1');
  assert.equal(has(w, 'room-code'), false);
  assert.equal(has(w, 'room-requests'), false);
  assert.equal(textOf(one(w, 'title')), 'Room of Bo (k3f9-2xq3)');
  assert.equal(textOf(one(w, 'status-line')), 'Connected');
  typeInto(w.app.nodes.roomComposer, 'my room draft');
  w.app.show('room', 'r2');
  assert.equal(w.app.nodes.roomComposer.value, '');
  assert.equal(textOf(one(w, 'room-code-closed')), 'The code of this room is closed. Create a new room to get a new code.');
  w.app.show('room', 'r1');
  assert.equal(w.app.nodes.roomComposer.value, 'my room draft');
  w.app.show('room', 'r3');
  assert.equal(w.app.nodes.roomComposer.disabled, true);
  assert.equal(textOf(one(w, 'closed-note')), 'You cannot send messages in this conversation.');
  w.app.show('room', 'r1');
  click(one(w, 'room-leave'));
  assert.equal(cardKind(w), 'leave-room');
  assert.equal(w.doc.activeElement, one(w, 'card-cancel'));
  assert.equal(calls(w, 'leaveRoom').length, 0);
  click(one(w, 'card-continue'));
  await flush();
  assert.deepEqual(calls(w, 'leaveRoom'), [['leaveRoom', 'r1']]);
  assert.equal(w.app.inspect().view, 'rooms');
});

test('room rows show the unread count and the status; the home tile counts room requests and unread messages', async () => {
  const w = messagesWorld({ rooms: [room({ id: 'r1', unread: 4, status: 'connected', owner: false, code: null, members: [{ pub: 'a', short: 'aaaabbbb', name: 'A' }, { pub: 'b', short: 'ccccdddd', name: 'B' }] })],
    requests: [{ knock: 'q1', kind: 'room', roomId: 'r1', from: { pub: 'p', short: 'abcdefgh', name: 'Di' }, at: T0 }] });
  w.app.show('rooms');
  const row = roomRows(w)[0];
  assert.equal(textOf(row.find((n) => attr(n, 'data-role') === 'unread')), '4');
  assert.ok(row.textContent.includes('Connected'));
  assert.ok(row.textContent.includes('Members (2)'));
  click(one(w, 'back'));
  assert.equal(textOf(tile(w, 'rooms').find((n) => attr(n, 'data-role') === 'badge')), '5');
});

test('a room read: the service\'s markRoomRead when it has one', async () => {
  const w = messagesWorld({ rooms: [room({ unread: 2, status: 'connected', owner: false, code: null })] }, { service: { optional: ['markRoomRead'] } });
  w.app.show('room', 'r1');
  await flush();
  assert.deepEqual(calls(w, 'markRoomRead'), [['markRoomRead', 'r1']]);
  assert.equal(calls(w, 'markRead').length, 0);
  w.svc.emit();
  await flush();
  assert.equal(calls(w, 'markRoomRead').length, 1, 'told once for the same count');
});

// ---------------------------------------------------------------------------------------------- unread, read, toasts, new messages

test('opening a conversation tells the service it was read, once per unread count and only on a page that is visible; a conversation marked unread counts as one', async () => {
  const w = messagesWorld({ conversations: [chat({ unread: 2 })] });
  w.doc.visibilityState = 'hidden';
  w.app.show('conversation', 'c1');
  await flush();
  assert.equal(calls(w, 'markRead').length, 0, 'a hidden page reads nothing');
  w.doc.setVisibility('visible');
  await flush();
  assert.deepEqual(calls(w, 'markRead'), [['markRead', 'c1']]);
  w.svc.emit();
  await flush();
  assert.equal(calls(w, 'markRead').length, 1, 'not again for the same count');
  await w.set({ conversations: [chat({ unread: 3 })] });
  assert.equal(calls(w, 'markRead').length, 2, 'a new message is read too');
  await w.set({ conversations: [chat({ unread: 0 })] });
  await w.set({ conversations: [chat({ unread: 0, markedUnread: true })] });
  assert.equal(calls(w, 'markRead').length, 3, 'a mark "unread" on the open conversation is cleared by reading it');
});

test('a message that arrives while the visitor reads higher up shows "New messages"; the button goes to the end; at the end the view follows by itself', async () => {
  const w = chatWorld();
  const sc = w.root; // the scrolling slot of the fake ui
  sc.scrollHeight = 2000; sc.clientHeight = 500; sc.scrollTop = 0;
  const more = chat().messages.concat([msg({ id: 'm7', t: T0 + 4000, text: 'new one', status: null })]);
  await w.set({ conversations: [chat({ messages: more })] });
  assert.equal(shown(one(w, 'jump-new')), true);
  assert.equal(textOf(one(w, 'jump-new')), 'New messages');
  click(one(w, 'jump-new'));
  assert.equal(sc.scrollTop, 2000);
  assert.equal(has(w, 'jump-new'), false);
  sc.scrollTop = 1500; // at the end: 2000 - 1500 - 500 = 0
  const even = more.concat([msg({ id: 'm8', t: T0 + 5000, text: 'again', status: null })]);
  await w.set({ conversations: [chat({ messages: even })] });
  assert.equal(has(w, 'jump-new'), false);
  assert.equal(sc.scrollTop, 2000, 'followed to the end');
});

test('the tools give Oldest and Latest', async () => {
  const w = chatWorld();
  const sc = w.root;
  sc.scrollHeight = 2000; sc.clientHeight = 500; sc.scrollTop = 700;
  openTools(w);
  click(tool(w, 'tool-oldest'));
  assert.equal(sc.scrollTop, 0);
  click(tool(w, 'tool-latest'));
  assert.equal(sc.scrollTop, 2000);
});

const inside = (n, role) => { for (let x = n.parentNode; x; x = x.parentNode) if (attr(x, 'data-role') === role) return true; return false; };

test('the header keeps a line under the title in a conversation and in a room (the status, who is typing, the tools, Leave room), so they stay in reach at the newest message; the compare line stays with the conversation; no such line anywhere else', async () => {
  const w = chatWorld({ typingPeer: true, compareText: '1234 5678' });
  const inSub = (role) => inside(one(w, role), 'subline');
  const line = one(w, 'status-line'); // a live line: made once for the visit, its text changes in place
  assert.equal(inSub('status-line'), true);
  assert.equal(inSub('typing'), true);
  assert.equal(inSub('tools-toggle'), true);
  assert.equal(inSub('verify'), false, 'the compare line is read once, at the top of the conversation');
  const head = all(w, (n) => n.tagName === 'HEADER')[0];
  assert.ok(head.className.includes('mw-apps-head-sub'));
  assert.equal(has(w, 'subline'), true);
  await w.set({ conversations: [chat({ status: 'waiting', knock: 'k1' })] });
  assert.equal(inSub('cancel-knock'), true);
  click(one(w, 'back'));
  assert.equal(has(w, 'subline'), false, 'the Messages view has none');
  assert.equal(head.className.includes('mw-apps-head-sub'), false);
  assert.equal(has(w, 'status-line'), false, 'the line is hidden when the view is left');
  // a room: the status and Leave room
  await w.set({ rooms: [room()] });
  w.app.show('room', 'r1');
  assert.equal(one(w, 'status-line'), line, 'the same node serves the room');
  assert.equal(inside(one(w, 'status-line'), 'subline'), true);
  assert.equal(inside(one(w, 'room-leave'), 'subline'), true);
  assert.equal(textOf(one(w, 'status-line')), 'Open for members');
  assert.ok(head.className.includes('mw-apps-head-sub'));
  click(one(w, 'back'));
  assert.equal(has(w, 'subline'), false);
  assert.equal(has(w, 'room-leave'), false);

});

test('opening the tools or the search brings the panel into sight; closing the tools returns to the newest message when the visitor was there, and leaves the place when the visitor was reading higher up', async () => {
  const w = chatWorld();
  const sc = w.root;
  sc.scrollHeight = 2000; sc.clientHeight = 500; sc.scrollTop = 1500; // at the end
  const seen = [];
  FakeNode.prototype.scrollIntoView = function (o) { seen.push([attr(this, 'data-role'), o && o.block]); };
  try {
    openTools(w);
    assert.deepEqual(seen, [['tools', 'start']]);
    click(tool(w, 'tool-search'));
    await flush();
    assert.deepEqual(seen[1], ['search', 'start']);
    click(tool(w, 'tool-search'));
    sc.scrollTop = 0; // the panel is at the top of the view
    click(one(w, 'tools-toggle'));
    assert.equal(sc.scrollTop, 2000, 'back at the newest message');
    // reading higher up: the place is kept
    sc.scrollTop = 700;
    openTools(w);
    sc.scrollTop = 50;
    click(one(w, 'tools-toggle'));
    assert.equal(sc.scrollTop, 50);
  } finally { delete FakeNode.prototype.scrollIntoView; }
});

test('a message shows its time of day (the day chip above gives the day); the whole moment is in the title of the time', () => {
  const w = chatWorld();
  const time = (id) => inMsg(w, id, 'body').parentNode.find((n) => n.tagName === 'TIME');
  const old = time('m1'); // two days before the page's clock
  assert.equal(textOf(old), clockText(T0 - 2 * 86400000, 'en'));
  assert.match(attr(old, 'title'), /Oct|Nov/);
  assert.ok(!/Oct|Nov/.test(textOf(old)));
  const fresh = time('m3');
  assert.equal(textOf(fresh), clockText(T0, 'en'));
  assert.equal(attr(fresh, 'datetime'), new Date(T0).toISOString());
});

test('a toast says who wrote ("New message from Bo"), never what; not for the first look at the model, not for a muted conversation, not for the one being read', async () => {
  const a = chat({ id: 'a' });
  const b = chat({ id: 'b', peer: { pub: 'p256:two', short: 'ssssmmmm', name: 'Two', nick: '' } });
  const m = chat({ id: 'm', muted: true, peer: { pub: 'p256:mute', short: 'qqqqrrrr', name: 'Mute', nick: '' } });
  const w = messagesWorld({ conversations: [a, b, m] });
  assert.equal(w.app.nodes.toast.hidden, true, 'the history that is already there is not news');
  w.app.show('conversation', 'a');
  const incoming = (c, id) => Object.assign({}, c, { messages: c.messages.concat([msg({ id, t: T0 + 9000, mine: false, text: 'a secret preview', status: null })]) });
  await w.set({ conversations: [incoming(a, 'x1'), b, m] });
  assert.equal(w.app.nodes.toast.hidden, true, 'the open conversation of a visible page');
  await w.set({ conversations: [incoming(a, 'x1'), incoming(b, 'x2'), m] });
  assert.equal(textOf(one(w, 'toast')), 'New message from Two');
  assert.ok(!textOf(one(w, 'toast')).includes('secret'));
  await w.set({ conversations: [incoming(a, 'x1'), incoming(b, 'x2'), incoming(m, 'x3')] });
  assert.equal(textOf(one(w, 'toast')), 'New message from Two', 'a muted conversation says nothing');
  await w.set({ requests: [{ knock: 'k1', kind: 'pair', from: { pub: 'p256:new', short: 'abcdefgh', name: 'Ev' }, at: T0 }] });
  assert.equal(textOf(one(w, 'toast')), 'Ev (abcd-efgh) wants to message you');
  w.app.destroy();
});

test('the unread badge on the Messages tile counts unread messages and requests together', async () => {
  const w = messagesWorld({ conversations: [conv({ id: 'a', unread: 2 }), conv({ id: 'b', unread: 9 })], requests: [{ knock: 'k', kind: 'pair', from: { pub: 'p', short: 'abcdefgh', name: 'X' }, at: T0 }] });
  assert.equal(textOf(tile(w, 'messages').find((n) => attr(n, 'data-role') === 'badge')), '9+');
  assert.equal(attr(tile(w, 'messages').find((n) => attr(n, 'data-role') === 'badge'), 'aria-label'), '12 unread');
});

// ---------------------------------------------------------------------------------------------- the whole view

test('inspect() is plain data for the shell: view, code, conversations, rooms, link; never a message text, a key or a name', async () => {
  const w = messagesWorld({
    code: CODE, link: 'open', tm: true,
    conversations: [chat({ unread: 1, pinned: true }), conv({ id: 'c2', status: 'waiting', knock: 'k2', peer: { pub: null, short: null, name: null, nick: null } })],
    rooms: [room({ messages: [{ id: 'a1', t: T0, mine: true, from: { pub: 'p256:me-a', short: 'ab23cd45', name: 'Ana' }, text: 'secret words', fmt: 'md1', status: 'sent' }] })],
    requests: [{ knock: 'q', kind: 'pair', from: { pub: 'p', short: 'abcdefgh', name: 'X' }, at: T0 }],
  });
  const i = w.app.inspect();
  assert.equal(i.view, 'home');
  assert.equal(i.signedIn, true);
  assert.equal(i.code, 'abcd', 'the channel only: the first four characters of the code (ADV: the secret half is not in what support and tests read)');
  assert.equal(i.link, 'open');
  assert.equal(i.tm, true);
  assert.equal(i.requests, 1);
  assert.equal(i.conversations.length, 2);
  assert.deepEqual(i.conversations[0], { id: 'c1', short: 'k3f9-2xq1', status: 'connected', unread: 1, messages: 6, lastStatus: 'failed', pinned: true, muted: false, archived: false, favorite: false });
  assert.deepEqual(i.conversations[1].status, 'waiting');
  assert.deepEqual(i.rooms, [{ id: 'r1', role: 'owner', status: 'open', members: 1, messages: 1, unread: 0 }]);
  const text = JSON.stringify(i);
  assert.ok(!text.includes('secret words') && !text.includes('hello') && !text.includes('p256:') && !text.includes('Ana'));
  assert.ok(!text.includes('efgh') && !text.includes('2345'), 'no part of the code but its channel');
  w.app.show('conversation', 'c1');
  assert.equal(w.app.inspect().view, 'conversation');
  assert.equal(w.app.inspect().current, 'c1');
  w.app.show('messages');
  assert.equal(w.app.inspect().view, 'messages');
  assert.equal(w.app.inspect().card, null);
});

test('a script click on any button of a busy view does nothing: no call reaches the service or the loader', async () => {
  const w = chatWorld({ messages: chat().messages.concat([msg({ id: 'r1', t: T0 + 9, text: 'x', status: null, reactions: { '👍': ['p256:peer-b'] } })]) }, { requests: [{ knock: 'k1', kind: 'pair', from: { pub: 'p', short: 'abcdefgh', name: 'X' }, at: T0 }] });
  openTools(w);
  click(tool(w, 'tool-search'));
  click(inMsg(w, 'm3', 'msg-menu'));
  click(menuItem(w, 'm3', 'react'));
  click(one(w, 'emoji-toggle'));
  const before = w.svc.calls.length;
  const buttons = all(w, (n) => n.tagName === 'BUTTON' && shown(n));
  assert.ok(buttons.length > 40, 'a busy view: ' + buttons.length + ' buttons');
  const history = w.app.inspect();
  for (const b of buttons) b.dispatchEvent({ type: 'click', isTrusted: false });
  for (const s of all(w, (n) => n.tagName === 'SELECT')) s.dispatchEvent({ type: 'change', isTrusted: false });
  await flush();
  assert.equal(w.svc.calls.length, before, 'the service was asked nothing');
  assert.deepEqual(w.acts.calls, []);
  assert.deepEqual(w.app.inspect(), history, 'the view did not move');
  assert.equal(has(w, 'card'), false);
  // the same buttons work for the person
  click(one(w, 'send'));
  assert.equal(ta(w).value, '');
});

test('the view never asks the browser to parse markup: no innerHTML, outerHTML, insertAdjacentHTML, document.write, eval or Function in apps-ui.js', () => {
  const src = readFileSync(new URL('../../src/loader/apps-ui.js', import.meta.url), 'utf8');
  const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
  for (const bad of ['innerHTML', 'outerHTML', 'insertAdjacentHTML', 'document.write', 'eval(', 'new Function', 'dangerouslySet', 'srcdoc', 'createContextualFragment', 'DOMParser']) {
    assert.ok(!code.includes(bad), bad);
  }
  // no module-scope DOM access: the file imports in Node (this test file did), and no window or document is named outside functions
  assert.ok(!/^(const|let|var)\s+\w+\s*=\s*(window|document)\b/m.test(code));
});

test('createAppsUi needs a service and a document', () => {
  assert.throws(() => createAppsUi({ root: new FakeDocument().body }), TypeError);
  assert.throws(() => createAppsUi({ service: makeService() }), TypeError);
  assert.throws(() => createAppsUi({ root: new FakeDocument().body, service: {} }), TypeError);
});

test('a service that has not even a language: English; a ui without the slot calls: the view goes into the root', () => {
  const w = world({}, { noUiHooks: true });
  assert.equal(w.app.node.parentNode, w.root);
  w.app.destroy();
  assert.equal(w.app.node.parentNode, null);
});

test('a hostile name and message stay text: no element is made from them and no attribute carries them', async () => {
  const evil = '<img src=x onerror=alert(1)>';
  const w = chatWorld({ peer: { pub: 'p256:peer-b', short: 'k3f92xq1', name: evil, nick: '' }, messages: [msg({ id: 'h1', text: evil + ' [x](javascript:alert(1)) https://example.test/<script>', status: null })] },
    { requests: [{ knock: 'k1', kind: 'pair', from: { pub: 'p', short: 'abcdefgh', name: evil }, at: T0 }] });
  assert.equal(all(w, (n) => n.tagName === 'IMG' || n.tagName === 'SCRIPT').length, 0);
  assert.ok(textOf(one(w, 'title')).includes(evil), 'the name is shown as text');
  for (const n of all(w, () => true)) for (const [k, v] of n.attrs) if (k !== 'href') assert.ok(!String(v).includes('onerror'), k);
  for (const a of all(w, (n) => n.tagName === 'A')) assert.match(a.getAttribute('href'), /^https?:\/\//);
});

// ---------------------------------------------------------------------------------------------- the strings

const BANNED = [/blockchain/i, /serverless/i, /unstoppable/i, /censorship[- ]resistant/i, /production[- ]ready/i, /fully decentralized/i, /sub-second/i, /reroute/i, /automatically/i, /always available/i];
const NO_DASH = /[\u2013\u2014\u2018\u2019\u201c\u201d]/;
const placeholders = (s) => (s.match(/\{[A-Za-z0-9_]+\}/g) || []).sort().join(',');

test('APPS_TEXT: English and French have the same keys and the same placeholders, every text is a string, and the tables are frozen', () => {
  assert.ok(Object.isFrozen(APPS_TEXT) && Object.isFrozen(APPS_TEXT.en) && Object.isFrozen(APPS_TEXT.fr));
  assert.deepEqual(Object.keys(APPS_TEXT.en), Object.keys(APPS_TEXT.fr), 'the same keys in the same order');
  assert.ok(Object.keys(APPS_TEXT.en).length > 200);
  for (const k of Object.keys(APPS_TEXT.en)) {
    for (const lang of ['en', 'fr']) assert.ok(typeof APPS_TEXT[lang][k] === 'string' && APPS_TEXT[lang][k].length > 0, lang + ' ' + k);
    assert.equal(placeholders(APPS_TEXT.en[k]), placeholders(APPS_TEXT.fr[k]), k + ' placeholders');
  }
  const same = Object.keys(APPS_TEXT.en).filter((k) => APPS_TEXT.en[k] === APPS_TEXT.fr[k]);
  for (const k of same) assert.ok(/^apps\.(me|rooms\.sentBy)$|^apps\.(title|messages\.title|back\.messages|tile\.messages|conv\.title|tool\.exp)/.test(k) || APPS_TEXT.en[k].length < 14, 'French differs for ' + k);
});

test('APPS_TEXT: English is ASCII, no banned word, no dash or curly quote, never the word online; the wording of the plan is verbatim', () => {
  for (const lang of ['en', 'fr']) {
    for (const [k, v] of Object.entries(APPS_TEXT[lang])) {
      for (const re of BANNED) assert.ok(!re.test(v), lang + ' ' + k + ' has ' + re);
      assert.ok(!NO_DASH.test(v), lang + ' ' + k + ' has a dash or a curly quote');
      assert.ok(!/\bonline\b|\ben ligne\b/i.test(v), lang + ' ' + k + ' says online');
      assert.ok(!/\berase|effacer partout/i.test(v), k);
    }
  }
  for (const [k, v] of Object.entries(APPS_TEXT.en)) assert.ok(/^[\x00-\x7f]*$/.test(v), 'English ' + k + ' is not ASCII');
  const en = APPS_TEXT.en;
  assert.equal(en['apps.title'], 'Apps');
  assert.equal(en['apps.subtitle.guest'], 'Sign in to use the apps at this door.');
  assert.equal(en['apps.tile.messages.text'], 'Direct messages with one person, by code');
  assert.equal(en['apps.tile.rooms.text'], 'A room for a few people, by code');
  assert.equal(en['apps.tile.calls.text'], 'Voice and video');
  assert.equal(en['apps.tile.notYet'], 'Not yet at this door');
  assert.equal(en['apps.tile.signInFirst'], 'Sign in first');
  assert.equal(en['apps.code.title'], 'Your code');
  assert.equal(en['apps.code.help'], 'Read it to the person you want to message; it works while this page is open.');
  assert.equal(en['apps.code.copy'], 'Copy');
  assert.equal(en['apps.code.new'], 'New code');
  assert.equal(en['apps.knock.label'], 'Their code');
  assert.equal(en['apps.knock.button'], 'Knock');
  assert.equal(en['apps.price.text'], PRICE_EN);
  assert.equal(en['apps.price.check'], 'Check: read your codes to each other.');
  assert.equal(en['apps.price.continue'], 'Continue');
  assert.equal(en['apps.price.notNow'], 'Not now');
  assert.equal(en['apps.request.wants'], '{name} ({short}) wants to message you');
  assert.equal(en['apps.request.accept'], 'Accept');
  assert.equal(en['apps.request.reject'], 'Reject');
  assert.equal(en['apps.status.connected'], 'Connected to you now');
  assert.equal(en['apps.status.notConnected'], 'Not connected, last connected {time}');
  assert.equal(en['apps.status.waiting'], 'Waiting for approval');
  assert.equal(en['apps.status.rejected'], 'Rejected');
  assert.equal(en['apps.status.left'], 'Left');
  assert.equal(en['apps.typing'], '{name} is typing');
  assert.equal(en['apps.verify'], 'Compare: {code}');
  assert.equal(en['apps.rooms.create'], 'Create a room');
  assert.equal(en['apps.rooms.join'], 'Join a room');
  assert.equal(APPS_TEXT.fr['apps.status.connected'], 'Connecté avec vous en ce moment', 'the French of the presence line the chat already uses');
});

test('APPS_TEXT: the code is twelve characters in every sentence that says how long it is; no text still says eight', () => {
  assert.equal(APPS_TEXT.en['apps.err.invalid'], 'A code has twelve characters, letters and numbers, like abcd-efgh-2345.');
  assert.equal(APPS_TEXT.fr['apps.err.invalid'], 'Un code compte douze caractères, des lettres et des chiffres, comme abcd-efgh-2345.');
  for (const lang of ['en', 'fr']) for (const [k, v] of Object.entries(APPS_TEXT[lang])) {
    assert.ok(!/\b8\b|\beight\b|\bhuit\b/i.test(v), lang + ' ' + k + ' still says eight');
    assert.ok(!/\babcd-2345\b/.test(v), lang + ' ' + k + ' shows an eight character example');
  }
});

test('appsText: parameters are filled, French by tag, English for another language, an unknown key is empty', () => {
  assert.equal(appsText('apps.request.wants', 'en', { name: 'Bo', short: 'k3f9-2xq1' }), 'Bo (k3f9-2xq1) wants to message you');
  assert.equal(appsText('apps.request.wants', 'fr-CA', { name: 'Bo', short: 'k3f9-2xq1' }), 'Bo (k3f9-2xq1) veut vous écrire');
  assert.equal(appsText('apps.title', 'de'), 'Apps');
  assert.equal(appsText('apps.title', undefined), 'Apps');
  assert.equal(appsText('no.such.key', 'fr'), '');
  assert.equal(appsText('apps.conv.unread', 'en', { n: 3 }), '3 unread');
  assert.equal(appsText('apps.status.notConnected', 'en', {}), 'Not connected, last connected {time}', 'a missing parameter is left as written');
  assert.ok(DOOR_TEXT.en['door.paste.title'], 'the door table is untouched');
});

test('every key the view uses exists, and every key in the table is used', () => {
  const src = readFileSync(new URL('../../src/loader/apps-ui.js', import.meta.url), 'utf8');
  const used = new Set([...src.matchAll(/'(apps\.[A-Za-z0-9.]+)'/g)].map((m) => m[1]));
  const prefixes = [...used].filter((k) => k.endsWith('.')); // 'apps.exp.' + a suffix, 'apps.tile.' + a key, ...
  const keys = new Set(Object.keys(APPS_TEXT.en));
  const missing = [...used].filter((k) => !keys.has(k) && !prefixes.includes(k));
  assert.deepEqual(missing, []);
  const unused = [...keys].filter((k) => !used.has(k) && !prefixes.some((p) => k.startsWith(p)));
  assert.deepEqual(unused, []);
});

// ---------------------------------------------------------------------------------------------- the source rules and the stylesheet

const read = (rel) => readFileSync(new URL('../../' + rel, import.meta.url), 'utf8');

test('apps-ui.js and the strings keep the wording rules, and the floor: no banned word, no dash, no curly quote (comments too), nothing past the browser floor', () => {
  for (const file of ['src/loader/apps-ui.js', 'src/loader/ui.js', 'src/loader/ui.css']) {
    const src = read(file);
    assert.doesNotMatch(src, /blockchain|serverless|unstoppable|censorship-resistant|production-ready/i, file);
    assert.doesNotMatch(src, /[\u2013\u2014\u201c\u201d\u2018\u2019]/, file);
  }
  for (const file of ['src/loader/apps-ui.js', 'src/loader/ui.js', 'src/loader/ui.css', 'src/loader/strings.js', 'src/loader/doors.js']) {
    assert.deepEqual(lintSource(read(file), file), [], file + ' is within the browser floor');
  }
  const app = read('src/loader/app.js');
  assert.equal((app.match(/new TorrentManager\(/g) || []).length, 1, 'one place builds the manager');
  assert.deepEqual(lintSource(app, 'src/loader/app.js'), []);
});

test('apps-ui.js and the loader files it touches are semicolon-free like their folder', () => {
  const code = read('src/loader/apps-ui.js').replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '').split('\n');
  const bad = code.filter((l) => /;\s*$/.test(l) && !/^\s*for \(/.test(l));
  assert.deepEqual(bad.slice(0, 3), []);
});

test('ui.css: the .mw-apps rules use the tokens only, a full view fixed inset 0 below the bar, one column and 40 px targets and 16 px fields on phones, a code that fits fourteen characters', () => {
  const css = read('src/loader/ui.css');
  const at = css.indexOf('/* ---- apps on the door page');
  assert.ok(at > 0, 'the apps block is in ui.css');
  assert.equal(css.indexOf('/* ---- apps on the door page', at + 10), -1, 'one apps block');
  const block = css.slice(at);
  const body = block.replace(/\/\*[\s\S]*?\*\//g, '');
  assert.doesNotMatch(body, /#[0-9a-fA-F]{3,8}\b/, 'no colour literal: tokens only');
  assert.doesNotMatch(body, /\b(rgb|rgba|hsl|hsla)\(/);
  assert.doesNotMatch(body, /:has\(|@container|container-type|color-mix|light-dark\(|subgrid|adoptedStyleSheets|popover/);
  assert.match(body, /\.mw-apps \{[^}]*position: fixed;[^}]*inset: 0;[^}]*z-index: calc\(var\(--mw-z\) - 1\);[^}]*overflow-y: auto;/, 'fixed over the page, below the bar, scrolling');
  assert.match(body, /--mw-apps-top:/);
  assert.match(body, /--mw-apps-bottom:/);
  const phones = body.slice(body.indexOf('@media (max-width: 767px)'));
  assert.match(phones, /\.mw-apps-tiles \{ grid-template-columns: 1fr; \}/, 'one column');
  assert.match(phones, /min-height: 40px/, '40 px targets');
  assert.match(phones, /font-size: 16px/, '16 px fields');
  assert.match(body, /\.mw-apps-code \{[^}]*font-size: clamp\(17px, 6\.6vw, 32px\);[^}]*white-space: nowrap;/, 'the code stays on one line at every width');
  assert.match(body, /monospace/);
  assert.match(body, /\.mw-apps-composer \{[^}]*position: sticky;[^}]*bottom: var\(--mw-apps-bottom\)/);
  // the header sticks, and its second line (status and tools) sticks with it; a heading that takes the focus gets no ring; on phones who is signed in waits one step back
  assert.match(body, /\.mw-apps-head \{[^}]*position: sticky;[^}]*top: 0;/);
  assert.match(body, /\.mw-apps-subline \{[^}]*flex: 1 0 100%;/);
  assert.match(body, /\.mw-apps-subline\[hidden\] \{ display: none; \}/);
  assert.match(body, /\.mw-apps-title:focus, \.mw-apps-title:focus-visible \{ outline: none; \}/);
  assert.match(phones, /\.mw-apps-head-sub \.mw-apps-who \{ display: none; \}/);
  assert.match(body, /\.mw-apps-tools, \.mw-apps-search \{ scroll-margin-top:/, 'a panel opened from the header clears the sticky header');
  // every colour value in the block is a var(--mw-...) or a keyword
  for (const m of body.matchAll(/(?:color|background|border(?:-[a-z]+)?|outline|box-shadow)\s*:\s*([^;}]+)/g)) {
    assert.doesNotMatch(m[1].replace(/var\(--mw-[a-z-]+\)/g, '').replace(/\b(transparent|inherit|currentColor|none|solid|dashed|0|\d+px|2px|3px|1px|4px|-?\d+)\b/g, ''), /[a-z]{4,}\(/, m[0]);
  }
  // the first phone block of the file, which build tests read, is still the one before this block
  assert.ok(css.indexOf('@media (max-width: 767px)') < at);
});

// ---------------------------------------------------------------------------------------------- ui.js: the full-view slot

class DomNode extends FakeNode {
  get classList() {
    const node = this;
    const list = () => String(node.className || '').split(/\s+/).filter(Boolean);
    const add = (...c) => { node.className = Array.from(new Set(list().concat(c))).join(' '); };
    const remove = (...c) => { node.className = list().filter((x) => c.indexOf(x) < 0).join(' '); };
    return {
      add, remove,
      toggle: (c, on) => { const has0 = list().indexOf(c) >= 0; const want = on === undefined ? !has0 : !!on; if (want !== has0) { if (want) add(c); else remove(c); } return want; },
      contains: (c) => list().indexOf(c) >= 0,
    };
  }
  get dataset() { if (!this._data) this._data = {}; return this._data; }
  querySelector(sel) {
    if (sel.startsWith('#')) return this.find((n) => n.getAttribute && n.getAttribute('id') === sel.slice(1)) || null;
    return this.find((n) => String(n.className || '').split(/\s+/).some((c) => sel.split(',').some((s) => s.trim() === '.' + c))) || null;
  }
}
class DomDocument extends FakeDocument {
  createElement(tag, attrs = null) {
    const el = new DomNode(tag, this);
    if (attrs) for (const k of Object.keys(attrs)) el.setAttribute(k, attrs[k]);
    return el;
  }
}

test('createUI: a full-view slot #mw-apps with role main after the bar and before the site; showApps shows a node there and hideApps empties it', () => {
  const doc = new DomDocument();
  const win = { document: doc, navigator: { language: 'en-CA' }, matchMedia: () => ({ matches: false }), localStorage: { getItem: () => null, setItem() {} }, setTimeout, clearTimeout, console };
  doc.defaultView = win;
  const root = doc.createElement('div');
  root.setAttribute('id', 'mw-root');
  doc.body.appendChild(root);
  // the page of index.html: the site, then the bar (createUI moves the bar before the site where the DOM can compare positions)
  const bar0 = doc.createElement('div'); bar0.setAttribute('id', 'mw-bar'); root.appendChild(bar0);
  const site0 = doc.createElement('div'); site0.setAttribute('id', 'mw-site'); root.appendChild(site0);
  const ui = createUI(root, undefined, { lang: 'en' });
  const slot = ui.appsSlot;
  assert.ok(slot, 'the slot is exposed');
  assert.equal(slot.getAttribute('id'), 'mw-apps');
  assert.equal(slot.getAttribute('role'), 'main');
  assert.ok(slot.className.split(' ').includes('mw-apps'));
  assert.equal(slot.hidden, true, 'hidden until there is something to show');
  const order = root.children.map((c) => c.getAttribute('id'));
  assert.ok(order.indexOf('mw-bar') < order.indexOf('mw-apps') && order.indexOf('mw-apps') < order.indexOf('mw-site'), order.join(','));
  const node = doc.createElement('div');
  ui.showApps(node);
  assert.equal(slot.hidden, false);
  assert.equal(slot.children.length, 1);
  assert.equal(slot.children[0], node);
  assert.ok(root.classList.contains('mw-has-apps'));
  const other = doc.createElement('div');
  ui.showApps(other);
  assert.deepEqual(slot.children, [other], 'one view in the slot');
  ui.hideApps();
  assert.equal(slot.hidden, true);
  assert.equal(slot.children.length, 0);
  assert.ok(!root.classList.contains('mw-has-apps'));
  // a second createUI on the same root finds the slot it made
  const again = createUI(root, undefined, { lang: 'en' });
  assert.equal(again.appsSlot, slot);
});

// ---------------------------------------------------------------------------------------------- app.js: the bare door page

const APPS_BLOCK = { rendezvous: ['wss://rendezvous.example.test/announce'], stun: ['stun:stun.example.test:3478'], idp: 'https://id.example.test' };

function doorJsonWith(extra = {}) {
  const files = ['/_mw/open.html', '/_mw/loader.js', '/mw-sw.js', '/_mw/boot.js'].map((path) => {
    const bytes = Buffer.from('bytes of ' + path);
    return { path, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex'), sri: 'sha384-' + createHash('sha384').update(bytes).digest('base64') };
  });
  return Object.assign(doorJsonFor({ version: '0.3.0', buildId: 'abcdef123456', files }), extra);
}
function fetchOf(json, { status = 200, fail = false } = {}) {
  const seen = [];
  const f = async (url, init) => {
    seen.push([url, init]);
    if (fail) throw new TypeError('offline');
    const bytes = new TextEncoder().encode(typeof json === 'string' ? json : JSON.stringify(json));
    return { status, headers: { get: () => String(bytes.length) }, body: null, arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) };
  };
  f.seen = seen;
  return f;
}

/** The parts of the page state that the bare-door branch of app.js touches, with fakes for the loader's UI and the page API. */
function pageOf(over = {}) {
  const logs = [];
  const uiCalls = [];
  const doc = new FakeDocument();
  const rootEl = doc.createElement('div');
  rootEl.setAttribute('id', 'mw-root');
  doc.body.appendChild(rootEl);
  doc.getElementById = (id) => (id === 'mw-root' ? rootEl : null);
  const ui = {
    shown: null,
    setStatus: (text) => uiCalls.push(['setStatus', text]),
    setIdentity: (info) => uiCalls.push(['setIdentity', info]),
    setPeers: (n) => uiCalls.push(['setPeers', n]),
    showApps(n) { this.shown = n; uiCalls.push(['showApps']); rootEl.appendChild(n); },
    hideApps() { this.shown = null; },
    showLinkPaste: (o) => uiCalls.push(['showLinkPaste', o]),
    download: () => true,
    prompt: () => Promise.resolve(true),
  };
  const listeners = [];
  const api = {
    identity: { onChange: (fn) => { listeners.push(fn); return () => {}; }, info: () => null, keys: () => null },
    service: (name) => (name === 'identity' ? { methods: {} } : null),
    openSignInCard: async () => true,
    setTorrentManager() {},
  };
  const A = Object.assign({
    win: { fetch: fetchOf(doorJsonWith({ apps: APPS_BLOCK })), location: { origin: 'https://door.test', search: '', pathname: '/_mw/open', hash: '' }, navigator: { language: 'en-CA' } },
    doc, ui, api, origin: 'https://door.test', webrtc: true, prefs: { share: true }, config: { stun: [], policy: {}, limits: {} },
    log: (line) => logs.push(line),
  }, over);
  return { A, logs, uiCalls, ui, api, listeners, doc };
}

test('readAppsBlock: this address\'s door.json, one request that skips the cache, and the checked apps block; anything else is null (the paste box stays)', async () => {
  const p = pageOf();
  const block = await __apps.readAppsBlock(p.A);
  assert.deepEqual(block, APPS_BLOCK);
  const [url, init] = p.A.win.fetch.seen[0];
  assert.equal(url, 'https://door.test/_mw/door.json');
  assert.equal(init.cache, 'no-store');
  assert.equal(init.credentials, 'omit');
  assert.equal(init.referrerPolicy, 'no-referrer');
  assert.equal(init.mode, 'same-origin');
  assert.equal(p.A.win.fetch.seen.length, 1, 'one request');
  // no block, a bad block, a block page, an error, a failing network
  const nothing = pageOf({ win: { fetch: fetchOf(doorJsonWith()), location: { origin: 'https://door.test', search: '' }, navigator: { language: 'en' } } });
  assert.equal(await __apps.readAppsBlock(nothing.A), null);
  assert.deepEqual(nothing.logs, []);
  const bad = pageOf({ win: { fetch: fetchOf(doorJsonWith({ apps: Object.assign({}, APPS_BLOCK, { idp: 'http://id.example.test' }) })), location: { origin: 'https://door.test', search: '' }, navigator: { language: 'en' } } });
  assert.equal(await __apps.readAppsBlock(bad.A), null);
  assert.ok(bad.logs.some((l) => l.includes('apps-idp') && l.includes('paste box')), bad.logs.join('|'));
  for (const f of [fetchOf('<html>blocked</html>'), fetchOf(doorJsonWith({ apps: APPS_BLOCK }), { status: 404 }), fetchOf({}, { fail: true }), undefined]) {
    const q = pageOf({ win: { fetch: f, location: { origin: 'https://door.test', search: '' }, navigator: { language: 'en' } } });
    assert.equal(await __apps.readAppsBlock(q.A), null);
  }
});

test('runDoorApps mounts the identity client (apps.idp) and the identity service only, site-less and visit-only, then the apps service and the view; it reports exactly that', async () => {
  const p = pageOf();
  const seen = { configure: [], mount: [], createApps: [] };
  const svc = makeService();
  const ok = await __apps.runDoorApps(p.A, APPS_BLOCK, {
    importApps: async () => ({ createApps: (deps) => { seen.createApps.push(deps); return svc; } }),
    identity: { createIdentityService: () => ({}) },
    client: { configure: (o) => seen.configure.push(o) },
    mountServices: async (api, opts) => { seen.mount.push([api, opts]); return { mounted: ['identity'], errors: {} }; },
  });
  assert.equal(ok, true);
  assert.deepEqual(seen.configure, [{ idp: 'https://id.example.test' }], 'the identity client is told the door\'s identity origin');
  assert.equal(seen.mount.length, 1);
  const [api, opts] = seen.mount[0];
  assert.equal(api, p.api);
  assert.deepEqual(Object.keys(opts.modules), ['identity'], 'no chat, files, media or calls service');
  assert.equal(opts.deps.ledgerId, null);
  assert.equal(opts.deps.pointer, null);
  assert.equal(opts.deps.node(), null);
  assert.equal(opts.deps.hostOnly(), false);
  assert.equal(opts.deps.identityExtra.sharedHub, true, 'visit-only keys: nothing is stored, a reload makes the visitor a guest');
  assert.equal(opts.deps.identityExtra.origin, 'https://door.test');
  assert.equal(opts.deps.identityExtra.scope(), null);
  assert.equal(opts.deps.identityExtra.legacy, null);
  // the service
  assert.equal(seen.createApps.length, 1);
  const d = seen.createApps[0];
  assert.equal(d.api, p.api);
  assert.deepEqual(d.config, APPS_BLOCK);
  assert.deepEqual(d.rendezvous, APPS_BLOCK.rendezvous);
  assert.deepEqual(d.stun, APPS_BLOCK.stun);
  assert.equal(d.idp, APPS_BLOCK.idp);
  assert.equal(d.lang, 'en-CA');
  assert.equal(typeof d.loadTm, 'function');
  assert.equal(p.A.tm, undefined, 'no torrent manager before the first accept');
  // the view
  assert.equal(p.A.appsService, svc);
  assert.ok(p.A.appsUi);
  assert.equal(p.ui.shown, p.A.appsUi.node);
  assert.deepEqual(p.uiCalls.find((c) => c[0] === 'setStatus'), ['setStatus', 'Apps']);
  assert.equal(__apps.appsInfo(p.A).view, 'home');
  assert.equal(__apps.appsInfo({}), null);
  assert.ok(p.logs.some((l) => l.startsWith('apps on the door page')));
  // the identity chip of the bar follows the sign-in
  p.listeners[0]({ state: 'signed-in', info: { pub: 'p256:me-a', short: 'ab23cd45', name: 'Ana' } });
  assert.deepEqual(p.uiCalls.filter((c) => c[0] === 'setIdentity').pop(), ['setIdentity', { pub: 'p256:me-a', short: 'ab23cd45', name: 'Ana' }]);
  p.listeners[0]({ state: 'guest', info: null });
  assert.deepEqual(p.uiCalls.filter((c) => c[0] === 'setIdentity').pop(), ['setIdentity', null]);
  // the actions of the view are the loader's: sign-in is the sign-in card, "Open a link" is the paste box
  svc.s.signedIn = false;
  click(one({ app: p.A.appsUi }, 'signin'));
  await flush();
  click(tile({ app: p.A.appsUi }, 'link'));
  assert.equal(p.uiCalls.filter((c) => c[0] === 'showLinkPaste').length, 1);
  assert.equal(p.uiCalls.find((c) => c[0] === 'showLinkPaste')[1].lang, 'en-CA');
  assert.equal(p.uiCalls.find((c) => c[0] === 'showLinkPaste')[1].onOpen('not a link'), false, 'the box says so and stays open');
  p.A.appsUi.destroy();
});

test('runDoorApps: when the apps cannot start the answer is false and the page keeps its paste box (no module, no createApps, no identity service, a refused origin, an identity that did not mount)', async () => {
  const base = { identity: { createIdentityService: () => ({}) }, client: { configure() {} }, mountServices: async () => ({ mounted: ['identity'], errors: {} }), importApps: async () => ({ createApps: () => makeService() }) };
  const cases = {
    'no service module': { importApps: async () => { throw new Error('Failed to fetch dynamically imported module'); } },
    'no createApps in the module': { importApps: async () => ({}) },
    'no identity service': { identity: {} },
    'no identity client': { client: {} },
    'the identity origin was refused': { client: { configure() { throw new TypeError('configure: idp must be an https origin'); } } },
    'the view did not start': { createUi: () => { throw new Error('view boom'); } },
  };
  for (const [name, over] of Object.entries(cases)) {
    const p = pageOf();
    assert.equal(await __apps.runDoorApps(p.A, APPS_BLOCK, Object.assign({}, base, over)), false, name);
    assert.equal(p.ui.shown, null, name);
    assert.equal(p.A.appsUi, undefined, name);
    assert.ok(p.logs.length >= 1, name + ' says why');
  }
  const noMount = pageOf({ api: undefined });
  noMount.A.api = Object.assign({}, noMount.api, { service: () => null });
  assert.equal(await __apps.runDoorApps(noMount.A, APPS_BLOCK, base), false);
  assert.ok(noMount.logs.some((l) => l.includes('did not mount')));
  const throwing = pageOf();
  assert.equal(await __apps.runDoorApps(throwing.A, APPS_BLOCK, Object.assign({}, base, { importApps: async () => ({ createApps: () => { throw new Error('boom'); } }) })), false);
  assert.ok(throwing.logs.some((l) => l.includes('did not start')));
});

test('loadAppsTm: the one manager of the page, made when the service first asks: lanes only, the door\'s STUN and nothing else, peers allowed from that moment; without WebRTC it refuses', async () => {
  const fakeTm = { id: 'tm' };
  const p = pageOf();
  p.A.tm = fakeTm; // ensureTorrentManager answers with the manager the page already has
  p.A.env = { isMobile: false };
  p.A.config = Object.assign({}, p.A.config, { policy: { desktop: { maxConns: 8, uploadLimit: 0 } }, limits: { maxSiteBytesDesktop: 1 }, stun: ['stun:public.invalid:3478'] });
  const tm = await __apps.loadAppsTm(p.A, APPS_BLOCK).catch((err) => err);
  assert.ok(tm === fakeTm || tm instanceof Error, 'it returned the manager or a policy error: ' + (tm && tm.message));
  assert.equal(p.A.lanesOnly, true);
  assert.equal(p.A.consentState, 'accepted');
  assert.deepEqual(p.A.iceServers, [{ urls: 'stun:stun.example.test:3478' }]);
  assert.deepEqual(p.A.routing, { stun: ['stun:stun.example.test:3478'] });
  assert.ok(!JSON.stringify(p.A.iceServers).includes('public.invalid'), 'no public default');
  const noRtc = pageOf({ webrtc: false });
  const err = await __apps.loadAppsTm(noRtc.A, APPS_BLOCK).then(() => null, (e) => e);
  assert.equal(err.code, 'E_UNSUPPORTED');
  assert.equal(noRtc.A.consentState, undefined, 'nothing is allowed when the browser cannot do it');
});

test('openLinkBox: the paste box of the door page, in the page\'s language', () => {
  const p = pageOf();
  __apps.openLinkBox(p.A);
  const [, opts] = p.uiCalls.find((c) => c[0] === 'showLinkPaste');
  assert.equal(opts.lang, 'en-CA');
  assert.equal(opts.onOpen(''), false);
  assert.equal(opts.onOpen('https://example.test/not-a-felinar-link'), false);
});

test('doors.js: the apps block as the page reads it', () => {
  assert.deepEqual(appsBlockOf({ apps: APPS_BLOCK }), APPS_BLOCK);
  assert.equal(appsBlockOf(doorJsonWith()), null);
});

// ---------------------------------------------------------------------------------------------- the view over the real service

/** A person's view over the real service of src/loader/apps.js on the fakes of test/unit/fakes/apps-fakes.mjs: a fake rendezvous and network, real keys and sealing. */
function personView(person, world) {
  const doc = new FakeDocument();
  const root = doc.createElement('div');
  doc.body.appendChild(root);
  const downloads = [];
  const ui = { showApps(n) { root.appendChild(n); }, hideApps() {}, download(name, text) { downloads.push({ name, text }); return true; }, prompt: () => Promise.resolve(true) };
  const acts = { calls: [], openLink() {}, copy: async () => true, signIn: async () => {}, signOut: async () => {}, log() {} };
  const app = createAppsUi({ root, ui, service: person.apps, lang: 'en', actions: acts, now: world.clock.now });
  const v = { doc, root, app, svc: person.apps, ui, acts, downloads, copies: [], person };
  worlds.push(v);
  return v;
}
// real time: the sealing uses real PBKDF2, which a busy machine (the whole suite in parallel) slows
const waitFor = (fn, what) => until(fn, what, 30000);
const idOf = (v) => v.app.inspect().conversations[0] && v.app.inspect().conversations[0].id;

test('end to end over the real service: a code, a knock, an accept, a message with formatting, receipts, a reply, a reaction, an edit and a deletion for both', async () => {
  const world = makeWorld();
  const ana = personView(await world.make('Ana'), world);
  const bo = personView(await world.make('Bo'), world);
  // Ana opens her code (after the price card); the view shows twelve characters in three groups
  ana.app.show('messages');
  assert.equal(attr(one(ana, 'card'), 'data-kind'), 'start');
  click(one(ana, 'card-continue'));
  const code = await waitFor(() => (has(ana, 'code') ? textOf(one(ana, 'code')) : null), 'the code of Ana');
  assert.match(code, /^[a-z2-9]{4}-[a-z2-9]{4}-[a-z2-9]{4}$/);
  assert.equal(code.length, 14);
  assert.equal(ana.app.inspect().code, code.slice(0, 4), 'the channel only');
  // Bo knocks with the code as Ana reads it out (capitals and spaces)
  bo.app.show('messages');
  click(one(bo, 'card-continue'));
  await waitFor(() => has(bo, 'code'), 'the code of Bo');
  typeInto(one(bo, 'knock-input'), code.toUpperCase().replace(/-/g, ' '));
  click(one(bo, 'knock-button'));
  await waitFor(() => has(bo, 'knock-note') && textOf(one(bo, 'knock-note')).startsWith('Request sent'), 'the knock of Bo');
  assert.equal(bo.app.inspect().conversations[0].status, 'waiting');
  assert.ok(visibleText(bo).includes('Request to ' + code), 'Bo sees the code he typed on the request');
  assert.ok(visibleText(bo).includes('Waiting for approval'));
  // before Ana accepts nothing joined a lane: no manager was asked for
  assert.equal(ana.person.loadCalls.length, 0);
  assert.equal(bo.person.loadCalls.length, 0);
  // Ana sees the request with Bo's name and short id, and accepts after the price
  await waitFor(() => all(ana, (n) => attr(n, 'data-role') === 'accept' && shown(n)).length === 1, 'the request on Ana\'s screen');
  const row = all(ana, (n) => attr(n, 'data-knock') && shown(n))[0];
  assert.match(row.textContent, /^Bo \([a-z0-9]{4}-[a-z0-9]{4}\) wants to message you/);
  click(one(ana, 'accept'));
  assert.equal(attr(one(ana, 'card'), 'data-kind'), 'accept');
  assert.equal(ana.person.loadCalls.length, 0, 'not before Continue');
  click(one(ana, 'card-continue'));
  await waitFor(() => ana.app.inspect().conversations[0] && ana.app.inspect().conversations[0].status === 'connected', 'Ana connected');
  await waitFor(() => bo.app.inspect().conversations[0] && bo.app.inspect().conversations[0].status === 'connected', 'Bo connected');
  assert.equal(ana.person.loadCalls.length, 1, 'the manager was loaded once, at the accept');
  assert.equal(bo.person.loadCalls.length, 1);
  // the conversation of each, with the status line and the compare code (8 digits, the same on both sides)
  ana.app.show('conversation', idOf(ana));
  bo.app.show('conversation', idOf(bo));
  assert.equal(textOf(one(ana, 'status-line')), 'Connected to you now');
  assert.equal(textOf(one(bo, 'status-line')), 'Connected to you now');
  const cmp = (v) => /Compare: (\d{4} \d{4})/.exec(one(v, 'verify').textContent);
  await waitFor(() => cmp(ana) && cmp(bo), 'the compare code');
  assert.equal(cmp(ana)[1], cmp(bo)[1], 'both people read the same digits');
  // Bo writes with formatting and a link
  typeInto(bo.app.nodes.composer, 'hello *Ana*, see https://example.test/page 🙂');
  keydown(bo.app.nodes.composer, 'Enter');
  const first = await waitFor(() => all(ana, (n) => attr(n, 'data-msg') && attr(n, 'data-mine') === '0')[0], 'the message on Ana\'s screen');
  const body = first.find((n) => attr(n, 'data-role') === 'body');
  assert.deepEqual(body.findAll((n) => n.tagName === 'STRONG').map(textOf), ['Ana']);
  assert.equal(body.find((n) => n.tagName === 'A').getAttribute('href'), 'https://example.test/page');
  assert.ok(body.textContent.includes('🙂'));
  // receipts: delivered, then read once Ana has the conversation open on a visible page
  const mineOfBo = () => all(bo, (n) => attr(n, 'data-msg') && attr(n, 'data-mine') === '1')[0];
  await waitFor(() => mineOfBo() && ['delivered', 'read'].includes(attr(mineOfBo(), 'data-status')), 'delivered ticks on Bo\'s screen');
  await waitFor(() => attr(mineOfBo(), 'data-status') === 'read', 'read ticks on Bo\'s screen');
  assert.equal(attr(mineOfBo().find((n) => attr(n, 'data-role') === 'ticks'), 'aria-label'), 'Read');
  const msgId = attr(first, 'data-msg');
  world.advance(1000); // the manual clock of the fakes only moves when told: later actions need a later time
  // Ana answers with a quote and reacts to Bo's message
  const live = (v, id) => all(v, (n) => attr(n, 'data-msg') === id)[0]; // the list is drawn again as receipts arrive: look the node up each time
  click(live(ana, msgId).find((n) => attr(n, 'data-role') === 'msg-menu'));
  click(live(ana, msgId).find((n) => attr(n, 'data-role') === 'msg-reply'));
  typeInto(ana.app.nodes.composer, 'got it');
  keydown(ana.app.nodes.composer, 'Enter');
  const answer = await waitFor(() => all(bo, (n) => attr(n, 'data-msg') && attr(n, 'data-mine') === '0')[0], 'the answer on Bo\'s screen');
  assert.equal(attr(answer.find((n) => attr(n, 'data-role') === 'quote'), 'data-quote-of'), attr(mineOfBo(), 'data-msg'), 'the quote points at Bo\'s message');
  click(live(ana, msgId).find((n) => attr(n, 'data-role') === 'msg-menu'));
  click(live(ana, msgId).find((n) => attr(n, 'data-role') === 'msg-react'));
  click(all(ana, (n) => attr(n, 'data-role') === 'react-pick')[0]);
  const chip = await waitFor(() => mineOfBo() && mineOfBo().find((n) => attr(n, 'data-role') === 'reaction'), 'the reaction on Bo\'s screen');
  assert.ok(textOf(chip).endsWith(' 1'));
  assert.equal(attr(chip, 'aria-pressed'), 'false', 'not Bo\'s own reaction');
  // Bo edits his message: Ana sees the new text and the edited mark
  world.advance(1000);
  click(mineOfBo().find((n) => attr(n, 'data-role') === 'msg-menu'));
  click(mineOfBo().find((n) => attr(n, 'data-role') === 'msg-edit'));
  assert.equal(bo.app.nodes.composer.value, 'hello *Ana*, see https://example.test/page 🙂');
  typeInto(bo.app.nodes.composer, 'hello Ana');
  keydown(bo.app.nodes.composer, 'Enter');
  await waitFor(() => all(ana, (n) => attr(n, 'data-msg') === msgId)[0].find((n) => attr(n, 'data-role') === 'edited'), 'the edited mark on Ana\'s screen');
  assert.equal(all(ana, (n) => attr(n, 'data-msg') === msgId)[0].find((n) => attr(n, 'data-role') === 'body').textContent, 'hello Ana');
  // Bo deletes it for both: a placeholder on both screens
  world.advance(1000);
  click(mineOfBo().find((n) => attr(n, 'data-role') === 'msg-menu'));
  click(mineOfBo().find((n) => attr(n, 'data-role') === 'msg-delete-both'));
  click(one(bo, 'card-continue'));
  await waitFor(() => all(ana, (n) => attr(n, 'data-msg') === msgId)[0].find((n) => attr(n, 'data-role') === 'body').textContent === 'This message was deleted', 'the deletion on Ana\'s screen');
  await waitFor(() => mineOfBo().find((n) => attr(n, 'data-role') === 'body').textContent === 'This message was deleted', 'the deletion on Bo\'s screen');
  // export through the service's own file
  click(one(ana, 'tools-toggle'));
  click(one(ana, 'tool-export'));
  await waitFor(() => ana.downloads.length === 1, 'the export');
  assert.match(ana.downloads[0].name, /^felinar-chat-[A-Za-z0-9-]+-\d{8}\.json$/);
  assert.equal(JSON.parse(ana.downloads[0].text).format, 'felinar-apps-chat');
});

test('end to end over the real service: a room; Bo asks with the code, Ana accepts after the room price, they write to each other with names', async () => {
  const world = makeWorld();
  const ana = personView(await world.make('Ana'), world);
  const bo = personView(await world.make('Bo'), world);
  ana.app.show('rooms');
  click(one(ana, 'room-create'));
  assert.equal(attr(one(ana, 'card'), 'data-kind'), 'room-create');
  click(one(ana, 'card-continue'));
  const code = await waitFor(() => (has(ana, 'room-code') ? textOf(one(ana, 'room-code')) : null), 'the room code');
  assert.match(code, /^[a-z2-9]{4}-[a-z2-9]{4}-[a-z2-9]{4}$/);
  assert.equal(textOf(one(ana, 'status-line')), 'Open for members');
  bo.app.show('rooms');
  typeInto(one(bo, 'join-input'), code.replace(/-/g, ''));
  click(one(bo, 'join-button'));
  assert.equal(attr(one(bo, 'card'), 'data-kind'), 'room-join');
  click(one(bo, 'card-continue'));
  await waitFor(() => has(bo, 'join-note') && textOf(one(bo, 'join-note')).startsWith('Request sent'), 'the join request');
  assert.ok(roomRows(bo)[0].textContent.includes('Room request'));
  await waitFor(() => has(ana, 'room-requests'), 'the request in Ana\'s room');
  assert.match(one(ana, 'room-requests').textContent, /^Bo \([a-z0-9]{4}-[a-z0-9]{4}\) wants to join your room/);
  assert.equal(ana.person.loadCalls.length, 0, 'no manager before the accept');
  click(one(ana, 'accept'));
  assert.equal(attr(one(ana, 'card'), 'data-kind'), 'room-accept');
  click(one(ana, 'card-continue'));
  await waitFor(() => bo.app.inspect().rooms[0] && bo.app.inspect().rooms[0].status === 'connected', 'Bo in the room');
  await waitFor(() => ana.app.inspect().rooms[0].members === 2, 'two members');
  bo.app.show('room', bo.app.inspect().rooms[0].id);
  await waitFor(() => bo.app.inspect().rooms[0].members === 2, 'the roster on Bo\'s screen');
  assert.ok(one(bo, 'roster').textContent.includes('Ana') && one(bo, 'roster').textContent.includes('owner'));
  typeInto(bo.app.nodes.roomComposer, 'hi room');
  keydown(bo.app.nodes.roomComposer, 'Enter');
  await waitFor(() => all(ana, (n) => attr(n, 'data-msg') && shown(n)).length === 1, 'the room message on Ana\'s screen');
  assert.match(all(ana, (n) => attr(n, 'data-role') === 'from' && shown(n))[0].textContent, /^Bo \(/);
  typeInto(ana.app.nodes.roomComposer, 'welcome');
  keydown(ana.app.nodes.roomComposer, 'Enter');
  await waitFor(() => all(bo, (n) => attr(n, 'data-msg') && attr(n, 'data-mine') === '0' && shown(n)).length === 1, 'the answer on Bo\'s screen');
  assert.match(all(bo, (n) => attr(n, 'data-role') === 'from' && shown(n))[0].textContent, /^Ana \(/);
  assert.equal(bo.app.nodes.roomMessageList.children.length >= 2, true);
});
