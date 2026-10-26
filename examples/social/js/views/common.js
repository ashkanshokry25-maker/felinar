// Building blocks the views share: links that stay in the app, avatars, a person's name with the short id beside it, text with
// mentions and https links, public pictures that load only on a tap (MF-49), reaction buttons, the post card and a dialog.
// Everything from other people is set as text; no function here parses HTML.

import { h, append, setChildren } from '../dom.js';
import * as M from '../model.js';
import { REACTIONS, REACTION_LABELS } from '../config.js';
import { hueOf, authorScope, shortIdOf } from '../ids.js';
import { hrefFor } from '../router.js';
import { PRIVACY, STATE } from '../strings.js';
import { formatBytes } from '../dom.js';

/** An anchor the app handles with pushState (app.js intercepts clicks on same-origin links the router knows). */
export function link(ctx, href, content, cls, extra) {
  return h('a', Object.assign({ href, class: cls || '' }, extra || {}), content);
}
export function profileHref(ctx, id) {
  const label = ctx.data.labelOf(id);
  const v = ctx.data.viewOf(id);
  return label ? hrefFor('profile', { label }) : v && v.profile.handle ? hrefFor('profile', { handle: v.profile.handle }) : '/';
}
export function postHref(ctx, item) {
  return hrefFor('post', { label: ctx.data.labelOf(item.l), h: item.h });
}

// ---------------------------------------------------------------------------------------------- pictures (public files)
const pictureCache = new Map();
/**
 * fetchFile(ctx, ref, ledger): mw.files.fetch comes first (R 2.8.4: nothing is fetched until the person taps; the loader's card names the file and
 * its size once per file), because mw.files.preview and mw.files.save answer only for a file that was fetched. The handle it returns is not used:
 * bytes reach the screen only through preview and the disk only through save (R 2.8.5). { ledger } names the ledger that lists the file, for loaders
 * that look files up on followed ledgers; a loader that knows only the page's own listings ignores it (docs/deviations/examples.md).
 */
export async function fetchFile(ctx, ref, ledger) {
  await ctx.mw.files.fetch(ref, ledger && ledger !== ctx.data.state.siteId ? { ledger } : undefined);
}
/** loadPicture(ctx, media, ledger) -> { url } | { none: true } through mw.files.preview, the only render path for a public file (R 2.8.5). */
export async function loadPicture(ctx, media, ledger) {
  const key = JSON.stringify(media.ref);
  if (!pictureCache.has(key)) {
    pictureCache.set(key, (async () => {
      await fetchFile(ctx, media.ref, ledger);
      const out = await ctx.mw.files.preview(media.ref);
      return out && out.kind === 'image' && out.url ? { url: out.url } : { none: true };
    })());
    pictureCache.get(key).catch(() => pictureCache.delete(key));
  }
  return pictureCache.get(key);
}
export const clearPictureCache = () => pictureCache.clear();

export function avatarNode(ctx, id, big) {
  const v = ctx.data.viewOf(id);
  const name = ctx.data.nameOf(id);
  const node = h('span', { class: 'avatar' + (big ? ' big' : ''), 'aria-hidden': 'true', style: null }, (name.trim()[0] || '?').toUpperCase());
  node.style.background = 'hsl(' + hueOf(id) + ', 55%, 36%)';
  const picture = v && v.profile && v.profile.avatar;
  if (picture && ctx.autoPictures() && (id === ctx.data.state.siteId || ctx.data.isFollowing(id))) {
    loadPicture(ctx, picture, id).then((p) => { if (p.url && node.isConnected) { setChildren(node, [h('img', { src: p.url, alt: '', width: big ? 88 : 44, height: big ? 88 : 44 })]); } }).catch(() => {});
  }
  return node;
}

