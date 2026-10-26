// Peer Guestbook: page logic for the felinar example (ARCHITECTURE sections 9 and 11).
// The HTML works on its own; the SDK at /_mw/sdk.js switches the live parts on. URLs are
// root-relative because the loader serves the site at its own origin, in a same-URL frame.
// Text from other visitors is only ever set as text (textContent or Text nodes), never as HTML.

const $ = (sel) => document.querySelector(sel);
const setText = (sel, text) => { const n = $(sel); if (n) n.textContent = text; };
const show = (sel, on) => { const n = $(sel); if (n) n.hidden = !on; };
const has = Object.prototype.hasOwnProperty;
const lookup = (table, key, fallback) => (typeof key === 'string' && has.call(table, key) ? table[key] : fallback);
const listOf = (x) => (Array.isArray(x) ? x : []);
const postsOf = (x) => listOf(x).filter((it) => it && typeof it === 'object'); // a malformed item must not break the list
const MAX_MSG = 280, MAX_SHOWN = 200;
const NOTICE_KEY = '_notice'; // keys starting with "_" are writable by the owner and moderators only
const MAX_NOTICE_BYTES = 2000; // the ledger policy allows 2048 bytes per value
const POST_NOTE = 'Each post is signed in your browser and carries a small proof-of-work fee, so posting takes a moment.';
const GUEST_NOTE = 'You are browsing as a guest. Posting asks you to sign in first.'; // loaders with sign in (v0.3) start every visitor as a guest
const ME_COPY = { guest: 'You have no key on this site yet. Signing in gives this site a key that works only here.',
  'signed-in': 'It comes from a key that works only on this site. Your recovery kit and devices are on your profile page.' };
const ERRORS = {
  E_RATE: 'You are posting too fast. Wait a moment and try again.', E_POLICY: 'The site owner does not allow that on this site.',
  E_LIMIT: 'That is empty or too long for this site.', E_NOT_MODERATOR: 'Only moderators can do that.',
  E_NOT_OWNER: 'Only the site owner can do that, and the owner key never enters a browser.',
  E_POW_ABORTED: 'Signing was cancelled before it finished.', E_IDENTITY: 'Your signing key is not available in this browser.',
  E_NO_HOST: 'This page is not running inside the felinar loader.', E_BANNED: 'A moderator has banned this identity on this site.',
  E_CAP: 'The site ledger is full. Only the owner and moderators can add entries now.',
  // v0.3 sign in (src/loader/strings.js ERROR_TEXT)
  E_NOT_SIGNED_IN: 'Sign in to do this.', E_USER_CANCELLED: 'You cancelled.', E_POPUP_BLOCKED: 'Your browser blocked the sign-in window. Tap Sign in again.',
  E_IDP_UNREACHABLE: 'The identity page could not be reached. Check your connection and try again.',
  E_UNSUPPORTED: 'This browser cannot do this. Use a current version of Chrome, Edge, Firefox or Safari.',
  E_HOST_ONLY_IDENTITY: 'This address shares one origin with other sites, so your identity applies to this visit only.',
  // the rest of the SDK's codes (src/loader/api.js ERROR_CODES) in the SDK's words (test/example/site.test.mjs checks each one)
  E_BAD_REQUEST: 'That request was not valid.', E_INTERNAL: 'Something went wrong on this page. Reload it and try again.', E_TIMEOUT: 'This took too long. Check your connection and try again.',
  E_FIELD: 'That field name is reserved. Choose another.', E_DECRYPT: 'This could not be opened with your keys.',
  E_NEEDS_GESTURE: 'Tap the button on the page to continue.', E_NONCE_REQUIRED: 'This site did not send a sign-in code. Reload the page and try again.',
  E_LEDGER_FULL: 'This site cannot take more entries right now.', E_SYNCING: 'Still catching up with the site. Try again in a moment.',
  E_HOST_ONLY: 'This feature needs peer connections, and you chose host only.',
  E_NO_OWN_TRACKER: 'This site has not set up its own connection server, so chat is off here.', E_NO_CHAT_KEY: '{name} has not turned on messages on this site.',
  E_BLOCKED: 'You cannot send to {name}.', E_STAMP: 'Working out the spam fee did not finish. Try again.', E_NOT_MEMBER: 'You are not a member of this group.',
  E_NOT_ADMIN: 'Only an admin of this group can do this.', E_NOT_CONTACT: 'Direct connections are only for your contacts.',
  E_PEER_UNREACHABLE: '{name} could not be reached directly.', E_FILE_UNAVAILABLE: 'Nobody who has this file is online right now.',
  E_FILE_TOMBSTONED: 'This file was removed.', E_FILE_HASH: 'This file did not match its checksum and was dropped.', E_DENIED: 'You do not have access to this.',
  E_MEDIA_TYPE: 'This kind of file is not accepted here.', E_MEDIA_STRIP: 'Location and camera details could not be removed, so the file was not sent.',
  E_MEDIA_UNPLAYABLE: 'This browser cannot play this file.', E_REVOKED: 'Access to this was taken back.', E_BUSY: 'The other person is in another call.',
  E_DECLINED: 'The call was declined.', E_NO_ANSWER: 'Nobody answered the call.',
  E_MEDIA_DENIED: 'The browser did not allow the microphone or camera. Allow it in the site settings of your browser and try again.',
  E_NO_DEVICE: 'No microphone or camera was found on this device.', E_CALL_FAILED: 'The call could not be connected, or its connection could not be checked.',
};
const HOW = { peers: 'from other visitors, peer-to-peer over WebRTC', webseed: 'from the web seed on the static host',
  cache: 'from the copy saved in this browser', mixed: 'partly from other visitors and partly from the web seed' };
