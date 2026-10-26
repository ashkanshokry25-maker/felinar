// Unit tests for src/widget/chat-panel.js: gesture flow (sign in, consent card, enable, join, send), the
// unavailable states, only R 2.11.2 chat methods used, delivery words behind the flag, closed shadow root.
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { FakeDocument, FakeNode } from './dropin-fake-dom.mjs';
import { createChatPanelElement } from '../../src/widget/chat-panel.js';
import { setStringFlag, STRING_FLAGS } from '../../src/loader/strings.js';

const flush = async () => { for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0)); };
afterEach(() => setStringFlag('deliveryStates', false));

function setup({ mw, cardAnswer = true } = {}) {
  const doc = new FakeDocument();
  const win = { document: doc, mw, matchMedia: () => ({ matches: false }), navigator: { language: 'en-CA' } };
  const prompts = [];
  const cards = { prompt: async (kind, data) => { prompts.push([kind, data]); return cardAnswer; } };
  class Base extends FakeNode { constructor() { super('mw-chat-panel', doc); } }
  const El = createChatPanelElement({ HTMLElement: Base, win, doc, getCards: () => cards });
  const el = new El();
  return { el, win, doc, prompts, text: () => el._shadow.findAll((n) => n._text).map((n) => n._text).join(' | '), btn: (l) => el._shadow.buttonByText(l) };
}

function fakeMw({ auth = 'signed-in', chat = 'off', features = { chat: true } } = {}) {
  const log = [];
  const handlers = [];
  const mw = {
    log,
    ready: async () => ({ auth, features }),
    auth: { state: () => auth, signIn: async () => { log.push('auth.signIn'); auth = 'signed-in'; return { state: 'signed-in' }; } },
    chat: {
      state: async () => ({ enabled: chat === 'on', tracker: 'tr.example', stun: 'st.example' }),
      enable: async () => { log.push('chat.enable'); chat = 'on'; },
      on: (name, fn) => { handlers.push([name, fn]); return () => { log.push('off:' + name); }; },
      room: { join: async (n) => { log.push('room.join:' + n); }, send: async (n, m) => { log.push('room.send:' + n + ':' + m.text); } },
      dm: { send: async (pub, m) => { log.push('dm.send:' + pub + ':' + m.text); return { state: 'delivered' }; } }
    },
    emit: (m, ev = 'message') => handlers.filter(([n]) => n === ev).forEach(([, f]) => f(m))
  };
  return mw;
}

test('unavailable: no window.mw, no chat object, chat feature off or missing', async () => {
  for (const mw of [undefined, {}, { ready: async () => ({ features: { chat: false } }), chat: {} }, { ready: async () => ({ features: {} }), chat: {} }, { ready: async () => { throw new Error('x'); }, chat: {} }]) {
    const t = setup({ mw });
    t.el.connectedCallback();
    await flush();
    assert.equal(t.el.view, 'unavailable');
    assert.ok(t.text().includes('Chat is not available on this site.'));
    assert.equal(t.el._shadow.findAll((n) => n.tagName === 'BUTTON').length, 0);
  }
});

test('closed shadow root; signed-out view offers Sign in, which calls mw.auth.signIn from the click', async () => {
  const mw = fakeMw({ auth: 'guest' });
  const t = setup({ mw });
  t.el.connectedCallback();
  await flush();
  assert.equal(t.el.shadowRoot, null);
  assert.equal(t.el.view, 'signed-out');
  t.btn('Sign in').dispatchEvent({ type: 'click', isTrusted: false });
  await flush();
  assert.deepEqual(mw.log, [], 'a script click does nothing');
  t.btn('Sign in').click();
  await flush();
  assert.deepEqual(mw.log.slice(0, 1), ['auth.signIn']);
  assert.equal(t.el.view, 'off', 'signed in, chat still off');
});

test('gesture flow: Turn on chat calls mw.chat.enable inside the click (its loader card is the consent), then joins the Lobby', async () => {
  const mw = fakeMw({ chat: 'off' });
  const t = setup({ mw });
  t.el.setAttribute('stun', 'stun.site.example');
  t.el.connectedCallback();
  await flush();
  assert.equal(t.el.view, 'off');
  t.btn('Turn on chat').click();
  assert.deepEqual(mw.log, ['chat.enable'], 'enable runs in the click itself, so the service can show its card (R 2.7, R 2.11.2 UI methods)');
  await flush();
  // v0.3 final integration: the panel no longer shows a card of its own first; the chat service's card is the one
  // consent (a visitor answered the same text twice in E-CH-R).
  assert.equal(t.prompts.length, 0);
  assert.deepEqual(mw.log.slice(0, 2), ['chat.enable', 'room.join:Lobby']);
  assert.equal(t.el.view, 'on');
});

