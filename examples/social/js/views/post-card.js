// The post card: one post, share or reply in a feed, on a wall or on its own page. A card is rebuilt only when its signature
// changes (reconcile in dom.js), so a half-typed edit, an open menu and the focus survive the stream of snapshots.

import { h, armedButton } from '../dom.js';
import * as M from '../model.js';
import { shortIdOf } from '../ids.js';
import { hrefFor } from '../router.js';
import { link, profileHref, postHref, avatarNode, textNodes, mediaTiles, reactionBar, reactionInfo, openDialog } from './common.js';
import { hubHost, pageOrigin } from '../hub.js';
import { composer } from './composer.js';

/** whoOf(ctx, item) -> { name, short, href, ledger, pub, badges } for the author of an item on a person's wall or in a group. */
export function whoOf(ctx, item) {
  const v = ctx.data.viewOf(item.l);
  const personal = !v || v.policy.writers === 'owner' || v.owner === item.author;
  const badges = [];
  if (v && !personal) {
    if (v.owner === item.author) badges.push('owner');
    else if (Array.isArray(v.policy.moderators) && v.policy.moderators.indexOf(item.author) !== -1) badges.push('moderator');
  }
  if (personal) return { name: (v && v.name) || ctx.data.nameOf(item.l), short: v && v.short ? v.short : ctx.data.labelOf(item.l).slice(0, 8), href: profileHref(ctx, item.l), ledger: item.l, pub: item.author, badges };
  const short = shortIdOf(item.author), ledger = ctx.data.ledgerForShort(short);
  return { name: (v && v.profiles && v.profiles[item.author]) || '', short, href: ledger ? profileHref(ctx, ledger) : null, ledger, pub: item.author, badges };
}

export function cardSig(ctx, item) {
  const info = reactionInfo(ctx, { l: item.l, h: item.h });
  const target = item.target ? ctx.data.viewOf(item.target.l) : null;
  const w = whoOf(ctx, item);
  return [item.key, item.latestH || item.h, w.name, w.badges.join(), info.sig, ctx.data.commentCounts().get(item.key) || 0,
    ctx.ui.editKey === item.key ? 'E' : '', ctx.data.canWrite() ? 1 : 0, ctx.data.signedIn() ? 1 : 0, target ? target.height : '',
    ctx.data.hiddenSet().has(item.key) ? 'H' : '', ctx.autoPictures() ? 'P' : '', Math.floor(ctx.env.now() / 600000)].join('|');
}

function quoted(ctx, target) {
  const v = ctx.data.viewOf(target.l);
  const p = v && v.posts.find((x) => x.h === target.h);
  if (!p) return h('p', { class: 'quote small muted' }, 'A post that is not in the copies this browser has.');
  const w = whoOf(ctx, p);
  return h('blockquote', { class: 'quote' }, h('p', { class: 'small' }, w.name ? w.name + ' (' + w.short + ')' : '(' + w.short + ')'), h('div', { class: 'post-body' }, textNodes(ctx, p.text)), mediaTiles(ctx, p.media, p.l));
}

function moreMenu(ctx, item, w, own) {
  const items = [];
  const d = ctx.data;
  items.push(h('button', { type: 'button', class: 'btn small', 'data-close': '', on: { click: async () => { try { await navigator.clipboard.writeText(location.origin + postHref(ctx, item)); ctx.note('Link copied.', 'ok'); } catch (err) { ctx.note('Copy this address from the bar: ' + postHref(ctx, item), 'info'); } } } }, 'Copy link'));
  if (own && item.type === 'post' && d.canWrite()) items.push(h('button', { type: 'button', class: 'btn small', 'data-act': 'edit', 'data-close': '', on: { click: () => { ctx.ui.editKey = item.key; ctx.rerender(); } } }, 'Edit'));
  if (own && d.signedIn()) items.push(armedButton('Delete', async () => { await d.deleteVersions(item); ctx.note('Deleted. Visitors stop showing it when they receive the deletion.', 'ok'); }, { cls: 'btn small danger' }));
  if (!own && d.isModerator() && item.l === d.state.siteId) {
    items.push(armedButton('Remove post', async () => { for (const v of item.versions) await ctx.mw.db.tombstone(v.h); ctx.note('Removed. Visitors stop showing it when they receive the removal.', 'ok'); }, { cls: 'btn small danger' }));
    if (w.pub && w.pub !== d.state.siteId) items.push(armedButton('Ban author', async () => { await ctx.mw.mod.ban(w.pub); ctx.note('Banned. Their posts disappear for visitors who receive the ban.', 'ok'); }, { cls: 'btn small danger' }));
  }
  if (!own) {
    items.push(h('button', { type: 'button', class: 'btn small', 'data-act': 'hide', 'data-close': '', on: { click: () => { d.hide(item.key); ctx.note('Hidden on this device.', 'ok'); } } }, 'Hide'));
    if (w.pub) items.push(armedButton('Block', async () => { d.block(w.pub); ctx.note('Blocked. Their posts, comments and messages are dropped on this device.', 'ok'); }, { cls: 'btn small danger' }));
    items.push(h('button', { type: 'button', class: 'btn small', 'data-act': 'report', 'data-close': '', on: { click: () => reportDialog(ctx, item) } }, 'Report'));
  }
  const menu = h('details', { class: 'menu' }, h('summary', { 'aria-label': 'More actions for this post' }, 'More'), h('div', { class: 'menu-list', on: { click: (ev) => { if (ev.target.closest && ev.target.closest('[data-close]')) menu.open = false; } } }, items));
  return menu;
}

