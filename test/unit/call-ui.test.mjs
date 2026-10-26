// Unit tests for the loader-owned call panel (src/loader/call-ui.js; v0.3 C2, lane wire-ui; research/v03/SEEDING-AND-ZERO-
// SETUP-DESIGN.md 3.5 "UI", "Flow and IP exposure", "Platform handling") on the fake DOM of the drop-in tests: the incoming
// card in a closed shadow root (name, short id, the IP sentence, accept with audio or video, decline), only trusted and
// unhurried clicks act, the service is called inside the click, the ring flashes the title, vibrates and plays a tone
// only where the page may play sound, the cards the calls service asks for, the panel's people, states, controls,
// keyboard shortcuts and media, the end of a call, and every text from CALL_TEXT. The calls service is a fake at its
// documented surface (lane calls).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FakeDocument } from './dropin-fake-dom.mjs';
import {
  createCallUi, CALL_UI_KINDS, durationText, endText, noticesOf, peerStateText, maySound, canShareScreen, callName
} from '../../src/loader/call-ui.js';
import { callText, errorText } from '../../src/loader/strings.js';

const PUB = 'p256:B' + 'A'.repeat(86);
const PUB2 = 'p256:B' + 'Q'.repeat(86);
const PUB3 = 'p256:B' + 'g'.repeat(86);
const ID = 'k'.repeat(22);

function fakeTimers(start = 1000000) {
  let t = start;
  let seq = 0;
  const q = new Map();
  const add = (fn, ms, repeat) => { const id = ++seq; q.set(id, { fn, at: t + ms, ms, repeat }); return id; };
  return {
    now: () => t,
    setTimeout: (fn, ms) => add(fn, ms, false),
    clearTimeout: (id) => q.delete(id),
    setInterval: (fn, ms) => add(fn, ms, true),
    clearInterval: (id) => q.delete(id),
    pending: () => q.size,
    advance(ms) {
      const end = t + ms;
      for (;;) {
        let next = null;
        for (const [id, h] of q) if (h.at <= end && (!next || h.at < next[1].at)) next = [id, h];
        if (!next) break;
        const [id, h] = next;
        t = h.at;
        if (h.repeat) h.at += h.ms; else q.delete(id);
        h.fn();
      }
      t = end;
    },
  };
}

class FakeStream { constructor(tracks) { this.tracks = tracks; } getTracks() { return this.tracks; } }

class FakeAudioContext {
  static made = 0;
  constructor() { FakeAudioContext.made++; this.oscillators = 0; this.currentTime = 0; this.closed = false; this.destination = {}; }
  createGain() { const p = { setValueAtTime() {}, linearRampToValueAtTime() {} }; return { gain: p, connect() {} }; }
  createOscillator() { this.oscillators++; return { frequency: { value: 0 }, connect() {}, start() {}, stop() {} }; }
  close() { this.closed = true; return Promise.resolve(); }
}

function fakeService() {
  const listeners = new Map();
  const ran = [];
  const answered = [];
  let media = null;
  const methods = {};
  for (const m of ['calls.decline', 'calls.mute', 'calls.camera', 'calls.screen', 'calls.hangup']) {
    methods[m] = async (params, ctx) => { ran.push({ m, params, ctx }); return { id: params.id }; };
  }
  return {
    methods,
    ran,
    answered,
    on(ev, fn) { if (!listeners.has(ev)) listeners.set(ev, new Set()); listeners.get(ev).add(fn); return () => listeners.get(ev).delete(fn); },
    emit(ev, data) { for (const fn of Array.from(listeners.get(ev) || [])) fn(data); },
    answer(id, opts) { answered.push({ id, opts }); return Promise.resolve({ id }); },
    media() { return media; },
    setMedia(m) { media = m; },
    listeners,
  };
}