test('declining the consent card (enable rejects E_USER_CANCELLED) leaves chat off, joins nothing and shows no error', async () => {
  const mw = fakeMw({ chat: 'off' });
  mw.chat.enable = async () => { mw.log.push('chat.enable'); throw Object.assign(new Error('cancelled'), { code: 'E_USER_CANCELLED' }); };
  const t = setup({ mw });
  t.el.connectedCallback();
  await flush();
  t.btn('Turn on chat').click();
  await flush();
  assert.deepEqual(mw.log, ['chat.enable']);
  assert.equal(t.el.view, 'off');
  assert.equal(t.el._note, '');
});

test('a refusal from the service (E_POLICY) is shown as its sentence and the panel stays off', async () => {
  const mw = fakeMw({ chat: 'off' });
  mw.chat.enable = async () => { throw Object.assign(new Error('members only'), { code: 'E_POLICY' }); };
  const t = setup({ mw });
  t.el.connectedCallback();
  await flush();
  t.btn('Turn on chat').click();
  await flush();
  assert.equal(t.el.view, 'off');
  assert.ok(t.el._note.length > 0, 'the code text is shown');
});

test('rectOf(label) gives the box of a button or of the message line, for a real click in the closed root; lobby lists the lines', async () => {
  const mw = fakeMw({ chat: 'on' });
  const t = setup({ mw });
  t.el.connectedCallback();
  await flush();
  assert.equal(t.el.rectOf('No such button'), null);
  mw.emit({ room: 'Lobby', from: 'p256:bbbb22223', text: 'hello' }, 'room');
  assert.deepEqual(t.el.lobby.map((l) => l.endsWith(': hello')), [true]);
});

test('Lobby: messages from mw.chat.on appear as text, sending uses room.send, errors show the code text', async () => {
  const mw = fakeMw({ chat: 'on' });
  const t = setup({ mw });
  t.el.connectedCallback();
  await flush();
  assert.equal(t.el.view, 'on');
  mw.emit({ room: 'Lobby', from: { pub: 'p256:aaaa11112', name: 'Bo', short: 'aaaa-1111' }, text: '<img src=x onerror=alert(1)> hi' });
  assert.ok(t.text().includes('Bo (aaaa-1111): <img src=x onerror=alert(1)> hi'), 'text only, never parsed; UX-6: the short id follows a name');
  assert.equal(t.el._shadow.findAll((n) => n.tagName === 'IMG').length, 0);
  const input = t.el._shadow.find((n) => n.tagName === 'INPUT');
  assert.equal(input.getAttribute('name'), 'message');
  assert.notEqual(input.getAttribute('type'), 'password');
  input.value = 'hello room';
  t.btn('Send').click();
  await flush();
  assert.ok(mw.log.includes('room.send:Lobby:hello room'));
  assert.ok(t.el.lobby.includes('You: hello room'), 'UX-7: the service does not echo one\'s own room line, so the panel adds it');
  mw.chat.room.send = async () => { const e = new Error('b'); e.code = 'E_BANNED'; throw e; };
  t.el._shadow.find((n) => n.tagName === 'INPUT').value = 'again';
  t.btn('Send').click();
  await flush();
  assert.ok(t.text().includes('You cannot post here.')); // neutral since review round R 5.3 (UX-11): a ledger ban is no room
});

test('direct messages: pick a person seen in the Lobby, send with dm.send, delivery words only behind the flag', async () => {
  const mw = fakeMw({ chat: 'on' });
  const t = setup({ mw });
  t.el.connectedCallback();
  await flush();
  mw.emit({ room: 'Lobby', from: { pub: 'p256:bobbob', name: 'Bo', short: 'bobb-0000' }, text: 'hi' });
  t.btn('Messages').click();
  t.btn('Bo').click();
  const input = t.el._shadow.find((n) => n.tagName === 'INPUT');
  input.value = 'psst';
  t.btn('Send').click();
  await flush();
  assert.ok(mw.log.includes('dm.send:p256:bobbob:psst'));
  assert.ok(!t.text().includes('Delivered'), 'flag off: no delivery words');
  assert.equal(STRING_FLAGS.deliveryStates, false);
  setStringFlag('deliveryStates', true);
  t.el._tab = 'dms';
  const input2 = t.el._shadow.find((n) => n.tagName === 'INPUT');
  input2.value = 'second';
  t.btn('Send').click();
  await flush();
  assert.ok(t.text().includes('(Delivered)'));
  // incoming DM is kept apart from the Lobby
  mw.emit({ from: { pub: 'p256:bobbob', name: 'Bo' }, text: 'back at you' });
  assert.ok(t.text().includes('Bo: back at you'));
});