const MODES = { shell: 'shell mode', domain: 'shell mode', dropin: 'drop-in mode', hub: 'hub mode', 'hub-shared': 'shared hub, demo only' };
const WRITERS = { open: 'Anyone', allow: 'People on the allow list', owner: 'Owner and moderators' };
const ROLE_HELP = { // the moderation card explains how moderators are named
  guest: 'You can read this guestbook. Posting asks you to sign in first.',
  owner: 'You hold the owner key: every post shows Remove post and Ban author, and you can edit the notice.',
  moderator: 'You are a moderator: every post shows Remove post and Ban author, and you can edit the notice.',
  writer: 'You can post and delete your own posts.',
  unmoderated: 'You can post and delete your own posts. This copy has no owner key, so it has no moderators.',
  reader: 'You can read this guestbook, but the owner only lets selected people post here.',
};
const SHARING = {
  pending: 'Peer connections start after you accept the loader\'s notice. Until then nothing connects to other visitors.',
  'host-only': 'Host only: no peer connections. Slower, and shared data won\'t sync.',
  mobile: 'Sharing only while this page is open and on screen.',
  desktop: 'While this tab is open your browser connects to other visitors and, unless sharing is off, passes on files and posts.',
};
const explain = (err) => { // a code without a sentence gets a generic line naming it (the SDK's errorText rule); internal messages never show
  const code = err && typeof err.code === 'string' ? err.code : '', text = lookup(ERRORS, code, null);
  return text ? text.replace(/^\{name\}/, 'This person').replace(/\{name\}/g, 'this person') : code ? 'Something went wrong (' + code + ').' : 'Something went wrong.';
};
// A guest signs in inside the click that asked to write: the sign-in window needs the person's own tap.
async function signedIn(ctx) { if (ctx.info.auth === 'guest') ctx.onAuth(await ctx.mw.auth.signIn()); }