function setup({ nav = {}, sound = false, strict = false, minVisibleMs = 500 } = {}) {
  const doc = new FakeDocument();
  doc.title = 'My site';
  const timers = fakeTimers();
  const vib = [];
  const n = Object.assign({ language: 'en-CA', vibrate: (p) => { vib.push(p); return true; } }, nav);
  if (sound) n.userActivation = { hasBeenActive: true, isActive: false };
  const ui = createCallUi({ doc, win: {}, nav: n, lang: 'en', strict, minVisibleMs, MediaStream: FakeStream, AudioContext: FakeAudioContext, cssHref: '/_mw/ui.css', ...timers });
  const svc = fakeService();
  ui.attach(svc);
  const host = () => doc.body.find((x) => x.getAttribute && x.getAttribute('data-mw-call') !== null);
  const btn = (label) => { const h = host(); return h ? h.buttonByText(label) : null; };
  const texts = () => { const h = host(); return h ? h.findAll((x) => x._text).map((x) => x._text) : []; };
  const click = (b, extra = {}) => b.dispatchEvent(Object.assign({ type: 'click', isTrusted: true }, extra));
  return { doc, timers, ui, svc, host, btn, texts, click, vib, nav: n };
}

const ring = (over = {}) => Object.assign({ id: ID, from: PUB2, name: 'Bo', kind: 'video', group: null, roster: [], expiresAt: 1000000 + 45000 }, over);
const flush = () => new Promise((r) => setTimeout(r, 0));

test('a ring shows the incoming card in a closed root: name, short id, the IP sentence, three choices, no input', () => {
  const t = setup();
  const before = t.doc.activeElement;
  t.svc.emit('ring', ring());
  const h = t.host();
  assert.ok(h, 'the host is in the loader document');
  assert.equal(h.shadowRoot, null, 'closed shadow root');
  assert.equal(h._shadow.mode, 'closed');
  const link = h.find((x) => x.tagName === 'LINK');
  assert.equal(link.getAttribute('href'), '/_mw/ui.css', 'styled by ui.css inside the root');
  const all = t.texts();
  assert.ok(all.includes('Bo'));
  assert.ok(all.includes(PUB2.slice(5, 13)), 'the short id of the key');
  assert.ok(all.includes('Bo is calling (video). Accepting shows your IP address to Bo.'));
  for (const label of ['Accept with audio', 'Accept with video', 'Decline']) assert.ok(t.btn(label), label);
  assert.equal(h.findAll((x) => x.tagName === 'INPUT' || x.tagName === 'TEXTAREA' || x.tagName === 'SELECT').length, 0);
  const alert = h.find((x) => x.getAttribute && x.getAttribute('role') === 'alert');
  assert.equal(alert.textContent, 'Bo is calling (video). Accepting shows your IP address to Bo.', 'announced');
  assert.equal(t.doc.activeElement, before, 'a ring never takes the focus from the page');
  assert.deepEqual(t.ui.inspect().card, { kind: 'call.incoming', id: ID, waiting: 0 });
});

test('only the person\'s own, unhurried click answers: the service is called inside that click', () => {
  const t = setup({ minVisibleMs: 500 });
  t.svc.emit('ring', ring({ kind: 'audio' }));
  const accept = t.btn('Accept with audio');
  t.timers.advance(600);
  accept.dispatchEvent({ type: 'click', isTrusted: false });
  assert.equal(t.svc.answered.length, 0, 'a script click does nothing');
  // A new card: a click right after it appeared is ignored (the redress guard's minimum visible time).
  t.ui.destroy();
  const u = setup({ minVisibleMs: 500 });
  u.svc.emit('ring', ring({ kind: 'audio' }));
  u.click(u.btn('Accept with audio'));
  assert.equal(u.svc.answered.length, 0, 'too soon after it appeared');
  u.timers.advance(501);
  u.click(u.btn('Accept with audio'));
  assert.deepEqual(u.svc.answered, [{ id: ID, opts: { video: false } }], 'answered synchronously, inside the click');
  assert.equal(u.ui.inspect().card, null, 'the card closed');
});

