// In-memory stand-in for /_mw/sdk.js, used only by the browser tests (test/example/browser.test.mjs for the guestbook,
// test/example/social-browser.test.mjs for the social template). It is not part of any site and is never published. The test serves it
// at /_mw/sdk.js and sets globalThis.__mwScenario (with page.addInitScript) before the page runs; globalThis.__mwMock lets the
// test play the other visitors, other people's ledgers, incoming chat, policy changes and consent.
//
// Two shapes, chosen by the scenario:
//   v0.2.1 (the default): ARCHITECTURE section 9. One ledger, a device identity that is always present, no auth namespace.
//   v0.3 (scenario auth: 'guest' | 'signed-in'): R 2.11.2. auth.*, identity.*, me.*, db.setMine and the { ledger } reads, hub.*, mod.*,
//     chat.*, files.*, media.*, report.send. The { ledger } option and mw.hub are the sdk lane's amendment (R 2.11.2 has no
//     method for reading followed ledgers); createPage, withdrawPage and site.info().pointer are the template's GAP 1 to 3 (js/hub.js)
//     and exist here only when the scenario turns them on.

const S = Object.assign({
  noHost: false, role: 'writer', name: '', owner: null, unmoderated: false, mode: 'shell', source: 'peers',
  siteId: 'mw1:Q2hlY2tpbmdUaGVFeGFtcGxlU2l0ZQ', btih: '0123456789abcdef0123456789abcdef01234567',
  height: 3, peers: 1, inSync: 1, consent: 'accepted', kvForm: 'record', replay: true, notice: null,
  policy: { writers: 'open', bits: 16, maxValueBytes: 2048, moderators: [], banned: [] }, posts: [],
}, globalThis.__mwScenario || {});
const V03 = S.auth === 'guest' || S.auth === 'signed-in';