// Tiny element builder. Children are appended as nodes or as text, never parsed as HTML.
function h(tag, attrs, ...children) {
  const node = document.createElement(tag);
  for (const key of Object.keys(attrs || {})) {
    if (key === 'class') node.className = attrs[key];
    else if (attrs[key] != null) node.setAttribute(key, attrs[key]);
  }
  for (const child of children) if (child != null && child !== '') node.append(child);
  return node;
}
function toast(text, kind) {
  const box = $('#toasts'), node = h('div', { class: 'toast ' + (kind || 'info') }, text);
  if (box) { box.append(node); setTimeout(() => node.remove(), 5000); }
}
const fmtCount = (n) => (Number(n) || 0).toLocaleString('en-US');
const plural = (n, one, many) => fmtCount(n) + ' ' + (Number(n) === 1 ? one : (many || one + 's'));
function fmtBytes(n) {
  let i = 0;
  for (n = Number(n) || 0; n >= 1024 && i < 3; i += 1) n /= 1024;
  return (i ? n.toFixed(1) : String(n)) + ' ' + ['B', 'KB', 'MB', 'GB'][i];
}
function timeAgo(ts) {
  const min = Math.round(Math.max(0, Date.now() - ts) / 60000);
  if (min < 60) return min < 1 ? 'just now' : min + ' min ago';
  if (min < 1440) return Math.round(min / 60) + ' h ago';
  return min < 20160 ? Math.round(min / 1440) + ' d ago' : new Date(ts).toLocaleDateString();
}
// Snapshot fields are plain objects; a Map is accepted too.
const pick = (obj, key) => (obj instanceof Map ? obj.get(key) : (obj && has.call(obj, key) ? obj[key] : undefined));
// A key's entry is either the value itself or a record { v, author, h, ts }.
const kvValue = (e) => (e && typeof e === 'object' && has.call(e, 'v') && has.call(e, 'h') ? e.v : e);
const isMobile = () => { try { if (window.matchMedia('(pointer: coarse)').matches) return true; } catch (err) { /* no matchMedia */ }
  return /Mobi|Android|iPhone|iPad|iPod/i.test(navigator.userAgent || ''); };

// Short id = first 8 hex of sha256(raw public key, without the 'p256:' tag), the loader's rule.
const shortIds = new Map();
function shortId(pub) {
  if (!shortIds.has(pub)) shortIds.set(pub, (async () => {
    try {
      const b64 = pub.slice(pub.indexOf(':') + 1).replace(/-/g, '+').replace(/_/g, '/');
      const raw = Uint8Array.from(atob(b64 + '='.repeat((4 - (b64.length % 4)) % 4)), (c) => c.charCodeAt(0));
      const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', raw));
      return Array.from(digest.subarray(0, 4), (b) => b.toString(16).padStart(2, '0')).join('');
    } catch (err) { return pub.slice(0, 8); } // no WebCrypto, or not base64url
  })());
  return shortIds.get(pub);
}

// Dynamic import: on a plain static host (no /_mw/sdk.js) the page shows a notice instead of failing.
async function loadSdk() {
  try { const mod = await import('/_mw/sdk.js'); return mod.default || globalThis.mw || null; } catch (err) { return null; }
}
function standalone(reason) {
  show('#standalone', true); setText('#standalone-why', reason);
  setText('#source', 'Served as plain static files, without the loader.'); setText('#ledger', 'Ledger: not available without the loader.');
  setText('#role-line', 'Your role on this site: none, because the loader is not running.');
  setText('#entries-empty', 'Open this site through the felinar loader to read and sign the guestbook.');
}

// /data/about.json is fetched at runtime to show that fetch() works through the loader.
async function loadAbout() {
  const slots = document.querySelectorAll('[data-about]');
  try {
    const res = await fetch('/data/about.json');
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const about = await res.json();
    for (const slot of slots) {
      const val = lookup(about, slot.dataset.about, null);
      if (Array.isArray(val)) slot.replaceChildren(...val.map((item) => h('li', null, String(item))));
      else if (val != null) slot.textContent = String(val);
    }
  } catch (err) { for (const slot of slots) slot.textContent = 'about.json could not be loaded (' + err.message + ')'; }
}

