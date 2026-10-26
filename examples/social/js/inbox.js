// The conversation state for the Messages page and the unread count: contacts (read once per session, because the first read
// opens a card), the threads loaded so far, and live messages from mw.chat.on('message'). Messages are never written to the
// ledger (R 2.7); they live here, in memory, and in the loader's own history if the person keeps it.

export function createInbox({ chat, data, announce }) {
  const state = { contacts: [], loaded: false, threads: new Map(), unread: new Map(), requests: [], presence: [] };
  const listeners = new Set();
  const emit = () => { for (const fn of listeners) fn(); };
  const byPub = (pub) => state.contacts.find((c) => c.pub === pub) || null;
  const byShort = (short) => state.contacts.find((c) => c.short === short) || null;
  // A direct message names its sender by key only: the name is the contact's nickname, else the name on a page this browser follows.
  const nameFor = (pub) => {
    const c = byPub(pub);
    if (c && c.name) return c.name;
    return data.ownerName(pub);
  };
  function thread(pub) {
    if (!state.threads.has(pub)) state.threads.set(pub, { pub, messages: [], loaded: false });
    return state.threads.get(pub);
  }
  let off = () => {};
  if (chat) {
    off = chat.onMessage((msg) => {
      const pub = msg.from && msg.from.pub;
      if (!pub || data.blockedSet().has(pub)) return;
      const t = thread(pub);
      t.messages.push({ id: msg.id || 'm' + t.messages.length + '-' + Date.now(), me: false, text: String(msg.text == null ? '' : msg.text), t: Number(msg.t) || Date.now(), state: '' });
      const name = nameFor(pub) || (msg.from && msg.from.name) || '';
      if (!byPub(pub)) state.contacts.push({ pub, name, short: (msg.from && msg.from.short) || '', blocked: false });
      if (!window.location.pathname.endsWith('/' + ((msg.from && msg.from.short) || '\u0000'))) {
        state.unread.set(pub, (state.unread.get(pub) || 0) + 1);
        announce('New message from ' + (name || (msg.from && msg.from.short) || 'someone'));
      }
      emit(); data.emit('change');
    });
  }
  return {
    state, onChange(fn) { listeners.add(fn); return () => listeners.delete(fn); },
    byPub, byShort, thread, nameFor,
    unreadTotal: () => Array.from(state.unread.values()).reduce((a, b) => a + b, 0),
    async loadContacts() { state.contacts = await chat.contacts(); state.loaded = true; emit(); return state.contacts; },
    async loadThread(pub) {
      const t = thread(pub);
      const hist = await chat.history(pub, { limit: 50 });
      const live = t.messages.filter((m) => !hist.some((x) => x.id === m.id));
      t.messages = hist.concat(live); t.loaded = true; state.unread.delete(pub); emit(); return t;
    },
    async send(pub, text) {
      const t = thread(pub);
      const res = await chat.send(pub, text);
      t.messages.push({ id: (res && res.id) || 'out' + Date.now(), me: true, text, t: Date.now(), state: (res && res.state) || '' });
      emit(); return res;
    },
    async loadPresence() { state.presence = await chat.presence(); emit(); return state.presence; },
    async loadRequests() { state.requests = await chat.requests(); emit(); return state.requests; },
    markRead(pub) { state.unread.delete(pub); emit(); },
    destroy() { off(); },
  };
}
