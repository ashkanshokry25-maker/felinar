// The side column on a wide screen (from 1024 px): your page, how many people you follow against this device's cap, people you
// may know (followed by people you follow, from the public follow lists this browser holds) and your groups.

import { h, setChildren } from '../dom.js';
import * as M from '../model.js';
import { hrefFor } from '../router.js';
import { link, profileHref, suggestionLabel } from './common.js';

export function renderSide(ctx, side) {
  const d = ctx.data;
  const cap = d.followCap();
  const me = d.own();
  const sugg = M.suggestions(Array.from(d.views.values()), d.followedIds(), d.state.siteId, 5);
  const groups = Array.from(d.views.values()).filter((v) => v.policy.writers === 'allow' || v.policy.writers === 'open');
  setChildren(side, [
    h('section', { class: 'card stack', 'aria-labelledby': 'side-you' }, h('h2', { id: 'side-you' }, 'Your page'),
      h('p', {}, me && me.name ? me.name : 'You', ' ', h('span', { class: 'short' }, '(' + (d.state.identity ? d.state.identity.short : '') + ')')),
      link(ctx, hrefFor('profile', { label: d.state.label }), 'Open my page', 'btn'), link(ctx, hrefFor('settings', { section: 'invite' }), 'Show my QR code', 'btn')),
    h('section', { class: 'card stack', 'aria-labelledby': 'side-follow' }, h('h2', { id: 'side-follow' }, 'Following'),
      h('p', { id: 'follow-cap', class: cap.near ? 'error' : '' }, cap.text), cap.atCap ? h('p', { class: 'small' }, 'To follow someone new, unfollow someone first. The limit protects a phone\'s battery and storage.') : null),
    sugg.length ? h('section', { class: 'card stack', 'aria-labelledby': 'side-know' }, h('h2', { id: 'side-know' }, 'People you may know'),
      h('p', { class: 'small muted' }, 'Followed by people you follow. Nothing else decides this list.'),
      h('ul', { class: 'stack tight' }, sugg.map((s) => h('li', { class: 'row between' }, h('span', {}, link(ctx, profileHref(ctx, s.l), suggestionLabel(ctx, s).name), h('span', { class: 'short' }, suggestionLabel(ctx, s).via)),
        h('button', { type: 'button', class: 'btn small', on: { click: async (ev) => { ev.currentTarget.disabled = true; try { await d.follow(s.ptr || s.l); } catch (err) { ctx.fail(err); } } } }, 'Follow'))))) : null,
    groups.length ? h('section', { class: 'card stack', 'aria-labelledby': 'side-groups' }, h('h2', { id: 'side-groups' }, 'Groups'),
      h('ul', { class: 'stack tight' }, groups.map((g) => h('li', {}, link(ctx, hrefFor('group', { label: g.label || d.labelOf(g.id) }), d.nameOf(g.id)))))) : null,
  ]);
}