// "Ledger: 1,204 entries, in sync with 3 peers". inSync counts peers holding the same entries.
function ledgerLine(s) {
  const peers = Number(s.peers) || 0;
  const inSync = typeof s.inSync === 'number' ? s.inSync : typeof s.inSync === 'boolean' ? (s.inSync ? peers : 0) : null;
  const line = 'Ledger: ' + plural(s.height, 'entry', 'entries');
  return inSync == null ? line : line + ', in sync with ' + plural(inSync, 'peer');
}
function updateLedger(ctx, d) {
  for (const k of ['height', 'peers', 'inSync']) if (has.call(d, k)) ctx.ledger[k] = d[k];
  setText('#ledger', ledgerLine(ctx.ledger));
}

// The role comes from ready(); a later policy can name this identity a moderator or ban it.
function roleOf(ctx, snap) {
  const pol = ctx.policy, me = ctx.me.pub;
  if (ctx.info.auth === 'guest') return pol.writers === 'owner' ? 'reader' : 'guest'; // a guest signs in when posting
  let role = snap.role || ctx.info.role || 'writer';
  if (role !== 'owner' && me && listOf(pol.moderators).indexOf(me) !== -1) role = 'moderator';
  if (role === 'writer' && pol.writers === 'owner') role = 'reader';
  if (role === 'reader' && pol.writers === 'open') role = 'writer';
  return role !== 'owner' && ctx.banned ? 'reader' : role;
}
// Consent-aware copy. At most one consent.state() call per 500 ms, always after the latest event.
function refreshSharing(ctx) {
  const c = ctx.mw.consent;
  if (!c || typeof c.state !== 'function' || ctx.sharingQueued) return;
  ctx.sharingQueued = true;
  setTimeout(() => {
    ctx.sharingQueued = false;
    Promise.resolve().then(() => c.state()).catch(() => '').then((state) => {
      const text = state === 'accepted' ? SHARING[isMobile() ? 'mobile' : 'desktop'] : state === 'pending' || state === 'host-only' ? SHARING[state] : '';
      setText('#sharing', text);
      show('#sharing', !!text);
    });
  }, ctx.sharingSeen ? 500 : 0);
  ctx.sharingSeen = true;
}
// mw.net.on throws for events an older SDK does not know; those are skipped.
function listen(mw, event, fn) { try { mw.net.on(event, fn); } catch (err) { /* unsupported event */ } }

