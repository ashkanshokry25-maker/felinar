// Settings (R 3.7): profile, identity, privacy defaults, what others can see, invite and discovery, notifications, storage, chat,
// pictures and videos, appearance, data export and delete my page. A section is a route (/settings/<section>); /settings lists them.
// Nothing here asks for a recovery phrase or a backup file: those open only on the identity page (E-ID-10).

import { h, setChildren, armedButton, formatBytes } from '../dom.js';
import * as M from '../model.js';
import { SETTINGS_SECTIONS, WALL_MODES, LIMITS, DIRECTORY_LABEL } from '../config.js';
import { hrefFor } from '../router.js';
import { PRIVACY, SIGNED_ENTRIES_NOTE, errorMessage, fieldError } from '../strings.js';
import { KEYS as SK, DEFAULT_PREFS } from '../store.js';
import { shortIdOf } from '../ids.js';
import { link, profileHref, stateCard, clearPictureCache, suggestionLabel } from './common.js';
import { inviteCard } from './invite.js';
import { scaleToAvatar } from '../media-prep.js';
import { lookup, UNVERIFIED_TEXT } from '../directory.js';

const TITLES = {
  profile: ['Profile', 'Your name, bio, links and picture.'], identity: ['Identity and sign-in', 'Your key for this page, recovery and your devices.'],
  privacy: ['Privacy defaults', 'Who may write on your wall, message you, and whether your follows are public.'],
  visibility: ['What others can see', 'What is public, what is not.'], invite: ['Invite and discovery', 'Your link, your QR code, your own domain as a handle.'],
  notifications: ['Notifications', 'What shows in Alerts.'], storage: ['Storage and follows', 'Who you follow and how much this browser keeps.'],
  chat: ['Messages', 'Turn messages on or off, and who may reach you.'], media: ['Pictures and videos', 'Public pictures and your private photos and videos.'],
  appearance: ['Appearance', 'Light, dark or automatic.'], export: ['Export my data', 'Download what this browser holds of yours.'], delete: ['Delete my page', 'Hide what you wrote on your page and remove your private record.'],
};
const WALL_LABEL = {
  everyone: ['Everyone', 'Anyone can write on your wall and comment on your posts.'],
  follow: ['People I follow (default)', 'Posts and comments from people you follow are shown. Others are ignored.'],
  nobody: ['Nobody', 'Nobody else can write on your wall or comment on your posts.'],
  approve: ['I approve each one', 'Each post or comment waits for you in Alerts before it is shown.'],
};

const row = (label, content) => h('div', {}, h('dt', {}, label), h('dd', {}, content));
const saved = (ctx) => ctx.note('Saved.', 'ok');
function checkbox(id, label, checked, onChange, hint) {
  return h('div', { class: 'field' }, h('label', { class: 'check', for: id }, h('input', { type: 'checkbox', id, props: { checked }, on: { change: (e) => onChange(e.target.checked, e.target) } }), label), hint ? h('p', { class: 'hint' }, hint) : null);
}
function radios(name, options, current, onChange) {
  return h('fieldset', {}, h('legend', {}, name.legend), options.map(([value, label, hint]) => h('div', { class: 'field' },
    h('label', { class: 'check', for: name.id + '-' + value }, h('input', { type: 'radio', id: name.id + '-' + value, name: name.id, value, props: { checked: current === value }, on: { change: () => onChange(value) } }), label),
    hint ? h('p', { class: 'hint' }, hint) : null)));
}

