// A person's page (R 3.1, 3.4, 3.5): the header (name with short id, claimed handle, bio, links), follow and message buttons,
// the wall (their posts, plus posts by others they accepted onto it), who they follow and the followers you can see.
// In the member's own home it shows other people from the ledgers this browser follows. On someone else's address it only
// reads, and a signed-in member gets "Open in your home".

import { h, setChildren, reconcile, armedButton } from '../dom.js';
import * as M from '../model.js';
import { hrefFor } from '../router.js';
import { STATE, errorMessage } from '../strings.js';
import { parseInviteLink } from '../hub.js';
import { isLedgerId } from '../ids.js';
import { link, profileHref, avatarNode, stateCard, textNodes } from './common.js';
import { postCard, cardSig } from './post-card.js';
import { composer } from './composer.js';
import { lookup, pinStatus, CHANGED_WARNING } from '../directory.js';
import { KEYS as SK } from '../store.js';

const WALL_TEXT = {
  everyone: 'Anyone can write on this wall.',
  follow: 'This wall takes posts from people the owner follows. Others are not shown.',
  nobody: 'This wall does not take posts from other people.',
  approve: 'The owner approves each post written on this wall before it is shown.',
};

export async function mount(ctx, route, container) {
  const d = ctx.data;
  const hash = location.hash;
  let id = null;
  if (route.site || route.label === d.state.label) id = d.state.siteId;
  else if (route.label) id = d.idOfLabel(route.label);
  else if (route.handle) { for (const v of d.views.values()) if (v.profile.handle === route.handle) id = v.id; }
  let parsed = null;
  if (!id && route.label) {
    parsed = parseInviteLink(location.pathname + hash) || parseInviteLink(hash);
    if (parsed && parsed.ledger && parsed.label === route.label) id = parsed.ledger;
  }
  if (!id) return unknownPage(ctx, route, container);

  let peeked = false;
  if (id !== d.state.siteId) {
    try { await d.peek(id); peeked = true; } catch (err) { /* the cap or no hub lane: the page shows what it holds */ }
  }
  const wallComposer = { node: null };
  const head = h('section', { class: 'card profile-head', id: 'profile-head' });
  const wallNote = h('p', { class: 'small muted', id: 'wall-note' });
  const wall = h('div', { class: 'feed', id: 'wall', role: 'region', 'aria-label': 'Wall' });
  const wallEmpty = h('div', {});
  const lists = h('div', { class: 'stack', id: 'profile-lists' });
  const composeBox = h('div', {});
  const msg = h('p', { class: 'small', role: 'status' });

  function title() {
    const v = d.viewOf(id);
    return v && v.name ? v.name : 'Profile';
  }
  async function openHome() {
    try {
      const rec = ctx.mw.me && typeof ctx.mw.me.get === 'function' ? await ctx.mw.me.get('home') : null;
      if (!rec || typeof rec.origin !== 'string') { msg.textContent = errorMessage({ code: 'NO_HOME' }); return; }
      const pointer = await ctx.hub.ownPointer();
      const target = new URL(rec.origin + '/@' + d.state.label + (pointer ? '#' + encodeURIComponent(pointer) : ''));
      if (target.protocol !== location.protocol) return;
      ctx.navigateTop(target.href, 'Open my page');
    } catch (err) { ctx.fail(err); }
  }
  // "Message": make the person a contact first, so a first message is not a stranger's request (which sites take only when the owner allows
  // them), then read the contacts (a card the loader shows once per session, which is why this runs in the click) and open the conversation.
  async function startConversation(ev, v) {
    ev.preventDefault();
    const href = hrefFor('thread', { short: v.short });
    try {
      if ((await ctx.chat.state()) !== 'on') return ctx.go(hrefFor('messages'));
      if (v.owner) await ctx.chat.addContact(v.owner, v.name || '');
      await ctx.inbox.loadContacts();
    } catch (err) { ctx.fail(err); }
    ctx.go(href);
  }
  // "Create my page" signs the new ledger's genesis with the key of this address. Only a hub identity ("Use one identity on all of
  // <hub>" at the identity page, mode 'hub') is the same key on the new address; a key for this address only would make a page whose
  // owner is a key its own address never gives back, so its owner could not post there. The page refuses before any card opens.
  async function createPage() {
    try {
      if (!ctx.hub.canCreatePage) throw Object.assign(new Error('NOT_AVAILABLE'), { code: 'NOT_AVAILABLE' });
      const mode = d.state.identity && d.state.identity.mode;
      if (mode !== 'hub') { msg.textContent = errorMessage({ code: 'HUB_IDENTITY' }); return; }
      const out = await ctx.hub.createPage();
      if (out.origin && ctx.mw.me && typeof ctx.mw.me.set === 'function') ctx.mw.me.set('home', { origin: out.origin }).catch(() => {});
      ctx.note('Your page is ready.', 'ok');
      if (out.url) ctx.navigateTop(out.url, 'Open my page'); // the address carries the pointer and the genesis in its fragment: open it as it is
    } catch (err) { ctx.fail(err); }
  }

  function drawHead() {
    const v = d.viewOf(id);
    if (!v) {
      setChildren(head, [h('p', { role: 'status' }, 'Looking for this page in the copies this browser has...')]);
      return;
    }
    const self = id === d.state.siteId && d.isHome();
    const following = d.isFollowing(id);
    const buttons = [];
    if (self) {
      buttons.push(link(ctx, hrefFor('settings', { section: 'profile' }), 'Edit profile', 'btn'), link(ctx, hrefFor('settings', { section: 'invite' }), 'Share my page', 'btn'));
    } else if (d.isHome()) {
      buttons.push(following
        ? armedButton('Unfollow', async () => { await d.unfollow(id); ctx.note('Unfollowed.', 'ok'); draw(); }, { cls: 'btn' })
        : h('button', { type: 'button', class: 'btn primary', id: 'follow', on: { click: async (ev) => { ev.currentTarget.disabled = true; try { await d.follow(parsed && parsed.pointer ? parsed.pointer : id); ctx.note('Following. Their posts appear in your timeline.', 'ok'); } catch (err) { ctx.fail(err); } draw(); } } }, 'Follow'));
      if (ctx.chat && v.short) buttons.push(link(ctx, hrefFor('thread', { short: v.short }), 'Message', 'btn', { on: { click: (ev) => startConversation(ev, v) } }));
    } else if (!d.signedIn()) {
      buttons.push(h('button', { type: 'button', class: 'btn primary', id: 'follow-signin', on: { click: () => ctx.signIn() } }, 'Sign in to follow'));
    } else {
      buttons.push(h('button', { type: 'button', class: 'btn primary', id: 'open-home', on: { click: openHome } }, 'Open in your home'),
        h('button', { type: 'button', class: 'btn', id: 'create-page', on: { click: createPage } }, 'Create my page'));
    }
    if (!self && v.owner) {
      buttons.push(armedButton('Block', async () => { d.block(v.owner); ctx.note('Blocked. Their posts and messages are dropped on this device.', 'ok'); }, { cls: 'btn danger' }));
    }
    const following2 = Array.from(v.follows.keys());
    const followers = M.followersYouCanSee(id, Array.from(d.views.values()));
    if (self) for (const n of d.notices()) if (n.k === 'follow' && followers.indexOf(n.from) === -1) followers.push(n.from);
    const linksList = v.profile.links.length ? h('ul', { class: 'links' }, v.profile.links.map((u) => h('li', {}, h('a', { href: u, target: '_blank', rel: 'noopener noreferrer nofollow' }, u)))) : null;
    setChildren(head, [
      h('div', { class: 'row' }, avatarNode(ctx, id, true),
        h('div', {}, h('h2', {}, v.name || '(' + v.short + ')'), h('p', { class: 'short' }, 'Short id ' + (v.short || '-')),
          v.profile.handle ? h('p', { class: 'small' }, h('span', { class: 'badge warn' }, 'Claimed handle'), ' @' + v.profile.handle + ' (not checked by this app; open the page at that address to check it)') : null)),
      v.profile.bio ? h('p', {}, textNodes(ctx, v.profile.bio)) : null, linksList,
      v.withdrawn ? h('p', { class: 'notice' }, STATE.withdrawn) : null,
      v.removed ? h('p', { class: 'notice' }, STATE.removedByHub + ' (' + v.removed.reason + ')') : null,
      h('div', { class: 'row' }, buttons), msg,
    ]);
    const mode = M.wallMode(v);
    wallNote.textContent = WALL_TEXT[mode];
    setChildren(lists, [
      peopleList(ctx, 'Following (public list)', following2),
      peopleList(ctx, 'Followers you can see', followers),
    ]);
    if (!self && d.isHome() && mode !== 'nobody' && !wallComposer.node) {
      wallComposer.node = composer(ctx, { mode: 'wall', to: id, placeholder: 'Write on this wall', onDone: () => draw() });
      composeBox.append(h('section', { class: 'card' }, wallComposer.node.node));
    }
  }
  function draw() {
    const v = d.viewOf(id);
    drawHead();
    if (!v) { setChildren(wallEmpty, [stateCard('', STATE.unknownPage, [])]); setChildren(wall, []); return; }
    const posts = M.wallPosts(v, Array.from(d.views.values())).filter((p) => !d.hiddenSet().has(p.key) && !d.blockedSet().has(p.author));
    reconcile(wall, posts, { key: (p) => p.key, sig: (p) => cardSig(ctx, p), build: (p) => postCard(ctx, p) });
    setChildren(wallEmpty, posts.length ? [] : [stateCard('', v.name ? v.name + ' has not posted anything this browser holds yet.' : 'No posts in the copies this browser holds yet.', [])]);
  }
  const pinNote = h('p', { class: 'notice', id: 'dir-warning', role: 'alert', hidden: true }, CHANGED_WARNING);
  container.append(head, pinNote, composeBox, wallNote, wall, wallEmpty, lists);
  if (ctx.flags.directory) {
    const pins = ctx.store.get(SK.dirPins, {});
    // A name you followed through the directory is pinned to the page you followed; if the name now points elsewhere, say so.
    for (const [pinned, name] of Object.entries(pins)) {
      lookup(name, undefined, { hubKey: ctx.flags.directoryKey }).then((res) => { if (res.ok && pinned === id && pinStatus(pins, pinned, res.entry) === 'changed') pinNote.hidden = false; });
    }
  }
  draw();
  let t = 0;
  ctx.onData('change', () => { if (!t) t = setTimeout(() => { t = 0; draw(); }, 120); });
  return { title: title(), destroy: () => { if (peeked) d.release(id).catch(() => {}); } };
}