function setupLive(ctx) {
  const { mw, info } = ctx;
  ctx.setPeers = (n) => { if (Number(n) >= 0) setText('#peers', fmtCount(n)); };
  ctx.setPeers(info.peers);
  updateLedger(ctx, {});
  listen(mw, 'peers', (d) => { ctx.peerEvents = true; ctx.setPeers(typeof d === 'number' ? d : d && d.count); });
  listen(mw, 'sync', (d) => { if (d && typeof d === 'object') updateLedger(ctx, d); });
  listen(mw, 'status', () => refreshSharing(ctx));
  listen(mw, 'progress', (p) => {
    if (!p || typeof p !== 'object') return;
    const seed = Number(p.webseedBytes) || 0;
    const peers = p.peerBytes != null ? Number(p.peerBytes) || 0 : Math.max(0, (Number(p.downloaded) || 0) - seed);
    const sent = Number(p.uploaded) > 0 ? ', ' + fmtBytes(p.uploaded) + ' passed on to others' : '';
    setText('#transfer', fmtBytes(peers) + ' from peers, ' + fmtBytes(seed) + ' from the web seed' + sent); show('#transfer', true);
  });
  Promise.resolve().then(() => mw.site.info()).then((site) => {
    site = site || {};
    const files = listOf(site.files), mode = site.mode || info.mode;
    const total = files.reduce((n, f) => n + (Number(f && f.length) || 0), 0);
    setText('#source', 'The files of "' + (site.name || 'this site') + '" arrived ' + lookup(HOW, site.source, 'through the loader') +
      '. Each one is checked against infohash ' + String(site.btih || info.btih || '').slice(0, 12) + '... before it is used.');
    setText('#site-meta', plural(files.length, 'file') + ', ' + fmtBytes(total) + ', ' +
      lookup(MODES, mode, String(mode || 'unknown') + ' mode') + ', ledger ' + info.siteId);
  }).catch((err) => toast(explain(err), 'error'));
  refreshSharing(ctx);
}
function setupName(ctx) {
  const form = $('#name-form'), input = $('#name');
  if (!form) return;
  input.value = ctx.me.name || '';
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const name = input.value.trim();
    if (!name) return toast('Type a name first. Names cannot be empty.', 'info');
    try {
      await signedIn(ctx);
      await ctx.mw.identity.setName(name);
      toast('Saved. Other visitors see you as "' + name + '" once their copies sync.', 'ok');
    } catch (err) { toast(explain(err), err && err.code === 'E_USER_CANCELLED' ? 'info' : 'error'); }
  });
}
// The owner notice lives at key "_notice"; the form shows only for the owner and moderators.
function setupNotice(ctx) {
  const form = $('#notice-form'), area = $('#notice-input');
  if (form) form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const value = area.value.trim();
    if (new TextEncoder().encode(JSON.stringify(value)).length > MAX_NOTICE_BYTES) return toast(ERRORS.E_LIMIT, 'error');
    try {
      if (value) await ctx.mw.db.set(NOTICE_KEY, value); else await ctx.mw.db.del(NOTICE_KEY);
      toast(value ? 'Notice published. Visitors see it as their copies sync.' : 'Notice removed.', 'ok');
    } catch (err) { toast(explain(err), 'error'); }
  });
  return (value) => {
    const text = typeof value === 'string' ? value.trim() : '', p = $('#notice');
    if (p) { p.textContent = text || 'No notice has been posted.'; p.classList.toggle('muted', !text); }
    if (area && document.activeElement !== area) area.value = text;
  };
}
function setupPost(ctx) {
  const form = $('#post-form'), area = $('#msg'), count = $('#count'), btn = $('#post-btn');
  if (!form) return;
  const busy = (on) => { btn.disabled = on; btn.textContent = on ? 'Signing...' : 'Post'; };
  area.addEventListener('input', () => { count.textContent = area.value.length + ' / ' + MAX_MSG; });
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const msg = area.value.trim();
    if (!msg || msg.length > MAX_MSG) return msg ? toast(ERRORS.E_LIMIT, 'error') : undefined;
    busy(true);
    try {
      await signedIn(ctx);
      await ctx.mw.db.append('guestbook', { msg });
      area.value = '';
      count.textContent = '0 / ' + MAX_MSG;
      toast('Posted. Your signed message is on its way to other visitors.', 'ok');
    } catch (err) { toast(explain(err), err && err.code === 'E_USER_CANCELLED' ? 'info' : 'error'); } finally { busy(false); }
  });
}
// Two taps instead of a modal confirm: works without allow-modals and suits phones.
function armed(cls, label, run) {
  const btn = h('button', { class: 'link danger ' + cls, type: 'button' }, label);
  const reset = () => { btn.disabled = false; btn.dataset.armed = ''; btn.textContent = label; };
  btn.addEventListener('click', async () => {
    if (btn.dataset.armed !== '1') {
      btn.dataset.armed = '1';
      btn.textContent = 'Tap again to confirm';
      return setTimeout(() => { if (!btn.disabled) reset(); }, 3000);
    }
    btn.disabled = true;
    try { await run(); } catch (err) { reset(); toast(explain(err), 'error'); }
  });
  return btn;
}
function actionsFor(ctx, it) {
  const { mw } = ctx, out = [];
  const mine = it.author === ctx.me.pub, mod = ctx.role === 'owner' || ctx.role === 'moderator';
  const shielded = it.author === ctx.info.owner || listOf(ctx.policy.moderators).indexOf(it.author) !== -1;
  const ok = (text) => () => toast(text, 'ok');
  if (mine) out.push(armed('act-delete', 'Delete', () => mw.db.tombstone(it.h).then(ok('Deleted. Visitors stop showing it when they receive the deletion.'))));
  else if (mod) out.push(armed('act-remove', 'Remove post', () => mw.db.tombstone(it.h).then(ok('Removed. Visitors stop showing it when they receive the removal.'))));
  if (mod && !mine && !shielded && mw.mod && typeof mw.mod.ban === 'function') {
    out.push(armed('act-ban', 'Ban author', () => mw.mod.ban(it.author).then(ok('Banned. Their posts disappear for visitors who receive the ban.'))));
  }
  return out;
}