function profileSection(ctx) {
  const d = ctx.data, v = d.own(), p = v ? v.profile : { bio: '', links: [], handle: '', avatar: null };
  const name = h('input', { type: 'text', id: 'pf-name', maxlength: LIMITS.nameChars, value: v ? v.name : '' });
  const bio = h('textarea', { id: 'pf-bio', rows: 3, maxlength: LIMITS.bioChars }); bio.value = p.bio || '';
  const links = [0, 1, 2].map((i) => h('input', { type: 'url', id: 'pf-link' + i, value: p.links[i] || '', autocomplete: 'off' }));
  const handle = h('input', { type: 'text', id: 'pf-handle', value: p.handle || '', autocomplete: 'off', placeholder: 'example.org' });
  const alt = h('input', { type: 'text', id: 'pf-avatar-alt', maxlength: LIMITS.altChars, value: (p.avatar && p.avatar.alt) || '' });
  const err = h('p', { class: 'error', role: 'alert' }), info = h('p', { class: 'small', role: 'status' });
  let avatar = p.avatar, scaled = null;
  // Sharing opens a card and the loader accepts it only for a call that comes from a click: choosing scales the picture, "Share this picture" shares it.
  const shareBtn = h('button', { type: 'button', class: 'btn', id: 'pf-avatar-share', hidden: true, on: { click: async () => {
    if (!scaled) return;
    try {
      await ctx.data.ensureFeature('files');
      const out = await ctx.mw.files.share(scaled, { public: true });
      avatar = { ref: out.ref, kind: 'image', alt: alt.value.trim() || 'Profile picture' };
      info.textContent = 'Picture shared (' + formatBytes(scaled.size) + '). Save to use it.';
      scaled = null; shareBtn.hidden = true;
    } catch (e) { if (!e || e.code !== 'E_USER_CANCELLED') ctx.fail(e); }
  } } }, 'Share this picture');
  const file = h('input', { type: 'file', id: 'pf-avatar', accept: 'image/*', 'aria-describedby': 'pf-avatar-hint', on: { change: async (ev) => {
    const f = ev.target.files[0]; if (!f) return;
    info.textContent = 'Scaling the picture to 512 px...'; shareBtn.hidden = true; scaled = null;
    try {
      scaled = await scaleToAvatar(f);
      info.textContent = 'Picture ready (' + formatBytes(scaled.size) + '). Share it, then save.';
      shareBtn.hidden = false;
    } catch (e) { info.textContent = ''; ctx.fail(e); }
  } } });
  return h('form', { class: 'card stack', id: 'profile-form', novalidate: true, on: { submit: async (ev) => {
    ev.preventDefault(); err.textContent = '';
    const draft = { name: name.value, bio: bio.value, links: links.map((l) => l.value), handle: handle.value, avatar: avatar ? { ref: avatar.ref, kind: 'image', alt: alt.value.trim() || 'Profile picture' } : null };
    const check = M.validateProfileDraft(draft);
    if (!check.ok) { err.textContent = fieldError(check.errors[0]) + ' (' + check.errors[0].field + ')'; return; }
    try { await d.saveProfile(draft); saved(ctx); } catch (e) { err.textContent = errorMessage(e); }
  } } },
    h('div', { class: 'field' }, h('label', { for: 'pf-name' }, 'Name', h('span', { class: 'hint' }, ' Up to 48 characters. Your short id is shown next to it.')), name),
    h('div', { class: 'field' }, h('label', { for: 'pf-bio' }, 'Bio', h('span', { class: 'hint' }, ' Up to 280 characters.')), bio),
    h('fieldset', {}, h('legend', {}, 'Links (up to 3, https only)'), links.map((l, i) => h('div', { class: 'field' }, h('label', { for: 'pf-link' + i, class: 'sr-only' }, 'Link ' + (i + 1)), l))),
    h('div', { class: 'field' }, h('label', { for: 'pf-handle' }, 'Your own domain as a handle', h('span', { class: 'hint' }, ' Optional. Shown as claimed until someone opens your page at that address.')), handle),
    h('div', { class: 'field' }, h('label', { for: 'pf-avatar' }, 'Picture'), file, shareBtn, h('p', { id: 'pf-avatar-hint', class: 'hint' }, 'Scaled to 512 px and kept under 256 KiB. It is public. Location and camera details are removed.'),
      h('label', { for: 'pf-avatar-alt' }, 'Describe your picture (required)'), alt, info),
    err, h('div', { class: 'row end' }, h('button', { type: 'submit', class: 'btn primary' }, 'Save profile')));
}