test('accept with video and decline; Escape on the card declines (it reveals nothing)', () => {
  const t = setup({ minVisibleMs: 0 });
  t.svc.emit('ring', ring());
  t.click(t.btn('Accept with video'));
  assert.deepEqual(t.svc.answered, [{ id: ID, opts: { video: true } }]);
  const u = setup({ minVisibleMs: 0 });
  u.svc.emit('ring', ring());
  u.click(u.btn('Decline'));
  assert.equal(u.svc.ran[0].m, 'calls.decline');
  assert.deepEqual(u.svc.ran[0].params, { id: ID });
  assert.deepEqual(u.svc.ran[0].ctx, { activation: true, tab: 'leader' });
  const v = setup({ minVisibleMs: 0 });
  v.svc.emit('ring', ring());
  const cardEl = v.host().find((x) => x.getAttribute && x.getAttribute('data-mw-call-card') === 'call.incoming');
  cardEl.dispatchEvent({ type: 'keydown', key: 'Escape', isTrusted: false });
  assert.equal(v.svc.ran.length, 0, 'a script key press does nothing');
  cardEl.dispatchEvent({ type: 'keydown', key: 'Escape', isTrusted: true });
  assert.equal(v.svc.ran[0].m, 'calls.decline');
});

test('the ring: the title flashes call.ringTitle, vibration where it exists, a tone only where the page may play sound', () => {
  FakeAudioContext.made = 0;
  const quiet = setup({ minVisibleMs: 0 });
  quiet.svc.emit('ring', ring());
  quiet.timers.advance(1000);
  assert.equal(quiet.doc.title, callText('call.ringTitle'));
  quiet.timers.advance(1000);
  assert.equal(quiet.doc.title, 'My site');
  quiet.timers.advance(1000);
  assert.equal(quiet.doc.title, 'Incoming call');
  assert.deepEqual(quiet.vib[0], [500, 300, 500]);
  assert.equal(FakeAudioContext.made, 0, 'no sticky activation: no sound');
  quiet.click(quiet.btn('Accept with audio'));
  assert.equal(quiet.doc.title, 'My site', 'restored when answered');
  assert.equal(quiet.vib[quiet.vib.length - 1], 0, 'vibration stopped');
  const pending = quiet.timers.pending();
  quiet.timers.advance(5000);
  assert.equal(quiet.doc.title, 'My site');
  assert.ok(quiet.timers.pending() <= pending);

  const loud = setup({ sound: true, minVisibleMs: 0 });
  loud.svc.emit('ring', ring());
  assert.equal(FakeAudioContext.made, 1, 'the page may play sound: one context');
  loud.timers.advance(3000);
  // The ring ends by itself when it expires (45 s).
  loud.timers.advance(45000);
  assert.equal(loud.doc.title, 'My site');
  const noVib = setup({ nav: { vibrate: undefined } });
  noVib.svc.emit('ring', ring());
  assert.equal(noVib.vib.length, 0);
});

test('a group ring names everyone in the call; the platform note comes with it', () => {
  const t = setup();
  t.svc.emit('state', { id: ID, role: 'callee', state: 'ringing', platform: 'call.ios', participants: [] });
  t.svc.emit('ring', ring({ group: 'grp1', roster: [PUB3] })); // the service's ring names no one but the caller
  const all = t.texts();
  assert.ok(all.includes('Join a call with Bo, ' + PUB3.slice(5, 13) + '? Each of them will see your IP address.'), all.join(' | '));
  assert.ok(all.includes(callText('call.ios')));
});