/**
 * reportDialog(ctx, item): R 3.5 "Report": to the page or group's moderators, or for a personal page to the hub's moderation contact.
 * mw.report.send reaches the moderators of the page on screen only (src/loader/mod.js moderatorsOf skips the reporter), so:
 *   - a post of the group on screen: mw.report.send, and the page says how many moderators received it ({ sent }), or that nobody did;
 *   - a personal page's post: the page's only moderator is the person it is about, so nothing is sent through the site; the dialog names
 *     the hub's moderation contact and copies the details to send there;
 *   - a group's post shown elsewhere (your home): a report sent from here would reach nobody, so the dialog offers to open the group.
 * The details are metadata only (address, author key, time, reason, note), never the picture or video itself.
 */
export function reportDialog(ctx, item) {
  const d = ctx.data;
  const reason = h('select', { id: 'rep-reason' }, ['spam', 'harassment', 'illegal', 'other'].map((r) => h('option', { value: r }, r.charAt(0).toUpperCase() + r.slice(1))));
  const note = h('textarea', { id: 'rep-note', rows: 3, maxlength: 280 });
  const contact = ctx.flags.moderationContact;
  const v = d.viewOf(item.l);
  const group = !!v && (v.policy.writers === 'allow' || v.policy.writers === 'open');
  const here = item.l === d.state.siteId;
  const contactLine = contact ? 'This hub takes reports at: ' + contact + '.' : 'This hub has not named a moderation contact.';
  const fields = [h('div', { class: 'field' }, h('label', { for: 'rep-reason' }, 'Reason'), reason), h('div', { class: 'field' }, h('label', { for: 'rep-note' }, 'Note (optional)'), note)];
  // The post's address on its own page (the author's label on this hub), so whoever reads the report can open it there.
  const hubHere = hubHost(location);
  const postUrl = (hubHere ? pageOrigin(hubHere, d.labelOf(item.l)) : location.origin) + postHref(ctx, item);
  const details = () => ['Report: ' + reason.value, 'Post: ' + postUrl, 'Page ledger: ' + item.l, 'Entry: ' + item.h, 'Written by: ' + (item.author || 'unknown key'),
    'Time claimed by the author: ' + (item.ts ? new Date(item.ts).toISOString() : 'unknown')].concat(note.value.trim() ? ['Note: ' + note.value.trim()] : []).join('\n');
  if (group && here) {
    openDialog(ctx, {
      title: 'Report this post',
      body: h('div', { class: 'stack' },
        h('p', { class: 'small', id: 'rep-where' }, 'A report sends details about the post (who wrote it, its address, the time and your note) to the moderators of this group. It never sends the picture or video itself.'),
        fields),
      actions: [{ label: 'Send report', run: async (close) => {
        const out = await ctx.mw.report.send({ target: { h: item.h }, reason: reason.value, note: note.value.trim() || undefined });
        const sent = out && typeof out.sent === 'number' ? out.sent : out && out.sent === true ? 1 : 0;
        close();
        if (sent > 0) ctx.note('Report sent to ' + sent + (sent === 1 ? ' moderator' : ' moderators') + ' of this group.', 'ok');
        else ctx.note('Nobody received this report: no moderator of this group could be reached. ' + contactLine, 'error');
      } }],
    });
    return;
  }
  if (group) {
    const target = hubHere ? pageOrigin(hubHere, v.label || d.labelOf(item.l)) + '/' : '';
    openDialog(ctx, {
      title: 'Report this post',
      body: h('div', { class: 'stack' },
        h('p', { class: 'small', id: 'rep-where' }, 'This post belongs to a group. A report sent from here would reach nobody, because a report goes to the moderators of the page it is sent from. Open the group and report the post there. ' + contactLine)),
      actions: target ? [{ label: 'Open the group', run: async (close) => { close(); ctx.navigateTop(target, 'Open the group'); } }] : [],
    });
    return;
  }
  openDialog(ctx, {
    title: 'Report this post',
    body: h('div', { class: 'stack' },
      h('p', { class: 'small', id: 'rep-where' }, 'Reports about a personal page go to this hub, not to the person whose page it is, so nothing is sent from here. ' +
        (contact ? 'Copy the details and send them to: ' + contact + '. They name the post (its address, who wrote it and the time) and add your reason and note. They never include the picture or video itself.'
          : 'This hub has not named a moderation contact, so a report about a personal page cannot reach anyone from here.')),
      fields),
    actions: [{ label: 'Copy the details', run: async (close) => {
      const text = details();
      try { await navigator.clipboard.writeText(text); close(); ctx.note(contact ? 'Copied. Send the details to ' + contact + '.' : 'Copied.', 'ok'); } catch (err) { close(); ctx.note(text, 'info'); }
    } }],
  });
}