function identitySection(ctx) {
  const d = ctx.data, box = h('div', { class: 'card stack' });
  const status = h('dl', { class: 'facts' });
  const id = d.state.identity || {};
  setChildren(box, [h('p', {}, 'You are signed in as ', h('strong', {}, id.name || 'you'), ' ', h('span', { class: 'short' }, '(' + (id.short || '') + ')'), '. This page holds a key that works only here. ', PRIVACY.scriptsNote),
    status, h('p', {}, PRIVACY.neverWords + ' Recovery, backup and your other devices are on the identity page.'),
    h('div', { class: 'row' }, h('button', { type: 'button', class: 'btn primary', id: 'open-identity', on: { click: async () => { try { await ctx.mw.identity.openIdentity(); } catch (e) { ctx.fail(e); } } } }, 'Open identity page'),
      h('button', { type: 'button', class: 'btn', id: 'sign-out', on: { click: () => ctx.signOut() } }, 'Sign out'))]);
  const yes = (b) => (b ? 'Yes' : 'No');
  Promise.resolve().then(() => ctx.mw.identity.backupStatus()).then((b) => {
    setChildren(status, [row('Recovery kit saved', yes(b && b.kitSaved)), row('Backup file saved', yes(b && b.fileSaved)), row('Passkey', yes(b && b.passkey)), row('Kept by this browser', yes(b && b.persisted))]);
  }).catch(() => setChildren(status, [row('Backup', 'Not reported by this loader')]));
  return box;
}

function privacySection(ctx) {
  const d = ctx.data, o = d.own();
  const prefs = () => Object.assign({}, DEFAULT_PREFS, ctx.store.get(SK.prefs, {}));
  const msg = h('p', { class: 'small', role: 'status' });
  const wall = radios({ legend: 'Who may write on my wall', id: 'wall' }, WALL_MODES.map((m) => [m, WALL_LABEL[m][0], WALL_LABEL[m][1]]), o ? M.wallMode(o) : 'follow', async (value) => {
    try { await d.setWall(value); saved(ctx); } catch (e) { ctx.fail(e); }
  });
  const follows = radios({ legend: 'My follows are', id: 'follows' }, [['public', 'Public', 'People can see who you follow. This is what gives "Followers you can see".'], ['private', 'Private', 'Kept in your private record on this device and synced only if you turn that on.']],
    prefs().followsPublic ? 'public' : 'private', (v) => { ctx.store.set(SK.prefs, Object.assign(prefs(), { followsPublic: v === 'public' })); saved(ctx); });
  const chat = ctx.chat;
  const blockedBox = h('section', { class: 'card stack', id: 'blocked-box' });
  const drawBlocked = () => {
    const blocked = ctx.store.get(SK.blocked, []);
    setChildren(blockedBox, [h('h2', {}, 'Blocked (' + blocked.length + ')'),
      blocked.length ? h('ul', { class: 'stack tight' }, blocked.map((pub) => h('li', { class: 'row between' }, h('span', {}, 'Key ' + shortIdOf(pub)), h('button', { type: 'button', class: 'btn small', on: { click: () => { d.unblock(pub); drawBlocked(); } } }, 'Unblock')))) : h('p', { class: 'muted' }, 'Nobody is blocked.')]);
  };
  drawBlocked();
  return h('div', { class: 'stack' },
    h('section', { class: 'card stack' }, wall), h('section', { class: 'card stack' }, follows),
    chat ? h('section', { class: 'card stack' }, h('h2', {}, 'Messages'),
      checkbox('requests-open', 'Let people I do not know send me a first message', false, async (on, el) => { try { await chat.setRequestsOpen(on); saved(ctx); } catch (e) { el.checked = !on; ctx.fail(e); } }, 'Strangers can send you a first message. You will not see it until you open your requests. Off by default.'),
      checkbox('presence-on', 'Show people connected to me that I am connected', false, async (on, el) => { try { await chat.setPresence(on, false); saved(ctx); } catch (e) { el.checked = !on; ctx.fail(e); } }, PRIVACY.presenceOff)) : null,
    h('section', { class: 'card stack' }, h('h2', {}, 'Private data'), h('p', {}, 'Your private follows and blocks are kept in your private record. Reading it opens a card once per session.'),
      h('button', { type: 'button', class: 'btn', id: 'load-private', on: { click: async () => { try { const r = await d.loadPrivate(); msg.textContent = 'Loaded ' + r.follows + ' private follows and ' + r.blocks + ' blocks.'; drawBlocked(); } catch (e) { ctx.fail(e); } } } }, 'Load my private follows and blocks'), msg),
    blockedBox);
}

