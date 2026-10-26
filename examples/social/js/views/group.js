// A group (R 3.5 "Groups"): its own site and ledger with an owner, up to 50 moderators and members who may post (an "allow" group
// of up to 1,000, or an "open" group where anyone signed in posts and pays the small spam fee). Posts and comments are written by
// members to the group's own ledger, so posting happens on the group's own address; from your home the group is read-only.
// Invite-only controls who can post, not who can read: anyone with the group's address can read its ledger.

import { h, setChildren, reconcile, armedButton } from '../dom.js';
import { PRIVACY } from '../strings.js';
import { shortIdOf } from '../ids.js';
import { KEYS as SK } from '../store.js';
import { parseInviteLink, hubHost, pageOrigin } from '../hub.js';
import { link, stateCard, textNodes } from './common.js';
import { postCard, cardSig } from './post-card.js';
import { composer } from './composer.js';

// A queue item names its sender by key (a string) or by an object with the short id.
// The request line (R 2.5.2) by what the loader said of the delivery: taken by a moderator's browser, waiting in the outbox, or unknown.
const joinLine = (delivered) => (delivered === true ? 'Request sent. A moderator has it; this page says "You\'re in" once they accept.'
  : delivered === false ? 'Request sent. No moderator is connected to you now. Your request waits for up to 7 days.'
    : 'Request sent. No moderator may be connected to you now; your request waits for up to 7 days.');
const queueFrom = (q) => (typeof q.from === 'string' ? shortIdOf(q.from) : q.from && q.from.short ? q.from.short : '');