test('the service\'s cards: the site\'s accept() binds to the open card; start, group, metered and screen confirm', async () => {
  const t = setup({ minVisibleMs: 0 });
  t.svc.emit('ring', ring());
  const p = t.ui.prompt('call.incoming', { id: ID, from: PUB2, name: 'Bo', kind: 'video' });
  assert.equal(t.ui.inspect().card.waiting, 1);
  t.click(t.btn('Accept with video'));
  assert.equal(await p, 'video', 'the choice goes to the waiting accept()');
  assert.equal(t.svc.answered.length, 0, 'and the panel does not answer a second time');

  // Without a ring card (the event was missed), the prompt shows one, focused on Decline (the site asked from a click).
  const p2 = t.ui.prompt('call.group', { id: 'z'.repeat(22), role: 'callee', from: PUB2, name: 'Bo', roster: [PUB3], names: ['Cy'] });
  assert.ok(t.texts().includes('Join a call with Bo, Cy? Each of them will see your IP address.'));
  assert.equal(t.doc.activeElement && t.doc.activeElement.textContent, 'Decline');
  t.click(t.btn('Decline'));
  assert.equal(await p2, 'decline');

  const start = t.ui.prompt('call.start', { to: PUB, name: 'Ana', relay: { operator: 'Relay Co' } });
  const all = t.texts();
  assert.ok(all.includes(callText('call.start', 'en', { name: 'Ana' })));
  assert.ok(all.includes(callText('call.startRelay', 'en', { operator: 'Relay Co' })));
  t.click(t.btn('Continue'));
  assert.equal(await start, true);
  const no = t.ui.prompt('call.metered', { video: true });
  assert.ok(t.texts().includes(callText('call.metered')));
  t.click(t.btn('Cancel'));
  assert.equal(await no, false);
  const esc = t.ui.prompt('call.group', { role: 'caller', to: [PUB, PUB3], names: ['Ana', null] });
  assert.ok(t.texts().includes('Join a call with Ana, ' + PUB3.slice(5, 13) + '? Each of them will see your IP address.'));
  t.host().find((x) => x.getAttribute && x.getAttribute('data-mw-call-card') === 'call.group').dispatchEvent({ type: 'keydown', key: 'Escape', isTrusted: true });
  assert.equal(await esc, false);
  const screen = t.ui.prompt('call.screen', { id: ID });
  assert.ok(t.texts().includes(callText('call.screen')));
  t.click(t.btn('Share screen'));
  assert.equal(await screen, true);
  assert.equal(await t.ui.prompt('call.unknown', {}), false, 'no card, nothing granted');
  assert.deepEqual(CALL_UI_KINDS, ['call.start', 'call.incoming', 'call.group', 'call.metered', 'call.screen']);
});

test('cards queue: a ring while a start card is open waits its turn; destroy answers every pending card no', async () => {
  const t = setup({ minVisibleMs: 0 });
  const first = t.ui.prompt('call.start', { to: PUB, name: 'Ana' });
  t.svc.emit('ring', ring());
  assert.equal(t.ui.inspect().queued, 1);
  t.click(t.btn('Cancel'));
  assert.equal(await first, false);
  assert.equal(t.ui.inspect().card.kind, 'call.incoming', 'the ring is next');
  const waiting = t.ui.prompt('call.screen', { id: ID });
  t.ui.destroy();
  assert.equal(await waiting, false);
  assert.equal(t.host(), null, 'the host is gone');
});