function visibilitySection() {
  const t = (a, b, c) => h('tr', {}, h('th', { scope: 'row' }, a), h('td', {}, b), h('td', {}, c));
  return h('section', { class: 'card stack' }, h('p', {}, PRIVACY.whatOthersSee), h('p', {}, PRIVACY.keyMatching),
    h('div', { class: 'table-wrap' }, h('table', { class: 'ceiling' }, h('caption', { class: 'sr-only' }, 'What is public'), h('thead', {}, h('tr', {}, h('th', { scope: 'col' }, 'What'), h('th', { scope: 'col' }, 'Who can see it'), h('th', { scope: 'col' }, 'Notes'))),
      h('tbody', {}, [
        t('Name, bio, links, picture, handle', 'Everyone who opens your page', 'Public and copied to every visitor.'),
        t('Posts, comments, shares', 'Everyone who opens your page', PRIVACY.deleteLimits),
        t('Reactions', 'Everyone who opens your page', 'Each reaction is a key on your ledger. Counts elsewhere are counts of keys.'),
        t('Who you follow', 'Everyone, if your follows are public', 'Private follows stay in your private record.'),
        t('Your IP address', 'People connected to this site', 'Shown next to your key when you post or chat.'),
        t('Messages', 'The people you write to', PRIVACY.conversations),
        t('Private photos and videos', 'You, and people you share them with', 'Encrypted on your device. The site\'s own code on this origin can open them while you are signed in; on a hub, that code is the hub\'s.'),
        t('Your private record', 'You', PRIVACY.recordNote),
      ]))));
}

function inviteSection(ctx) {
  const parts = [h('section', { class: 'card stack' }, h('h2', {}, 'Your link and QR code'), inviteCard(ctx).node),
    h('section', { class: 'card stack' }, h('h2', {}, 'Your own domain as a handle'),
      h('p', {}, 'If you own a domain, you can use it as your handle. Publish a TXT record named _magnet on that domain with your page\'s pointer, then enter the domain in your profile. People then see it as @your-domain. The strong check is opening your page at that domain, which checks the DNS record against your signed pointer.'),
      link(ctx, hrefFor('settings', { section: 'profile' }), 'Open profile settings', 'btn'))];
  if (ctx.flags.directory) parts.push(directoryCard(ctx));
  else parts.push(h('section', { class: 'card stack', id: 'directory-off' }, h('h2', {}, 'Hub directory'), h('p', {}, 'Off. This hub has not turned its directory on (' + DIRECTORY_LABEL + '). Links and QR codes work without it.')));
  return h('div', { class: 'stack' }, parts);
}
function directoryCard(ctx) {
  const input = h('input', { type: 'search', id: 'dir-name', placeholder: 'A name to look up', autocomplete: 'off' });
  const out = h('div', { class: 'stack', id: 'dir-results', 'aria-live': 'polite' });
  async function run(ev) {
    ev.preventDefault();
    const q = input.value.trim(); if (!q) return;
    const res = await lookup(q, undefined, { hubKey: ctx.flags.directoryKey });
    if (!res.ok) { setChildren(out, [h('p', { class: 'error' }, 'The directory is not available on this hub.')]); return; }
    if (!res.entry) { setChildren(out, [h('p', { class: 'muted' }, 'No such name in this directory.')]); return; }
    const e = res.entry;
    // An entry that does not verify (js/directory.js: the person's signature, the hub's countersignature, the page's own pointer) is
    // shown for what it is and cannot be followed from here: a shard from a CDN or a changed host could name someone else's page.
    if (!e.verified) {
      setChildren(out, [h('p', {}, h('strong', {}, e.name), ' ', h('span', { class: 'badge warn' }, 'Not verified')),
        h('p', { class: 'small', id: 'dir-unverified' }, (UNVERIFIED_TEXT[e.reason] || UNVERIFIED_TEXT.shape) + ' It cannot be followed from the directory. Ask the person for their link instead.')]);
      return;
    }
    const follow = h('button', { type: 'button', class: 'btn small', id: 'dir-follow', on: { click: async () => {
      try {
        await ctx.data.follow(e.pointer || e.ledgerId);
        ctx.store.set(SK.dirPins, Object.assign({}, ctx.store.get(SK.dirPins, {}), { [e.ledgerId]: e.name }));
        ctx.note('Following ' + e.name + '. Your follow stays with this page even if the name later moves.', 'ok');
      } catch (err) { ctx.fail(err); }
    } } }, 'Follow');
    setChildren(out, [h('p', {}, h('strong', {}, e.name), ' ', h('span', { class: 'badge' }, 'Signed by the person and the hub'), ' ', h('span', { class: 'short' }, 'page ' + e.ledgerId.slice(0, 12) + '...')), follow]);
  }
  return h('section', { class: 'card stack', id: 'directory-on' }, h('h2', {}, 'Hub directory'),
    h('p', { class: 'small' }, 'Names here are first come, first served, and one per person. A name that later points to a different page shows a warning on pages you followed by name. This directory is ' + DIRECTORY_LABEL + '.'),
    h('form', { on: { submit: run } }, h('div', { class: 'field' }, h('label', { for: 'dir-name' }, 'Look up a name'), input), h('div', { class: 'row end' }, h('button', { type: 'submit', class: 'btn' }, 'Look up'))), out);
}

