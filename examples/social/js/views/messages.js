// Messages (R 3.5 "Realtime"): direct messages between people who allow it, over the loader's chat lane. Nothing here is written to
// any ledger, so a conversation can be recorded by anyone connected to it (R 2.14.2). The list of who is "Connected to you now",
// the contacts, message requests and one conversation. Reading contacts and history opens a card once per session, so those
// buttons are real taps.

import { h, setChildren } from '../dom.js';
import { hrefFor } from '../router.js';
import { PRIVACY, CONNECTED, errorMessage } from '../strings.js';
import { KEYS as SK } from '../store.js';
import { stateCard, link } from './common.js';

export async function mount(ctx, route, container) {
  const d = ctx.data, chat = ctx.chat, inbox = ctx.inbox;
  if (!d.signedIn()) { container.append(stateCard('', 'Sign in to send and read messages.', [h('button', { type: 'button', class: 'btn primary', on: { click: () => ctx.signIn() } }, 'Sign in')])); return { title: 'Messages' }; }
  if (!chat || !inbox) { container.append(stateCard('', errorMessage({ code: 'NOT_AVAILABLE' }), [])); return { title: 'Messages' }; }
  const on = (await chat.state()) === 'on';
  if (!on) {
    const msg = h('p', { class: 'error', role: 'alert' });
    container.append(h('section', { class: 'card state' }, h('p', {}, 'Messages are off. When you turn them on, a card names who your browser will connect to and what they can see.'), h('p', {}, PRIVACY.conversations),
      h('div', { class: 'row' }, h('button', { type: 'button', class: 'btn primary', id: 'chat-on', on: { click: async () => { try { await d.ensureFeature('chat'); await chat.enable(); ctx.rerender(); } catch (e) { msg.textContent = errorMessage(e); } } } }, 'Turn on messages')), msg));
    return { title: 'Messages' };
  }
  const unsub = inbox.onChange(() => draw());
  ctx.subs.push(unsub);
  const body = h('div', { class: 'stack' });
  container.append(h('p', { class: 'small muted' }, PRIVACY.messagesArrive), body);
  let note = '', code = '';
  const isVerified = (c) => !!c.verified || ctx.store.get(SK.verified, []).indexOf(c.pub) !== -1;

  async function ensureContacts() { if (!inbox.state.loaded) await inbox.loadContacts(); }
  function peopleList() {
    const s = inbox.state;
    return h('div', { class: 'stack' },
      h('section', { class: 'card stack', id: 'presence' }, h('h2', {}, CONNECTED),
        s.presence.length ? h('ul', { class: 'convo-list' }, s.presence.map((p) => h('li', {}, p.short ? link(ctx, hrefFor('thread', { short: p.short }), (p.name || p.short)) : h('span', {}, p.name || 'Someone')))) : h('p', { class: 'muted' }, 'Nobody who shares presence with you right now. People who are connected to you can see that your address is on this site\'s chat.'),
        h('button', { type: 'button', class: 'btn small', on: { click: async () => { try { await inbox.loadPresence(); } catch (e) { ctx.fail(e); } } } }, 'Refresh')),
      h('section', { class: 'card stack', id: 'contacts' }, h('h2', {}, 'Conversations'),
        s.loaded ? (s.contacts.length ? h('ul', { class: 'convo-list' }, s.contacts.map((c) => h('li', {}, h('a', { href: hrefFor('thread', { short: c.short || c.pub.slice(5, 13) }) }, h('span', {}, c.name || c.short || 'Someone'), ' ', h('span', { class: 'short' }, '(' + c.short + ')'), isVerified(c) ? null : h('span', { class: 'badge' }, 'New contact'), inbox.state.unread.get(c.pub) ? h('span', { class: 'count' }, String(inbox.state.unread.get(c.pub))) : null)))) : h('p', { class: 'muted' }, 'No contacts yet. Open someone\'s page and tap Message.')) :
          [h('p', {}, 'Your contacts are in your private record. Showing them opens a card once per session.'), h('button', { type: 'button', class: 'btn', id: 'show-contacts', on: { click: async () => { try { await inbox.loadContacts(); await inbox.loadPresence(); } catch (e) { ctx.fail(e); } } } }, 'Show my conversations')]),
      s.requests.length ? h('section', { class: 'card stack', id: 'requests' }, h('h2', {}, 'Message requests (' + s.requests.length + ')'), h('ul', { class: 'stack' }, s.requests.map((r) => h('li', { class: 'row between' }, h('span', {}, (r.from && (r.from.name || r.from.short)) || 'Someone'),
        h('span', { class: 'row' }, h('button', { type: 'button', class: 'btn small', on: { click: async () => { try { await chat.acceptRequest(r.id); await inbox.loadRequests(); } catch (e) { ctx.fail(e); } } } }, 'Accept'),
          h('button', { type: 'button', class: 'btn small', on: { click: async () => { try { await chat.declineRequest(r.id); await inbox.loadRequests(); } catch (e) { ctx.fail(e); } } } }, 'Decline')))))) : null);
  }
  function threadView() {
    const c = inbox.byShort(route.short);
    if (!c) {
      return h('section', { class: 'card state' }, h('p', {}, inbox.state.loaded ? 'No conversation with that id. Messages need a contact: open the person\'s page and tap Message.' : 'Open your conversations first.'),
        inbox.state.loaded ? null : h('button', { type: 'button', class: 'btn primary', on: { click: async () => { try { await ensureContacts(); } catch (e) { ctx.fail(e); } } } }, 'Show my conversations'),
        link(ctx, hrefFor('messages'), 'All conversations', 'btn'));
    }
    const t = inbox.thread(c.pub), who = c.name || c.short;
    const area = h('textarea', { id: 'dm-text', rows: 3, maxlength: 2000, 'aria-label': 'Message' });
    const err = h('p', { class: 'error', role: 'alert' });
    const verify = isVerified(c) ? null : h('button', { type: 'button', class: 'btn small', id: 'verify', on: { click: async () => {
      try { const r = await chat.verify(c.pub); code = r && r.code ? String(r.code).replace(/(\d{4})(?=\d)/g, '$1 ') : ''; draw(); } catch (e) { ctx.fail(e); }
    } } }, 'Verify this person');
    const block = h('button', { type: 'button', class: 'btn small danger', on: { click: () => { d.block(c.pub); ctx.note('Blocked.', 'ok'); ctx.go(hrefFor('messages')); } } }, 'Block');
    const matched = h('button', { type: 'button', class: 'btn small', id: 'codes-match', on: { click: () => { ctx.store.set(SK.verified, Array.from(new Set(ctx.store.get(SK.verified, []).concat([c.pub])))); code = ''; draw(); } } }, 'The codes match');
    const verifyLine = isVerified(c)
      ? h('p', { class: 'small', id: 'verified-line' }, h('span', { class: 'badge' }, 'Verified'), ' You compared a code with ' + who + ' on this device.')
      : code
        ? h('div', { class: 'notice info', id: 'verify-code' }, h('p', {}, 'Compare this code with ' + who + ' in person or over a call you trust: ', h('strong', {}, code)), matched)
        : h('p', { class: 'small muted' }, h('span', { class: 'badge' }, 'New contact'), ' Names are free text. Compare a short code in person to be sure who you are talking to.');
    const bubble = (m) => h('div', { class: 'bubble' + (m.me ? ' me' : '') }, m.text,
      h('small', {}, (m.t ? new Date(m.t).toLocaleTimeString() : '') + (m.me ? ' Sent' : '')));
    const history = t.loaded
      ? h('div', { class: 'bubbles', id: 'bubbles', role: 'log', 'aria-label': 'Conversation' }, t.messages.length ? t.messages.map(bubble) : [h('p', { class: 'muted' }, 'No messages yet.')])
      : h('div', { class: 'stack' }, h('p', {}, 'Showing the history opens a card once per session.'),
        h('button', { type: 'button', class: 'btn', id: 'load-thread', on: { click: async () => { try { await inbox.loadThread(c.pub); } catch (e) { ctx.fail(e); } } } }, 'Open this conversation'));
    const form = h('form', { class: 'stack', novalidate: true, on: { submit: async (ev) => {
      ev.preventDefault(); err.textContent = '';
      if (!area.value.trim()) return;
      try { await inbox.send(c.pub, area.value.trim()); area.value = ''; } catch (e) { err.textContent = errorMessage(e, { name: who }); }
    } } },
    h('div', { class: 'field' }, h('label', { for: 'dm-text' }, 'Write a message'), area), err,
    h('div', { class: 'row end' }, h('button', { type: 'submit', class: 'btn primary', id: 'dm-send' }, 'Send')));
    const top = h('div', { class: 'row between' }, h('h2', {}, who + ' ', h('span', { class: 'short' }, '(' + c.short + ')')), link(ctx, hrefFor('messages'), 'All conversations', 'btn small'));
    return h('div', { class: 'stack' }, h('section', { class: 'card stack' }, top, h('div', { class: 'row' }, verify, block), verifyLine, history, form));
  }
  function draw() {
    setChildren(body, [route.name === 'thread' ? threadView() : peopleList(), note ? h('p', { class: 'small', role: 'status' }, note) : null]);
    const bubbles = document.getElementById('bubbles'); if (bubbles) bubbles.scrollTop = bubbles.scrollHeight;
  }
  draw();
  if (!inbox.state.loaded) { /* the first read of contacts needs a tap, so the buttons above do it */ }
  if (route.name === 'thread') inbox.markRead((inbox.byShort(route.short) || {}).pub);
  return { title: route.name === 'thread' ? 'Conversation' : 'Messages' };
}