export async function mount(ctx, route, container) {
  const d = ctx.data;
  let id = route.site ? d.state.siteId : route.label === d.state.label ? d.state.siteId : route.label ? d.idOfLabel(route.label) : null;
  if (!id && route.label) { const p = parseInviteLink(location.hash); if (p && p.ledger && p.label === route.label) id = p.ledger; }
  if (!id) { container.append(stateCard('', "This group isn't in the copies this browser has. Open it from its link.", [link(ctx, '/', 'Back to the timeline', 'btn')])); return { title: 'Group not found' }; }
  const here = id === d.state.siteId;
  let peeked = false;
  if (!here) { try { await d.peek(id); peeked = true; } catch (err) { /* read what is held */ } }

  const head = h('section', { class: 'card stack', id: 'group-head' });
  const composeBox = h('div', {});
  const feed = h('div', { class: 'feed', id: 'group-feed', role: 'region', 'aria-label': 'Group posts' });
  const empty = h('div', {});
  const mod = h('section', { class: 'card stack', id: 'mod-panel', hidden: true });
  const room = h('section', { class: 'card stack', id: 'lobby' });
  let comp = null;
  let queueSig = '';

  function policyLine(v) {
    const w = v.policy.writers;
    if (w === 'open') return 'Open group: anyone who is signed in can post, with a small spam fee (' + (v.policy.bits || 0) + '-bit proof of work per post).';
    return 'Invite-only group: only members can post. Anyone with this group\'s address can still read it. For private conversation, use a private group chat.';
  }
  // R 2.5.2: a join request goes to the moderators' chat keys; the screens are "Request sent", "No moderator is connected to you now. Your request
  // waits for up to 7 days.", "You're in" and "Your request was declined". Messages are turned on first (the loader's card, in this tap).
  async function ask() {
    try {
      const v = d.viewOf(id) || { policy: {} };
      const opts = { moderators: Array.isArray(v.policy.moderators) ? v.policy.moderators : [], owner: v.owner, me: d.state.identity && d.state.identity.pub };
      if (!ctx.hub.joinBySdk && ctx.chat && (await ctx.chat.state()) !== 'on') await ctx.chat.enable();
      const r = await ctx.hub.requestJoin(id, opts);
      // delivered: true (a moderator's browser took it), false (it waits in the outbox), undefined (the loader does not say).
      const delivered = r && typeof r.delivered === 'boolean' ? r.delivered : null;
      ctx.store.set(SK.groups, Object.assign({}, ctx.store.get(SK.groups, {}), { [id]: { requestedAt: Date.now(), delivered } }));
      ctx.note(delivered === false ? 'Request sent. No moderator is connected to you now. Your request waits for up to 7 days.' : 'Request sent.', 'ok'); drawHead();
    } catch (e) { ctx.fail(e); }
  }
  function drawHead() {
    const v = d.viewOf(id);
    if (!v) { setChildren(head, [h('p', { role: 'status' }, 'Looking for this group in the copies this browser has...')]); return; }
    const role = here ? d.state.role : null;
    const requested = (ctx.store.get(SK.groups, {})[id] || {}).requestedAt;
    const mods = Array.isArray(v.policy.moderators) ? v.policy.moderators.length : 0;
    const lines = [];
    if (here && d.signedIn()) {
      if (role === 'owner') lines.push('You are the owner of this group.');
      else if (role === 'moderator') lines.push('You are a moderator of this group.');
      else if (role === 'writer') lines.push(requested ? "You're in." : 'You are a member of this group.');
      else if (v.policy.writers === 'allow') lines.push(!requested ? 'You are not a member yet.' : joinLine((ctx.store.get(SK.groups, {})[id] || {}).delivered));
    }
    const actions = [];
    if (!here) {
      const host = hubHost(location);
      actions.push(host ? h('a', { class: 'btn primary', href: pageOrigin(host, v.label || d.labelOf(id)) + '/', id: 'open-group' }, 'Open the group to post') : null);
      actions.push(d.isHome() && !d.isFollowing(id) ? h('button', { type: 'button', class: 'btn', id: 'follow-group', on: { click: async () => { try { await d.follow(id); drawHead(); } catch (e) { ctx.fail(e); } } } }, 'Follow this group') : null);
    } else if (!d.signedIn()) actions.push(h('button', { type: 'button', class: 'btn primary', on: { click: () => ctx.signIn() } }, 'Sign in'));
    else if (role === 'reader' && v.policy.writers === 'allow' && !requested) actions.push(h('button', { type: 'button', class: 'btn primary', id: 'ask-join', on: { click: ask } }, 'Ask to join'));
    if (here && d.signedIn() && (role === 'writer' || role === 'moderator')) actions.push(armedButton('Leave group', async () => { ctx.note('Ask a moderator to remove you from the member list. Signing out stops this page acting as you.', 'info'); await ctx.signOut(); }, { cls: 'btn' }));
    setChildren(head, [h('h2', {}, v.name || 'Group'), v.profile.bio ? h('p', {}, textNodes(ctx, v.profile.bio)) : null, h('p', {}, policyLine(v)),
      h('p', { class: 'small muted' }, mods + (mods === 1 ? ' moderator' : ' moderators') + (v.policy.allowCount ? ', ' + v.policy.allowCount.toLocaleString('en-US') + ' members' : '') + '. ' + PRIVACY.groups),
      lines.map((t) => h('p', { id: 'group-role' }, t)), h('div', { class: 'row' }, actions)]);
  }
  function drawCompose() {
    if (!here || !d.canWrite()) { setChildren(composeBox, []); comp = null; return; }
    if (!comp) { comp = composer(ctx, { mode: 'post', placeholder: 'Write to the group', onDone: () => draw() }); setChildren(composeBox, [h('section', { class: 'card' }, comp.node)]); }
  }
  function draw() {
    const v = d.viewOf(id);
    drawHead(); drawCompose();
    if (!v) { setChildren(feed, []); return; }
    const posts = v.posts.filter((p) => !d.hiddenSet().has(p.key) && !d.blockedSet().has(p.author));
    reconcile(feed, posts, { key: (p) => p.key, sig: (p) => cardSig(ctx, p), build: (p) => postCard(ctx, p) });
    setChildren(empty, posts.length ? [] : [stateCard('', 'No posts in this group yet.', [])]);
    drawMod();
  }
  async function drawMod() {
    if (!here || !d.isModerator()) { mod.hidden = true; return; }
    mod.hidden = false;
    let queue = [];
    try { queue = await ctx.mw.mod.queue(); } catch (e) { queue = []; }
    queueSig = queue.map((q) => q.id).join(',');
    const unban = h('input', { type: 'text', id: 'unban-pub', placeholder: 'p256:...', autocomplete: 'off' });
    setChildren(mod, [h('h2', {}, 'Moderation'),
      queue.length ? h('ul', { class: 'stack' }, queue.map((q) => h('li', { class: 'row between' }, h('span', {}, q.kind + (queueFrom(q) ? ' from ' + queueFrom(q) : '')),
        h('span', { class: 'row' }, ['accept', 'decline', 'deny'].map((dec) => h('button', { type: 'button', class: 'btn small', 'data-decision': dec, on: { click: async () => { try { await ctx.mw.mod.decide(q.id, dec, {}); drawMod(); } catch (e) { ctx.fail(e); } } } }, dec.charAt(0).toUpperCase() + dec.slice(1))))))) : h('p', { class: 'muted' }, 'The queue is empty.'),
      h('form', { class: 'stack', on: { submit: async (ev) => { ev.preventDefault(); try { await ctx.mw.mod.unban(unban.value.trim()); ctx.note('Unbanned.', 'ok'); unban.value = ''; } catch (e) { ctx.fail(e); } } } },
        h('div', { class: 'field' }, h('label', { for: 'unban-pub' }, 'Lift a ban (paste the person\'s key)'), unban), h('div', { class: 'row end' }, h('button', { type: 'submit', class: 'btn' }, 'Unban')))]);
  }
  async function drawRoom() {
    if (!here || !ctx.chat || !d.signedIn()) { room.hidden = true; return; }
    const log = h('div', { class: 'bubbles', id: 'room-log', role: 'log', 'aria-label': 'Lobby' });
    const area = h('textarea', { id: 'room-text', rows: 2, maxlength: 2000, 'aria-label': 'Message to the Lobby' });
    const seen = new Set();
    const add = (m) => { // a room message you send is not echoed back by the loader, so the form adds it; an id seen twice is shown once
      if (m.id) { if (seen.has(m.id)) return; seen.add(m.id); }
      const from = m.from || {}, name = from.name || (from.pub && d.ownerName(from.pub)) || from.short || 'Someone';
      log.append(h('div', { class: 'bubble' }, h('small', {}, name + ':'), m.text)); log.scrollTop = log.scrollHeight;
    };
    const joinBtn = h('button', { type: 'button', class: 'btn', id: 'join-lobby', on: { click: async () => {
      try { await ctx.chat.joinRoom('Lobby'); joinBtn.hidden = true; form.hidden = false; const off = ctx.chat.onRoom((m) => { if (!m.room || m.room === 'Lobby') add(m); }); ctx.subs.push(off); } catch (e) { ctx.fail(e); }
    } } }, 'Join the Lobby');
    const form = h('form', { hidden: true, class: 'stack', on: { submit: async (ev) => { ev.preventDefault(); const t = area.value.trim(); if (!t) return; try { const sent = await ctx.chat.sendRoom('Lobby', t); area.value = ''; add({ id: sent && sent.id, from: d.state.identity || { name: 'You' }, text: t }); } catch (e) { ctx.fail(e); } } } },
      h('div', { class: 'field' }, h('label', { for: 'room-text' }, 'Message'), area), h('div', { class: 'row end' }, h('button', { type: 'submit', class: 'btn primary' }, 'Send')));
    setChildren(room, [h('h2', {}, 'Lobby'), h('p', { class: 'small' }, PRIVACY.rooms), joinBtn, log, form]);
  }
  container.append(head, composeBox, mod, feed, empty, room);
  draw(); drawRoom();
  let t = 0;
  ctx.onData('change', () => { if (!t) t = setTimeout(() => { t = 0; draw(); }, 150); });
  // The SDK has no event for the moderation queue (mw.mod.queue() is a read), so a moderator's panel asks again every 5 s and redraws
  // only when the queue changed (a join request or a report that arrived by message).
  const queueTimer = setInterval(async () => {
    if (!here || !d.isModerator()) return;
    let ids = '';
    try { ids = (await ctx.mw.mod.queue()).map((q) => q.id).join(','); } catch (e) { return; }
    if (ids !== queueSig) drawMod();
  }, 5000);
  return { title: (d.viewOf(id) && d.viewOf(id).name) || 'Group', destroy: () => { clearInterval(queueTimer); if (peeked) d.release(id).catch(() => {}); } };
}