test('the panel: people with their states, Direct or Relayed by the operator, controls into the service, keyboard', async () => {
  const md = { getDisplayMedia: () => null };
  const t = setup({ nav: { mediaDevices: md } });
  const state = {
    id: ID, role: 'caller', state: 'ringing', kind: 'audio', caller: PUB, connectedAt: null, operator: 'Relay Co',
    local: { mute: false, camera: false, screen: false }, paused: {}, notice: 'metered', platform: 'call.android',
    participants: [{ pub: PUB2, state: 'ringing', name: 'Bo' }, { pub: PUB3, state: 'ringing', name: null }],
  };
  t.svc.emit('state', state);
  let all = t.texts();
  assert.ok(all.includes(callText('call.calling', 'en', { name: 'Bo, ' + PUB3.slice(5, 13) })));
  assert.ok(all.includes('Ringing'));
  assert.ok(all.includes(callText('call.metered')) && all.includes(callText('call.android')));
  assert.equal(t.doc.activeElement && t.doc.activeElement.textContent, 'Mute', 'the person started it: the panel takes the focus');
  t.svc.emit('state', Object.assign({}, state, { state: 'connected', connectedAt: 1000000, participants: [{ pub: PUB2, state: 'direct', path: 'direct', name: 'Bo' }, { pub: PUB3, state: 'relayed', path: 'relayed' }] }));
  all = t.texts();
  assert.ok(all.includes('Direct'));
  assert.ok(all.includes('Relayed by Relay Co'));
  t.svc.emit('peer', { id: ID, pub: PUB3, state: 'left', reason: 'hangup' });
  assert.ok(t.texts().includes('Left the call'));
  // Controls: the service is called inside the click, with the loader's own activation.
  t.click(t.btn('Mute'));
  assert.deepEqual(t.svc.ran.pop(), { m: 'calls.mute', params: { id: ID, on: true }, ctx: { activation: true, tab: 'leader' } });
  t.click(t.btn('Turn camera on'));
  assert.deepEqual(t.svc.ran.pop().params, { id: ID, on: true });
  t.click(t.btn('Share screen'));
  assert.deepEqual(t.svc.ran.pop(), { m: 'calls.screen', params: { id: ID, on: true }, ctx: { activation: true, tab: 'leader' } });
  t.btn('Mute').dispatchEvent({ type: 'click', isTrusted: false });
  assert.equal(t.svc.ran.length, 0, 'script clicks do nothing');
  const panelEl = t.host().find((x) => x.getAttribute && x.getAttribute('data-mw-call-panel') === ID);
  panelEl.dispatchEvent({ type: 'keydown', key: 'm', isTrusted: true });
  assert.equal(t.svc.ran.pop().m, 'calls.mute');
  panelEl.dispatchEvent({ type: 'keydown', key: 'v', isTrusted: true });
  assert.equal(t.svc.ran.pop().m, 'calls.camera');
  panelEl.dispatchEvent({ type: 'keydown', key: 'm', isTrusted: true, ctrlKey: true });
  assert.equal(t.svc.ran.length, 0, 'a shortcut with Ctrl is the browser\'s');
  // The state follows the service: pressed buttons and paused notices.
  t.svc.emit('state', Object.assign({}, state, { state: 'connected', connectedAt: 1000000, local: { mute: true, camera: true, screen: false, videoPaused: true }, paused: { camera: true }, participants: [{ pub: PUB2, state: 'direct', name: 'Bo' }] }));
  assert.equal(t.btn('Unmute').getAttribute('aria-pressed'), 'true');
  assert.ok(t.btn('Turn camera off'));
  all = t.texts();
  assert.ok(all.includes(callText('call.paused')) && all.includes(callText('call.videoPaused')));
  t.timers.advance(42000);
  assert.ok(t.texts().includes('0:42'), 'the call clock');
  t.click(t.btn('Hang up'));
  assert.equal(t.svc.ran.pop().m, 'calls.hangup');
});

test('Share screen is offered only where the browser has getDisplayMedia (Android browsers do not)', () => {
  const t = setup({ nav: { mediaDevices: {} } });
  t.svc.emit('state', { id: ID, role: 'caller', state: 'connected', connectedAt: 1, local: {}, participants: [{ pub: PUB2, state: 'direct' }] });
  assert.equal(t.host().buttonByText('Share screen').hidden, true);
  assert.equal(canShareScreen({ getDisplayMedia() {} }), true);
  assert.equal(canShareScreen({ getDisplayMedia: true }), false);
  assert.equal(canShareScreen(null), false);
});