function notificationsSection(ctx) {
  const prefs = () => Object.assign({}, DEFAULT_PREFS, ctx.store.get(SK.prefs, {}));
  const set = (k) => (on) => { ctx.store.set(SK.prefs, Object.assign(prefs(), { [k]: on })); saved(ctx); };
  return h('section', { class: 'card stack' }, h('p', {}, 'Alerts show replies, mentions, follows and shares. They arrive while this page is open. There are no push notifications when the page is closed; that would need a push relay (see About).'),
    checkbox('n-replies', 'Replies to my posts', prefs().notifyReplies, set('notifyReplies')), checkbox('n-mentions', 'Mentions', prefs().notifyMentions, set('notifyMentions')),
    checkbox('n-follows', 'New followers', prefs().notifyFollows, set('notifyFollows')), checkbox('n-shares', 'Shares of my posts', prefs().notifyShares, set('notifyShares')));
}

function storageSection(ctx) {
  const d = ctx.data, box = h('div', { class: 'stack' });
  function draw() {
    const cap = d.followCap(), ids = Array.from(d.followedIds());
    let total = 0;
    const rows = ids.map((id) => { const v = d.viewOf(id); const b = v ? v.bytes : 0; total += b; return h('li', { class: 'row between' }, h('span', {}, link(ctx, profileHref(ctx, id), d.nameOf(id)), ' ', h('span', { class: 'short' }, formatBytes(b))),
      armedButton('Unfollow', async () => { await d.unfollow(id); draw(); }, { cls: 'btn small danger' })); });
    setChildren(box, [h('section', { class: 'card stack' }, h('p', { id: 'cap-text' }, cap.text), h('p', { class: 'small muted' }, 'The limit is chosen for this kind of device and real-device tests confirm or lower it. This browser keeps about ' + formatBytes(total) + ' of the pages you follow.'),
      ids.length ? h('ul', { class: 'stack tight' }, rows) : h('p', { class: 'muted' }, 'You do not follow anyone yet.')),
    suggestionsCard(ctx),
    h('section', { class: 'card stack' }, h('h2', {}, 'Clear the cache'), h('p', {}, 'Removes drafts, hidden items, alerts and loaded pictures from this device. Your pages and posts are not touched.'),
      armedButton('Clear cache', async () => { for (const k of [SK.drafts, SK.notices, SK.hidden, SK.okQueue, SK.wallQueue]) ctx.store.remove(k); clearPictureCache(); ctx.note('Cache cleared on this device.', 'ok'); }, { cls: 'btn danger' }))]);
  }
  draw();
  let t = 0;
  ctx.onData('change', () => { if (!t) t = setTimeout(() => { t = 0; if (box.isConnected && !box.contains(document.activeElement)) draw(); }, 300); });
  return box;
}