function peopleList(ctx, title, ids) {
  const d = ctx.data;
  const known = ids.filter((l) => isLedgerId(l));
  return h('details', { class: 'card' }, h('summary', {}, title + ' (' + known.length + ')'),
    known.length ? h('ul', { class: 'stack tight' }, known.map((l) => h('li', {}, link(ctx, profileHref(ctx, l), d.nameOf(l)), ' ', h('span', { class: 'short' }, d.viewOf(l) && d.viewOf(l).short ? '(' + d.viewOf(l).short + ')' : '')))) :
      h('p', { class: 'muted' }, 'Nobody this browser can see yet.'));
}

function unknownPage(ctx, route, container) {
  const d = ctx.data;
  const input = h('input', { type: 'text', id: 'follow-link', placeholder: 'Paste a link or a pointer', autocomplete: 'off' });
  const note = h('p', { class: 'small', role: 'status' });
  const form = h('form', { class: 'stack', on: { submit: async (ev) => {
    ev.preventDefault();
    const parsed = parseInviteLink(input.value);
    if (!parsed || !parsed.pointer) { note.textContent = 'That link has no pointer, so this browser cannot find the page. Ask for the whole link or the QR code.'; return; }
    if (!d.isHome()) { note.textContent = 'Open this in your own page to follow someone.'; return; }
    try { await d.follow(parsed.pointer); ctx.go(hrefFor('profile', { label: parsed.label })); } catch (err) { note.textContent = errorMessage(err); }
  } } }, h('div', { class: 'field' }, h('label', { for: 'follow-link' }, 'Follow by link'), input), note, h('div', { class: 'row end' }, h('button', { type: 'submit', class: 'btn primary' }, 'Follow')));
  container.append(h('section', { class: 'card state' }, h('p', {}, STATE.unknownPage), form, h('div', { class: 'row' }, link(ctx, '/', 'Back to the timeline', 'btn'))));
  return { title: 'Page not found' };
}