test('media: the service\'s tracks play in the closed root only (audio for each person, video for camera or screen)', () => {
  const t = setup();
  const audio = { id: 'a1', kind: 'audio' };
  const cam = { id: 'v1', kind: 'video' };
  const mine = { id: 'v0', kind: 'video' };
  t.svc.setMedia({ local: { audio: { id: 'a0' }, camera: mine, screen: null }, remote: [{ pub: PUB2, audio, camera: cam, screen: null }] });
  t.svc.emit('state', { id: ID, role: 'callee', state: 'connected', connectedAt: 1, local: { camera: true }, participants: [{ pub: PUB2, state: 'direct' }] });
  const h = t.host();
  const a = h.find((x) => x.tagName === 'AUDIO');
  assert.ok(a.srcObject instanceof FakeStream);
  assert.deepEqual(a.srcObject.getTracks(), [audio]);
  const vids = h.findAll((x) => x.tagName === 'VIDEO');
  const remote = vids.find((v) => v.className === 'mw-call-video');
  assert.deepEqual(remote.srcObject.getTracks(), [cam]);
  assert.equal(remote.hidden, false);
  const local = vids.find((v) => v.className === 'mw-call-local');
  assert.deepEqual(local.srcObject.getTracks(), [mine]);
  assert.equal(local.muted, true, 'the own preview never plays back');
  // The person left: the elements go.
  t.svc.setMedia({ local: { audio: null, camera: null }, remote: [] });
  t.svc.emit('state', { id: ID, role: 'callee', state: 'connected', connectedAt: 1, local: {}, participants: [] });
  assert.equal(t.host().findAll((x) => x.tagName === 'AUDIO').length, 0);
});

test('the end of a call says how it ended, then the panel goes; a callee who declined sees nothing more', () => {
  const t = setup();
  const st = { id: ID, role: 'caller', state: 'ringing', caller: PUB, local: {}, participants: [{ pub: PUB2, state: 'ringing', name: 'Bo' }] };
  t.svc.emit('state', st);
  t.svc.emit('ended', { id: ID, reason: 'declined', code: 'E_DECLINED', duration: 0 });
  t.svc.emit('state', Object.assign({}, st, { state: 'ended', participants: [{ pub: PUB2, state: 'left', reason: 'declined', name: 'Bo' }] }));
  assert.ok(t.texts().includes('Bo declined.'));
  t.timers.advance(6001);
  assert.equal(t.ui.inspect().panel, null);
  assert.equal(t.host(), null, 'nothing left on the page');

  const u = setup({ minVisibleMs: 0 });
  u.svc.emit('ring', ring());
  u.svc.emit('state', { id: ID, role: 'callee', state: 'ringing', caller: PUB2, local: {}, participants: [{ pub: PUB2, state: 'ringing', name: 'Bo' }] });
  u.svc.emit('ended', { id: ID, reason: 'no-answer', code: 'E_NO_ANSWER', duration: 0 });
  u.svc.emit('state', { id: ID, role: 'callee', state: 'ended', caller: PUB2, local: {}, participants: [] });
  assert.equal(u.ui.inspect().card, null, 'the expired ring card closed');
  assert.equal(u.ui.inspect().panel, null);
});

