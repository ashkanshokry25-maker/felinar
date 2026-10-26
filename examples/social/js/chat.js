// Thin wrapper over mw.chat (R 2.7, 2.11.2): contacts, direct messages, rooms, requests and presence for the Messages page, plus
// the one thing the template adds, notices (notices.js), which travel as ordinary direct messages and are filtered out of the
// conversation list. Chat is off until the person turns it on (a card the loader shows), and on a host-only visit it refuses
// with E_HOST_ONLY; this file passes those errors on unchanged.
//
// Shapes of the landed chat service (src/chat/service.js): mw.chat.on('message') gives a direct message { id, from: <public key>, dir, t, n,
// text, grant, gap } and mw.chat.on('room') a room message { room, id, from: <public key>, t, text }; contacts are { pub, nick, blocked,
// verified, hasChatKey }; message requests are { id, from: <public key>, t, size }; chat.state() is { state: 'on' | 'off', ... }. Names are
// not carried, so this file makes every sender a person { pub, name, short } the views can show; older loaders that already send that
// object are accepted too. A room message you send is not echoed back to you: the view adds it itself.

import { decodeNotice } from './notices.js';
import { shortIdOf } from './ids.js';

const noop = () => {};
const asFn = (x) => (typeof x === 'function' ? x : noop);

/** personOf(from) -> { pub, name, short } for a public key string or for an object that already has those fields. */
export function personOf(from) {
  if (typeof from === 'string') return { pub: from, name: '', short: shortIdOf(from) };
  const x = from && typeof from === 'object' ? from : {};
  const pub = typeof x.pub === 'string' ? x.pub : '';
  return { pub, name: x.name || x.nick || '', short: x.short || (pub ? shortIdOf(pub) : '') };
}
const withPerson = (msg) => Object.assign({}, msg, { from: personOf(msg.from) });

export function createChat({ mw }) {
  const chat = mw && mw.chat && typeof mw.chat === 'object' ? mw.chat : null;
  if (!chat) return null;
  const subs = [];
  const sub = (event, fn) => {
    try { const off = chat.on(event, fn); subs.push(asFn(off)); return asFn(off); } catch (err) { return noop; }
  };
  const messageListeners = new Set(), roomListeners = new Set(), noticeListeners = new Set();
  let wired = false;
  function wire() {
    if (wired || typeof chat.on !== 'function') return;
    wired = true;
    sub('message', (raw) => {
      if (!raw || typeof raw !== 'object' || typeof raw.text !== 'string') return; // a file grant has no text: the Media page handles those
      const msg = withPerson(raw);
      const notice = !msg.room ? decodeNotice(msg.text) : null;
      if (notice) { for (const fn of noticeListeners) fn(notice, msg); return; }
      for (const fn of messageListeners) fn(msg);
    });
    sub('room', (raw) => { if (raw && typeof raw === 'object' && typeof raw.text === 'string') { const msg = withPerson(raw); for (const fn of roomListeners) fn(msg); } });
  }
  const person = (p) => {
    const x = p && typeof p === 'object' ? p : {};
    const who = personOf({ pub: x.pub || x.key || '', name: x.nick || x.name || '', short: x.short || '' });
    return { pub: who.pub, name: who.name, short: who.short, blocked: !!x.blocked, verified: !!x.verified };
  };
  return {
    available: true,
    async state() {
      try {
        const st = typeof chat.state === 'function' ? await chat.state() : 'off';
        return st === 'on' || (st && (st.enabled === true || st.state === 'on')) ? 'on' : 'off';
      } catch (err) { return 'off'; }
    },
    enable() { return chat.enable(); },
    disable() { return chat.disable(); },
    onNotice(fn) { wire(); noticeListeners.add(fn); return () => noticeListeners.delete(fn); },
    onMessage(fn) { wire(); messageListeners.add(fn); return () => messageListeners.delete(fn); },
    onRoom(fn) { wire(); roomListeners.add(fn); return () => roomListeners.delete(fn); },
    onEvent(event, fn) { return sub(event, fn); },
    /** sendNotice(pub, text) -> true when the loader accepted it. A notice that cannot be delivered is dropped silently: it is a courtesy. */
    async sendNotice(pub, text) {
      try { await chat.dm.send(pub, { text }); return true; } catch (err) { return false; }
    },
    /** contacts() -> [{ pub, name, short, blocked }]. The first call of a session opens a card (UI-gated), so call it from a click. */
    async contacts() { const out = await chat.contacts.list(); return (Array.isArray(out) ? out : []).map(person).filter((p) => p.pub); },
    async history(pub, opts) {
      const out = await chat.dm.history(pub, Object.assign({ limit: 50 }, opts));
      return (Array.isArray(out) ? out : []).filter((m) => m && typeof m.text === 'string').map((m, i) => ({
        id: m.id || 'h' + i, me: m.dir === 'out' || !!(m.me || m.mine || m.outgoing), text: m.text, t: Number(m.t) || 0, state: m.state || '',
      })).filter((m) => !decodeNotice(m.text));
    },
    async send(pub, text) { return chat.dm.send(pub, { text }); },
    async presence() {
      try { const out = typeof chat.presence.list === 'function' ? await chat.presence.list() : []; return (Array.isArray(out) ? out : []).map((p) => Object.assign(person(p), { status: p.status || '', since: Number(p.since) || 0 })); } catch (err) { return []; }
    },
    setPresence(on, isPublic) { return chat.presence.set({ on: !!on, public: !!isPublic }); },
    async requests() { const out = await chat.requests.list(); return (Array.isArray(out) ? out : []).filter((r) => r && typeof r === 'object').map((r) => Object.assign({}, r, { from: personOf(r.from) })); },
    acceptRequest(id) { return chat.requests.accept(id); },
    declineRequest(id) { return chat.requests.decline(id); },
    setRequestsOpen(on) { return chat.requests.setOpen(!!on); },
    joinRoom(name) { return chat.room.join(name); },
    leaveRoom(name) { return chat.room.leave(name); },
    sendRoom(name, text) { return chat.room.send(name, { text }); },
    createGroup(name, members) { return chat.group.create({ name, members }); },
    sendGroup(id, text) { return chat.group.send(id, { text }); },
    block(pub) { return chat.contacts.block(pub); },
    unblock(pub) { return chat.contacts.unblock(pub); },
    addContact(pub, nick) { return chat.contacts.add(pub, { nick }); },
    verify(pub) { return chat.contacts.verify(pub); },
    setHolder(on) { return chat.holder.set(!!on); },
    destroy() { for (const off of subs) off(); subs.length = 0; messageListeners.clear(); roomListeners.clear(); noticeListeners.clear(); },
  };
}