// Returns render(items newest first, profiles).
function setupBook(ctx) {
  const list = $('#entries'), empty = $('#entries-empty');
  let seq = 0, lastKey = '';
  return async (items, profiles) => {
    if (!list) return;
    const mine = ++seq, shown = items.slice(0, MAX_SHOWN);
    const names = await Promise.all(shown.map((it) => {
      const name = pick(profiles, it.author);
      // MF-70: a profile name is chosen by its author, so the short id of the key always stands beside it
      return shortId(String(it.author)).then((short) => (typeof name === 'string' && name ? name + ' (' + short + ')' : short));
    }));
    if (mine !== seq) return; // a newer snapshot is already rendering
    const mods = listOf(ctx.policy.moderators);
    const key = ctx.role + (ctx.me.pub || '') + mods.join() + shown.map((it, i) => it.h + names[i]).join();
    if (key === lastKey) return; // nothing visible changed: keep focus and half-confirmed buttons
    lastKey = key;
    list.replaceChildren(...shown.map((it, i) => {
      const isMe = it.author === ctx.me.pub;
      const ts = Math.abs(Number(it.ts)) < 8.64e15 ? Number(it.ts) : NaN; // claimed by the author, informational
      const tag = isMe ? 'you' : it.author === ctx.info.owner ? 'owner' : mods.indexOf(it.author) !== -1 ? 'moderator' : '';
      const when = Number.isFinite(ts) ? h('time', { class: 'when', datetime: new Date(ts).toISOString(), title: 'Time as claimed by the author' }, timeAgo(ts)) : null;
      return h('li', { class: isMe ? 'entry mine' : 'entry', 'data-h': it.h, 'data-author': it.author },
        h('div', { class: 'entry-head' }, h('span', { class: 'who', title: it.author }, names[i], tag ? h('span', { class: 'tag' }, tag) : null), when),
        h('p', { class: 'msg' }, it.v && typeof it.v.msg === 'string' ? it.v.msg : JSON.stringify(it.v)),
        h('div', { class: 'actions' }, ...actionsFor(ctx, it)));
    }));
    if (empty) { empty.textContent = 'No messages yet. Be the first to sign.'; empty.hidden = shown.length > 0; }
  };
}
function applyRole(ctx) {
  const role = ctx.role;
  setText('#role-badge', role); show('#role-badge', true);
  setText('#role-line', 'Your role on this site: ' + role + '.');
  setText('#role-help', lookup(ROLE_HELP, role === 'writer' && ctx.info.unmoderated ? 'unmoderated' : role, ''));
  show('#notice-form', role === 'owner' || role === 'moderator');
  for (const fieldset of document.querySelectorAll('#post-form fieldset, #name-form fieldset')) fieldset.disabled = role === 'reader';
  setText('#post-note', role === 'guest' ? GUEST_NOTE : role !== 'reader' ? POST_NOTE : ctx.banned ? ERRORS.E_BANNED : ROLE_HELP.reader);
}
function renderPolicy(pol) {
  setText('#pol-writers', lookup(WRITERS, pol.writers, pol.writers ? String(pol.writers) : '-'));
  setText('#pol-fee', Number(pol.bits) > 0 ? pol.bits + '-bit proof-of-work per post' : 'None');
  setText('#pol-mods', fmtCount(listOf(pol.moderators).length));
  setText('#pol-banned', fmtCount(listOf(pol.banned).length));
}