test('the texts of the end, the people and the notices are CALL_TEXT\'s (and the two error sentences)', () => {
  assert.equal(durationText(0), '0:00');
  assert.equal(durationText(155000), '2:35');
  assert.equal(durationText(3723000), '1:02:03');
  assert.equal(endText({ reason: 'declined', name: 'Bo' }), callText('call.declined', 'en', { name: 'Bo' }));
  assert.equal(endText({ reason: 'busy', name: 'Bo' }), 'Bo is in another call.');
  assert.equal(endText({ reason: 'unreachable', name: 'Bo' }), callText('call.notHere', 'en', { name: 'Bo' }));
  assert.equal(endText({ reason: 'no-answer' }), errorText('E_NO_ANSWER'));
  assert.equal(endText({ reason: 'failed', name: 'Bo', connected: false }), callText('call.noPath', 'en', { name: 'Bo' }));
  assert.equal(endText({ reason: 'failed', connected: true }), errorText('E_CALL_FAILED'));
  assert.equal(endText({ reason: 'fingerprint' }), errorText('E_CALL_FAILED'));
  assert.equal(endText({ reason: 'hangup', duration: 155000 }), 'Call ended (2:35).');
  assert.equal(endText({ reason: 'hangup', duration: 155000 }, 'fr'), 'Appel terminé (2:35).');
  assert.deepEqual(noticesOf({ notice: 'metered', platform: 'call.ios', paused: { audio: true }, local: { videoPaused: true } }), [
    callText('call.metered'), callText('call.ios'), callText('call.paused'), callText('call.videoPaused')
  ]);
  assert.deepEqual(noticesOf({}), []);
  // Code review v0.3 (round 2): a phone shows "Keep this page open during the call." while CALL_FLAGS.phoneNotes keeps the
  // platform notes off (state.platform null), and the platform note instead of it once they ship.
  assert.deepEqual(noticesOf({}, 'en', { phone: true }), [callText('call.keepOpen')]);
  assert.equal(callText('call.keepOpen'), 'Keep this page open during the call.');
  assert.deepEqual(noticesOf({ platform: 'call.android' }, 'fr', { phone: true }), [callText('call.android', 'fr')]);
  assert.equal(peerStateText({ state: 'relayed' }, 'Relay Co'), 'Relayed by Relay Co');
  assert.equal(peerStateText({ state: 'connecting', path: 'direct' }), 'Direct');
  assert.equal(peerStateText({ state: 'reconnecting' }), 'Reconnecting');
  assert.equal(peerStateText({ state: 'left', path: 'direct' }), 'Left the call');
  assert.equal(peerStateText({ state: 'ringing' }, null, 'fr'), 'Sonnerie');
  assert.equal(callName(null, PUB), PUB.slice(5, 13));
  assert.equal(maySound({ getAutoplayPolicy: () => 'allowed' }), true);
  assert.equal(maySound({ getAutoplayPolicy: () => 'disallowed', userActivation: { hasBeenActive: true } }), false, 'the browser\'s own answer wins');
  assert.equal(maySound({ userActivation: { hasBeenActive: true } }), true);
  assert.equal(maySound({}), false);
  assert.equal(maySound(null), false);
});