/** nameBlock(ctx, id, { href }): "Ada (5666dca3)", the short id always beside the name (MF-70). */
export function nameNodes(ctx, id, extra) {
  const v = ctx.data.viewOf(id);
  const name = v && v.name ? v.name : '';
  return [h('a', { class: 'name', href: profileHref(ctx, id) }, name || ctx.data.nameOf(id)),
    ' ', h('span', { class: 'short' }, '(' + (v && v.short ? v.short : ctx.data.labelOf(id).slice(0, 8)) + ')'), extra || null];
}

// ---------------------------------------------------------------------------------------------- text
export function textNodes(ctx, text) {
  return M.tokenize(text).map((t) => {
    if (t.type === 'link') return h('a', { href: t.value, target: '_blank', rel: 'noopener noreferrer nofollow' }, t.value);
    if (t.type === 'mention') {
      const id = ctx.data.ledgerForShort(t.value);
      return id ? h('a', { href: profileHref(ctx, id) }, '@' + ctx.data.nameOf(id)) : h('span', { class: 'mention' }, '@' + t.value);
    }
    return t.value;
  });
}

// ---------------------------------------------------------------------------------------------- media tiles
/**
 * mediaTiles(ctx, media[]): a pictures or video block that fetches nothing until the reader taps the tile (MF-49): no
 * thumbnails from peers for public files. Alt text is shown before the picture loads, and is the picture's alt after.
 */
export function mediaTiles(ctx, media, authorId) {
  if (!media || !media.length) return null;
  const tiles = media.map((m) => {
    const tile = h('div', { class: 'tile' });
    const caption = m.alt || (m.kind === 'video' ? 'Video' : 'Picture without a description');
    const size = m.len ? ' (' + formatBytes(m.len) + ')' : '';
    const showImage = async (btn) => {
      btn.disabled = true;
      try {
        const p = await loadPicture(ctx, m, authorId);
        if (p.url) setChildren(tile, [h('img', { src: p.url, alt: m.alt || '', loading: 'lazy' })]);
        else setChildren(tile, [h('span', {}, 'No preview for this format. '), saveButton(ctx, m, authorId)]);
      } catch (err) { btn.disabled = false; if (!err || err.code !== 'E_USER_CANCELLED') ctx.fail(err); }
    };
    if (m.kind === 'video') {
      append(tile, [h('p', { class: 'small' }, caption + size), saveButton(ctx, m, authorId, 'Save video')]);
    } else {
      const btn = h('button', { type: 'button', class: 'btn small', on: { click: () => showImage(btn) } }, 'Show picture' + size);
      append(tile, [h('p', { class: 'small' }, caption), btn]);
      if (ctx.autoPictures() && (ctx.data.isFollowing(authorId) || authorId === ctx.data.state.siteId)) setTimeout(() => { if (btn.isConnected) showImage(btn); }, 0);
    }
    return tile;
  });
  return h('div', {}, h('div', { class: 'media-grid' }, tiles), h('p', { class: 'small muted' }, PRIVACY.fetchPublic));
}
function saveButton(ctx, m, authorId, label) {
  return h('button', { type: 'button', class: 'btn small', on: { click: async () => { try { await fetchFile(ctx, m.ref, authorId); await ctx.mw.files.save(m.ref); } catch (err) { if (!err || err.code !== 'E_USER_CANCELLED') ctx.fail(err); } } } }, label || 'Save');
}