async function main() {
  loadAbout();
  const mw = await loadSdk();
  if (!mw) return standalone('The loader SDK at /_mw/sdk.js is not served here.');
  let info;
  try { info = (await mw.ready()) || {}; } catch (err) { return standalone(explain(err)); }
  const ctx = { mw, info, me: info.identity || {}, policy: {}, banned: false, ledger: { height: info.height, peers: info.peers } };
  ctx.role = roleOf(ctx, {});
  for (const sel of ['#unmoderated', '#unmoderated-note']) show(sel, !!info.unmoderated); show('#mod-howto', !info.unmoderated);
  const showMe = () => { // the id line and the name field follow who is signed in
    setText('#me-short', ctx.me.short || '-'); if (info.auth) setText('#me-copy', ME_COPY[info.auth] || '');
    const name = $('#name'); if (name && document.activeElement !== name) name.value = ctx.me.name || '';
  };
  showMe();
  setupLive(ctx); setupName(ctx); setupPost(ctx);
  const renderNotice = setupNotice(ctx), renderBook = setupBook(ctx);
  applyRole(ctx);
  let roleKey = ctx.role + false, gotSnapshot = false, last = null, view = null;
  const refreshRole = () => {
    ctx.banned = !!ctx.me.pub && listOf(ctx.policy.banned).indexOf(ctx.me.pub) !== -1;
    ctx.role = roleOf(ctx, last || {});
    if (ctx.role + ctx.banned !== roleKey) { roleKey = ctx.role + ctx.banned; applyRole(ctx); }
  };
  ctx.onAuth = (a) => { // signed in or out, here or in another window of this page
    if (!a || typeof a !== 'object') return;
    info.auth = a.state; info.identity = a.identity || null; if (a.role) info.role = a.role;
    ctx.me = a.identity || {};
    showMe(); refreshRole();
    if (view) renderBook(view.items, view.profiles);
  };
  if (info.auth && mw.auth && typeof mw.auth.onChange === 'function') mw.auth.onChange(ctx.onAuth);
  const apply = (snap) => {
    if (!snap || typeof snap !== 'object') return;
    gotSnapshot = true; last = snap;
    ctx.policy = snap.policy && typeof snap.policy === 'object' ? snap.policy : {};
    refreshRole();
    const items = postsOf(pick(snap.lists, 'guestbook')).reverse(); // ledger order is oldest first
    if (!ctx.peerEvents) ctx.setPeers(snap.peers);
    updateLedger(ctx, snap);
    setText('#posts', fmtCount(items.length));
    renderPolicy(ctx.policy);
    renderNotice(kvValue(pick(snap.kv, NOTICE_KEY)));
    view = { items, profiles: snap.profiles || {} };
    renderBook(items, view.profiles);
  };
  try { mw.db.subscribe(apply); } catch (err) { toast(explain(err), 'error'); }
  if ($('#entries')) { // first paint from explicit reads, in case the host pushes snapshots only on change
    try {
      const [items, notice] = await Promise.all([mw.db.list('guestbook', { limit: MAX_SHOWN, newestFirst: true }), mw.db.get(NOTICE_KEY)]);
      if (!gotSnapshot) { setText('#posts', fmtCount(postsOf(items).length)); renderNotice(kvValue(notice)); await renderBook(postsOf(items), {}); }
    } catch (err) { toast(explain(err), 'error'); }
  }
  document.addEventListener('visibilitychange', () => { if (!document.hidden) refreshSharing(ctx); });
  setInterval(() => { // keep "x min ago" fresh; datetime is always an ISO string written above
    for (const t of document.querySelectorAll('time.when')) t.textContent = timeAgo(Date.parse(t.getAttribute('datetime')));
  }, 60000);
}

main();