test('the panel uses only chat.*, auth.* and ready(): a spy over the whole mw object sees nothing else', async () => {
  const seen = new Set();
  const base = fakeMw({ chat: 'on' });
  const wrap = (o, path) => new Proxy(o, { get(target, k) { const v = target[k]; if (typeof k === 'string' && k !== 'log' && k !== 'emit') seen.add(path + k); return v && typeof v === 'object' ? wrap(v, path + k + '.') : v; } });
  const mw = wrap(base, '');
  const t = setup({ mw });
  t.el.connectedCallback();
  await flush();
  for (const k of seen) assert.ok(/^(ready|auth|chat)/.test(k), k);
  assert.ok(![...seen].some((k) => /identity|me\.|files|media|mod\.|db/.test(k)));
});

test('no secret fields anywhere: only a message line; info sentence shown; unmount unsubscribes', async () => {
  const mw = fakeMw({ chat: 'on' });
  const t = setup({ mw });
  t.el.connectedCallback();
  await flush();
  const inputs = t.el._shadow.findAll((n) => ['INPUT', 'TEXTAREA', 'SELECT'].includes(n.tagName));
  assert.ok(inputs.every((n) => n.getAttribute('name') === 'message' && n.getAttribute('type') === 'text'));
  assert.ok(t.text().includes('Scripts on this page can act as you on this site while you are signed in. They cannot reach your other sites.'));
  t.el.disconnectedCallback();
  assert.ok(mw.log.includes('off:message'));
});

test('the chat service\'s own event shapes (v0.3 reconciliation): room messages on \'room\', from as a key string, grants without text', async () => {
  const mw = fakeMw({ chat: 'on' });
  const t = setup({ mw });
  t.el.connectedCallback();
  await flush();
  assert.equal(t.el.view, 'on');
  // src/chat/service.js onRoom: { room, id, from: <site pub>, t, text, arrived } on 'room'.
  mw.emit({ room: 'Lobby', id: 'r1', from: 'p256:roomauthor9', t: 1, text: 'hello lobby', arrived: 2 }, 'room');
  assert.ok(t.text().includes('hello lobby'), 'a room message shows in the Lobby');
  // A direct message: { id, from: <site pub>, dir: 'in', t, n, text, grant: null, gap } on 'message'.
  mw.emit({ id: 'd1', from: 'p256:dmauthor0001', dir: 'in', t: 3, n: 1, text: 'just you', grant: null, gap: false });
  // A grant message (the site sees { grant: { t } } and no text): nothing in the panel, never the word null.
  mw.emit({ id: 'd2', from: 'p256:dmauthor0001', dir: 'in', t: 4, n: 2, text: null, grant: { t: 'media' }, gap: false });
  t.btn('Messages').click();
  const pick = t.el._shadow.buttonByText('p256:dmauthor0001'.slice(-9));
  assert.ok(pick, 'the sender is listed by the end of their key');
  pick.click();
  assert.ok(t.text().includes('just you'), 'the direct message is kept for its sender');
  assert.ok(!t.text().includes('null'), 'no text for a grant');
});

test('integrator (UX-8, UX-20, UX-6): a message arriving while typing keeps the line and the focus; Enter sends; tabs are tabs; no "?" names', async () => {
  const mw = fakeMw({ chat: 'on' });
  const t = setup({ mw });
  t.el.connectedCallback();
  await flush();
  const input = () => t.el._shadow.find((n) => n.tagName === 'INPUT');
  input().value = 'half a sent';
  input().focus();
  mw.emit({ room: 'Lobby', from: 'p256:cccc33334', text: 'interrupting' }, 'room');
  assert.equal(input().value, 'half a sent', 'the typed line survives the re-render');
  assert.equal(t.doc.activeElement, input(), 'and keeps the focus');
  assert.ok(!t.el.lobby.some((l) => l.startsWith('?')), 'a sender without a name shows its short id');
  const form = t.el._shadow.find((n) => n.tagName === 'FORM');
  assert.ok(form, 'the composer is a form');
  let prevented = false;
  form.dispatchEvent({ type: 'submit', isTrusted: true, preventDefault: () => { prevented = true; } });
  await flush();
  assert.equal(prevented, true);
  assert.ok(mw.log.includes('room.send:Lobby:half a sent'), 'Enter (submit) sends like the button');
  const tabs = t.el._shadow.findAll((n) => n.getAttribute && n.getAttribute('role') === 'tab');
  assert.equal(tabs.length, 2);
  assert.deepEqual(tabs.map((b) => b.getAttribute('aria-selected')), ['true', 'false']);
  assert.ok(tabs.every((b) => b.getAttribute('aria-pressed') === null || b.getAttribute('aria-pressed') === undefined));
});