// ---------------------------------------------------------------------------------------------- reactions
/** reactionInfo(ctx, target) -> { summary, reported, group, sig } for the buttons and the label under them. */
export function reactionInfo(ctx, target) {
  const d = ctx.data, v = d.viewOf(target.l);
  const group = !!(v && (v.policy.writers === 'allow' || v.policy.writers === 'open'));
  const pub = d.state.identity && d.state.identity.pub;
  const all = [d.own()].concat(Array.from(d.views.values()).filter((x) => x !== d.own()));
  const entries = M.collectReactions(target, all);
  const summary = M.summarizeReactions(entries, { followed: d.followedIds(), me: d.state.siteId, group, meScope: group && pub ? authorScope(pub).slice(1, 17) : '' });
  const reported = v ? M.reportedCount(v, target) : null;
  return { summary, reported, group, sig: JSON.stringify([summary.counts, summary.mine, reported && reported.n]) };
}
export function reactionBar(ctx, target) {
  const info = reactionInfo(ctx, target);
  const can = ctx.data.canWrite();
  const bar = h('div', { class: 'post-foot', role: 'group', 'aria-label': 'Reactions' });
  for (const r of REACTIONS) {
    const n = info.summary.counts[r];
    const mine = info.summary.mine === r;
    bar.append(h('button', {
      type: 'button', class: 'btn small react', 'data-react': r, 'aria-pressed': mine ? 'true' : 'false', disabled: !can,
      on: { click: async (ev) => { ev.currentTarget.disabled = true; try { await ctx.data.react(target, mine ? null : r); } catch (err) { ctx.fail(err); } } },
    }, REACTION_LABELS[r] + (n ? ' ' + n : '')));
  }
  const notes = [];
  if (info.summary.total) notes.push(info.summary.total.toLocaleString('en-US') + ' ' + info.summary.label);
  if (info.reported) notes.push(info.reported.n.toLocaleString('en-US') + ' ' + info.reported.label);
  if (!can) notes.push(ctx.data.signedIn() ? 'To react, open this in your own page.' : 'Sign in to react.');
  if (notes.length) bar.append(h('p', { class: 'react-note' }, notes.join('. ')));
  return bar;
}

// ---------------------------------------------------------------------------------------------- state blocks
export function stateCard(title, text, actions) {
  return h('section', { class: 'card state' }, title ? h('h2', {}, title) : null, text ? h('p', {}, text) : null,
    actions && actions.length ? h('div', { class: 'row' }, actions) : null);
}
export const missingPost = () => stateCard('', STATE.unknownPost);

/** openDialog({ title, body, actions }) -> the <dialog>; Escape and Cancel close it, focus returns to the opener. */
export function openDialog(ctx, { title, body, actions }) {
  const opener = document.activeElement;
  const dlg = h('dialog', { class: 'card', 'aria-labelledby': 'dlg-title' });
  const close = () => {
    try { dlg.close(); } catch (err) { /* already closed */ }
    dlg.remove();
    let back = opener; // a button inside a menu that closed cannot hold focus: the menu's own button does
    const menu = back && back.closest ? back.closest('details') : null;
    if (menu && !menu.open && !back.closest('summary')) back = menu.querySelector('summary');
    if (back && back.focus) back.focus();
  };
  append(dlg, [h('h2', { id: 'dlg-title' }, title), body, h('div', { class: 'row end' }, [h('button', { type: 'button', class: 'btn', on: { click: close } }, 'Cancel')].concat((actions || []).map((a) => h('button', { type: 'button', class: a.cls || 'btn primary', on: { click: async () => { try { await a.run(close); } catch (err) { ctx.fail(err); } } } }, a.label))))]);
  dlg.addEventListener('cancel', (e) => { e.preventDefault(); close(); });
  document.body.append(dlg);
  if (typeof dlg.showModal === 'function') dlg.showModal(); else dlg.setAttribute('open', '');
  return { dlg, close };
}

export function shortOf(pub) { return shortIdOf(pub); }

/** suggestionLabel(ctx, s) -> what to call a suggested page: its name if this browser holds it, else "Page <label start>", and who follows it. */
export function suggestionLabel(ctx, s) {
  const d = ctx.data, v = d.viewOf(s.l);
  const name = v && v.name ? v.name : 'Page ' + d.labelOf(s.l).slice(0, 8);
  const via = s.via.slice(0, 3).map((l) => d.nameOf(l)).join(', ');
  return { name, via: 'Followed by ' + via + (s.via.length > 3 ? ' and ' + (s.via.length - 3) + ' more' : '') };
}