function shareDialog(ctx, item) {
  const note = h('textarea', { id: 'share-note', rows: 3, maxlength: 1000 });
  openDialog(ctx, {
    title: 'Share this post',
    body: h('div', { class: 'field' }, h('label', { for: 'share-note' }, 'Add a note (optional)'), note),
    actions: [{ label: 'Share', run: async (close) => { await ctx.data.shareItem({ l: item.l, h: item.h }, note.value); close(); ctx.note('Shared on your page.', 'ok'); } }],
  });
}

/** postCard(ctx, item): a post, a share or a reply as a card, for a feed, a wall, a group or the post's own page. */
export function postCard(ctx, item) {
  const d = ctx.data;
  const w = whoOf(ctx, item);
  const mePub = d.state.identity && d.state.identity.pub;
  const own = !!mePub && item.author === mePub;
  if (ctx.ui.editKey === item.key && item.type === 'post') {
    const c = composer(ctx, { mode: 'edit', item, onDone: () => { ctx.ui.editKey = ''; ctx.rerender(); }, onCancel: () => { ctx.ui.editKey = ''; ctx.rerender(); } });
    return h('article', { class: 'card post', 'data-key': item.key }, c.node);
  }
  const nameNode = w.href ? h('a', { class: 'name', href: w.href }, w.name || '(' + w.short + ')') : h('span', { class: 'name' }, w.name || 'Someone');
  const head = h('div', { class: 'post-head' }, w.ledger ? avatarNode(ctx, w.ledger) : h('span', { class: 'avatar', 'aria-hidden': 'true' }, (w.name || '?').slice(0, 1).toUpperCase()),
    h('div', { class: 'who' }, nameNode, ' ', h('span', { class: 'short' }, '(' + w.short + ')'), w.badges.map((b) => h('span', { class: 'badge' }, b)),
      item.to ? h('span', { class: 'short' }, ['to ', h('a', { href: profileHref(ctx, item.to) }, d.nameOf(item.to))]) : null,
      item.type === 'share' ? h('span', { class: 'short' }, 'shared') : null,
      h('a', { class: 'when', href: postHref(ctx, item), title: 'Time as claimed by the author' }, h('time', { datetime: item.ts ? new Date(item.ts).toISOString() : null }, M.timeAgo(item.ts, ctx.env.now()))),
      item.edited ? h('span', { class: 'badge' }, 'edited') : null));
  const body = [];
  if (item.type === 'reply') {
    body.push(h('p', { class: 'small muted' }, 'In reply to ', h('a', { href: hrefFor('post', { label: d.labelOf(item.target.l), h: item.target.h }) }, 'a post by ' + d.nameOf(item.target.l))));
    body.push(h('div', { class: 'post-body' }, textNodes(ctx, item.text)));
  } else if (item.type === 'share') {
    if (item.text) body.push(h('div', { class: 'post-body' }, textNodes(ctx, item.text)));
    body.push(quoted(ctx, item.target));
  } else {
    if (item.text) body.push(h('div', { class: 'post-body' }, textNodes(ctx, item.text)));
    body.push(mediaTiles(ctx, item.media, item.l));
    if (item.link) body.push(h('a', { class: 'link-card', href: item.link.url, target: '_blank', rel: 'noopener noreferrer nofollow' }, item.link.url));
    if (item.edited && item.versions.length > 1) {
      const hist = M.editHistory(item.versions);
      body.push(h('details', { class: 'history' }, h('summary', {}, 'History (' + hist.length + ' earlier ' + (hist.length === 1 ? 'version' : 'versions') + ')'),
        h('ul', {}, hist.map((v) => h('li', {}, h('span', { class: 'small muted' }, M.timeAgo(v.ts, ctx.env.now()) + ': '), v.text || '(pictures only)')))));
    }
  }
  const count = d.commentCounts().get(item.key) || 0;
  const foot = [];
  if (item.type !== 'reply') foot.push(reactionBar(ctx, { l: item.l, h: item.h }));
  const actions = h('div', { class: 'post-foot' },
    item.type !== 'reply' ? link(ctx, postHref(ctx, item), 'Comments' + (count ? ' (' + count + ')' : ''), 'btn small', { 'data-act': 'comments' }) : null,
    item.type !== 'reply' && d.canWrite() && !(own && item.type === 'share') ? h('button', { type: 'button', class: 'btn small', 'data-act': 'share', on: { click: () => shareDialog(ctx, item) } }, 'Share') : null,
    moreMenu(ctx, item, w, own));
  const card = h('article', { class: 'card post', 'data-key': item.key, 'data-type': item.type, 'aria-label': (w.name || w.short) + ': ' + (item.text || 'post').slice(0, 60) }, head, body, foot, actions);
  return card;
}
