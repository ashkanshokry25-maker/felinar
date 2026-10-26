// Alerts (R 3.5 "Notifications in the page"): replies, mentions, follows and shares that arrived as notices while this page was
// open or waiting at the hub mailbox, mentions found in the pages this browser holds, posts and comments waiting for your
// approval ("I approve each one"), and new messages. Nothing arrives while the page is closed: there is no push (see About).

import { h, setChildren, announce } from '../dom.js';
import { hrefFor } from '../router.js';
import { mentionsOfMe, notificationId } from '../notices.js';
import { link, profileHref, stateCard } from './common.js';
import { shortIdOf } from '../ids.js';

const VERB = {
  follow: 'followed you', reply: 'replied to your post', mention: 'mentioned you', share: 'shared your post', wall: 'wrote on your wall', join: 'asked to join a group you moderate',
};

export function mount(ctx, route, container) {
  const d = ctx.data;
  if (!d.signedIn()) { container.append(stateCard('', 'Sign in to see your alerts.', [h('button', { type: 'button', class: 'btn primary', on: { click: () => ctx.signIn() } }, 'Sign in')])); return { title: 'Alerts' }; }
  const wallBox = h('section', { class: 'card stack', id: 'wall-queue', hidden: true });
  const list = h('ol', { class: 'stack', id: 'alerts', 'aria-label': 'Alerts' });
  const empty = h('div', {});
  const seenBtn = h('button', { type: 'button', class: 'btn', id: 'mark-seen', on: { click: () => { d.markNoticesSeen(); announce('All alerts marked as seen'); } } }, 'Mark all as seen');
  const inbox = ctx.inbox;
  const asked = new Set();

  function href(n) {
    if (n.ref) return hrefFor('post', { label: d.labelOf(n.ref.l), h: n.ref.h });
    return profileHref(ctx, n.from);
  }
  function draw() {
    const mine = d.state.identity ? [d.state.identity.short, shortIdOf(d.state.identity.pub)] : [];
    const items = d.notices().slice();
    const have = new Set(items.map((n) => n.id));
    for (const m of mentionsOfMe(d.timeline({ filter: 'posts' }), mine, d.state.siteId)) { const id = notificationId(m); if (!have.has(id)) { have.add(id); items.push(Object.assign({ id, t: 0, seen: true }, m)); } }
    for (const n of items.slice(0, 12)) if (!asked.has(n.from) && !d.viewOf(n.from)) { asked.add(n.from); d.peek(n.from).then(() => d.release(n.from)).catch(() => {}); }
    const queue = d.wallQueue();
    wallBox.hidden = !queue.length;
    setChildren(wallBox, queue.length ? [h('h2', {}, 'Waiting for your approval (' + queue.length + ')'), h('ul', { class: 'stack' }, queue.map((q) => h('li', { class: 'row between' },
      h('span', {}, link(ctx, profileHref(ctx, q.from), d.nameOf(q.from)), q.k === 'wall' ? ' wrote on your wall' : ' commented on your post'),
      h('span', { class: 'row' }, h('button', { type: 'button', class: 'btn small', 'data-act': 'accept', on: { click: () => { d.decideWall(q.id, true); d.flushOk().catch(() => {}); } } }, 'Accept'),
        h('button', { type: 'button', class: 'btn small', 'data-act': 'decline', on: { click: () => d.decideWall(q.id, false) } }, 'Decline')))))] : []);
    setChildren(list, items.map((n) => h('li', { class: 'card' + (n.seen ? '' : ' unseen'), 'data-kind': n.k },
      h('p', {}, n.seen ? null : h('span', { class: 'badge' }, 'New'), n.seen ? null : ' ', link(ctx, profileHref(ctx, n.from), d.nameOf(n.from)), ' ' + (VERB[n.k] || 'sent a notice') + '. ',
        n.k === 'follow' || n.k === 'join' ? null : link(ctx, href(n), 'Open'), n.t ? h('span', { class: 'short' }, ' ' + new Date(n.t).toLocaleString()) : null))));
    const msgs = inbox ? Array.from(inbox.state.unread.entries()) : [];
    setChildren(empty, [msgs.length ? h('section', { class: 'card stack', id: 'unread-messages' }, h('h2', {}, 'New messages'), h('ul', { class: 'stack tight' }, msgs.map(([pub, n]) => {
      const c = inbox.byPub(pub); return h('li', {}, link(ctx, hrefFor('thread', { short: c ? c.short : pub.slice(5, 13) }), (inbox.nameFor(pub) || (c && c.short)) || 'Someone'), ' (' + n + ')');
    }))) : null, !items.length && !queue.length && !msgs.length ? stateCard('', 'Nothing yet. Replies, mentions, follows and shares appear here while this page is open.', []) : null]);
    seenBtn.hidden = !items.some((n) => !n.seen);
  }
  container.append(h('div', { class: 'row end' }, seenBtn), wallBox, empty, list);
  draw();
  ctx.onData('change', draw);
  if (inbox) { const off = inbox.onChange(draw); ctx.subs.push(off); }
  const t = setTimeout(() => d.markNoticesSeen(), 2500);
  return { title: 'Alerts', destroy: () => clearTimeout(t) };
}