function suggestionsCard(ctx) {
  const d = ctx.data;
  const sugg = M.suggestions(Array.from(d.views.values()), d.followedIds(), d.state.siteId, 8);
  return h('section', { class: 'card stack', id: 'suggestions' }, h('h2', {}, 'People you may know'),
    h('p', { class: 'small muted' }, 'Followed by people you follow, from the public follow lists this browser holds. Nothing else decides this list.'),
    sugg.length ? h('ul', { class: 'stack tight' }, sugg.map((s) => h('li', { class: 'row between' }, h('span', {}, link(ctx, profileHref(ctx, s.l), suggestionLabel(ctx, s).name), ' ', h('span', { class: 'short' }, suggestionLabel(ctx, s).via)),
      h('button', { type: 'button', class: 'btn small', on: { click: async (ev) => { ev.currentTarget.disabled = true; try { await d.follow(s.ptr || s.l); ctx.rerender(); } catch (e) { ctx.fail(e); ev.currentTarget.disabled = false; } } } }, 'Follow')))) : h('p', { class: 'muted' }, 'Nobody to suggest yet.'));
}

function chatSection(ctx) {
  const chat = ctx.chat, box = h('section', { class: 'card stack' });
  if (!chat) return setChildren(box, [h('p', {}, errorMessage({ code: 'NOT_AVAILABLE' }))]);
  const state = h('p', { id: 'chat-state', role: 'status' }, 'Checking...');
  const toggle = h('button', { type: 'button', class: 'btn primary', id: 'chat-toggle' }, '...');
  const holder = checkbox('holder', 'Hold encrypted messages for others while I am here', false, async (on, el) => { try { await chat.setHolder(on); saved(ctx); } catch (e) { el.checked = !on; ctx.fail(e); } },
    'While this page is open, and for up to 7 days, you will keep encrypted messages from other people that you cannot read. Nothing is written to disk. Not available on phones.');
  let on = false;
  const paint = () => { state.textContent = on ? 'Messages are on.' : 'Messages are off.'; toggle.textContent = on ? 'Turn messages off' : 'Turn messages on'; };
  toggle.addEventListener('click', async () => { try { if (on) await chat.disable(); else { await ctx.data.ensureFeature('chat'); await chat.enable(); } on = await chat.state() === 'on'; paint(); } catch (e) { ctx.fail(e); } });
  chat.state().then((s) => { on = s === 'on'; paint(); });
  setChildren(box, [h('p', {}, PRIVACY.messagesArrive + ' ' + PRIVACY.conversations), state, h('div', { class: 'row' }, toggle), ctx.env.deviceClass() === 'desktop' ? holder : null]);
  return box;
}

function mediaSection(ctx) {
  const prefs = () => Object.assign({}, DEFAULT_PREFS, ctx.store.get(SK.prefs, {}));
  return h('section', { class: 'card stack' }, h('h2', {}, 'Public pictures'),
    checkbox('auto-pictures', 'Show pictures from people I follow as soon as they appear', prefs().autoPictures, (on) => { ctx.store.set(SK.prefs, Object.assign(prefs(), { autoPictures: on })); saved(ctx); ctx.rerender(); }, PRIVACY.fetchPublic + ' Off by default: a picture loads only when you tap it. Your browser may still ask once for each file.'),
    h('h2', {}, 'Private photos and videos'), h('p', {}, 'Encrypted on your device. Only you, after signing in, and the people you share them with can open them, and the site\'s own code on this origin can open them too while you are signed in. On a hub, that code is the hub\'s. People you share with can keep a copy.'),
    link(ctx, hrefFor('media'), 'Open my photos and videos', 'btn'));
}

function appearanceSection(ctx) {
  const cur = ctx.store.get(SK.theme, 'auto');
  return h('section', { class: 'card stack' }, radios({ legend: 'Colour theme', id: 'theme' }, [['auto', 'Automatic (follows your device)'], ['light', 'Light'], ['dark', 'Dark']], cur, (v) => { ctx.store.set(SK.theme, v); if (v === 'auto') document.documentElement.removeAttribute('data-theme'); else document.documentElement.setAttribute('data-theme', v); document.getElementById('theme-toggle').textContent = 'Theme: ' + v; }),
    h('p', { class: 'small muted' }, 'Movement and animation are reduced automatically when your device asks for less motion.'));
}

