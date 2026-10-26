// One post on its own page (R 3.7 /@<label>/p/<h>): the post, its History, and the comments. Comments live on the commenters'
// own ledgers; the post's author lists the ones they accept in mw.ok, and this page reads them from those ledgers (following
// each commenter only for as long as the page is open). Your own comment shows at once, marked as waiting for the author.

import { h, setChildren, reconcile, armedButton } from '../dom.js';
import * as M from '../model.js';
import { LIMITS } from '../config.js';
import { errorMessage, fieldError } from '../strings.js';
import { textNodes, profileHref, missingPost } from './common.js';
import { postCard, cardSig } from './post-card.js';
import { parseInviteLink } from '../hub.js';

export async function mount(ctx, route, container) {
  const d = ctx.data;
  let id = route.label === d.state.label ? d.state.siteId : route.label ? d.idOfLabel(route.label) : null;
  if (!id && route.label) { const p = parseInviteLink(location.hash); if (p && p.ledger && p.label === route.label) id = p.ledger; }
  if (!id) { container.append(missingPost()); return { title: 'Post not found' }; }
  const peeked = new Set();
  if (id !== d.state.siteId) { try { await d.peek(id); peeked.add(id); } catch (err) { /* read what is held */ } }

  const host = h('div', { class: 'stack', id: 'post-host' });
  const heading = h('h2', {}, 'Comments');
  const list = h('div', { class: 'stack', id: 'thread-list' });
  const composerBox = h('div', { id: 'comment-box' });
  container.append(host, h('section', { class: 'card stack', id: 'thread', 'aria-label': 'Comments' }, heading, list, composerBox));
  let replyTo = null, composerKey = '';

  const findPost = () => {
    const v = d.viewOf(id);
    if (!v) return null;
    return v.posts.find((p) => p.h === route.h || p.versions.some((x) => x.h === route.h)) || v.shares.find((s) => s.h === route.h) || null;
  };
  async function pullCommenters(missingLedgers) {
    for (const l of missingLedgers.slice(0, 20)) {
      if (peeked.has(l) || l === d.state.siteId) continue;
      peeked.add(l);
      try { await d.peek(l); } catch (err) { /* at the follow cap: those comments stay unloaded */ }
    }
  }
  function commentNode(node) {
    const c = node.comment, v = d.viewOf(c.l);
    const mine = d.state.identity && c.author === d.state.identity.pub;
    const box = h('div', { class: 'comment', 'data-comment': c.key },
      h('p', { class: 'small' }, h('a', { href: profileHref(ctx, c.l) }, d.nameOf(c.l)), ' ', h('span', { class: 'short' }, '(' + (v ? v.short : '') + ')'), ' ',
        h('span', { class: 'short' }, M.timeAgo(c.ts, ctx.env.now())), c.edited ? [' ', h('span', { class: 'badge' }, 'edited')] : null,
        !node.accepted ? [' ', h('span', { class: 'badge warn' }, 'Waiting for the author to accept')] : null),
      h('div', { class: 'post-body' }, textNodes(ctx, c.text)),
      h('div', { class: 'row' },
        d.canWrite() ? h('button', { type: 'button', class: 'btn small', 'data-act': 'reply', on: { click: () => { replyTo = M.makeRef(c.l, c.h); drawComposer(true); document.getElementById('comment-text').focus(); } } }, 'Reply') : null,
        mine ? armedButton('Delete', async () => { await d.deleteVersions(c); ctx.note('Deleted.', 'ok'); }, { cls: 'btn small danger' }) :
          h('button', { type: 'button', class: 'btn small', on: { click: () => { d.hide(c.key); ctx.note('Hidden on this device.', 'ok'); } } }, 'Hide')));
    const wrap = h('div', { class: 'thread' }, box);
    for (const child of node.children) wrap.append(commentNode(child));
    return wrap;
  }
  function drawComposer(force) {
    const key = [d.canWrite() ? 1 : 0, d.signedIn() ? 1 : 0, replyTo ? M.refKey(replyTo) : ''].join('|');
    if (!force && key === composerKey) return;
    composerKey = key;
    if (!d.canWrite()) {
      setChildren(composerBox, [h('p', { class: 'muted small' }, d.signedIn() ? 'To comment, open this post in your own page.' : 'Sign in to comment.')]);
      return;
    }
    const area = h('textarea', { id: 'comment-text', rows: 3, maxlength: LIMITS.commentChars, 'aria-describedby': 'comment-count' });
    const count = h('span', { id: 'comment-count', class: 'counter' }, '0 / ' + LIMITS.commentChars);
    const err = h('p', { class: 'error', role: 'alert' });
    const send = h('button', { type: 'submit', class: 'btn primary', id: 'comment-send', disabled: true }, 'Comment');
    area.addEventListener('input', () => { count.textContent = area.value.length + ' / ' + LIMITS.commentChars; send.disabled = !area.value.trim(); });
    setChildren(composerBox, [h('form', { class: 'stack', novalidate: true, on: { submit: async (ev) => {
      ev.preventDefault();
      send.disabled = true; err.textContent = '';
      try {
        const post = findPost();
        await d.addComment({ l: post.l, h: post.h }, area.value, replyTo || undefined);
        area.value = ''; replyTo = null; count.textContent = '0 / ' + LIMITS.commentChars;
        ctx.note('Commented. It shows on this post once its author accepts it.', 'ok'); drawComposer(true); draw();
      } catch (e) { const ours = !!e && /^(EMPTY|MENTIONS|E_LIMIT)$/.test(e.code); err.textContent = ours ? fieldError(e) : errorMessage(e); send.disabled = false; }
    } } },
      h('div', { class: 'field' }, h('label', { for: 'comment-text' }, replyTo ? 'Your reply' : 'Write a comment'), area, count),
      replyTo ? h('p', { class: 'small' }, 'Replying to a comment. ', h('button', { type: 'button', class: 'link', on: { click: () => { replyTo = null; drawComposer(true); } } }, 'Reply to the post instead')) : null,
      err, h('div', { class: 'row end' }, send))]);
  }
  function draw() {
    const post = findPost();
    if (!post) { setChildren(host, [missingPost()]); setChildren(list, []); composerBox.hidden = true; return; }
    composerBox.hidden = post.type !== 'post';
    reconcile(host, [post], { key: (p) => p.key, sig: (p) => cardSig(ctx, p), build: (p) => postCard(ctx, p) });
    const t = M.threadOf({ l: post.l, h: post.h }, Array.from(d.views.values()), { me: d.state.siteId, blocked: d.blockedSet(), hidden: d.hiddenSet() });
    if (t.missingLedgers.length) pullCommenters(t.missingLedgers);
    heading.textContent = 'Comments' + (t.count ? ' (' + t.count + ')' : '');
    setChildren(list, (t.roots.length ? t.roots.map(commentNode) : [h('p', { class: 'muted' }, 'No comments yet.')]).concat(t.missing
      ? [h('p', { class: 'small muted' }, t.missing + (t.missing === 1 ? ' comment is' : ' comments are') + ' not loaded yet: this browser does not hold the commenter\'s page. Comments from people you do not follow load only while this page is open.')] : []));
    drawComposer(false);
  }
  draw();
  let timer = 0;
  ctx.onData('change', () => { if (!timer) timer = setTimeout(() => { timer = 0; draw(); }, 150); });
  return { title: 'Post', destroy: () => { for (const l of peeked) d.release(l).catch(() => {}); } };
}