// Deterministic fake P-256 public keys: 65 bytes starting with 0x04, base64url (87 characters).
export function fakePub(seed) {
  const bytes = [4];
  for (let i = 1; i < 65; i++) bytes.push((seed * 131 + i * 17) & 255);
  return btoa(String.fromCharCode.apply(null, bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
const tag = (b64) => (V03 ? 'p256:' + b64 : b64);
const ME = S.me || tag(fakePub(1));
let counter = 0;
const newHash = () => { counter += 1; return (counter.toString(16).padStart(8, '0') + 'ab'.repeat(28)).slice(0, 64); };
const minute = (ms) => Math.floor(ms / 60000) * 60000;
let chatSeq = 0;
const chatId = () => { chatSeq += 1; return 'c' + chatSeq.toString(36).padStart(6, '0'); };
const clone = (x) => JSON.parse(JSON.stringify(x));
// The ledger's schema for _mw.cfg (src/chain/state.js cfgOk, R 2.5.5): one unknown key hides the whole object. The mock models it when the
// scenario asks (enforceCfg), so a template that writes a key the ledger does not know fails here as it would against the loader.
const CFG_ENUMS = { chat: ['off', 'members', 'open'], files: ['off', 'members'], media: ['off', 'members'], records: ['off', 'sealed'], requests: ['off', 'on'], calls: ['off', 'contacts'] };
function cfgOk(v) {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return false;
  for (const k of Object.keys(v)) {
    const x = v[k];
    if (CFG_ENUMS[k]) { if (CFG_ENUMS[k].indexOf(x) < 0) return false; } else if (k === 'maxItems') { if (!Number.isSafeInteger(x) || x < 1 || x > 32) return false; } else if (k === 'chatBits') { if (!Number.isSafeInteger(x) || x < 0 || x > 32) return false; } else if (k === 'pin' || k === 'age' || k === 'turn') { /* shape not modelled */ } else return false;
  }
  return true;
}
const enc = (s) => new TextEncoder().encode(s);
const b64url = (u8) => btoa(String.fromCharCode.apply(null, u8)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

const HOME = S.siteId;
const state = {
  height: S.height, peers: S.peers, inSync: S.inSync, kv: {}, lists: { guestbook: [] }, profiles: {},
  policy: clone(S.policy), owner: S.owner || null, bytes: 4096,
};
if (S.name) state.profiles[ME] = S.name;
for (const p of S.posts) {
  state.lists.guestbook.push({ h: p.h || newHash(), author: p.author, ts: p.ts != null ? p.ts : minute(Date.now()), v: { msg: p.msg } });
  if (p.name) state.profiles[p.author] = p.name;
}
const record = (v, author) => (S.kvForm === 'plain' ? v : { v, author, h: newHash(), ts: minute(Date.now()) });
// The entries of keys (put), current or replaced by a later write: db.tombstone(h) takes their hashes too (docs/SDK.md: "To make a key
// absent, del it, then tombstone the older entries whose bytes must go"). h -> author.
const kvEntries = new Map();
const noteKv = (rec) => { if (rec && typeof rec === 'object' && typeof rec.h === 'string') kvEntries.set(rec.h, rec.author || null); return rec; };
if (S.notice != null) state.kv._notice = record(S.notice, S.owner || ME);
// A v0.3 scenario may seed the home ledger and a world of other ledgers.
if (S.home) {
  Object.assign(state.lists, clone(S.home.lists || {}));
  Object.assign(state.kv, clone(S.home.kv || {}));
  for (const k of Object.keys(state.kv)) noteKv(state.kv[k]);
  Object.assign(state.profiles, clone(S.home.profiles || {}));
  if (S.home.policy) state.policy = clone(S.home.policy);
}
const others = new Map(); // ledger id -> { id, owner, policy, lists, kv, profiles, bytes }
for (const l of S.ledgers || []) others.set(l.id, { id: l.id, owner: l.owner, withdrawn: l.withdrawn, removed: l.removed, policy: clone(l.policy || { writers: 'owner', bits: 16, maxValueBytes: 2048, moderators: [], banned: [] }), lists: clone(l.lists || {}), kv: clone(l.kv || {}), profiles: clone(l.profiles || {}), bytes: l.bytes || 20480 });
const followed = new Set(S.followed || []);
const pointerMap = new Map(Object.entries(S.pointers || {}));

const listeners = { state: new Set(), peers: new Set(), progress: new Set(), status: new Set(), sync: new Set(), pow: new Set() };
const ledgerSubs = new Map(); // id -> Set(fn)
const chatListeners = new Map();
const authListeners = new Set();
const mediaListeners = new Map();
const calls = [];
const err = (code, message) => Object.assign(new Error(message || code), { code });
const later = (value, ms) => new Promise((resolve) => setTimeout(() => resolve(value), ms == null ? 5 : ms));
const fail = (code) => new Promise((resolve, reject) => setTimeout(() => reject(err(code)), 5));
const ledgerOf = (opts) => (opts && opts.ledger && opts.ledger !== HOME ? others.get(opts.ledger) || null : state);
function snapOf(l) {
  const home = l === state;
  return clone({ height: l.height || 1, depth: 1, bytes: l.bytes || 1024, capReached: false, kv: l.kv, lists: l.lists, profiles: l.profiles, policy: l.policy,
    owner: l.owner || null, authors: 1, unmoderated: false, peers: home ? state.peers : 1, inSync: home ? state.inSync : 1, role: home ? currentRole() : 'reader',
    withdrawn: l.withdrawn === true, removed: l.removed || undefined });
}
const snapshot = () => snapOf(state);
function emit(event, data) { for (const fn of listeners[event] || []) fn(data); }
function push() { setTimeout(() => emit('state', snapshot()), 5); }
function pushLedger(id) { setTimeout(() => { const l = others.get(id); for (const fn of ledgerSubs.get(id) || []) if (l) fn(snapOf(l)); }, 5); }
function emitChat(event, data) { for (const fn of chatListeners.get(event) || []) fn(data); }

// ---- auth state (v0.3)
let auth = V03 ? S.auth : 'signed-in';
// mode is the key mode as the loader names it (docs/SDK.md, mw.ready): 'private' by default, 'hub' for one identity on all of a hub.
const identity = () => (auth === 'signed-in' || !V03 ? { pub: ME, short: S.short || 'cafe0001', name: state.profiles[ME] || S.name || '', mode: S.identityMode || 'private' } : null);
function currentRole() {
  if (V03 && auth !== 'signed-in') return 'reader';
  return S.role;
}
const banned = (pub) => state.policy.banned.indexOf(pub) !== -1;
const isMod = () => currentRole() === 'owner' || currentRole() === 'moderator' || state.policy.moderators.indexOf(ME) !== -1;
function canWrite() {
  if (V03 && auth !== 'signed-in') return 'E_NOT_SIGNED_IN';
  if (banned(ME)) return 'E_BANNED';
  if (isMod()) return null;
  if (state.policy.writers === 'open') return null;
  if (V03 && state.policy.writers === 'allow' && currentRole() === 'writer') return null; // on the allow list
  return 'E_POLICY';
}
const authorScope = async (pub) => '@' + b64url(new Uint8Array(await crypto.subtle.digest('SHA-256', enc(pub)))).slice(0, 16) + '/';

function findItem(h) {
  for (const name of Object.keys(state.lists)) { const at = state.lists[name].findIndex((it) => it && it.h === h); if (at !== -1) return { list: state.lists[name], at }; }
  return null;
}

// The loader refuses a feature the page's own ledger has no switch for (src/chat/service.js chatAllowed, src/files/service.js, src/media/service.js).
function needSwitch(name) {
  if (!S.enforceCfg) return;
  const e = state.kv['_mw.cfg'];
  const c = e && typeof e === 'object' && 'v' in e && 'h' in e ? e.v : e;
  if (!c || !c[name] || c[name] === 'off') throw err('E_POLICY', 'this site has not turned this on');
}

const mw = {
  ready() {
    calls.push(['ready']);
    if (S.noHost) return fail('E_NO_HOST');
    const info = { siteId: S.siteId, btih: S.btih, mode: S.mode, identity: identity(), role: currentRole(), peers: state.peers, height: state.height, owner: S.owner, unmoderated: S.unmoderated };
    if (V03) { info.auth = auth; info.features = Object.assign({ chat: !!S.chat, files: true, media: true, records: true, requests: false }, S.features || {}); }
    if (S.legacy) { delete info.role; delete info.unmoderated; }
    return later(info);
  },
  db: {
    get(key, opts) {
      calls.push(['db.get', key, opts && opts.ledger]);
      const l = ledgerOf(opts);
      return later(l ? l.kv[key] : undefined);
    },
    set(key, value) {
      calls.push(['db.set', key, value]);
      if (S.appendError) return fail(S.appendError);
      const denied = canWrite() || (key[0] === '_' && !isMod() ? 'E_POLICY' : null);
      if (denied) return fail(denied);
      if (value === null) delete state.kv[key];
      else if (key === '_mw.cfg' && S.enforceCfg && !cfgOk(value)) { /* hidden by the ledger: a valid block with no effect */ } else state.kv[key] = noteKv(record(value, ME));
      state.height += 1;
      push();
      return later({ h: newHash() });
    },
    del(key) { return mw.db.set(key, null); },
    list(name, opts) {
      calls.push(['db.list', name, opts && opts.ledger]);
      const o = opts || {}, l = ledgerOf(o);
      const items = ((l && l.lists[name]) || []).slice();
      if (o.newestFirst !== false) items.reverse();
      return later(clone(items.slice(0, o.limit || 100)));
    },
    append(name, value, opts) {
      calls.push(['db.append', name, value]);
      if (S.appendError && name !== 'mw.f') return fail(S.appendError);
      const denied = canWrite();
      if (denied) return fail(denied);
      const item = { h: newHash(), author: ME, ts: minute(Date.now()), v: value };
      (state.lists[name] = state.lists[name] || []).push(item);
      state.height += 1;
      if (opts && typeof opts.onProgress === 'function') { opts.onProgress({ hashes: 1024, bits: 16 }); emit('pow', { hashes: 1024, bits: 16 }); }
      push();
      return later({ h: item.h }, S.writeDelay != null ? S.writeDelay : 40); // stands in for the proof-of-work
    },
    tombstone(h) {
      calls.push(['db.tombstone', h]);
      const f = findItem(h);
      if (!f) {
        if (!kvEntries.has(h)) return fail('E_LIMIT');
        if (kvEntries.get(h) !== ME && !isMod()) return fail('E_NOT_MODERATOR');
        kvEntries.delete(h);
        for (const k of Object.keys(state.kv)) if (state.kv[k] && state.kv[k].h === h) delete state.kv[k]; // a key's current entry (no older one is modelled)
        state.height += 1;
        push();
        return later({ h: newHash() });
      }
      if (f.list[f.at].author !== ME && !isMod()) return fail('E_NOT_MODERATOR');
      f.list.splice(f.at, 1);
      state.height += 1;
      push();
      return later(undefined);
    },
    subscribe(fn, opts) {
      if (opts && opts.ledger && opts.ledger !== HOME) {
        const id = opts.ledger;
        if (!ledgerSubs.has(id)) ledgerSubs.set(id, new Set());
        ledgerSubs.get(id).add(fn);
        const l = others.get(id);
        if (l && S.replay !== false) setTimeout(() => fn(snapOf(l)), 15);
        return () => ledgerSubs.get(id).delete(fn);
      }
      listeners.state.add(fn);
      if (S.replay && !S.noHost) setTimeout(() => fn(snapshot()), 15);
      return () => listeners.state.delete(fn);
    },
    async setMine(name, value) {
      calls.push(['db.setMine', name, value]);
      const denied = canWrite();
      if (denied) throw err(denied);
      const key = (await authorScope(ME)) + name;
      if (value === null) delete state.kv[key]; else state.kv[key] = noteKv(record(value, ME));
      state.height += 1;
      push();
      return { h: newHash() };
    },
  },
  mod: {
    ban(pub) {
      calls.push(['mod.ban', pub]);
      if (!isMod()) return fail('E_NOT_MODERATOR');
      state.policy.banned.push(pub);
      for (const name of Object.keys(state.lists)) state.lists[name] = state.lists[name].filter((it) => it.author !== pub);
      state.height += 1;
      push();
      return later(undefined);
    },
  },
  identity: {
    setName(name) {
      calls.push(['identity.setName', name]);
      if (typeof name !== 'string' || !name) return fail('E_LIMIT');
      state.profiles[ME] = name;
      state.height += 1;
      push();
      return later(undefined);
    },
    export() { return fail('E_IDENTITY'); },
    import() { return fail('E_IDENTITY'); },
  },
  net: {
    peers() { return state.peers; },
    on(event, fn) {
      if (!listeners[event] || event === 'state') throw err('E_LIMIT', 'mw.net.on: unknown event ' + event);
      listeners[event].add(fn);
      return () => listeners[event].delete(fn);
    },
  },
  site: {
    info() {
      calls.push(['site.info']);
      const info = { name: S.siteName || 'Peer Guestbook', btih: S.btih, source: S.source, mode: S.mode,
        files: [{ path: 'index.html', length: 6318 }, { path: 'css/app.css', length: 7000 }, { path: 'media/clip.mp4', length: 18833 }] };
      if (S.pointer) info.pointer = S.pointer; // GAP 3: only when the scenario turns it on
      return later(info);
    },
  },
  consent: {
    state() { calls.push(['consent.state']); return later(S.consent); },
    accept() { S.consent = 'accepted'; emit('status', { consent: 'accepted' }); return later(undefined); },
  },
  owner: { policy() { return fail('E_NOT_OWNER'); } },
};

if (V03) {
  const needSign = () => (auth === 'signed-in' ? null : 'E_NOT_SIGNED_IN');
  const notify = () => { for (const fn of authListeners) fn({ state: auth, identity: identity(), role: currentRole() }); };
  mw.auth = {
    async signIn() {
      calls.push(['auth.signIn']);
      if (S.signInError) throw err(S.signInError);
      await later(null, S.signInDelay != null ? S.signInDelay : 20);
      auth = 'signed-in';
      notify();
      return { state: 'signed-in', identity: identity(), role: currentRole() };
    },
    async signOut(opts) { calls.push(['auth.signOut', opts]); auth = 'guest'; notify(); return { state: 'guest' }; },
    state() { return auth; },
    onChange(fn) { authListeners.add(fn); return () => authListeners.delete(fn); },
  };
  Object.assign(mw.identity, {
    current() { return identity(); },
    backupStatus() { return later(S.backup || { kitSaved: false, fileSaved: false, passkey: true, persisted: true, legacy: false }); },
    async openIdentity() { calls.push(['identity.openIdentity']); return 'done'; },
  });
  const record2 = S.me2 || {};
  const privateRecord = Object.assign({}, record2);
  mw.me = {
    async get(field) { calls.push(['me.get', field]); const e = needSign(); if (e) throw err(e); return field ? privateRecord[field] : clone(privateRecord); },
    async set(field, value) { calls.push(['me.set', field, value]); const e = needSign(); if (e) throw err(e); privateRecord[field] = clone(value); return { stored: S.syncedRecord ? 'synced' : 'local' }; },
    async del(field) { calls.push(['me.del', field]); delete privateRecord[field]; return { stored: S.syncedRecord ? 'synced' : 'local' }; },
    async sync(o) { calls.push(['me.sync', o]); if (S.syncError) throw err(S.syncError, S.syncErrorMessage); return { on: !!(o && o.on) }; },
    async erase() { calls.push(['me.erase']); for (const k of Object.keys(privateRecord)) delete privateRecord[k]; return { tombstoned: 0, shredded: true }; },
  };
  // mw.hub as the loader answers (src/loader/personal-site.js): follow -> { ledger, following, cap }, unfollow -> { ledger, following, removed },
  // list -> [{ ledger, owner, since, height, pointer }], createPage -> { ledgerId, label, url, pointer } with the pointer and the genesis in the url fragment.
  mw.hub = {
    async follow(target) {
      calls.push(['hub.follow', target]);
      const id = pointerMap.get(target) || (typeof target === 'string' && target.startsWith('mw1:') ? target : null);
      const cap = S.followCap || 250;
      if (!id) throw err('E_BAD_REQUEST', 'follow takes a pointer');
      if (followed.has(id)) return { ledger: id, following: followed.size, already: true };
      if (followed.size >= cap) throw err('E_LIMIT', 'You follow ' + followed.size + ' of ' + cap + ' on this phone');
      followed.add(id);
      return { ledger: id, following: followed.size, cap };
    },
    async unfollow(id) { calls.push(['hub.unfollow', id]); const removed = followed.delete(id); return { ledger: id, following: followed.size, removed }; },
    async list() { return Array.from(followed, (ledger) => ({ ledger, owner: null, since: Date.now(), height: 1, pointer: null })); },
  };
  if (S.createPage) {
    mw.hub.createPage = async () => {
      calls.push(['hub.createPage']);
      if (S.createPage.error) throw err(S.createPage.error);
      const pointer = 'v=mw1; btih=' + S.btih + '; owner=' + ME + '; chain=AAAAAAAAAAAAAAAAAAAAAA';
      return { ledgerId: S.createPage.ledgerId || 'mw1:Q2hlY2tpbmdUaGVFeGFtcGxlU2l0ZQ', label: S.createPage.label, url: S.createPage.origin + '/#' + encodeURIComponent(pointer) + '#mwgen=e30', pointer };
    };
  }
  if (S.withdrawPage) mw.hub.withdrawPage = async () => { calls.push(['hub.withdrawPage']); return { withdrawn: true }; };
  mw.mod.unban = async (pub) => { calls.push(['mod.unban', pub]); state.policy.banned = state.policy.banned.filter((p) => p !== pub); push(); return { h: newHash() }; };
  mw.mod.queue = async () => clone(S.modQueue || []);
  mw.mod.decide = async (id, decision) => { calls.push(['mod.decide', id, decision]); S.modQueue = (S.modQueue || []).filter((q) => q.id !== id); return { ok: true }; };
  if (S.requestJoin) mw.mod.requestJoin = async (g) => { calls.push(['mod.requestJoin', g]); return { sent: true }; };
  // { sent } is the number of moderators the report went to (src/loader/mod.js): the reporter is skipped, so 0 when nobody else moderates.
  mw.report = { async send(r) { calls.push(['report.send', r]); return { sent: typeof S.reportSent === 'number' ? S.reportSent : 1 }; } };

  // ---- chat (R 2.7). The shapes follow the landed service (src/chat/service.js): state() is an object, a room or direct message names its
  // sender by public key (a string), room.send gives no echo to its sender, contacts carry { pub, nick, blocked, verified, hasChatKey } and
  // verify() gives eight digits. scenario chat: { enabled, contacts: [{ pub, nick }], presence: [{ pub, status, since }], enableError, anyone }
  const ROOMS_TEXT = 'Public and signed. Anyone connected can read this, and a recording proves what you wrote.';
  const contactOf = (c) => ({ pub: c.pub, nick: c.nick || '', blocked: !!c.blocked, verified: !!c.verified, hasChatKey: c.hasChatKey !== false });
  const chatState = { enabled: !!(S.chat && S.chat.enabled), contacts: ((S.chat && S.chat.contacts) || []).map(contactOf), history: {}, sent: [], rooms: new Set(), requestsOpen: false, presence: clone((S.chat && S.chat.presence) || []) };
  const known = (pub) => chatState.contacts.find((c) => c.pub === pub);
  const needChat = () => { if (!chatState.enabled) throw err('E_POLICY', 'messages are off'); };
  mw.chat = {
    async enable() { calls.push(['chat.enable']); needSwitch('chat'); if (S.chat && S.chat.enableError) throw err(S.chat.enableError); chatState.enabled = true; emitChat('state', { state: 'on' }); return { state: 'on' }; },
    async disable() { chatState.enabled = false; emitChat('state', { state: 'off' }); return { state: 'off' }; },
    async state() {
      return { state: chatState.enabled ? 'on' : 'off', hostOnly: false, peers: 0, lane: false, holder: false, presence: { on: false, public: false }, requestsOpen: chatState.requestsOpen, chatKey: null, label: 'mw-pres-v1' };
    },
    on(event, fn) { if (!chatListeners.has(event)) chatListeners.set(event, new Set()); chatListeners.get(event).add(fn); return () => chatListeners.get(event).delete(fn); },
    presence: { async set(o) { calls.push(['chat.presence.set', o]); }, async list() { return chatState.enabled ? clone(chatState.presence) : []; } },
    contacts: {
      async list() { calls.push(['chat.contacts.list']); return clone(chatState.contacts); },
      async add(pub, o) { calls.push(['chat.contacts.add', pub, o]); needChat(); if (!known(pub)) chatState.contacts.push(contactOf({ pub, nick: o && o.nick })); return { pub, nick: (o && o.nick) || '', hasChatKey: true }; },
      async remove(pub) { chatState.contacts = chatState.contacts.filter((c) => c.pub !== pub); },
      async block(pub) { calls.push(['chat.contacts.block', pub]); },
      async unblock(pub) { calls.push(['chat.contacts.unblock', pub]); },
      async verify(pub) { calls.push(['chat.contacts.verify', pub]); return { code: '48291305' }; },
    },
    requests: { async list() { return chatState.enabled ? clone(S.requests || []) : []; }, async accept() {}, async decline() {}, async setOpen(on) { calls.push(['chat.requests.setOpen', on]); chatState.requestsOpen = on; } },
    dm: {
      async send(pub, body) {
        calls.push(['chat.dm.send', pub, body]);
        needChat();
        if (!known(pub) && !(S.chat && S.chat.anyone)) throw err('E_NO_CHAT_KEY');
        const id = chatId();
        chatState.sent.push({ pub, body });
        (chatState.history[pub] = chatState.history[pub] || []).push({ id, from: ME, dir: 'out', t: Date.now(), n: 0, text: body.text == null ? null : body.text, grant: body.grant || null, gap: false });
        return { id, state: 'outbox' };
      },
      async history(pub) { calls.push(['chat.dm.history', pub]); return clone(chatState.history[pub] || []); },
      async keepHistory() {},
    },
    room: {
      async join(name) { calls.push(['chat.room.join', name]); needChat(); chatState.rooms.add(name); return { name, joined: true, label: ROOMS_TEXT }; },
      async leave(name) { chatState.rooms.delete(name); },
      async send(name, body) {
        calls.push(['chat.room.send', name, body]);
        needChat();
        if (!chatState.rooms.has(name)) throw err('E_POLICY', 'join the room first');
        return { id: chatId(), reached: 0 }; // the sender hears no echo, as in the service
      },
    },
    group: { async create() { return { id: 'g1' }; }, async send() {} },
    holder: { async set(on) { calls.push(['chat.holder.set', on]); } },
  };
  if (!S.chat) delete mw.chat;

  // ---- files and media
  const PIXEL = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
  // public files (R 2.8): list() gives the listings of the page's own ledger; fetch() must come before preview() or save(), as in the lane
  const files = new Map();
  const fileListeners = new Map();
  const emitFiles = (event, data) => { for (const fn of fileListeners.get(event) || []) fn(data); };
  for (const f of S.fileList || []) files.set(f.ref, Object.assign({ name: 'photo-7f3k.jpg', ext: 'jpg', len: 2048, mime: 'image/jpeg', author: fakePub(7), t: Date.now(), mine: false, fetched: false }, f));
  const listing = (ref) => {
    const f = files.get(ref);
    if (f) return f;
    if (S.anyRef === false) throw err('E_FILE_UNAVAILABLE');
    const made = { ref, name: 'photo-' + String(ref).slice(0, 4) + '.jpg', ext: 'jpg', len: 2048, mime: 'image/jpeg', author: fakePub(7), t: Date.now(), mine: false, fetched: false };
    files.set(ref, made);
    return made;
  };
  const needFetched = (ref) => { const f = files.get(ref); if (!f || !f.fetched) throw err('E_FILE_UNAVAILABLE', 'fetch the file first'); return f; };
  mw.files = {
    async enable() { calls.push(['files.enable']); return { enabled: true }; },
    async list() { calls.push(['files.list']); return clone(Array.from(files.values())); },
    async received() { return []; },
    async share(file, opts) {
      calls.push(['files.share', file && file.name, opts]);
      needSwitch(opts && opts.public === false ? 'media' : 'files');
      if (S.shareError) throw err(S.shareError);
      const ref = 'ref' + (files.size + 1) + '-' + (file && file.name ? file.name : 'file');
      files.set(ref, { ref, name: (file && file.name) || 'file', ext: '', len: (file && file.size) || 0, mime: (file && file.type) || '', author: ME, t: Date.now(), mine: true, fetched: true });
      emitFiles('shared', { ref, listed: true });
      return { ref, ih: '0'.repeat(40), listed: true };
    },
    async fetch(ref, opts) {
      calls.push(['files.fetch', ref, opts && opts.ledger]);
      if (S.fetchError) throw err(S.fetchError);
      const f = listing(ref);
      f.fetched = true;
      return { handle: {}, name: f.name, size: f.len, mime: f.mime };
    },
    async preview(ref) { calls.push(['files.preview', ref]); const f = needFetched(ref); return /^image\//.test(f.mime) ? { kind: 'image', url: PIXEL } : /^text\//.test(f.mime) ? { kind: 'text', text: 'Plain text from a member' } : { kind: 'none' }; },
    async save(ref) { calls.push(['files.save', ref]); needFetched(ref); return { saved: true, mode: 'attachment' }; },
    async remove(ref) { calls.push(['files.remove', ref]); files.delete(ref); emitFiles('removed', { ref }); },
    on(event, fn) { if (!fileListeners.has(event)) fileListeners.set(event, new Set()); fileListeners.get(event).add(fn); return () => fileListeners.get(event).delete(fn); },
  };
  const items = clone(S.media || []);
  mw.media = {
    async upload(file, o) {
      calls.push(['media.upload', file && file.name]);
      needSwitch('media');
      if (S.uploadError) throw err(S.uploadError);
      for (const phase of ['strip', 'poster', 'encrypt', 'seed']) { if (o && o.onProgress) o.onProgress({ phase, done: 1, total: 4 }); await later(null, 8); }
      const video = file && /^video\//.test(file.type);
      const item = { id: 'm' + (items.length + 1), kind: video ? 'video' : 'image', mime: file.type || 'image/png', len: file.size || 1000, w: 320, h: 180, from: 'me', t: Date.now(), available: 'online' };
      items.push(item);
      return clone(item);
    },
    async list(o) { calls.push(['media.list', o]); const from = (o && o.from) || 'all'; return clone(items.filter((i) => from === 'all' || (from === 'mine' ? i.from === 'me' : i.from !== 'me'))); },
    async open(id, o) {
      calls.push(['media.open', id, o && o.part]);
      const it = items.find((x) => x.id === id);
      if (!it) throw err('E_FILE_UNAVAILABLE');
      if (S.revoked && S.revoked.indexOf(id) !== -1) throw err('E_REVOKED');
      return { url: '/_mw/media/' + (it.kind === 'video' ? 'v-' : 'i-') + id + (o && o.part === 'poster' ? '?part=poster' : ''), mime: it.mime, duration: it.kind === 'video' ? 4 : undefined, w: it.w, h: it.h };
    },
    close(id) { calls.push(['media.close', id]); },
    async share(id, o) { calls.push(['media.share', id, o]); return { granted: (o.to || []).slice(), held: [] }; },
    async revoke(id, o) { calls.push(['media.revoke', id, o]); return { revoked: (o && o.from) || [], reencrypted: !!(o && o.reencrypt) }; },
    async delete(id) { calls.push(['media.delete', id]); const at = items.findIndex((x) => x.id === id); if (at !== -1) items.splice(at, 1); return { deleted: true }; },
    async keepAvailable(id, on) { calls.push(['media.keepAvailable', id, on]); return { on }; },
    async pinRequest(id) { calls.push(['media.pinRequest', id]); return { requested: true }; },
    on(event, fn) { if (!mediaListeners.has(event)) mediaListeners.set(event, new Set()); mediaListeners.get(event).add(fn); return () => mediaListeners.get(event).delete(fn); },
  };
} else {
  mw.identity.export = () => fail('E_IDENTITY');
}

// legacy: the v0.1 SDK surface (no role in ready(), no consent, no mod, no 'sync' event).
if (S.legacy) { delete mw.consent; delete mw.mod; delete listeners.sync; }

globalThis.mw = mw;
globalThis.__mwMock = {
  me: ME, calls, fakePub, snapshot,
  injectRaw(item) { state.lists.guestbook.push(item); push(); }, // a malformed item, as a buggy peer might produce
  remoteAppend(author, msg, name) {
    state.lists.guestbook.push({ h: newHash(), author, ts: minute(Date.now()), v: { msg } });
    if (name) state.profiles[author] = name;
    state.height += 1;
    push();
  },
  setPeers(peers, inSync) { state.peers = peers; state.inSync = inSync; emit('peers', { count: peers }); push(); },
  setPolicy(patch) { Object.assign(state.policy, patch); state.height += 1; push(); },
  setConsent(value) { S.consent = value; emit('status', { consent: value }); },
  emit,
  // ---- v0.3 helpers for the social tests
  newHash,
  followed: () => Array.from(followed),
  ledger(id) { return id === HOME ? state : others.get(id) || null; },
  addLedger(l) { others.set(l.id, { id: l.id, owner: l.owner, policy: clone(l.policy || { writers: 'owner', bits: 16, maxValueBytes: 2048, moderators: [], banned: [] }), lists: clone(l.lists || {}), kv: clone(l.kv || {}), profiles: clone(l.profiles || {}), bytes: l.bytes || 20480 }); pushLedger(l.id); },
  /** remoteList(ledgerId, name, item): another person's ledger gains an item (or, for the home ledger, the home ledger does). */
  remoteList(id, name, item) {
    const l = id === HOME ? state : others.get(id);
    (l.lists[name] = l.lists[name] || []).push(Object.assign({ h: newHash(), ts: minute(Date.now()) }, item));
    if (id === HOME) push(); else pushLedger(id);
    return l.lists[name][l.lists[name].length - 1].h;
  },
  remoteKv(id, key, value) { const l = id === HOME ? state : others.get(id); l.kv[key] = value; if (id === HOME) push(); else pushLedger(id); },
  setAuth(next) { auth = next; for (const fn of authListeners) fn({ state: auth, identity: identity(), role: currentRole() }); },
  setRole(role) { S.role = role; push(); },
  /** chatReceive({ from: <pub> | { pub }, text, id?, t? }): a direct message arrives (the landed event shape: from is a public key string). */
  chatReceive(msg) {
    const pub = typeof msg.from === 'string' ? msg.from : msg.from && msg.from.pub;
    emitChat('message', { id: msg.id || chatId(), from: pub, dir: 'in', t: msg.t || Date.now(), n: 0, text: msg.text == null ? null : msg.text, grant: msg.grant || null, gap: false });
  },
  /** roomReceive({ room?, from, text }): a room message from somebody else. */
  roomReceive(msg) {
    const pub = typeof msg.from === 'string' ? msg.from : msg.from && msg.from.pub;
    emitChat('room', { room: msg.room || 'Lobby', id: msg.id || chatId(), from: pub, t: msg.t || Date.now(), text: msg.text, arrived: Date.now() });
  },
  addFile(f) { files.set(f.ref, Object.assign({ name: 'photo-7f3k.jpg', ext: 'jpg', len: 2048, mime: 'image/jpeg', author: fakePub(7), t: Date.now(), mine: false, fetched: false }, f)); emitFiles('shared', { ref: f.ref }); },
  mediaEvent(event, data) { for (const fn of mediaListeners.get(event) || []) fn(data); },
  scenario: S,
};

export default mw;