function exportSection(ctx) {
  const d = ctx.data, msg = h('p', { class: 'small', role: 'status' });
  const save = (name, obj) => {
    const a = h('a', { href: 'data:application/json;charset=utf-8,' + encodeURIComponent(JSON.stringify(obj, null, 2)), download: name });
    document.body.append(a); a.click(); a.remove();
  };
  // R 3.3: the file holds the decrypted record fields too. Reading the record opens the identity page's card the first time in a session,
  // which is why it happens in this tap; when the person closes the card the file is still made, and it says the record is not in it.
  async function exportAll() {
    let record, recordError = '';
    try { if (!ctx.mw.me || typeof ctx.mw.me.get !== 'function') throw Object.assign(new Error('NOT_AVAILABLE'), { code: 'NOT_AVAILABLE' }); record = await ctx.mw.me.get(); } catch (e) { record = undefined; recordError = errorMessage(e); }
    save('my-page-' + d.state.label.slice(0, 8) + '.json', d.exportData({ record, recordError }));
    msg.textContent = 'Saved the file your browser downloads' + (record === undefined ? ', without your private record (' + recordError + ').' : ', with your private record.');
  }
  return h('section', { class: 'card stack' },
    h('p', {}, 'Downloads a file with your posts, comments, follows, settings and your private record as this browser holds them. Private photos and videos are saved one by one from the Media page. The file is made in this browser and is not uploaded.'),
    h('p', { class: 'small muted', id: 'export-signed' }, SIGNED_ENTRIES_NOTE),
    h('div', { class: 'row' },
      h('button', { type: 'button', class: 'btn primary', id: 'export-data', on: { click: exportAll } }, 'Download my data'),
      h('button', { type: 'button', class: 'btn', id: 'export-private', on: { click: async () => { try { const rec = await ctx.mw.me.get(); save('my-private-record.json', { note: PRIVACY.recordNote, record: rec }); msg.textContent = 'Saved your private record.'; } catch (e) { ctx.fail(e); } } } }, 'Download my private record')), msg);
}

// "Delete my page" (R 3.3, 2.15): what it can do with this copy of the loader, and the card says only that. The private record and its keys
// go through mw.me.erase; every list item you wrote is tombstoned (its value and salt leave every copy that syncs); every key you set
// (reactions, author-scoped keys) is deleted, and tombstoned where the page knows the entry's hash. The loader cannot clear a display name
// (mw.identity.setName takes 1 to 48 characters) and has no withdrawal pointer yet (GAP 2): the card says so, and promises the withdrawal
// only where mw.hub.withdrawPage exists.
export function deleteText(canWithdraw) {
  return 'This hides every post, comment, share, follow and profile item you wrote on your page from copies that sync, removes your reactions and the other values you set there, and removes your private record and its keys here. ' +
    (canWithdraw ? 'It also withdraws your page\'s address. ' : 'Your page\'s address keeps working: this copy of the loader cannot withdraw it yet. ') +
    'Your display name stays on your page: this copy of the loader cannot clear it yet. ' + PRIVACY.deleteLimits +
    ' The ledger keeps a stub of each entry (your key, the time, and the list or key name), and the earlier values of the keys removed stay in copies of the ledger.';
}