test('call-ui.js never captures media or takes a Wake Lock itself, and names no banned word (SZ 3.1.9, wording rules)', async () => {
  const { readFileSync } = await import('node:fs');
  const src = readFileSync(new URL('../../src/loader/call-ui.js', import.meta.url), 'utf8');
  const code = src.replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');
  assert.doesNotMatch(code, /\.getUserMedia\s*\(|\.getDisplayMedia\s*\(|wakeLock\s*\.\s*request|audioSession/);
  assert.doesNotMatch(src, /blockchain|serverless|unstoppable|censorship-resistant|production-ready/i);
  assert.doesNotMatch(src, /[\u2013\u2014\u201c\u201d\u2018\u2019]/, 'no em or en dashes, straight quotes');
  await flush();
});

test('an answer that fails before the call starts says why on a small card; the panel takes no focus for it', async () => {
  const t = setup({ minVisibleMs: 0 });
  t.svc.answer = () => Promise.reject(Object.assign(new Error('denied'), { code: 'E_MEDIA_DENIED' }));
  t.svc.emit('ring', ring());
  t.click(t.btn('Accept with audio'));
  await flush();
  assert.equal(t.ui.inspect().card.kind, 'call.notice');
  assert.ok(t.texts().includes(errorText('E_MEDIA_DENIED')));
  t.click(t.btn('OK'));
  assert.equal(t.ui.inspect().card, null);
  // A cancelled card is not an error worth a card.
  t.svc.answer = () => Promise.reject(Object.assign(new Error('x'), { code: 'E_USER_CANCELLED' }));
  t.svc.emit('ring', ring({ id: 'y'.repeat(22) }));
  t.click(t.btn('Accept with audio'));
  await flush();
  assert.equal(t.ui.inspect().card, null);
});

test('the title flash keeps a title the site sets while the call rings', () => {
  const t = setup({ minVisibleMs: 0 });
  t.svc.emit('ring', ring());
  t.timers.advance(1000);
  assert.equal(t.doc.title, 'Incoming call');
  t.doc.title = 'Inbox (2)';
  t.timers.advance(1000);
  assert.equal(t.doc.title, 'Inbox (2)', 'the off phase shows the site\'s new title');
  t.timers.advance(1000);
  assert.equal(t.doc.title, 'Incoming call');
  t.click(t.btn('Decline'));
  assert.equal(t.doc.title, 'Inbox (2)');
});

// ---- with the real calls service of lane calls (real chat sealing over fake wires, the fake WebRTC of its fixture) ----

import { createFakeNetwork } from '../fixtures/calls/fake-webrtc.mjs';
import { fakeClock, people, until } from '../fixtures/calls/peers.mjs';

test('with the real calls service: the ring shows on the callee\'s panel, its Accept connects, Mute and Hang up work', async () => {
  const clock = fakeClock();
  const net = createFakeNetwork();
  const [a, b] = await people(clock, net, 2);
  const doc = new FakeDocument();
  doc.title = 'Site';
  const setInterval = (fn, ms) => { const h = { t: null }; const tick = () => { h.t = clock.setTimeout(tick, ms); fn(); }; h.t = clock.setTimeout(tick, ms); return h; };
  const clearInterval = (h) => { if (h) clock.clearTimeout(h.t); };
  class MS { constructor(tracks) { this.tracks = tracks; } }
  const ui = createCallUi({ doc, win: {}, nav: { language: 'en' }, lang: 'en', strict: false, minVisibleMs: 0, MediaStream: MS, now: clock.now, setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout, setInterval, clearInterval });
  ui.attach(b.calls);
  const host = () => doc.body.find((x) => x.getAttribute && x.getAttribute('data-mw-call') !== null);
  const texts = () => host().findAll((x) => x._text).map((x) => x._text);
  const click = (label) => host().buttonByText(label).dispatchEvent({ type: 'click', isTrusted: true });
  try {
    await a.call('calls.start', { to: b.pub, video: false });
    await until(clock, () => ui.inspect().card && ui.inspect().card.kind === 'call.incoming', { label: 'the incoming card' });
    assert.ok(texts().includes('P0 is calling (audio). Accepting shows your IP address to P0.'), texts().join(' | '));
    assert.equal(b.browser.pcs.length, 0, 'the callee makes no connection before the person accepts');
    click('Accept with audio');
    await until(clock, () => a.events.state.some((s) => s.state === 'connected') && b.events.state.some((s) => s.state === 'connected'), { label: 'connected' });
    await until(clock, () => texts().includes('Direct'), { label: 'the panel shows the path' });
    assert.ok(ui.inspect().panel, 'the panel shows the call');
    const audio = host().find((x) => x.tagName === 'AUDIO');
    assert.ok(audio && audio.srcObject instanceof MS, 'the caller\'s audio plays in the closed root');
    click('Mute');
    await until(clock, () => b.events.state.some((s) => s.local && s.local.mute === true), { label: 'muted' });
    await until(clock, () => host().buttonByText('Unmute'), { label: 'the button follows the state' });
    click('Hang up');
    await until(clock, () => b.events.ended.length && a.events.ended.length, { label: 'ended on both sides' });
    await until(clock, () => texts().some((x) => /^Call ended \(\d+:\d\d\)\.$/.test(x)), { label: 'the end sentence' });
  } finally {
    ui.destroy();
    await a.close();
    await b.close();
  }
});