function deleteSection(ctx) {
  const d = ctx.data, log = h('ol', { class: 'stack tight', id: 'delete-log', 'aria-live': 'polite' });
  const ackField = checkbox('delete-ack', 'I understand', false, () => {});
  const ack = ackField.querySelector('input');
  const say = (t) => log.append(h('li', {}, t));
  const canWithdraw = ctx.hub.canWithdraw;
  // One write, retried while the loader says E_RATE; true when it was written.
  async function write(fn) {
    for (let tries = 0; tries < 6; tries++) {
      try { await fn(); return true; } catch (e) { if (e && e.code === 'E_RATE') { say('Waiting for the rate limit...'); await new Promise((r) => setTimeout(r, 15000)); } else { say(errorMessage(e)); return false; } }
    }
    return false;
  }
  async function run() {
    if (!ack.checked) { ctx.fail({ code: 'EMPTY' }); return; }
    if (!d.isHome()) { say('Open this on your own page: only your own page is deleted from here.'); return; }
    try {
      say('Removing your private record and its keys for this page...');
      try { await ctx.mw.me.erase(); } catch (e) { if (e && e.code !== 'E_POLICY') say('Private record: ' + errorMessage(e)); }
      const payloads = d.ownPayloads(); let n = 0;
      for (const p of payloads) {
        if (await write(() => ctx.mw.db.tombstone(p.h))) n += 1;
        if (n && n % 10 === 0) say('Hidden ' + n + ' of ' + payloads.length + ' items');
      }
      say('Hidden ' + n + ' of ' + payloads.length + ' items.');
      const keys = d.ownKeys(); let k = 0;
      for (const e of keys) {
        if (!(await write(() => ctx.mw.db.del(e.key)))) continue;
        k += 1;
        if (e.h) await write(() => ctx.mw.db.tombstone(e.h)); // the value's bytes too, where the page knows the entry
      }
      say('Removed ' + k + ' of ' + keys.length + ' reactions and other values.');
      if (canWithdraw) {
        say('Asking the identity page to withdraw your page...');
        try { await ctx.hub.withdrawPage(); say('Your page is withdrawn. Visitors see: This page was withdrawn by its owner.'); } catch (e) { say(errorMessage(e)); }
      } else say('Your page\'s address keeps working: this copy of the loader cannot withdraw it yet.');
      say('Your display name stays on your page: this copy of the loader cannot clear it yet.');
      ctx.store.clearAll();
      say('Cleared this device. You can close this page.');
    } catch (e) { ctx.fail(e); }
  }
  return h('section', { class: 'card stack' }, h('p', { id: 'delete-text' }, deleteText(canWithdraw)),
    h('p', { class: 'notice' }, 'This cannot be undone. Copies on devices that never sync again stay where they are.'),
    ackField, armedButton('Delete my page', run, { cls: 'btn danger' }), log);
}

const BUILD = { profile: profileSection, identity: identitySection, privacy: privacySection, visibility: visibilitySection, invite: inviteSection, notifications: notificationsSection,
  storage: storageSection, chat: chatSection, media: mediaSection, appearance: appearanceSection, export: exportSection, delete: deleteSection };

export function mount(ctx, route, container) {
  const d = ctx.data, signed = d.signedIn();
  const list = (current) => h('ul', { class: 'settings-list' }, SETTINGS_SECTIONS.filter((s) => signed || s === 'appearance' || s === 'visibility').map((s) => h('li', {},
    h('a', { href: hrefFor('settings', { section: s }), 'aria-current': current === s ? 'page' : null }, TITLES[s][0]))));
  if (!signed && route.section && route.section !== 'appearance' && route.section !== 'visibility') {
    container.append(stateCard('', 'Sign in to change your settings.', [h('button', { type: 'button', class: 'btn primary', on: { click: () => ctx.signIn() } }, 'Sign in')]));
    return { title: 'Settings' };
  }
  if (!route.section) {
    container.append(h('section', { class: 'card stack' }, h('p', {}, signed ? 'Choose a section.' : 'Sign in to change most settings. You can change the look of the page without signing in.'),
      h('ul', { class: 'settings-list' }, SETTINGS_SECTIONS.filter((s) => signed || s === 'appearance' || s === 'visibility').map((s) => h('li', {}, h('a', { href: hrefFor('settings', { section: s }) }, TITLES[s][0], h('span', { class: 'short' }, ' ' + TITLES[s][1])))))));
    return { title: 'Settings' };
  }
  const body = BUILD[route.section](ctx);
  container.append(h('div', { class: 'settings-grid' }, h('nav', { class: 'settings-nav', 'aria-label': 'Settings sections' }, list(route.section)),
    h('div', { class: 'stack' }, h('p', {}, link(ctx, hrefFor('settings'), 'All settings', 'link')), h('p', { class: 'muted' }, TITLES[route.section][1]), body)));
  return { title: TITLES[route.section][0] };
}
